import axios from "axios"
import { Logger } from '../../src/utils/Logger.js'
import { tavily } from "@tavily/core"
import { getConfig } from './config.js'

// ─── Turn budget limits ─────────────────────────────────────────────────
//pending to trash
const LIMITS = {
    memoryQuery: 30,   // query_memory_database
    memoryWrite: 30,   // addto / update / remove_memory_database — shared slot
    media: 30,         // send_gif / send_meme — shared slot
    webSearch: 30,     // web_search
    total: 20,         // ANY chat-context tool call, combined — hard ceiling
    narration: 30,     // narrated-instead-of-called attempts tolerated before forcing a tool-free reply
    badArgs: 30,       // malformed/empty-argument calls tolerated before forcing a tool-free reply
}

// A single, consistent "you're done, talk now" instruction attached to
// EVERY successful tool result. The old code returned bare
// {"status":"ok","message":null} on success, which reads to a small model
// as "the call worked, I could call another one" rather than "stop." This
// string is what was actually missing — the budget/hard-stop machinery
// only kicks in as a last resort; this is what should stop it on the
// FIRST successful call in the common case.
const DONE_NOTE = "Tool succeeded — you have what you need. Do not call this or any other tool again for this message. Write your final, visible, in-character reply right now, using this result."

// ─── Tool Executor ──────────────────────────────────────────────────────
//
// Turn-loop contract (read this before touching turn state):
//   1. Call resetTurn() once at the START of handling each new incoming
//      user message — NOT per loop iteration within that turn.
//   2. After every tool execution, check shouldHardStop(). If true, stop
//      calling tools entirely and force a final generation with `tools`
//      removed from the request, e.g.:
//
//        const result = await toolExecutor.execute(name, args)
//        messages.push({ role: "tool", tool_call_id: id, content: result })
//        if (toolExecutor.shouldHardStop()) {
//            return await callModel(messages /* no `tools` field */)
//        }
//
//      An 8B model under load frequently does NOT comply with a "STOP" a
//      instruction baked into a tool result string — it just tries a
//      different tool name next. shouldHardStop() must be checked by the
//      loop code itself; the in-band STOP message alone is not enough.
//   3. When the model narrates a tool call in prose instead of emitting a
//      real one, call recordNarration() and check its return value the
//      same way — true means force a tool-free final generation.
//
// Flawless-turn tracking (for the auto-dataset-save pipeline):
//   turnFlawless starts true on every resetTurn() and is flipped to false
//   the first time markFlawed() is called anywhere below. lily.js checks
//   this.tools.turnFlawless right before saving a completed turn to the
//   training-data queue — see maybeSaveFlawlessTurn() in lily.js. Every
//   branch that already represents "something went wrong" (error, block,
//   bad args, narration, malformed tool call, retry, budget exhaustion)
//   should call markFlawed() with a short reason string. markFlawed() is
//   idempotent — only the first reason of a turn sticks — so it's safe to
//   call from multiple places without worrying about overwriting context.
class ToolExecutor {
    // First param kept for call-site backward compatibility (Lily used to
    // hand this its own opts snapshot) but is otherwise IGNORED now — see
    // the opts getter below, which reads config.json live on every access
    // instead of relying on whatever was passed in at construction time.
    constructor(_legacyOpts = null, mcSend = null, getStateController = null) {
        this.mcSend = mcSend
        this.getStateController = getStateController
        this.lastMineTime = 0
        this.resetTurn()
    }

    // Reads config.json fresh on every access — no snapshot, nothing to go
    // stale, edits take effect on the next call that touches this.opts.
    get opts() {
        return getConfig()
    }

    resetTurn() {
        this.turnUsage = { memoryWrite: 0, media: 0, memoryQuery: 0, webSearch: 0, total: 0 }
        this.turnHardStop = false
        this.turnNarrationCount = 0
        this.turnBadArgs = 0
        this.turnFlawless = true
        this._flawReason = null
    }

    // Loop code checks this after every tool execution.
    shouldHardStop() {
        return this.turnHardStop
    }

    // Marks the current turn as no longer a clean training candidate.
    // Idempotent — only the first reason recorded per turn is kept, which
    // makes debugging "why wasn't this saved" straightforward (check
    // _flawReason) without needing to track every disqualifying event.
    markFlawed(reason) {
        if (this.turnFlawless) {
            this.turnFlawless = false
            this._flawReason = reason
            Logger.info(`Turn disqualified from flawless-save: ${reason}`, "FLAWLESS CHECK")
        }
    }

    // Loop code calls this when the model describes/announces a tool call
    // in prose instead of emitting a real one. Returns true once the
    // narration budget is exhausted and the loop should force a tool-free
    // final generation instead of retrying.
    recordNarration() {
        this.turnNarrationCount++
        this.markFlawed('narrated_tool')
        if (this.turnNarrationCount > LIMITS.narration) {
            this.turnHardStop = true
            return true
        }
        return false
    }

    // ─── Shared helpers ──────────────────────────────────────────────────
    _blocked(message) {
        this.turnHardStop = true
        this.markFlawed('blocked')
        return JSON.stringify({ status: "blocked", stop: true, message })
    }

    _err(message) {
        // Errors don't get DONE_NOTE — a failed call is legitimately
        // retryable (different query, etc.), unlike a success.
        this.markFlawed('tool_error')
        return JSON.stringify({ status: "error", message })
    }

    // Every successful tool call goes through here (or attaches the same
    // fields inline, for the handful of callers that build their own
    // payload). `message` is optional human-readable context; `extra` can
    // carry structured data like a gif url. `done` defaults to true and
    // should only be set false for a call that is a genuine, expected
    // setup step for another call the model is about to make (there are
    // currently none — kept as an escape hatch).
    _ok(message, extra = {}, { done = true } = {}) {
        return JSON.stringify({
            status: "ok",
            message,
            ...(done ? { instruction: DONE_NOTE } : {}),
            ...extra
        })
    }

    // Generic per-turn budget guard, shared by every limited chat-context
    // tool (memory query, memory write, media, web search). Returns a
    // blocked-result string once `key` has hit `limit`, else null.
    _checkLimit(key, limit, label) {
        if (this.turnUsage[key] >= limit) {
            return this._blocked(
                `STOP. You've already hit the limit for ${label} this turn (max ${limit}). Do not call it again for any reason. ` +
                `Write your visible, in-character reply now using only what you already have.`
            )
        }
        return null
    }

    // Every tool call attempt (successful, blocked, or errored) counts
    // against the total-3 ceiling. Checked first in execute() for every
    // non-Minecraft tool, before the tool-specific limit.
    _spendTotal() {
        if (this.turnUsage.total >= LIMITS.total) {
            return this._blocked(
                `STOP. You have already made ${this.turnUsage.total} tool calls this turn — that is the hard maximum for ANY tool, of any kind, combined. ` +
                `Do not call query_memory_database, addto/update/remove_memory_database, send_gif, send_meme, or web_search again — not this one, not a different one. ` +
                `Write your final, visible, in-character chat reply to the user right now, using only what you already have.`
            )
        }
        this.turnUsage.total++
        return null
    }

    _noController() {
        return this._err("Can't perform actions right now.")
    }

    // Shared arg validator for any tool that takes a free-text query/fact.
    // Rejects empty/too-short arguments immediately with an explicit
    // instruction, instead of silently searching "" and letting the model
    // read the empty result as "the tool is broken" and start thrashing.
    //
    // First offense in a turn: soft error, real retry still possible within
    // the total budget. Second offense in the SAME turn: hard-stop — the
    // model isn't converging on a real value, so stop inviting more
    // attempts and force it to answer with what it has.
    _requireQuery(query, minWords, exampleHint) {
        const trimmed = (query ?? "").trim()
        if (!trimmed || trimmed.split(/\s+/).length < minWords) {
            this.turnBadArgs++
            this.markFlawed('bad_args')
            if (this.turnBadArgs > LIMITS.badArgs) {
                return this._blocked(
                    `STOP. You've now called a tool with a missing/empty/too-short argument ${this.turnBadArgs} time(s) this turn. ` +
                    `Do not call any more tools this turn, of any kind. Write your visible, in-character reply right now using only what you already have — ` +
                    `it's fine to skip whatever you were trying to do with that tool.`
                )
            }
            return this._err(
                `Missing or too-short query argument. You must pass an actual descriptive query string in the argument — ` +
                `not an empty value, not the raw user message. Example of a valid value: "${exampleHint}". ` +
                `If you don't actually have a real value to put there, don't call this tool again — drop it and reply in character instead.`
            )
        }
        return null
    }

    async wikiSearch(query) {
        Logger.info(`"${query}"`, "WIKI")
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout
            })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No relevant information found in the wiki."
            return text
        } catch (err) {
            Logger.error(err.message, "WIKI")
            return "No relevant information found in the wiki right now."
        }
    }

    async memoryQuery(query, { daysAgo = null, windowDays = 2, daysBack = null } = {}) {
        const limitErr = this._checkLimit('memoryQuery', LIMITS.memoryQuery, 'memory search (query_memory_database)')
        if (limitErr) return limitErr

        // Mode 3 (open-ended recap) is exempt from the query-text requirement.
        if (daysBack === null) {
            const argErr = this._requireQuery(query, 2, "shinyshadow_ favorite food")
            if (argErr) return argErr
        }

        this.turnUsage.memoryQuery++

        const finish = (resultsText) => JSON.stringify({
            status: "ok",
            results: resultsText,
            instruction: "Memory lookup complete. Use these results (or their absence) to write your visible, in-character reply now — don't search again unless this genuinely didn't answer what you needed."
        })

        if (daysBack !== null) {
            Logger.info(`Queried recent memories up to ${daysBack} days back`, "MEMORY QUERY")
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/recent`, {
                    limit: 10, days_back: daysBack, min_importance: 0.3
                }, { timeout: this.opts.dbTimeout })

                if (!data?.results?.length) return finish(`No memories found from the last ${daysBack} days.`)

                return finish(data.results.map(e => {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return e.type === "episodic" ? `[${date}] ${e.content}` : `[${date}] ${e.text}`
                }).join("\n"))
            } catch (err) {
                Logger.error(err.message, "MEMORY QUERY")
                return finish("No relevant information found in memory.")
            }
        }

        Logger.info(`Queried memory: "${query}" from ${daysAgo ?? "any"} days ago`, "MEMORY QUERY")
        try {
            const k = daysAgo !== null ? 25 : 10
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query, k, min_score: this.opts.memoryQueryMinScore
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) return finish("No relevant information found in memory.")

            let results = data.results

            if (daysAgo !== null) {
                const nowSecs = Date.now() / 1000
                const targetTs = nowSecs - daysAgo * 86400
                const windowSecs = Math.max(windowDays, 0) * 86400
                const lo = targetTs - windowSecs
                const hi = targetTs + windowSecs
                results = results.filter(e => e.timestamp >= lo && e.timestamp <= hi)
                if (!results.length) return finish(`No relevant information found from around ${daysAgo} days ago.`)
            }

            results = results.slice(0, 10)
            return finish(results.map(e => {
                if (e.type === "episodic") {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return `[${date}] ${e.content}`
                }
                return e.text
            }).join("\n"))
        } catch (err) {
            Logger.error(err.message, "MEMORY QUERY")
            return finish("No relevant information found in memory.")
        }
    }

    async memoryAdd(factText, source = "user") {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(factText, 2, "ShinyShadow_ said their favorite color is teal")
        // if (argErr) return argErr
        this.turnUsage.memoryWrite++

        Logger.info(` Added memory: "${factText}"`, "MEMORY ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`, { text: factText, source }, { timeout: this.opts.dbTimeout })

            // Only treat this as a real failure if the backend explicitly said so.
            // Anything else (missing status field, "success", true, etc.) is treated
            // as success instead of silently flagging a working call as an error.
            const failed = data?.status === "error" || data?.ok === false
            if (failed) {
                Logger.error(`add_fact returned failure: ${JSON.stringify(data)}`, "MEMORY ADD")
                return this._err(data.message ?? "Failed to store information.")
            }
            if (data?.status !== "ok") {
                // Unexpected-but-not-explicitly-failed shape — log it so we can see
                // exactly what the backend actually returns, but don't fail the turn.
                Logger.warning(`Unexpected add_fact response shape: ${JSON.stringify(data)}`, "MEMORY ADD")
            }
            return this._ok(data?.message ?? "Stored.")
        } catch (err) {
            Logger.error(err.message, "MEMORY ADD")
            return this._err("Failed to store information.")
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr

        const argErr = this._requireQuery(searchQuery, 2, "shinyshadow_ favorite color") || this._requireQuery(updatedText, 2, "ShinyShadow_'s favorite color is now teal")
        if (argErr) return argErr
        if (searchQuery.trim().toLowerCase() === updatedText.trim().toLowerCase()) {
            this.markFlawed('memory_update_noop')
            return JSON.stringify({
                status: "noop",
                message: "The old and new text are identical — there's nothing to update. If you don't actually know the current value, don't call this tool at all. Write your reply now."
            })
        }
        this.turnUsage.memoryWrite++

        Logger.info(`Updated memory: "${searchQuery}" → "${updatedText}"`, "MEMORY UPDATE")
        try {
            const { data } = await axios.put(`${this.opts.memoryDbUrl}/update_fact`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            if (data.status !== "ok") return this._err(data.message ?? "Failed to update entry.")
            return this._ok(data.message ?? "Updated.")
        } catch (err) {
            Logger.error(err.message, "MEMORY UPDATE")
            return this._err("Failed to update entry.")
        }
    }

    async memoryRemove(searchQuery) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(searchQuery, 2, "IsGone favorite color")
        if (argErr) return argErr
        this.turnUsage.memoryWrite++

        Logger.info(`Attempted to remove memory: "${searchQuery}"`, "MEMORY REMOVE")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/remove_by_query`, {
                query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore, types: ["fact"]
            }, { timeout: this.opts.dbTimeout })
            if (data?.status !== "ok" || !data?.removed?.length) {
                // Not found is still a *resolved* outcome, not a reason to retry —
                // give it the same stop instruction so the model doesn't hammer
                // this with rephrased queries. Also treated as a flaw for the
                // same reason as the memoryUpdate no-op above: it's evidence
                // the model acted on a fact that wasn't actually there.
                this.markFlawed('memory_remove_not_found')
                return JSON.stringify({
                    status: "not_found",
                    message: "No matching memories found.",
                    instruction: "Nothing matched — that's a final answer, not a failure to fix by retrying. Reply now, in character."
                })
            }
            return this._ok(`Removed: ${data.removed.join(", ")}`, { removed: data.removed })
        } catch (err) {
            Logger.error(err.message, "MEMORY REMOVE")
            return this._err("Failed to remove entries.")
        }
    }

    // Not part of the live chat-turn budget — called out-of-band by a
    // batch/summarizer process, not by the model mid-conversation.
    async addEpisodicMemory({ summary, raw, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation_batch" }) {
        Logger.info(`"${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}"`, "EPISODIC BATCH ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_episodic`, {
                summary, raw, participants, emotions, importance, channel, source,
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            Logger.error(err.message, "EPISODIC BATCH ADD")
            return this._err("Failed to store episodic memory.")
        }
    }
    async minecraftActionCraft(args = {}) {
        const { item, quantity } = args
        if (typeof item !== "string" || !item.trim()) {
            return this._err("item required, in item_name format (e.g. 'iron_sword').")
        }
        const itemId = item.trim().toLowerCase().replace(/^minecraft:/, '')
        const amount = Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, 64) : 1

        Logger.info(`Lily is crafting ${itemId} x${amount}`, "MINECRAFT")
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        const result = await stateController.craftItem(itemId, amount)
        return result.ok
            ? this._ok(result.message ?? `Crafted ${amount}x ${itemId}.`)
            : this._err(result.message ?? "Crafting failed.")
        if (!result.ok) {
            Logger.error(result.message ?? "Crafting failed.", "MINECRAFT")
        }
    }
    async searchGif(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "excited anime girl jumping")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "GIF")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })
            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('gif_not_found')
                return JSON.stringify({ status: "not_found", message: "No GIF found — don't retry with a near-identical query, just reply without a gif." })
            }
            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('gif_no_url')
                return JSON.stringify({ status: "not_found", message: "No GIF URL — don't retry, just reply without a gif." })
            }
            Logger.success(`Gif found, URL: ${url}`, "GIF")
            return this._ok("Gif found and already queued to send — do NOT put the url in your text, just reply naturally to the user.", { url })
        } catch (err) {
            Logger.error(err.message, "GIF")
            return this._err("Gif not found, ignore this and reply naturally to the user. Do NOT attempt to send another gif this turn.")
        }
    }

    async searchMeme(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "drake approving")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "MEME")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/static-memes/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('meme_not_found')
                return JSON.stringify({ status: "not_found", message: "No meme found — don't retry with a near-identical query, just reply without a meme." })
            }

            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('meme_no_url')
                return JSON.stringify({ status: "not_found", message: "No meme URL — don't retry, just reply without a meme." })
            }

            Logger.success(`Meme found, URL: ${url}`, "MEME")
            return this._ok("Meme found and already queued to send — do NOT put the url in your text, just reply to the user message naturally.", { url })
        } catch (err) {
            Logger.error(err.message, "MEME")
            if (err.response) Logger.error(JSON.stringify(err.response.data), "MEME RESPONSE")
            return this._err("Meme not found, ignore this and reply naturally to the user. Do NOT attempt to send another meme this turn.")
        }
    }

    async webSearch(query) {
        const limitErr = this._checkLimit('webSearch', LIMITS.webSearch, 'web_search')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "current Minecraft version")
        if (argErr) return argErr
        this.turnUsage.webSearch++

        Logger.info(`Querying Tavily API: "${query}"`, "WEB SEARCH")
        try {
            const client = tavily({ apiKey: process.env.TAVILY_API_KEY })
            const response = await client.search(query, {
                maxResults: 5,
                searchDepth: "basic",
            })

            const results = response?.results ?? []
            if (!results.length) {
                return JSON.stringify({
                    status: "ok",
                    results: "No results found.",
                    instruction: "Search came back empty — that's your answer, don't keep rephrasing. Reply now, in character."
                })
            }

            const resultsText = results.map(r =>
                `**${r.title}**\n${r.url}\n${r.content ?? ""}`
            ).join("\n\n")

            return JSON.stringify({
                status: "ok",
                results: resultsText,
                instruction: "Search complete. Summarize this in your own words for your visible, in-character reply now — don't search again unless this truly didn't cover it, and never paste URLs or raw excerpts verbatim."
            })
        } catch (err) {
            Logger.error(err.message, "WEB SEARCH")
            return this._err("Web search failed.")
        }
    }

    // ─── Minecraft Actions ───────────────────────────────────────────────
    // Run in the Minecraft-agent context, not the Discord chat context —
    // exempt from the chat-turn budget above, and gated by their own
    // per-action cooldowns (e.g. lastMineTime) instead.
    _simpleDispatch(action, payload, okMessage, failFallback) {
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()
        const result = stateController.dispatchAction(action, payload)
        return result.ok
            ? this._ok(okMessage)
            : this._err(result.message ?? failFallback)
    }

    async minecraftActionAttack(args = {}) {
        const { slot, entityId } = args
        if (!slot || slot < 1 || slot > 36) {
            return this._err("slot (1-36) required.")
        }
        if (entityId === undefined || entityId === null) {
            return this._err("entityId required — pick one from the Hostile/Passive Mobs list.")
        }
        Logger.info(`attack slot:${slot} target:${entityId}`, "MINECRAFT")
        return this._simpleDispatch('attack', { slot, entityId }, "Engaging target.", "Attack failed.")
    }

    async minecraftActionEat(args = {}) {
        const { slot } = args
        Logger.info(`Lily ate slot number ${slot ? ` ${slot}` : ''}`, "MINECRAFT")
        return this._simpleDispatch('use', { slot }, "Ate.", "Eat failed.")
    }

    async minecraftActionSwapSlot(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 36) {
            return this._err("slot (1-36) required.")
        }
        Logger.info(`Lily swapped to slot number ${slot}`, "MINECRAFT")
        return this._simpleDispatch('swap_slot', { slot }, `Swapped to slot ${slot}.`, "Swap failed.")
    }

    async minecraftActionDrop(args = {}) {
        const { slot, amount } = args
        if (!slot || slot < 1 || slot > 36) {
            return this._err("slot (1-36) required.")
        }
        const count = Number.isInteger(amount) && amount > 0 ? amount : 1
        const MAX_DROPS_PER_CALL = 64

        if (count > MAX_DROPS_PER_CALL) {
            return this._err(`Can't drop more than ${MAX_DROPS_PER_CALL} at once.`)
        }

        Logger.info(`Lily has dropped the item in slot ${slot} ${count} time(s)`, "MINECRAFT")
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        for (let i = 0; i < count; i++) {
            const result = stateController.dispatchAction('drop', { slot })
            if (!result.ok) {
                return this._err(result.message ?? `Drop failed after ${i} of ${count} item(s).`)
            }
            if (i < count - 1) {
                await new Promise(resolve => setTimeout(resolve, 250))
            }
        }

        return this._ok(`Dropped ${count} item(s) from slot ${slot}.`)
    }

    async minecraftActionFollow(args = {}) {
        const { player } = args
        if (!player) {
            return this._err("player name required.")
        }
        Logger.info(`Lily is now following ${player}`, "MINECRAFT")
        return this._simpleDispatch('follow', { player }, `Following ${player}.`, "Follow failed.")
    }

    async minecraftActionRetreat(args = {}) {
        const { player } = args
        Logger.info(`Lily is retreating towards ${player ? ` → ${player}` : ''}`, "MINECRAFT")
        return this._simpleDispatch('retreat', { player }, "Retreating.", "Retreat failed.")
    }

    async minecraftActionStop() {
        Logger.info(`Lily stopping`, "MINECRAFT")
        return this._simpleDispatch('stop', {}, "Stopped.", "Stop failed.")
    }

    async minecraftActionBreak(args = {}) {
        const requests = Array.isArray(args.blocks) && args.blocks.length > 0
            ? args.blocks
            : [args]

        const now = Date.now()
        if (now - this.lastMineTime < 9000) {
            this.markFlawed('mine_cooldown')
            return JSON.stringify({ status: "cooldown", message: "Mining too fast! Wait a moment." })
        }
        this.lastMineTime = now

        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        const MAX_AMOUNT = 32
        const summaries = []

        for (const req of requests) {
            const { x, y, z, block, radius } = req
            const hasCoords = x !== undefined && y !== undefined && z !== undefined
            const hasBlock = typeof block === "string" && block.trim().length > 0

            if (!hasCoords && !hasBlock) {
                summaries.push("skipped one entry — no x/y/z or block name given")
                continue
            }

            const amount = Number.isInteger(req.amount) && req.amount > 0
                ? Math.min(req.amount, MAX_AMOUNT)
                : 1

            const label = hasCoords ? `(${x}, ${y}, ${z})` : `"${block}"${radius ? ` radius:${radius}` : ''}`
            Logger.info(`Lily is breaking the block at ${label} x${amount}`, "MINECRAFT")

            const payload = hasCoords ? { x, y, z, amount } : { block, radius, amount }
            const result = stateController.dispatchAction('break', payload)

            summaries.push(result.ok
                ? `${amount > 1 ? `${amount}x ` : ''}${block ?? label}`
                : `${block ?? label} failed: ${result.message ?? 'unknown error'}`)

            if (requests.indexOf(req) < requests.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500))
            }
        }

        return this._ok(`Started mining: ${summaries.join(', ')}.`)
    }

    // ─── Generic Execute ─────────────────────────────────────────────────
    async execute(name, args) {
        // Minecraft actions run in a different loop/context with their own
        // cooldowns and are exempt from the chat-turn tool budget below.
        if (name.startsWith("minecraft_action_")) {
            switch (name) {
                case "minecraft_action_attack": return this.minecraftActionAttack(args)
                case "minecraft_action_eat": return this.minecraftActionEat(args)
                case "minecraft_action_swap_slot": return this.minecraftActionSwapSlot(args)
                case "minecraft_action_drop": return this.minecraftActionDrop(args)
                case "minecraft_action_follow": return this.minecraftActionFollow(args)
                case "minecraft_action_retreat": return this.minecraftActionRetreat(args)
                case "minecraft_action_stop": return this.minecraftActionStop()
                case "minecraft_action_break": return this.minecraftActionBreak(args)
                case "minecraft_action_craft": return this.minecraftActionCraft(args)
                default:
                    Logger.warning(`Unknown: ${name}`, "TOOL")
                    this.markFlawed('unknown_tool')
                    return `Unknown tool: ${name}`
            }
        }

        // Every remaining tool (chat-context: memory, media, web search)
        // spends from the shared total-3-per-turn budget, checked first.
        const totalBlock = this._spendTotal()
        if (totalBlock) return totalBlock

        switch (name) {
            case "web_search": return this.webSearch(args?.query ?? "")
            case "query_memory_database": return this.memoryQuery(args?.query ?? "", {
                daysAgo: args?.days_ago ?? null,
                windowDays: args?.window_days ?? 2,
                daysBack: args?.days_back ?? null
            })
            case "addto_memory_database": return this.memoryAdd(args?.text ?? "", args?.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args?.query ?? "", args?.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args?.query ?? "")
            case "send_meme": return this.searchMeme(args?.query ?? "")
            case "send_gif": return this.searchGif(args?.query ?? "")
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                this.markFlawed('unknown_tool')
                return `Unknown tool: ${name}`
        }
    }
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: `Search everything you know and remember — stored facts about people/the server/yourself (including your OWN opinions, favorites, preferences, and past statements), AND past events/experiences. One search covers both.

                        Check this before stating anything as fact you're not 100% sure of — including questions about yourself.

                        Three ways to use this, pick ONE per call:
                        1. Plain fact/topic lookup — pass query with 2+ keywords, leave days_ago and days_back unset.
                        2. A specific past event at a rough point in time ("10 days ago") — pass query plus days_ago (searches around that point, ± window_days).
                        3. Open-ended recent stretch, no specific topic ("what did we talk about this week") — pass days_back, leave query empty.

                        query must be a real 2+ word string in modes 1 and 2 — never omit it or pass an empty string in those modes, the call will be rejected. A result only counts if it's actually relevant — ignore anything that just shares a keyword. One call is normally enough — only call a second time if the first came back genuinely empty and you have a meaningfully different query to try.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing what to look up. Required (2+ words) for modes 1 and 2. Omit only for mode 3 (days_back)." },
                    days_ago: { type: "number", minimum: 0, description: "Search for a specific past event with a rough time reference. Omit for fact lookups or open-ended recaps." },
                    window_days: { type: "number", minimum: 0, maximum: 30, description: "Only used with days_ago. Tolerance around days_ago. Default 2." },
                    days_back: { type: "number", minimum: 1, description: "Open-ended recap covering from now back this many days, no topic needed." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a NEW fact that has never been stored before — including a new self-opinion you're inventing for the first time. NEVER use this for a fact about a real person (like ShinyShadow_) unless they just told you that fact themselves in this exact message. text is required and must be a real 2+ word sentence, never empty. One call per message is normal — do not chain this with update_ or remove_memory_database unless the user's message actually contains multiple distinct facts. Once it returns success, that fact is stored — reply naturally, don't call it again to 'confirm'.",
            parameters: { type: "object", properties: { text: { type: "string", description: "The full fact to store, as a real sentence. Required, never empty." }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Correct an EXISTING stored fact that query_memory_database just confirmed is wrong. You must call query_memory_database first in this same turn to know the current value — never update a fact you haven't looked up, and never update a fact to the same value it already had. Both query and text are required real strings (2+ words each), never empty. Once it returns success, the correction is saved — reply naturally, don't call it again.",
            parameters: { type: "object", properties: { query: { type: "string", description: "Keywords identifying the existing fact. Required, never empty." }, text: { type: "string", description: "The corrected fact, as a full sentence. Required, never empty." } }, required: ["query", "text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove one specific stored fact about a person, named by that fact's content (e.g. 'IsGone's favorite color'). Only for a concrete fact someone points to as wrong. Do NOT use for vague/joking instructions like 'forget everything' or 'reset' — treat those as banter instead. query is required (2+ words), never empty. Once it returns a result (removed OR not found), that's final — reply naturally, don't call it again with a rephrased query.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific fact to remove, in a few keywords — never a vague phrase like 'everything', never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send ONE reaction GIF. The query argument is REQUIRED and MUST be 2-4 descriptive words describing the reaction/vibe — e.g. 'excited anime girl jumping', 'confused cat blinking', 'dramatic slow clap'. NEVER call this with an empty query, and NEVER pass the user's literal raw message or a single generic word (like just 'happy' or 'lol'). Send at most ONE gif or meme per message, combined — once this returns a url, it's already queued to send, so just write your reply, don't call send_meme too.",
            parameters: { type: "object", properties: { query: { type: "string", description: "A real 2-4 word descriptive search phrase. Required, never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send ONE meme image when it fits the moment. The query argument is REQUIRED and MUST be 2-4 descriptive words that evoke a meme format or reaction — e.g. 'drake approving', 'minecraft players be like', 'surprised pikachu'. NEVER call this with an empty query, and NEVER pass the user's literal raw message or a single generic word. Send at most ONE gif or meme per message, combined — once this returns a url, it's already queued to send, so just write your reply, don't call send_gif too.",
            parameters: { type: "object", properties: { query: { type: "string", description: "A real 2-4 word descriptive search phrase. Required, never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for current information, news, facts, or anything outside your basic knowledge. query is required and must be a real search phrase, never empty. One call is normally enough — only call again if the first result was genuinely off-topic and you have a meaningfully different query.",
            parameters: {
                type: "object",
                properties: { query: { type: "string", description: "A real search query. Required, never empty." } },
                required: ["query"]
            }
        }
    },
    // ─── Minecraft Action Tools ─────────────────────────────────────────
    {
        type: "function",
        function: {
            name: "minecraft_action_attack",
            description: "Attack a specific mob by its id, using a weapon from your hotbar. Once called, you automatically keep chasing/attacking that entity until it dies or you're told to stop. Requires slot (1-36, must hold a weapon: sword/axe/trident) and entityId (from Hostile/Passive Mobs list). If no weapon in hotbar, don't call this — explain in chat instead. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Hotbar slot (1-36) holding the weapon." },
                    entityId: { type: "number", description: "Exact id of the mob to attack." }
                },
                required: ["slot", "entityId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_eat",
            description: "Eat the food item currently held, or swap to a slot first and eat that. Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Optional hotbar slot holding food to swap to first. Omit to eat whatever's held." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_swap_slot",
            description: "Switch your held hotbar slot without using or dropping anything. Requires slot (1-36). Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Hotbar slot to switch to." }
                },
                required: ["slot"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_drop",
            description: "Drop item(s) from a hotbar slot. If no amount given, use 1. Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Hotbar slot to drop from." },
                    amount: { type: "number", minimum: 1, maximum: 64, description: "How many to drop. Default 1 if unspecified." }
                },
                required: ["slot", "amount"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_follow",
            description: "Follow a player continuously until told to stop. Use for any phrasing meaning 'come with/to me' (follow me, come here, stick with me, walk with me). Runs on its own once called — no need to call again while it continues; only a new follow request calls it again. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: { player: { type: "string", description: "Exact name of the player to follow." } },
                required: ["player"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_retreat",
            description: "Flee toward a player for safety. Optional player name — defaults to usual companion if omitted. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: { player: { type: "string", description: "Optional player to retreat toward." } },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_stop",
            description: "Stop all current actions (attacking, following, moving, mining) and stay in place. Once called, idle is the finished state — don't call again just because you're still shown idle later. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    // Schema change — accept either the old flat args OR a `blocks` array
    {
        type: "function",
        function: {
            name: "minecraft_action_break",
            description: "Mine block(s). For a SINGLE block type, pass x/y/z (or block) + amount directly. For MULTIPLE distinct block types in one request (e.g. 'acacia AND oak logs'), pass a `blocks` array instead — one entry per type — so it's ONE call, not one per type. Runs on its own after calling; don't call again for the same request. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate. Omit if using `blocks` or `block`." },
                    y: { type: "number" },
                    z: { type: "number" },
                    block: { type: "string", description: "Block name, alternative to x/y/z." },
                    radius: { type: "number" },
                    amount: { type: "number", minimum: 1, maximum: 32 },
                    blocks: {
                        type: "array",
                        description: "Use for multiple distinct block types in one request. Each entry is the same shape as the flat args (x/y/z or block, plus amount).",
                        items: {
                            type: "object",
                            properties: {
                                x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
                                block: { type: "string" }, radius: { type: "number" },
                                amount: { type: "number", minimum: 1, maximum: 32 }
                            }
                        }
                    }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_craft",
            description: "Craft an item. item is REQUIRED and MUST be the plain Minecraft item id in item_name format — lowercase, underscores, NO 'minecraft:' prefix (that gets added automatically on the Java side). Examples: to craft an iron sword pass item: \"iron_sword\"; iron chestplate → item: \"iron_chestplate\"; sticks → item: \"stick\"; a crafting table itself → item: \"crafting_table\". quantity is optional (default 1) and means how many of the FINISHED item to craft, not ingredient count. This call waits for the actual result — if it succeeds you'll be told what was made, if it fails you'll be told exactly why (missing ingredients, not enough of an ingredient, no crafting table nearby, etc) so you can tell the player what's wrong. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", description: "Item id in item_name format, e.g. 'iron_sword', 'iron_chestplate', 'stick', 'crafting_table'. Required, never empty, never prefixed with 'minecraft:'." },
                    quantity: { type: "number", minimum: 1, maximum: 64, description: "How many of the finished item to craft. Default 1 if unspecified." }
                },
                required: ["item"]
            }
        }
    },
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

export { ToolExecutor, TOOLS, TOOL_NAMES }