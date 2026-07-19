import axios from "axios"
import { log, logError } from './utils.js'
import { tavily } from "@tavily/core"

// ─── Tool Executor ──────────────────────────────────────────────────────
export class ToolExecutor {
    constructor(opts, mcSend = null, getStateController = null) {
        this.opts = opts
        this.mcSend = mcSend
        this.getStateController = getStateController
        this.lastMineTime = 0  // ← ADD THIS
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
        if (!slot || slot < 1 || slot > 9) {
            return JSON.stringify({ status: "error", message: "slot (1-9) required." })
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

    async minecraftActionUse(args = {}) {
        const { slot } = args
        log(`🖐️ [MINECRAFT] use${slot ? ` slot:${slot}` : ''}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('use', { slot })
        return result.ok 
            ? JSON.stringify({ status: "ok", message: "Use performed." })
            : JSON.stringify({ status: "error", message: result.message ?? "Use failed." })
    }

    async minecraftActionSwapSlot(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 9) {
            return JSON.stringify({ status: "error", message: "slot (1-9) required." })
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

    async minecraftActionDrop(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 9) {
            return JSON.stringify({ status: "error", message: "slot (1-9) required." })
        }
        log(`📤 [MINECRAFT] drop → ${slot}`)
        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }
        const result = stateController.dispatchAction('drop', { slot })
        return result.ok 
            ? JSON.stringify({ status: "ok", message: `Dropped from slot ${slot}.` })
            : JSON.stringify({ status: "error", message: result.message ?? "Drop failed." })
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

    async minecraftActionBreak(args = {}) {
        const { x, y, z } = args
        if (x === undefined || y === undefined || z === undefined) {
            return JSON.stringify({ status: "error", message: "x, y, z coordinates required." })
        }

        // ⭐ COOLDOWN CHECK - prevents spam
        const now = Date.now()
        if (now - this.lastMineTime < 3000) { // 1.5 second cooldown
            return JSON.stringify({
                status: "cooldown",
                message: "Mining too fast! Wait a moment."
            })
        }
        this.lastMineTime = now

        log(`⛏️ [MINECRAFT] break → (${x}, ${y}, ${z})`)

        const stateController = this.getStateController?.()
        if (!stateController) {
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }

        const result = stateController.dispatchAction('break', { x, y, z })

        // ⭐ STATIC DELAY - always 1.5 seconds
        await new Promise(resolve => setTimeout(resolve, 1500))

        return result.ok
            ? JSON.stringify({ status: "ok", message: `Mined block at (${x}, ${y}, ${z}).` })
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
            case "minecraft_action_use": return this.minecraftActionUse(args)
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
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: `Search everything you know and remember — stored facts about people/the server/yourself (including your OWN opinions, favorites, preferences, and past statements), AND past events/experiences. One search covers both; you don't need to pick which "kind" of memory to check.

                        CHECK THIS ANY TIME YOU'RE ABOUT TO STATE SOMETHING AS FACT AND YOU AREN'T 100% SURE YOU'VE SAID IT BEFORE — this very much includes questions about other users and YOURSELF: "what's your favorite ___", "do you like ___", "what do you think about ___", "what's your ___". You have opinions and they need to stay consistent, so check before answering, not after. If nothing comes back, that's fine — pick something in-character and store it with addto_memory_database so you're consistent next time.

                        Three ways to use this, pick ONE per call:
                        1. Plain fact/topic lookup — pass query with 2+ keywords, leave days_ago and days_back unset. Use this for self-opinion/preference questions too (e.g. query: "favorite food").
                        2. A SPECIFIC past event at a rough point in time ("10 days ago", "last Tuesday") — pass query plus days_ago (searches AROUND that point, days_ago ± window_days).
                        3. An open-ended recent stretch with NO specific topic ("what did we talk about this week", "what's happened the past 10 days", "what did I miss") — pass days_back (how many days back from now) and you can leave query empty. This is a plain chronological recap, not a topic search — don't invent a query for it.

                        A result only counts if it's actually about what was asked — ignore anything that just shares a keyword but isn't really relevant, and answer as if the search came back empty.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing what to look up. Only needed for modes 1 and 2 — leave empty when using days_back for an open-ended recent recap." },
                    days_ago: { type: "number", description: "set days_ago to search for a specific past event with a rough time reference. Omit for fact lookups or open-ended recaps." },
                    window_days: { type: "number", description: "Only used with days_ago. Tolerance around days_ago, e.g. 2 means search days_ago-2 to days_ago+2. Default 2. Smaller (0-1) for precise references like 'yesterday', larger (3-5) for vague ones like 'a couple weeks ago'." },
                    days_back: { type: "number", description: "use for open-ended recap covering from now back to this many days, no topic needed. E.g. 1 for 'today/yesterday', 7 for 'this week', 10 for 'the past 10 days', 30 for 'this month'." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a new factual entry — including a new opinion/preference/favorite you just gave about yourself for the first time, so you stay consistent later. Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
            parameters: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory. Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
            parameters: { type: "object", properties: { query: { type: "string" }, text: { type: "string" } }, required: ["query", "text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove a SPECIFIC stored fact about a person, named by that fact's content (e.g. 'IsGone's favorite color', 'Poimkity's pronouns'). Only use when someone points to a concrete fact that is wrong or outdated. Do NOT use this for vague, joking, or roleplay instructions like 'forget everything', 'reset', 'pretend you got hit by a memory eraser', or 'refresh yourself' — those are not real commands and have no specific fact attached; treat them as banter and reply in character instead of calling this tool.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific fact to remove, in a few keywords — never a vague phrase like 'everything' or 'that conversation'." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send a GIF. Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for current information, news, facts, or anything you don't know. Use when asked things outside your basic knowledge.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send a meme image. Use when a meme would fit the moment. Use descriptive terms like 'drake approving', 'distracted boyfriend', 'this is fine fire'. Reply naturally after, never mention the tool.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    // ─── Separate Minecraft Action Tools ────────────────────────────────
    {
        type: "function",
        function: {
            name: "minecraft_action_attack",
            description: "Attack a specific mob by its id using a weapon from your hotbar. You'll automatically keep chasing and attacking that exact entity — you do NOT need to call this again to keep fighting it. Requires slot (a weapon: sword/axe/trident/bow) and entityId (the id shown next to the mob in Hostile Mobs / Passive Mobs, e.g. id: 16621).",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 9, description: "Hotbar slot (1-9) holding the weapon." },
                    entityId: { type: "number", description: "Exact id of the mob to attack, from the entity list you were shown." }
                },
                required: ["slot", "entityId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_use",
            description: "Use, eat, or place the item you're currently holding. Optional slot (1-9) to swap to that item first. Use when someone tells you to eat, drink, place a block, use a tool, or interact with an item.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 9, description: "Optional slot to swap to first (1-9). Omit to use current slot." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_swap_slot",
            description: "Switch to a specific hotbar slot. Requires slot (1-9). Use when someone tells you to swap, switch, or select a slot.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 9, description: "Slot to switch to (1-9)." }
                },
                required: ["slot"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_drop",
            description: "Drop an item from a hotbar slot. Requires slot (1-9). Use when someone tells you to drop, throw, or discard an item.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 9, description: "Slot to drop from (1-9)." }
                },
                required: ["slot"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_follow",
            description: "Follow a player continuously until told to stop. Requires the exact player name. Use when someone tells you to follow, come with, or stick with them.",
            parameters: {
                type: "object",
                properties: {
                    player: { type: "string", description: "Exact name of the player to follow." }
                },
                required: ["player"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_retreat",
            description: "Flee toward a player for safety. Optional player name — defaults to your regular companion if omitted. Use when someone tells you to retreat, run away, fall back, or get to safety.",
            parameters: {
                type: "object",
                properties: {
                    player: { type: "string", description: "Optional player to retreat toward. Omit to use default companion." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_stop",
            description: "Stop all current actions — attacking, following, moving, mining. Stay in place. Use when someone tells you to stop, halt, cease, wait, or hold.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_break",
            description: "Break or mine a specific block at coordinates. Requires x, y, z. Use when someone tells you to mine, break, dig, or destroy a specific block. Only use coordinates from Blocks of Interest.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate of the block." },
                    y: { type: "number", description: "Y coordinate of the block." },
                    z: { type: "number", description: "Z coordinate of the block." }
                },
                required: ["x", "y", "z"]
            }
        }
    }
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))