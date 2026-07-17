import axios from "axios"
import { log, logError } from './utils.js'
import { tavily } from "@tavily/core"
// ─── Tool Executor ──────────────────────────────────────────────────────
export class ToolExecutor {
    /**
     * @param {object} opts
     * @param {(type: string, params: object) => void} [mcSend] - sends a
     *   command to the Minecraft bridge, same signature/shape used by
     *   survivalLoop.js (e.g. mcSend('attack', { mode: 'once' })). Required
     *   for minecraft_action to actually do anything in-world; wire it in
     *   when constructing Lily, e.g. `new Lily({ ... }, mcSend)`.
     */
    constructor(opts, mcSend = null, getStateController = null) {
        this.opts = opts
        this.mcSend = mcSend
        this.getStateController = getStateController
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

    // ── Facts (permanent, deduped, never decay) ────────────────────────────────

    async memoryQuery(query, { daysAgo = null, windowDays = 2, daysBack = null } = {}) {
        // Pure recency mode — "what did we talk about this week/past 10 days".
        // No semantic search at all: just chronological listing, no query text needed.
        if (daysBack !== null) {
            log(`🧠 [MEMORY QUERY] recency-only daysBack=${daysBack}`)
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/recent`, {
                    limit: 10, days_back: daysBack, min_importance: 0.3
                    // no `types` — recent facts and events both count
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
            // Over-fetch when a time window is requested, since filtering happens
            // client-side after the similarity search.
            const k = daysAgo !== null ? 25 : 10
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query, k, min_score: this.opts.memoryQueryMinScore
                // no `types` filter — searches facts and episodic memories together
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
            // Duplicate detection now happens server-side in add_fact — no
            // separate pre-check call needed.
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

    // ── Episodic (decaying, time-stamped batches/events) ───────────────────────

    /**
     * Called only by lily.js's automatic batch summarizer (summarizeAndStore/
     * observe) — NOT exposed to Lily as a tool. She never decides to call
     * this; episodic memory is purely ambient from her perspective. Carries
     * a real `raw` transcript alongside the LLM summary, so the summary can
     * stay short (good for search) while the raw lines are what actually get
     * returned on a hit via memoryQuery.
     */
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

    // ── Everything below is unchanged ───────────────────────────────────────────

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
    /**
     * Performs ONE physical action in-world, on request from a chat message.
     * Mirrors the action set the survival loop can pick from, just triggered
     * directly instead of on a timer.
     */
    async minecraftAction(args = {}) {
        const { action, slot, x, y, z, player, target } = args
        log(`⛏️ [MINECRAFT] ${action} ${JSON.stringify(args)}`)

        const stateController = this.getStateController?.()
        if (!stateController) {
            logError(`[MINECRAFT] No stateController wired into ToolExecutor — action dropped`)
            return JSON.stringify({ status: "error", message: "Can't perform actions right now." })
        }

        const result = stateController.requestExplicit(action, { slot, x, y, z, player })

        if (!result.ok) {
            return JSON.stringify({ status: "error", message: result.message ?? `Unknown action: ${action}` })
        }
        return JSON.stringify({ status: "ok", message: `Action ${action} performed.`, target: target ?? null })
    }

    async execute(name, args) {
        switch (name) {
            case "web_search": return this.webSearch(args.query ?? "")
            case "minecraft_action": return this.minecraftAction(args)
            case "query_memory_database":
                return this.memoryQuery(args.query ?? "", {
                    daysAgo: args.days_ago ?? null,
                    windowDays: args.window_days ?? 2,
                    daysBack: args.days_back ?? null
                })
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "send_meme": return this.searchMeme(args.query ?? "")
            case "send_gif": return this.searchGif(args.query ?? "")
            case "break":
                return stateController.requestExplicit('break', { blocks: args.blocks })
            default:
                console.warn(`⚠️ [TOOL] Unknown: ${name}`)
                return `Unknown tool: ${name}`
        }
    }
    async searchMeme(query) {
        log(`🎭 [MEME] "${query}"`)
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/static-memes/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })

            log(`🎭 [MEME RAW] ${JSON.stringify(data).slice(0, 300)}`)

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
}

// ─── Tool Definitions (for Ollama) ──────────────────────────────────────
// Unchanged from before — the model's tool schema/behavior doesn't need to
// know the two DBs merged into one; only the backend wiring above changed.
export const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: `Search everything you know and remember — stored facts about people/the server/yourself, AND past events/experiences. One search covers both; you don't need to pick which "kind" of memory to check.

                        Three ways to use this, pick ONE per call:
                        1. Plain fact/topic lookup — pass query with 2+ keywords, leave days_ago and days_back unset.
                        2. A SPECIFIC past event at a rough point in time ("10 days ago", "last Tuesday") — pass query plus days_ago (searches AROUND that point, days_ago ± window_days).
                        3. An open-ended recent stretch with NO specific topic ("what did we talk about this week", "what's happened the past 10 days", "what did I miss") — pass days_back (how many days back from now) and you can leave query empty. This is a plain chronological recap, not a topic search — don't invent a query for it.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing what to look up. Only needed for modes 1 and 2 — leave empty when using days_back for an open-ended recent recap." },
                    days_ago: { type: "number", description: "Only for mode 2 — a specific past event with a rough time reference. Omit for fact lookups or open-ended recaps." },
                    window_days: { type: "number", description: "Only used with days_ago. Tolerance around days_ago, e.g. 2 means search days_ago-2 to days_ago+2. Default 2. Smaller (0-1) for precise references like 'yesterday', larger (3-5) for vague ones like 'a couple weeks ago'." },
                    days_back: { type: "number", description: "Only for mode 3 — open-ended recap covering from now back to this many days, no topic needed. E.g. 1 for 'today/yesterday', 7 for 'this week', 10 for 'the past 10 days', 30 for 'this month'." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a new factual entry.  Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
            parameters: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory.  Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
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
            description: "Search and send a GIF.  Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
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
    {
        type: "function",
        function: {
            name: 'minecraft_action',
            description: "Perform ONE physical action in the Minecraft world because someone directly asked you to (e.g. 'attack that zombie', 'come here', 'follow me', 'eat something', 'drop your sword', 'mine that ore', 'run away', 'retreat', 'back off'). This is the same set of actions you use during normal survival ticks, just triggered on request. Only call this when the message is actually asking you to DO something physical — not for banter. Pick exactly one action per call. Reply naturally afterward, don't narrate the tool call.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['follow', 'break', 'attack', 'retreat', 'stop', 'move_to', 'use', 'swap_slot', 'drop'] },
                    player: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    z: { type: 'number' }
                },
                required: ['action']
            }
        }
    }
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))