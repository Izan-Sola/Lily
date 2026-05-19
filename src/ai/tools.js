import axios from "axios"
import { log, logError } from './utils.js'

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
                params: { query, k: 5, min_score: this.opts.memoryQueryMinScore },
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
            case "minecraft_action": return this.minecraftAction(args.action ?? "", args.target ?? "")
            case "query_memory_database": return this.memoryQuery(args.query ?? "")
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "query_episodic_memory": return this.episodicQuery(args.query ?? "", args.k ?? 5)
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
                return this.queryRecentEpisodicMemories(args.limit ?? 5, args.days_back ?? 1)
            case "send_gif": return this.searchGif(args.query ?? "")
            default:
                console.warn(`⚠️ [TOOL] Unknown: ${name}`)
                return `Unknown tool: ${name}`
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
            description: "Search stored factual memory. Use multiple keywords.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a new factual entry.",
            parameters: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory.",
            parameters: { type: "object", properties: { query: { type: "string" }, text: { type: "string" } }, required: ["query", "text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove matching memories.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "query_episodic_memory",
            description: "Search episodic memory for past events.",
            parameters: { type: "object", properties: { query: { type: "string" }, k: { type: "number" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_episodic_memory",
            description: "Store an episodic memory (event/experience).",
            parameters: { type: "object", properties: { title: { type: "string" }, summary: { type: "string" }, participants: { type: "array", items: { type: "string" } }, emotions: { type: "array", items: { type: "string" } }, importance: { type: "number" } }, required: ["title", "summary"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send a GIF.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    }
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))