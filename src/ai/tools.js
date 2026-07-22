import axios from "axios"
import { log, logError } from './utils.js'
import { tavily } from "@tavily/core"


// ─── Tool Executor ──────────────────────────────────────────────────────
export class ToolExecutor {
    constructor(opts, mcSend = null, getStateController = null) {
        this.opts = opts
        this.mcSend = mcSend
        this.getStateController = getStateController
        this.lastMineTime = 0
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

    async memoryAdd(factText, source = "user") {
        log(`💾 [MEMORY ADD] "${factText.slice(0, 100)}${factText.length > 100 ? '...' : ''}"`)
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`, { text: factText, source }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store information." })
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        log(`✏️ [MEMORY UPDATE] "${searchQuery}" → "${updatedText.slice(0, 100)}"`)
        try {
            const { data } = await axios.put(`${this.opts.memoryDbUrl}/update_fact`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY UPDATE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to update entry." })
        }
    }

    async memoryRemove(searchQuery) {
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
            return JSON.stringify({ status: "error", message: "Failed to remove entries." })
        }
    }

    async addEpisodicMemory({ summary, raw, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation_batch" }) {
        log(`🎞️ [EPISODIC BATCH ADD] "${summary.slice(0, 100)}${summary.length > 100 ? '...' : ''}"`)
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_episodic`, {
                summary, raw, participants, emotions, importance, channel, source,
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[EPISODIC BATCH ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store episodic memory." })
        }
    }

    async searchGif(query) {
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
            return JSON.stringify({ status: "ok", url })
        } catch (err) {
            logError(`[GIF] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to search for GIF." })
        }
    }

    async webSearch(query) {
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

    async searchMeme(query) {
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
            return JSON.stringify({ status: "ok", url })
        } catch (err) {
            logError(`[MEME] ${err.message}`)
            if (err.response) logError(`[MEME RESPONSE] ${JSON.stringify(err.response.data)}`)
            return JSON.stringify({ status: "error", message: "Failed to search for meme." })
        }
    }

    // ─── Minecraft Actions ──────────────────────────────────────────────────────
    async minecraftActionAttack(args = {}) {
        const { slot, entityId } = args
        if (!slot || slot < 1 || slot > 36) {
            return JSON.stringify({ status: "error", message: "slot (1-36) required." })
        }
        if (entityId === undefined || entityId === null) {
            return JSON.stringify({ status: "error", message: "entityId required — pick one from the Hostile/Passive Mobs list." })
        }
        log(`⚔️ [MINECRAFT] attack slot:${slot} target:${entityId}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('attack', { slot, entityId })
        return result.ok
            ? JSON.stringify({ status: "ok", message: "Engaging target." })
            : JSON.stringify({ status: "error", message: result.message ?? "Attack failed." })
    }

    async minecraftActionEat(args = {}) {
        const { slot } = args
        log(`🍎 [MINECRAFT] eat${slot ? ` slot:${slot}` : ''}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('use', { slot })  // Java side still expects 'use' — don't rename the dispatched action label
        return result.ok
            ? JSON.stringify({ status: "ok", message: "Ate." })
            : JSON.stringify({ status: "error", message: result.message ?? "Eat failed." })
    }

    async minecraftActionSwapSlot(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 36) {
            return JSON.stringify({ status: "error", message: "slot (1-36) required." })
        }
        log(`🔄 [MINECRAFT] swap_slot → ${slot}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('swap_slot', { slot })
        return result.ok
            ? JSON.stringify({ status: "ok", message: `Swapped to slot ${slot}.` })
            : JSON.stringify({ status: "error", message: result.message ?? "Swap failed." })
    }
    // Drops `amount` items from `slot`. The Java side only exposes a single-item
    // "drop once" command, so amount > 1 is achieved by repeating that command
    // with a short delay between each drop rather than a native count-based
    // command. If the mod ever adds a count-based drop command
    // (e.g. "drop <n>"), swap this loop for a single dispatchAction call.
    async minecraftActionDrop(args = {}) {
        const { slot, amount } = args
        if (!slot || slot < 1 || slot > 36) {
            return JSON.stringify({ status: "error", message: "slot (1-36) required." })
        }
        const count = Number.isInteger(amount) && amount > 0 ? amount : 1
        const MAX_DROPS_PER_CALL = 64   // sanity cap so a bad/huge amount can't spam commands forever

        if (count > MAX_DROPS_PER_CALL) {
            return JSON.stringify({ status: "error", message: `Can't drop more than ${MAX_DROPS_PER_CALL} at once.` })
        }

        log(`📤 [MINECRAFT] drop → slot:${slot} amount:${count}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }

        for (let i = 0; i < count; i++) {
            const result = stateController.dispatchAction('drop', { slot })
            if (!result.ok) {
                return JSON.stringify({
                    status: "error",
                    message: result.message ?? `Drop failed after ${i} of ${count} item(s).`
                })
            }
            if (i < count - 1) {
                await new Promise(resolve => setTimeout(resolve, 250))  // brief gap between repeated drops
            }
        }

        return JSON.stringify({ status: "ok", message: `Dropped ${count} item(s) from slot ${slot}.` })
    }
    async minecraftActionFollow(args = {}) {
        const { player } = args
        if (!player) {
            return JSON.stringify({ status: "error", message: "player name required." })
        }
        log(`🚶 [MINECRAFT] follow → ${player}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('follow', { player })
        return result.ok
            ? JSON.stringify({ status: "ok", message: `Following ${player}.` })
            : JSON.stringify({ status: "error", message: result.message ?? "Follow failed." })
    }

    async minecraftActionRetreat(args = {}) {
        const { player } = args
        log(`🏃 [MINECRAFT] retreat${player ? ` → ${player}` : ''}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('retreat', { player })
        return result.ok
            ? JSON.stringify({ status: "ok", message: "Retreating." })
            : JSON.stringify({ status: "error", message: result.message ?? "Retreat failed." })
    }

    async minecraftActionStop() {
        log(`✋ [MINECRAFT] stop`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('stop', {})
        return result.ok
            ? JSON.stringify({ status: "ok", message: "Stopped." })
            : JSON.stringify({ status: "error", message: result.message ?? "Stop failed." })
    }

    // Unified break: exact coords (from Blocks of Interest) OR a block name to
    // search for. `amount` is forwarded as-is — the chaining to the next
    // closest same-type block after each break happens client-side (Java
    // MiningManager + the block name), not here. This call just kicks off
    // the first target.
    async minecraftActionBreak(args = {}) {
        const { x, y, z, block, radius } = args
        const hasCoords = x !== undefined && y !== undefined && z !== undefined
        const hasBlock = typeof block === "string" && block.trim().length > 0

        if (!hasCoords && !hasBlock) {
            return JSON.stringify({ status: "error", message: "Either x/y/z (from Blocks of Interest) or a block name is required." })
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
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }

        const payload = hasCoords ? { x, y, z, amount } : { block, radius, amount }
        const result = stateController.dispatchAction('break', payload)
        await new Promise(resolve => setTimeout(resolve, 1500))

        return result.ok
            ? JSON.stringify({ status: "ok", message: amount > 1 ? `Started mining ${amount}x.` : "Started mining." })
            : JSON.stringify({ status: "error", message: result.message ?? "Break failed." })
    }


    // ─── Generic Execute ─────────────────────────────────────────────────────────

    async execute(name, args) {
        switch (name) {
            case "web_search": return this.webSearch(args.query ?? "")
            case "query_memory_database": return this.memoryQuery(args.query ?? "", {
                daysAgo: args.days_ago ?? null,
                windowDays: args.window_days ?? 2,
                daysBack: args.days_back ?? null
            })
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "send_meme": return this.searchMeme(args.query ?? "")
            case "send_gif": return this.searchGif(args.query ?? "")
            // Minecraft actions
            case "minecraft_action_attack": return this.minecraftActionAttack(args)
            case "minecraft_action_eat": return this.minecraftActionEat(args)
            case "minecraft_action_swap_slot": return this.minecraftActionSwapSlot(args)
            case "minecraft_action_drop": return this.minecraftActionDrop(args)
            case "minecraft_action_follow": return this.minecraftActionFollow(args)
            case "minecraft_action_retreat": return this.minecraftActionRetreat(args)
            case "minecraft_action_stop": return this.minecraftActionStop()
            case "minecraft_action_break": return this.minecraftActionBreak(args)
           // case "minecraft_action_break_unlisted": return this.minecraftActionBreakClosestGeneric(args)
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

                        Check this any time you're about to state something as fact and aren't 100% sure you've said it before — including questions about yourself: "what's your favorite ___", "do you like ___". Pick something in-character and store it with addto_memory_database if nothing comes back, so you're consistent next time.

                        Three ways to use this, pick ONE per call:
                        1. Plain fact/topic lookup — pass query with 2+ keywords, leave days_ago and days_back unset.
                        2. A specific past event at a rough point in time ("10 days ago") — pass query plus days_ago (searches around that point, ± window_days).
                        3. Open-ended recent stretch, no specific topic ("what did we talk about this week") — pass days_back, leave query empty.

                        A result only counts if it's actually relevant — ignore anything that just shares a keyword.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing what to look up. Only needed for modes 1 and 2." },
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
            description: "Store a new factual entry — including a new opinion/preference you just gave about yourself for the first time. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string" }, text: { type: "string" } }, required: ["query", "text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove a specific stored fact about a person, named by that fact's content (e.g. 'IsGone's favorite color'). Only for a concrete fact someone points to as wrong. Do NOT use for vague/joking instructions like 'forget everything' or 'reset' — treat those as banter instead.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific fact to remove, in a few keywords — never a vague phrase like 'everything'." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send a GIF. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for current information, news, facts, or anything outside your basic knowledge.",
            parameters: {
                type: "object",
                properties: { query: { type: "string", description: "Search query" } },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send a meme image when one would fit the moment. Use descriptive terms like 'drake approving'. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    // ─── Minecraft Action Tools ────────────────────────────────
    // Every tool below is called AT MOST ONCE per player message, only for actions that
    // message actually asked for. Their effects complete instantly or continue on their
    // own in-game; seeing that continuation on a later state update is not a reason to
    // call the same tool again. Only a NEW player message can trigger another call.
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
            name: "minecraft_action_swap_slot",
            description: "Switch to a specific hotbar slot. Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: { slot: { type: "number", minimum: 1, maximum: 36, description: "Slot to switch to." } },
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