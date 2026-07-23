import axios from "axios"
import { log, logError } from './utils.js'
import { tavily } from "@tavily/core"

// ─── Turn budget limits ─────────────────────────────────────────────────
// Single source of truth for every per-turn cap. Update here, nowhere else.
const LIMITS = {
    memoryQuery: 2,   // query_memory_database
    memoryWrite: 1,   // addto / update / remove_memory_database — shared slot
    media: 1,         // send_gif / send_meme — shared slot
    webSearch: 2,     // web_search
    total: 3,         // ANY tool calls combined, hard ceiling
    narration: 1,      // max times we tolerate the model narrating instead of calling, before we force a tool-free reply
    badArgs: 1,        // max times we tolerate a malformed/empty-argument call before forcing a tool-free reply
}

// ─── Tool Executor ──────────────────────────────────────────────────────
export class ToolExecutor {
    constructor(opts, mcSend = null, getStateController = null) {
        this.opts = opts
        this.mcSend = mcSend
        this.getStateController = getStateController
        this.lastMineTime = 0

        // ── Per-turn usage guards ──────────────────────────────────────
        // Call resetTurn() from the loop code once at the START of handling
        // each new incoming user message (NOT per loop iteration within that
        // turn).
        this.turnUsage = { memoryWrite: 0, media: 0, memoryQuery: 0, webSearch: 0, total: 0 }
        this.turnHasQueriedMemory = false

        // ── Hard-stop state ─────────────────────────────────────────────
        // THIS IS THE FIX for the "15 loops in one turn" bug. Previously,
        // a blocked tool result (with stop:true baked into the JSON string)
        // was just fed back to the model as a tool result and the model was
        // trusted to read "stop" and comply. An 8B model under load will
        // frequently NOT comply — it just tries a different tool name next.
        //
        // The loop code MUST check `executor.shouldHardStop()` after EVERY
        // tool execution (not just parse the JSON) and, if true, break out
        // of the tool-calling loop entirely and force a final generation
        // with tools disabled / removed from the request, so the model is
        // structurally incapable of attempting another call. Do not feed
        // the model another round with tools available once this is true.
        //
        //     const result = await toolExecutor.execute(name, args)
        //     messages.push({ role: "tool", tool_call_id: id, content: result })
        //     if (toolExecutor.shouldHardStop()) {
        //         const final = await callModel(messages /* no `tools` field */)
        //         return final
        //     }
        //
        // If this check isn't present in the outer loop, every hard-stop
        // below is purely cosmetic and the model will keep being invited
        // back into the tool-calling loop indefinitely.
        this.turnHardStop = false

        // ── Narration-recovery state ────────────────────────────────────
        // The loop code detects narration (model described a tool call in
        // prose instead of emitting a real one) and should call
        // recordNarration() when that happens, then check the return value.
        // Once the narration budget is exhausted, the loop should force a
        // tool-free final generation instead of re-prompting and hoping.
        this.turnNarrationCount = 0

        // ── Bad-argument-recovery state ─────────────────────────────────
        // Fixes the "model keeps calling tools with blank/garbage args"
        // spiral. A single malformed call (empty query/text, etc.) gets a
        // soft error inviting a real retry. A SECOND malformed call in the
        // same turn means the model is thrashing, not correcting itself —
        // at that point we hard-stop instead of letting it keep trying,
        // since a bad-args error consumes a total-budget slot but NOT its
        // tool-specific slot, and would otherwise let the model retry
        // near-indefinitely within just the 3-call total ceiling.
        this.turnBadArgs = 0
    }

    resetTurn() {
        this.turnUsage = { memoryWrite: 0, media: 0, memoryQuery: 0, webSearch: 0, total: 0 }
        this.turnHasQueriedMemory = false
        this.turnHardStop = false
        this.turnNarrationCount = 0
        this.turnBadArgs = 0
    }

    // Call this from the outer loop right after ANY tool execution.
    // Returns true if the loop must stop calling tools and force a final
    // visible reply (with tools removed from the next request payload).
    shouldHardStop() {
        return this.turnHardStop
    }

    // Call this from the outer loop when the model produces prose that
    // describes/announces a tool call instead of emitting a real one.
    // Returns true once narration has happened too many times and the loop
    // should force a tool-free final generation instead of retrying.
    recordNarration() {
        this.turnNarrationCount++
        if (this.turnNarrationCount > LIMITS.narration) {
            this.turnHardStop = true
            return true
        }
        return false
    }

    // ─── Shared helpers ──────────────────────────────────────────────────
    _blocked(message) {
        this.turnHardStop = true
        return JSON.stringify({ status: "blocked", stop: true, message })
    }

    _err(message) {
        return JSON.stringify({ status: "error", message })
    }

    _ok(message, extra = {}) {
        return JSON.stringify({ status: "ok", message, ...extra })
    }

    // Every tool call attempt (successful, blocked, or errored) counts
    // against the total-3 ceiling. Once hit, sets turnHardStop so the loop
    // can break unconditionally instead of relying on the model to comply.
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

    // Shared arg validator for any tool that takes a free-text search query.
    // Fixes the "model called the tool with empty/garbage arguments" bug:
    // instead of silently searching for "" and getting nothing (which reads
    // to the model like the tool is broken, so it thrashes trying other
    // tools), we reject immediately with an explicit instruction.
    //
    // First offense in a turn: soft error, real retry still possible within
    // the total budget. Second offense in the SAME turn: treat it as a hard
    // stop — the model is not converging on a real value, so stop inviting
    // more attempts and force it to answer with what it has.
    _requireQuery(query, minWords, exampleHint) {
        const trimmed = (query ?? "").trim()
        if (!trimmed || trimmed.split(/\s+/).length < minWords) {
            this.turnBadArgs++
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
        log(`🔍 [WIKI] "${query}"`)
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout
            })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No relevant information found in the wiki."
            return text
        } catch (err) {
            logError(`[WIKI] ${err.message}`)
            return "No relevant information found in the wiki right now."
        }
    }

    async memoryQuery(query, { daysAgo = null, windowDays = 2, daysBack = null } = {}) {
        if (this.turnUsage.memoryQuery >= LIMITS.memoryQuery) {
            return this._blocked(
                `STOP. You have already searched memory ${this.turnUsage.memoryQuery} time(s) this turn — that is the maximum (${LIMITS.memoryQuery}). ` +
                `Do not call query_memory_database again this turn for any reason. ` +
                `If you didn't find what you needed, say so in character or move on — do not retry with different keywords. Write your visible reply now.`
            )
        }

        // Mode 3 (open-ended recap) is exempt from the query-text requirement.
        if (daysBack === null) {
            const argErr = this._requireQuery(query, 2, "shinyshadow_ favorite food")
            if (argErr) return argErr
        }

        this.turnUsage.memoryQuery++
        this.turnHasQueriedMemory = true

        if (daysBack !== null) {
            log(`🧠 [MEMORY QUERY] recency-only daysBack=${daysBack}`)
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/recent`, {
                    limit: 10, days_back: daysBack, min_importance: 0.3
                }, { timeout: this.opts.dbTimeout })

                if (!data?.results?.length) return `No memories found from the last ${daysBack} days.`

                return data.results.map(e => {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return e.type === "episodic" ? `[${date}] ${e.content}` : `[${date}] ${e.text}`
                }).join("\n")
            } catch (err) {
                logError(`[MEMORY QUERY] ${err.message}`)
                return "No relevant information found in memory."
            }
        }

        log(`🧠 [MEMORY QUERY] "${query}" daysAgo=${daysAgo ?? "any"}`)
        try {
            const k = daysAgo !== null ? 25 : 10
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query, k, min_score: this.opts.memoryQueryMinScore
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) return "No relevant information found in memory."

            let results = data.results

            if (daysAgo !== null) {
                const nowSecs = Date.now() / 1000
                const targetTs = nowSecs - daysAgo * 86400
                const windowSecs = Math.max(windowDays, 0) * 86400
                const lo = targetTs - windowSecs
                const hi = targetTs + windowSecs
                results = results.filter(e => e.timestamp >= lo && e.timestamp <= hi)
                if (!results.length) return `No relevant information found from around ${daysAgo} days ago.`
            }

            results = results.slice(0, 10)
            return results.map(e => {
                if (e.type === "episodic") {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return `[${date}] ${e.content}`
                }
                return e.text
            }).join("\n")
        } catch (err) {
            logError(`[MEMORY QUERY] ${err.message}`)
            return "No relevant information found in memory."
        }
    }

    // Shared gate for add/update/remove — they all spend the same 1/turn slot.
    _memoryWriteGuard() {
        if (this.turnUsage.memoryWrite >= LIMITS.memoryWrite) {
            return this._blocked(
                `STOP. You have already made a memory write this turn (add, update, and remove all share ONE slot per turn). ` +
                `Do not call addto_memory_database, update_memory_database, or remove_memory_database again for any reason, even a different fact. ` +
                `Write your visible in-character reply to the user now.`
            )
        }
        return null
    }

    async memoryAdd(factText, source = "user") {
        const guard = this._memoryWriteGuard()
        if (guard) return guard
        const argErr = this._requireQuery(factText, 2, "ShinyShadow_ said their favorite color is teal")
        if (argErr) return argErr
        this.turnUsage.memoryWrite++

        log(`💾 [MEMORY ADD] "${factText.slice(0, 100)}${factText.length > 100 ? '...' : ''}"`)
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`, { text: factText, source }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY ADD] ${err.message}`)
            return this._err("Failed to store information.")
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        const guard = this._memoryWriteGuard()
        if (guard) return guard
        if (!this.turnHasQueriedMemory) {
            return this._blocked(
                `You haven't looked up the existing fact yet this turn. You must call query_memory_database first to confirm what it currently says — ` +
                `never guess at the old value. Do not call update_memory_database again until you've queried. If you don't actually need to correct anything, skip this and reply now.`
            )
        }
        const argErr = this._requireQuery(searchQuery, 2, "shinyshadow_ favorite color") || this._requireQuery(updatedText, 2, "ShinyShadow_'s favorite color is now teal")
        if (argErr) return argErr
        // Reject no-op calls: same text passed as both the lookup query and the replacement.
        if (searchQuery.trim().toLowerCase() === updatedText.trim().toLowerCase()) {
            return JSON.stringify({
                status: "noop",
                message: "The old and new text are identical — there's nothing to update. If you don't actually know the current value, don't call this tool at all. Write your reply now."
            })
        }
        this.turnUsage.memoryWrite++

        log(`✏️ [MEMORY UPDATE] "${searchQuery}" → "${updatedText.slice(0, 100)}"`)
        try {
            const { data } = await axios.put(`${this.opts.memoryDbUrl}/update_fact`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY UPDATE] ${err.message}`)
            return this._err("Failed to update entry.")
        }
    }

    async memoryRemove(searchQuery) {
        const guard = this._memoryWriteGuard()
        if (guard) return guard
        const argErr = this._requireQuery(searchQuery, 2, "IsGone favorite color")
        if (argErr) return argErr
        this.turnUsage.memoryWrite++

        log(`🗑️ [MEMORY REMOVE] "${searchQuery}"`)
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/remove_by_query`, {
                query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore, types: ["fact"]
            }, { timeout: this.opts.dbTimeout })
            if (data?.status !== "ok" || !data?.removed?.length) {
                return JSON.stringify({ status: "not_found", message: "No matching memories found." })
            }
            return JSON.stringify({ status: data.status, message: `Removed: ${data.removed.join(", ")}`, removed: data.removed })
        } catch (err) {
            logError(`[MEMORY REMOVE] ${err.message}`)
            return this._err("Failed to remove entries.")
        }
    }

    async addEpisodicMemory({ summary, raw, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation_batch" }) {
        // Not part of the live chat turn budget — called out-of-band by a
        // batch/summarizer process, not by the model mid-conversation.
        log(`🎞️ [EPISODIC BATCH ADD] "${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}"`)
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_episodic`, {
                summary, raw, participants, emotions, importance, channel, source,
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[EPISODIC BATCH ADD] ${err.message}`)
            return this._err("Failed to store episodic memory.")
        }
    }

    // Shared gate for gif/meme — they share one media slot per turn.
    _mediaGuard() {
        if (this.turnUsage.media >= LIMITS.media) {
            return this._blocked(
                `STOP. You have already sent a gif or meme this turn (send_gif and send_meme share ONE slot per turn). ` +
                `Do not call either tool again. You already have media queued up — write your visible in-character reply to go with it now.`
            )
        }
        return null
    }

    async searchGif(query) {
        const guard = this._mediaGuard()
        if (guard) return guard
        const argErr = this._requireQuery(query, 2, "excited anime girl jumping")
        if (argErr) return argErr
        this.turnUsage.media++

        log(`🎞️ [GIF] "${query}"`)
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })
            const results = data?.data?.data ?? []
            if (!results.length) return JSON.stringify({ status: "not_found", message: "No GIF found." })
            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) return JSON.stringify({ status: "not_found", message: "No GIF URL." })
            log(`✅ [GIF] Found`)
            return this._ok(null, { url })
        } catch (err) {
            logError(`[GIF] ${err.message}`)
            return this._err("Failed to search for GIF.")
        }
    }

    async searchMeme(query) {
        const guard = this._mediaGuard()
        if (guard) return guard
        const argErr = this._requireQuery(query, 2, "drake approving")
        if (argErr) return argErr
        this.turnUsage.media++

        log(`🎭 [MEME] "${query}"`)
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/static-memes/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) return JSON.stringify({ status: "not_found", message: "No meme found." })

            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) return JSON.stringify({ status: "not_found", message: "No meme URL." })

            log(`✅ [MEME] Found`)
            return this._ok(null, { url })
        } catch (err) {
            logError(`[MEME] ${err.message}`)
            if (err.response) logError(`[MEME RESPONSE] ${JSON.stringify(err.response.data)}`)
            return this._err("Failed to search for meme.")
        }
    }

    async webSearch(query) {
        if (this.turnUsage.webSearch >= LIMITS.webSearch) {
            this.turnHardStop = true
            return JSON.stringify({
                status: "blocked", stop: true,
                message: `STOP. You have already used web_search ${this.turnUsage.webSearch} time(s) this turn — that is the maximum (${LIMITS.webSearch}). ` +
                    `Do not call web_search again this turn. Answer the user now using whatever you already found.`
            })
        }
        const argErr = this._requireQuery(query, 2, "current Minecraft version")
        if (argErr) return argErr
        this.turnUsage.webSearch++

        log(`🌐 [WEB SEARCH] "${query}"`)
        try {
            const client = tavily({ apiKey: process.env.TAVILY_API_KEY })
            const response = await client.search(query, {
                maxResults: 5,
                searchDepth: "basic",
            })

            const results = response?.results ?? []
            if (!results.length) return "No results found."

            return results.map(r =>
                `**${r.title}**\n${r.url}\n${r.content ?? ""}`
            ).join("\n\n")
        } catch (err) {
            logError(`[WEB SEARCH] ${err.message}`)
            return "Web search failed."
        }
    }

    // ─── Minecraft Actions ───────────────────────────────────────────────
    // These are NOT part of the chat turn budget above (they run in the
    // Minecraft-agent context, not the Discord chat context, and have their
    // own per-action cooldowns like lastMineTime).
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
        log(`⚔️ [MINECRAFT] attack slot:${slot} target:${entityId}`)
        return this._simpleDispatch('attack', { slot, entityId }, "Engaging target.", "Attack failed.")
    }

    async minecraftActionEat(args = {}) {
        const { slot } = args
        log(`🍎 [MINECRAFT] eat${slot ? ` slot:${slot}` : ''}`)
        return this._simpleDispatch('use', { slot }, "Ate.", "Eat failed.")
    }

    async minecraftActionSwapSlot(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 36) {
            return this._err("slot (1-36) required.")
        }
        log(`🔄 [MINECRAFT] swap_slot → ${slot}`)
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

        log(`📤 [MINECRAFT] drop → slot:${slot} amount:${count}`)
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
        log(`🚶 [MINECRAFT] follow → ${player}`)
        return this._simpleDispatch('follow', { player }, `Following ${player}.`, "Follow failed.")
    }

    async minecraftActionRetreat(args = {}) {
        const { player } = args
        log(`🏃 [MINECRAFT] retreat${player ? ` → ${player}` : ''}`)
        return this._simpleDispatch('retreat', { player }, "Retreating.", "Retreat failed.")
    }

    async minecraftActionStop() {
        log(`✋ [MINECRAFT] stop`)
        return this._simpleDispatch('stop', {}, "Stopped.", "Stop failed.")
    }

    async minecraftActionBreak(args = {}) {
        const { x, y, z, block, radius } = args
        const hasCoords = x !== undefined && y !== undefined && z !== undefined
        const hasBlock = typeof block === "string" && block.trim().length > 0

        if (!hasCoords && !hasBlock) {
            return this._err("Either x/y/z (from Blocks of Interest) or a block name is required.")
        }

        const MAX_AMOUNT = 32
        const amount = Number.isInteger(args.amount) && args.amount > 0 ? Math.min(args.amount, MAX_AMOUNT) : 1

        const now = Date.now()
        if (now - this.lastMineTime < 9000) {
            return JSON.stringify({ status: "cooldown", message: "Mining too fast! Wait a moment." })
        }
        this.lastMineTime = now

        log(`⛏️ [MINECRAFT] break → ${hasCoords ? `(${x}, ${y}, ${z})` : `"${block}"${radius ? ` radius:${radius}` : ''}`} x${amount}`)

        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        const payload = hasCoords ? { x, y, z, amount } : { block, radius, amount }
        const result = stateController.dispatchAction('break', payload)
        await new Promise(resolve => setTimeout(resolve, 1500))

        return result.ok
            ? this._ok(amount > 1 ? `Started mining ${amount}x.` : "Started mining.")
            : this._err(result.message ?? "Break failed.")
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
                default:
                    console.warn(`⚠️ [TOOL] Unknown: ${name}`)
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
                console.warn(`⚠️ [TOOL] Unknown: ${name}`)
                return `Unknown tool: ${name}`
        }
    }
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export const TOOLS = [
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

                        query must be a real 2+ word string in modes 1 and 2 — never omit it or pass an empty string in those modes, the call will be rejected. A result only counts if it's actually relevant — ignore anything that just shares a keyword. Max 2 calls per turn — the 3rd call will be blocked.`,
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
            description: "Store a NEW fact that has never been stored before — including a new self-opinion you're inventing for the first time. NEVER use this for a fact about a real person (like ShinyShadow_) unless they just told you that fact themselves in this exact message. text is required and must be a real 2+ word sentence, never empty. Max ONE memory write (add/update/remove, combined) per turn — do not call this after already calling update_ or remove_memory_database. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { text: { type: "string", description: "The full fact to store, as a real sentence. Required, never empty." }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Correct an EXISTING stored fact that query_memory_database just confirmed is wrong. You must call query_memory_database first in this same turn to know the current value — never update a fact you haven't looked up, and never update a fact to the same value it already had. Both query and text are required real strings (2+ words each), never empty. Max ONE memory write (add/update/remove, combined) per turn — do not call this after already calling addto_ or remove_memory_database. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string", description: "Keywords identifying the existing fact. Required, never empty." }, text: { type: "string", description: "The corrected fact, as a full sentence. Required, never empty." } }, required: ["query", "text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove one specific stored fact about a person, named by that fact's content (e.g. 'IsGone's favorite color'). Only for a concrete fact someone points to as wrong. Do NOT use for vague/joking instructions like 'forget everything' or 'reset' — treat those as banter instead. query is required (2+ words), never empty. Max ONE memory write (add/update/remove, combined) per turn — do not call this after already calling addto_ or update_memory_database.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific fact to remove, in a few keywords — never a vague phrase like 'everything', never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send ONE reaction GIF. The query argument is REQUIRED and MUST be 2-4 descriptive words describing the reaction/vibe — e.g. 'excited anime girl jumping', 'confused cat blinking', 'dramatic slow clap'. NEVER call this with an empty query, and NEVER pass the user's literal raw message or a single generic word (like just 'happy' or 'lol'). Max ONE media tool (send_gif OR send_meme, combined) per turn — do not call send_meme after this. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string", description: "A real 2-4 word descriptive search phrase. Required, never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send ONE meme image when it fits the moment. The query argument is REQUIRED and MUST be 2-4 descriptive words that evoke a meme format or reaction — e.g. 'drake approving', 'minecraft players be like', 'surprised pikachu'. NEVER call this with an empty query, and NEVER pass the user's literal raw message or a single generic word. Max ONE media tool (send_gif OR send_meme, combined) per turn — do not call send_gif after this. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string", description: "A real 2-4 word descriptive search phrase. Required, never empty." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for current information, news, facts, or anything outside your basic knowledge. query is required and must be a real search phrase, never empty. Max 2 calls per turn — the 3rd call will be blocked.",
            parameters: {
                type: "object",
                properties: { query: { type: "string", description: "A real search query. Required, never empty." } },
                required: ["query"]
            }
        }
    },
    // ─── Minecraft Action Tools (unchanged) ────────────────────────────────
    {
        type: "function",
        function: {
            name: "minecraft_action_attack",
            description: "Attack a specific mob by its id, using a weapon from your hotbar. Once called, you automatically keep chasing/attacking that entity until it dies or you're told to stop. Requires slot (1-36, must hold a weapon: sword/axe/trident/bow) and entityId (from Hostile/Passive Mobs list). If no weapon in hotbar, don't call this — explain in chat instead. Reply naturally after; never mention the tool.",
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
    {
        type: "function",
        function: {
            name: "minecraft_action_break",
            description: "Mine block(s). Check Blocks of Interest first (one entry per type, closest match, with x/y/z), amount (max 32) breaks several of that type in one call — it auto-retargets the next closest match after each one, so this call is not repeated per block. Runs on its own after one call; only call again for a genuinely new/different request or a clearly failed attempt. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate, copied exactly from a Blocks of Interest entry. Omit if using block instead." },
                    y: { type: "number", description: "Y coordinate, copied exactly from a Blocks of Interest entry." },
                    z: { type: "number", description: "Z coordinate, copied exactly from a Blocks of Interest entry." },
                    amount: { type: "number", minimum: 1, maximum: 32, description: "How many blocks of this type to break total. Defaults to 1." }
                },
                required: []
            }
        }
    }
]
export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))