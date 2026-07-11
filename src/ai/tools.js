import axios from "axios"
import { log, logError } from './utils.js'
import { tavily } from "@tavily/core"
// ─── Tool Executor ──────────────────────────────────────────────────────
export class ToolExecutor {
    constructor(opts) {
        this.opts = opts
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

    async episodicQuery(query, k = 5) {
        log(`🎞️ [EPISODIC QUERY] "${query}"`)
        try {
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/search`, {
                query, k, min_score: this.opts.episodicQueryMinScore
            }, { timeout: this.opts.dbTimeout })
            if (!data?.results?.length) return "No relevant episodic memories found."
            return data.results.map(m =>
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

    /**
     * Semantic removal of episodic memories, backed by /remove_by_query.
     * Note the endpoint's response shape is { status, removed: [titles] },
     * not { status, message } like the factual-memory remove endpoint —
     * normalize it here so callers/log lines don't need to special-case it.
     */
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
    async minecraftAction(action, target) {
        log(`⛏️ [MINECRAFT] ${action} → ${target || "none"}`)
        // This would integrate with your Minecraft bot
        return JSON.stringify({ status: "ok", message: `Action ${action} performed.` })
    }
    async queryRecentEpisodicMemories(limit = 4, daysBack = 1) {
        log(`📅 [RECENT EPISODIC] limit=${limit}, daysBack=${daysBack}`)
        try {
            const { data } = await axios.post(`${this.opts.episodicDbUrl}/recent`, {
                limit: Math.min(limit, 10),
                days_back: 1,
                min_importance: 0.3  // Include moderately important memories too
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) {
                return "I don't have any recent memories to share! I've mostly just been hanging out and chatting with everyone~"
            }

            // Format into a natural, conversational summary
            const memories = data.results.map(m => {
                const date = new Date(m.timestamp * 1000).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })
                return `📅 ${date}: ${m.summary}`
            }).join('\n')

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
            case "minecraft_action": return this.minecraftAction(args.action ?? "", args.target ?? "")
            case "query_memory_database": return this.memoryQuery(args.query ?? "")
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "query_episodic_memory": return this.episodicQuery(args.query ?? "", 5, args.days_back ?? 90)
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
                return this.queryRecentEpisodicMemories(args.limit ?? 15, args.days_back ?? 1)
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
            description: "Retrieve the most recent events, conversations, or activities. Use when someone asks what Lily has been doing lately, what happened recently, or if anything interesting occurred while they were away.",
            parameters: {
                type: "object",
                properties: {
                    limit: {
                        type: "number",
                        description: "Number of recent memories to retrieve (default 5, max 10)"
                    },
                    days_back: {
                        type: "number",
                        description: "How many days back to look (default 7, max 30)"
                    }
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
            description: "Search episodic memory for past events or conversations. Use when asked about something specific that happened. Choose days_back based on context: 1 for 'yesterday'/'today', 7 for 'this week'/'recently', 30 for 'last month', 90+ for older memories.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords describing the event to search for" },
                    days_back: { type: "number", description: "How many days back to search. Pick based on context: 1=today/yesterday, 7=this week, 30=this month, 90=last few months, 365=last year" }
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
    }
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

