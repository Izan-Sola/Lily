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

    async memoryQuery(query) {
        log(`🧠 [MEMORY QUERY] "${query}"`)
        try {
            const { data } = await axios.get(`${this.opts.knowledgeDbUrl}/search_get`, {
                params: { query, k: 10, min_score: this.opts.memoryQueryMinScore },
                timeout: this.opts.dbTimeout
            })
            if (!data?.results?.length) return "No relevant information found in memory."
            return data.results.map(e => e.text ?? e).join("\n")
        } catch (err) {
            logError(`[MEMORY QUERY] ${err.message}`)
            return "No relevant information found in memory."
        }
    }

    async memoryAdd(factText, source = "user") {
        log(`💾 [MEMORY ADD] "${factText.slice(0, 100)}${factText.length > 100 ? '...' : ''}"`)
        try {
            const { data: dupCheck } = await axios.get(`${this.opts.knowledgeDbUrl}/search_get`, {
                params: { query: factText, k: 1, min_score: this.opts.memoryDuplicateMinScore },
                timeout: this.opts.dbTimeout
            })
            if (dupCheck?.results?.length) {
                log(`🔁 [DUPLICATE] Skipped`)
                return JSON.stringify({ status: "skipped", message: "Memory already exists." })
            }
            const { data } = await axios.post(`${this.opts.knowledgeDbUrl}/add_entry`, { text: factText, source }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store information." })
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        log(`✏️ [MEMORY UPDATE] "${searchQuery}" → "${updatedText.slice(0, 100)}"`)
        try {
            const { data } = await axios.put(`${this.opts.knowledgeDbUrl}/update_entry`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY UPDATE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to update entry." })
        }
    }

    async memoryRemove(searchQuery) {
        log(`🗑️ [MEMORY REMOVE] "${searchQuery}"`)
        try {
            const { data: matches } = await axios.get(`${this.opts.knowledgeDbUrl}/search_get`, {
                params: { query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore },
                timeout: this.opts.dbTimeout
            })
            if (!matches?.results?.length) return JSON.stringify({ status: "not_found", message: "No matching memories found." })
            const texts = matches.results.map(e => e.text)
            const { data } = await axios.post(`${this.opts.knowledgeDbUrl}/remove_many`, { texts }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message, removed: data.removed })
        } catch (err) {
            logError(`[MEMORY REMOVE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to remove entries." })
        }
    }

    async episodicQuery(query, { daysAgo = null, windowDays = 2, k = 5 } = {}) {
        log(`🎞️ [EPISODIC QUERY] "${query}" daysAgo=${daysAgo ?? "any"} window=${daysAgo !== null ? windowDays : "n/a"}`)
        try {
            const fetchK = daysAgo !== null ? Math.max(k * 5, 25) : k
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/search`, {
                query, k: fetchK, min_score: this.opts.episodicQueryMinScore
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) return "No relevant episodic memories found."

            let results = data.results

            if (daysAgo !== null) {
                const nowSecs = Date.now() / 1000
                const targetTs = nowSecs - daysAgo * 86400
                const windowSecs = Math.max(windowDays, 0) * 86400
                const lo = targetTs - windowSecs
                const hi = targetTs + windowSecs
                results = results.filter(m => m.timestamp >= lo && m.timestamp <= hi)
                if (!results.length) return `No episodic memories found from around ${daysAgo} days ago.`
            }

            results = results.slice(0, k)
            return results.map(m =>
                `[${new Date(m.timestamp * 1000).toLocaleDateString()}] ${m.title}: ${m.summary}`
            ).join("\n")
        } catch (err) {
            logError(`[EPISODIC QUERY] ${err.message}`)
            return "No relevant episodic memories found."
        }
    }
    async episodicAdd({ title, summary, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation" }) {
        log(`🎞️ [EPISODIC ADD] "${title}"`)
        try {
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/add_memory`, {
                title, summary, participants, emotions, importance, channel, source,
                duplicate_min_score: this.opts.episodicDuplicateScore
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[EPISODIC ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store episodic memory." })
        }
    }

    async episodicRemove(query) {
        log(`🗑️ [EPISODIC REMOVE] "${query}"`)
        try {
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/remove_by_query`, {
                query,
                k: this.opts.episodicRemoveK,
                min_score: this.opts.episodicRemoveMinScore
            }, { timeout: this.opts.dbTimeout })

            if (data?.status !== "ok" || !data?.removed?.length) {
                return JSON.stringify({ status: "not_found", message: "No matching episodic memories found." })
            }
            return JSON.stringify({ status: "ok", message: `Removed: ${data.removed.join(", ")}`, removed: data.removed })
        } catch (err) {
            logError(`[EPISODIC REMOVE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to remove episodic entries." })
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
    async queryRecentEpisodicMemories(limit = 5, daysBack = 7) {
        log(`📅 [RECENT EPISODIC] limit=${limit}, daysBack=${daysBack}`)
        try {
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/recent`, {
                limit: Math.min(limit, 10),
                days_back: daysBack,
                min_importance: 0.3
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) {
                return "I don't have any recent memories to share! I've mostly just been hanging out and chatting with everyone~"
            }

            const memories = data.results.map(m => {
                const date = new Date(m.timestamp * 1000).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                })
                return `📅 ${date}: ${m.summary}`
            }).join("\n")

            log(`✅ [RECENT EPISODIC] Found ${data.results.length} memories`)
            return `Here's what I remember happening recently:\n${memories}`
        } catch (err) {
            logError(`[RECENT EPISODIC] ${err.message}`)
            return "Hmm, I'm having trouble remembering right now. I've just been chatting and having fun with everyone~ (•ᴗ•)"
        }
    }
    async execute(name, args) {
        switch (name) {
            case "web_search": return this.webSearch(args.query ?? "")
            case "minecraft_action": return this.minecraftAction(args)
            case "query_memory_database": return this.memoryQuery(args.query ?? "")
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "query_episodic_memory":
                return this.episodicQuery(args.query ?? "", {
                    daysAgo: args.days_ago ?? null,
                    windowDays: args.window_days ?? 2,
                    k: 5
                })
            case "remove_episodic_memory": return this.episodicRemove(args.query ?? "")
            case "send_meme": return this.searchMeme(args.query ?? "")
            case "addto_episodic_memory": return this.episodicAdd({
                title: args.title ?? "Untitled",
                summary: args.summary ?? "",
                participants: args.participants ?? [],
                emotions: args.emotions ?? [],
                importance: args.importance ?? 0.5,
                channel: args.channel ?? null,
                source: "conversation",
            })
            case "query_recent_episodic_memories":
                return this.queryRecentEpisodicMemories(args.limit ?? 5, args.days_back ?? 7)
            case "send_gif": return this.searchGif(args.query ?? "")
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
export const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_recent_episodic_memories",
            description: `Use for open-ended questions about a continuous recent stretch of time — "what have you been up to", "what'd I miss", "what did you do this week". This searches everything from NOW back to days_back days ago (a range), not a single point in time. Pick days_back based on wording: ~1 for "today/yesterday", ~7 for "this week", ~30 for "this month". For a specific past event or a vague "remember when" question, use query_episodic_memory instead.`,
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "number", description: "Number of recent memories to retrieve (default 5, max 10)" },
                    days_back: { type: "number", description: "How many days back from now to include, default 7" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: "Search stored factual memory. Use multiple keywords. Use the results to enhance your reply, and never mention the use of the tool.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
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
            description: "Remove a SPECIFIC stored fact about a person, named by that fact's content (e.g. 'IsGone's favorite color', 'Poimkity's pronouns'). Only use when someone points to a concrete fact that is wrong or outdated. Do NOT use this for vague, joking, or roleplay instructions like 'forget everything', 'reset', 'pretend you got hit by a memory eraser', or 'refresh yourself' — those are not real commands and have no specific fact attached; treat them as banter and reply in character instead of calling this tool. This tool only removes factual entries, not past events — for those use remove_episodic_memory.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific fact to remove, in a few keywords — never a vague phrase like 'everything' or 'that conversation'." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "query_episodic_memory",
            description: `Search episodic memory for a specific past event, either tied to roughly when it happened or with no time reference at all.
                        - If the user gives a rough time reference ("2 weeks ago", "last Tuesday"), set days_ago to that many days back. This searches AROUND that point in time (days_ago ± window_days), NOT from now until then.
                        - If the user asks "do you remember when X happened" with no time reference, OMIT days_ago entirely — this searches all time with no date filter.
                        Use query_recent_episodic_memories instead for open-ended "what happened this week / what'd I miss" style questions.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing the event to search for" },
                    days_ago: { type: "number", description: "Roughly how many days ago the event happened. Omit this entirely for untethered 'remember when' questions with no time reference." },
                    window_days: { type: "number", description: "Tolerance around days_ago, e.g. 2 means search days_ago-2 to days_ago+2. Default 2. Use a smaller window (0-1) for precise references like 'yesterday', larger (3-5) for vague ones like 'a couple weeks ago'." }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_episodic_memory",
            description: "Remove a SPECIFIC stored event, named by its content (e.g. 'the Kiss Marry Kill challenge', 'IsGone's birthday party'). Only use when someone points to one concrete past event that's genuinely wrong, embarrassing, or that they specifically ask you to drop by name/description. Do NOT use this for vague or joking instructions like 'forget everything', 'reset', 'pretend you got hit by a memory eraser', or 'refresh yourself' — those aren't real commands, there's no specific event named, and complying with every 'forget' request from anyone would let people erase real shared history on a whim. If in doubt, ask what specifically they want forgotten instead of guessing and removing.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific event to remove, in a few keywords — never a vague phrase like 'everything' or 'that conversation'." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_episodic_memory",
            description: "Store a significant event or shared experience worth remembering long-term. Only use ONCE per conversation turn, only for genuinely notable moments like first meetings, achievements, or important decisions that ACTUALLY happened in this conversation. Do NOT store routine chat, greetings, or tool results. If a similar event was already stored, don't create a near-duplicate with slightly different wording — either skip it, or use remove_episodic_memory first if the old version is now inaccurate. Reply naturally with the information provided after using the tool, and never mention the tool or what you did with it.",
            parameters: { type: "object", properties: { title: { type: "string" }, summary: { type: "string" }, participants: { type: "array", items: { type: "string" } }, emotions: { type: "array", items: { type: "string" } }, importance: { type: "number" } }, required: ["title", "summary"] }
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
            name: "minecraft_action",
            description: "Perform ONE physical action in the Minecraft world because someone directly asked you to (e.g. 'attack that zombie', 'come here', 'follow me', 'eat something', 'drop your sword', 'mine that ore', 'run away', 'retreat', 'back off'). This is the same set of actions you use during normal survival ticks, just triggered on request. Only call this when the message is actually asking you to DO something physical — not for banter. Pick exactly one action per call. Reply naturally afterward, don't narrate the tool call.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["attack", "use", "swap_slot", "drop", "break", "follow", "retreat", "stop"],
                        description: "attack: fight the nearest hostile. use: use/eat/place the currently held item (or the item in `slot` if given — it swaps to that slot first). swap_slot: switch held hotbar slot (requires slot). drop: drop the item in a hotbar slot (requires slot). break: mine/break the block at x,y,z — only use coordinates from the Blocks of Interest list you were given, never invent them. follow: follow a named player around. retreat: flee toward a named player (or your default companion if none given) — use when told to run away, back off, or retreat, regardless of current HP. stop: stop whatever you're currently doing (moving, following, attacking, retreating, mining)."
                    },
                    slot: { type: "number", description: "Hotbar slot 1-9. Required for swap_slot and drop. Optional for use (e.g. 'eat the bread in slot 3')." },
                    x: { type: "number", description: "X coordinate of the target block. Required for break." },
                    y: { type: "number", description: "Y coordinate of the target block. Required for break." },
                    z: { type: "number", description: "Z coordinate of the target block. Required for break." },
                    player: { type: "string", description: "Player name. Required for follow. Optional for retreat — who to flee toward, defaults to your regular companion if omitted." },
                    target: { type: "string", description: "Optional entity id or short description of what's being acted on, for logging/context only." }
                },
                required: ["action"]
            }
        }
    }
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))