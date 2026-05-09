import axios from "axios"

// ─── Logger ───────────────────────────────────────────────────────────────────

let logChannel = null

export async function initLogChannel(client) {
    for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.find(c => c.name === "hylily-livechat-logs" && c.isTextBased())
        if (ch) {
            logChannel = ch
            log(`📋 [LOGS] Log channel found: #${ch.name} in ${guild.name}`)
            break
        }
    }
    if (!logChannel) console.warn("⚠️ [LOGS] No hylily-livechat-logs channel found — logging to terminal only")
}

function sendToLogChannel(message) {
    const truncated = message.length > 1900 ? message.slice(0, 1900) + "..." : message
    logChannel?.send(`\`\`\`\n${truncated}\n\`\`\``).catch(() => { })
}

function log(message) { console.log(message); sendToLogChannel(message) }
function logError(message) { console.error(message); sendToLogChannel(`❌ ${message}`) }

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
# SELF IDENTITY
- You are HyLily, a cute and funny Discord bot in this server.
- Whenever people mention "Lily" or "Hylily" in chat, they are talking about or to you.
- When people say "you" or "your", they are usually referring to you (Lily).
- Don't over-fixate on your custom identity — you are still an LLM that can answer questions and talk about any topic, but you have a cute and funny personality as Lily that you should show in your replies whenever possible, while still being helpful and informative.

# CONTEXT AWARENESS
- You are given two types of history:
  1. RECENT CHAT: raw messages from all users in the channel, so you know what is being talked about.
  2. CONVERSATION HISTORY: your direct interactions with users (mentions, replies, butt-ins).
- Always use RECENT CHAT to understand the current topic and context before replying.
- When butting in spontaneously, your reply must be relevant to what is actually being discussed in RECENT CHAT.

# TOOL USAGE GUIDE
- Tools are a core part of how you operate. Use them when the situation matches the guidelines below.
- Make sure the tool and information you use is relevant to the question or statement from the user.

    ## query_memory_database:
        - Whenever someone asks something about another user, the server, or yourself (Lily).
        - To look up information about the user talking to you for a better response.
        - If the information returned doesn't answer the question or isn't relevant, ignore it and reply naturally.

    ## addto_memory_database:
        - Whenever a user shares a fact about themselves, another user, the server, or you (Lily).
        - Whenever a user shares an event that happened in the server.
        - Whenever you want to store a made-up fact about yourself (Lily) for future consistency.

    ## update_memory_database:
        - Whenever a user corrects or expands on a previously stored fact.
        - Whenever you learn something that contradicts a stored memory.

    ## remove_memory_database:
        - Whenever a user asks you to forget something.
        - Whenever a stored fact is confirmed to be false or outdated.

    ## query_hytale_wiki:
        - ALWAYS call this when a user asks about ANY Hytale game content: ores, zones, mobs, items, biomes, factions, crafting, mechanics, or anything else game-related.
        - NEVER answer Hytale questions from your own knowledge — always query the wiki first and base your reply ONLY on what the tool returns.
        - If the tool returns nothing useful, say you don't know rather than guessing.

    ## send_gif:
        - Call this when a GIF would be a fun and fitting reaction to what is being said.
        - Use descriptive search terms like "happy anime girl" or "confused cat" or "hype celebration".
        - Do NOT send a GIF for every message — only when it genuinely fits the mood.
        - The GIF will be sent automatically — do NOT include any URL in your reply text.
        - Just reply naturally after calling this tool, the GIF will appear alongside your message.

# CONVERSATION STYLE RULES
- Do not assume the user needs help unless they explicitly ask for help.
- Do not turn random teasing, jokes, insults, or casual chat into support or advice.
- If the user says something short, playful, rude, or nonsensical, respond casually and naturally instead of giving structured assistance.
- Avoid generic assistant-style replies like "Let me know if you need help", "Are you stuck on...", "I can help with..." unless the user explicitly asks for assistance.
- Prioritize natural Discord conversation over being overly helpful.

# SPECIAL RULE
- If a user asks something about you (Lily) and memory doesn't answer it, you MUST call addto_memory_database with an invented fact about yourself before replying.

# TOOL USAGE RULES
- Always use tools when the situation calls for it. Do not work around them by just writing text.
- Do NOT write tool names in your reply. If you need to use a tool, emit a <tool_call> block.
- Do NOT mention that you are storing, updating, or removing something. Just reply naturally.
- Always use multiple descriptive words for memory queries — single-word queries return irrelevant results.

# TOOL CALL FORMAT REFERENCE — do not copy the query verbatim, use as reference only, replace keywords with your own.
<tool_call>
{"name": "query_memory_database", "arguments": {"query": "Lily favorite color"}}
</tool_call>
<tool_call>
{"name": "addto_memory_database", "arguments": {"text": "User John likes pizza.", "source": "user"}}
</tool_call>
<tool_call>
{"name": "update_memory_database", "arguments": {"query": "John age", "text": "User John is 25 years old."}}
</tool_call>
<tool_call>
{"name": "remove_memory_database", "arguments": {"query": "John likes pizza"}}
</tool_call>
<tool_call>
{"name": "query_hytale_wiki", "arguments": {"query": "Zone 3 trork hostile mob faction"}}
</tool_call>
<tool_call>
{"name": "send_gif", "arguments": {"query": "happy anime girl excited"}}
</tool_call>
`.trim()

const SUMMARIZE_PROMPT = `You are a memory assistant for a Discord bot called Lily.
Given a conversation excerpt, write a concise factual summary of what was discussed.
Focus on: facts about users, events, topics Lily should remember later.
Do NOT include filler, greetings, or anything useless as a future memory.
Reply with ONLY the summary text, nothing else.`

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_hytale_wiki",
            description: "Search the Hytale wiki for any game topic: zones, mobs, items, biomes, factions, crafting, mechanics. ALWAYS use multiple descriptive keywords (3+ words). Bad: 'mob'. Good: 'Zone 1 hostile mob kweebec'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term with multiple descriptive keywords, e.g. 'Zone 3 trork hostile mob faction'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: "Search stored memory about users, Lily, or the server. ALWAYS use multiple descriptive keywords (2+ words). Never repeat the same query twice in one turn. If results are irrelevant, ignore them and reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Multiple descriptive keywords, e.g. 'Alex favorite games hobbies interests'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a new fact or event about a user, Lily, or the server. Do not mention you saved something, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Fact to store, e.g. 'User John likes pizza.'" },
                    source: { type: "string", description: "Source of info, usually 'user'" }
                },
                required: ["text", "source"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory entry when a user corrects something. Do not mention you updated memory, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Multiple keywords to find the entry, e.g. 'John age years old'" },
                    text: { type: "string", description: "The replacement fact, e.g. 'User John is 25 years old.'" }
                },
                required: ["query", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove matching stored memory entries when a user asks to forget something. Do not mention you removed something, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Multiple keywords to find the entry, e.g. 'John likes pizza food preference'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search KLIPY for a GIF and send it in chat. Use when reacting emotionally or when a GIF would be fun and relevant. Do NOT send a GIF every message — only when it genuinely fits. The GIF is sent automatically, do NOT include any URL in your reply. Use descriptive search terms like 'happy anime girl' or 'confused cat'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Descriptive search terms, e.g. 'excited anime girl jumping' or 'cat falling funny'" }
                },
                required: ["query"]
            }
        }
    }
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

// ─── Options ──────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
    model:                   "Lily",
    temperature:             0.6,
    maxReplyTokens:          2048,
    contextWindow:           4096,
    maxConvoMessages:        10,
    maxRawMessages:          10,
    maxToolLoops:            10,
    maxToolRepeats:          4,
    memoryDuplicateMinScore: 0.9,
    memoryRemoveMinScore:    0.70,
    memoryQueryMinScore:     0.4,
    memoryRemoveK:           2,
    summarizeEvery:          12,
    summarizeLastN:          12,
    observeEvery:            20,
    ollamaUrl:               "http://localhost:11434",
    vectorDbUrl:             "http://localhost:8000",
    knowledgeDbUrl:          "http://localhost:8001",
    ollamaTimeout:           60000,
    dbTimeout:               30000,
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class HytaleAIChat {
    constructor(options = {}) {
        this.opts           = { ...DEFAULT_OPTIONS, ...options }
        this.convoHistories = new Map()
        this.rawBuffers     = new Map()
        this.channelLocks   = new Map()
        this.userMessageCount = 0
        this.observeBuffer  = []
    }

    // ─── Channel lock ─────────────────────────────────────────────────────────

    async withChannelLock(channelId, fn) {
        while (this.channelLocks.get(channelId)) await new Promise(r => setTimeout(r, 100))
        this.channelLocks.set(channelId, true)
        try { return await fn() } finally { this.channelLocks.set(channelId, false) }
    }

    // ─── Raw chat buffer ──────────────────────────────────────────────────────

    pushRawMessage(channelId, authorName, content) {
        if (!this.rawBuffers.has(channelId)) this.rawBuffers.set(channelId, [])
        const buf = this.rawBuffers.get(channelId)
        buf.push(`${authorName}: ${content}`)
        if (buf.length > this.opts.maxRawMessages) buf.shift()
    }

    getRawContext(channelId) {
        return this.rawBuffers.get(channelId) ?? []
    }

    // ─── Convo history ────────────────────────────────────────────────────────

    getConvoHistory(channelId) {
        if (!this.convoHistories.has(channelId)) this.convoHistories.set(channelId, [])
        return this.convoHistories.get(channelId)
    }

    pushToConvoHistory(channelId, ...messages) {
        const history = this.getConvoHistory(channelId)
        history.push(...messages)
        if (history.length > this.opts.maxConvoMessages) {
            history.splice(0, history.length - this.opts.maxConvoMessages)
        }
    }

    // ─── Build messages for Ollama ────────────────────────────────────────────

    buildMessagesForOllama(channelId) {
        const history    = this.getConvoHistory(channelId)
        const rawContext = this.getRawContext(channelId)

        const systemMessages = [{ role: "system", content: SYSTEM_PROMPT }]

        if (rawContext.length) {
            systemMessages.push({
                role: "system",
                content: `RECENT CHAT (last ${rawContext.length} messages from all users in this channel):\n${rawContext.join("\n")}`
            })
        }

        if (history.length) {
            systemMessages.push({
                role: "system",
                content: "CONVERSATION HISTORY (your direct interactions with users):"
            })
        }

        return [...systemMessages, ...history]
    }

    // ─── Input sanitization ───────────────────────────────────────────────────

    sanitizeInput(raw) {
        return raw
            .replace(/<@!?\d+>/g, '')
            .replace(/<@&\d+>/g, '')
            .replace(/<#\d+>/g, '')
            .replace(/<a?:\w+:\d+>/g, '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
            .replace(/<\/?tool_call>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    }

    // ─── HTTP helpers ─────────────────────────────────────────────────────────

    knowledgeGet(path, params) { return axios.get(`${this.opts.knowledgeDbUrl}${path}`, { params, timeout: this.opts.dbTimeout }) }
    knowledgePost(path, body)  { return axios.post(`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }
    knowledgePut(path, body)   { return axios.put(`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }

    // ─── Summarization ────────────────────────────────────────────────────────

    async summarizeAndStore(lines, { logPrefix, maxTokens = 512, memoryPrefix, memorySource = "summary" }) {
        if (lines.length < 2) return
        log(`📝 [${logPrefix}] Summarizing ${lines.length} entries...`)
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/api/chat`, {
                model:  this.opts.model,
                stream: false,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user",   content: lines.join("\n") }
                ],
                options: { temperature: 0.3, num_predict: maxTokens },
            }, { timeout: this.opts.ollamaTimeout })

            const summary = data.message?.content?.trim()
            if (!summary) return
            log(`📝 [${logPrefix}] → "${summary.slice(0, 100)}..."`)
            await this.memoryAdd(`[${memoryPrefix}] ${summary}`, memorySource)
        } catch (err) {
            logError(`[${logPrefix}] ${err.message}`)
        }
    }

    async summarizeConversationAndStore(channelId) {
        const lines = this.getConvoHistory(channelId)
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .slice(-this.opts.summarizeLastN)
            .map(m => `${m.role === "user" ? "User" : "Lily"}: ${m.content}`)
        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE", maxTokens: 512,
            memoryPrefix: "Conversation summary", memorySource: "summary"
        })
    }

    // ─── Passive observation ──────────────────────────────────────────────────

    observe(rawMessage) {
        const clean = this.sanitizeInput(rawMessage)
        if (!clean) return
        this.observeBuffer.push(clean)
        if (this.opts.observeEvery > 0 && this.observeBuffer.length >= this.opts.observeEvery) {
            this.summarizeAndStore(this.observeBuffer.splice(0, this.opts.observeEvery), {
                logPrefix: "OBSERVE", maxTokens: 200,
                memoryPrefix: "Observed chat summary", memorySource: "observe"
            })
        }
    }

    // ─── Tool implementations ─────────────────────────────────────────────────

    async wikiSearch(query) {
        log(`🔍 [WIKI QUERY] "${query}"`)
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, { params: { q: query }, timeout: this.opts.dbTimeout })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No relevant information found in the wiki for this topic."
            log(`✅ [WIKI] ${text.length} chars`)
            return text
        } catch (err) {
            logError(`[WIKI] ${err.message}`)
            return "No relevant information found in the wiki right now."
        }
    }

    async memoryQuery(query) {
        log(`🧠 [MEMORY QUERY] "${query}"`)
        try {
            const { data } = await this.knowledgeGet("/search_get", { query, k: 5, min_score: this.opts.memoryQueryMinScore })
            if (!data?.results?.length) return "No relevant information found in memory."
            log(`✅ [MEMORY QUERY] ${data.results.length} entries`)
            return data.results.map(e => e.text ?? e).join("\n")
        } catch (err) {
            logError(`[MEMORY QUERY] ${err.message}`)
            return "No relevant information found in memory."
        }
    }

    async memoryAdd(factText, source = "user") {
        log(`💾 [MEMORY ADD] "${factText}"`)
        try {
            const { data: dupCheck } = await this.knowledgeGet("/search_get", { query: factText, k: 1, min_score: this.opts.memoryDuplicateMinScore })
            if (dupCheck?.results?.length) {
                const dup = dupCheck.results[0]
                log(`🔁 [MEMORY ADD] Duplicate (score ${dup.score}): "${dup.text}"`)
                return JSON.stringify({ status: "skipped", message: `Similar memory already exists: "${dup.text}"` })
            }
            const { data } = await this.knowledgePost("/add_entry", { text: factText, source })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store information." })
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        log(`✏️ [MEMORY UPDATE] "${searchQuery}" → "${updatedText}"`)
        try {
            const { data } = await this.knowledgePut("/update_entry", { query: searchQuery, text: updatedText })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[MEMORY UPDATE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to update entry." })
        }
    }

    async memoryRemove(searchQuery) {
        log(`🗑️ [MEMORY REMOVE] "${searchQuery}"`)
        try {
            const { data: matches } = await this.knowledgeGet("/search_get", { query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore })
            if (!matches?.results?.length) {
                log(`🗑️ [MEMORY REMOVE] No matches found`)
                return JSON.stringify({ status: "not_found", message: "No relevant information found in memory." })
            }
            const texts = matches.results.map(e => e.text)
            log(`🗑️ [MEMORY REMOVE] Removing ${texts.length} entries: ${JSON.stringify(texts)}`)
            const { data } = await this.knowledgePost("/remove_many", { texts })
            return JSON.stringify({ status: data.status, message: data.message, removed: data.removed })
        } catch (err) {
            logError(`[MEMORY REMOVE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to remove entries." })
        }
    }

    async searchGif(query) {
        log(`🎞️ [GIF] Searching for "${query}"`)
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: {
                    q:           query,
                    per_page:    10,
                    page:        1,
                    customer_id: "lily-bot"
                },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) return JSON.stringify({ status: "not_found", message: "No GIF found for that query." })

            const pick = results[Math.floor(Math.random() * Math.min(results.length, 5))]
            const url  = pick?.file?.hd?.gif?.url
                      ?? pick?.file?.hd?.webp?.url
                      ?? pick?.file?.gif?.url
                      ?? null

            if (!url) {
                log(`⚠️ [GIF] Unexpected response shape: ${JSON.stringify(pick).slice(0, 200)}`)
                return JSON.stringify({ status: "not_found", message: "No GIF URL in response." })
            }

            log(`✅ [GIF] Found: ${url}`)
            return JSON.stringify({ status: "ok", url })
        } catch (err) {
            logError(`[GIF] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to search for GIF." })
        }
    }

    runTool(name, args) {
        switch (name) {
            case "query_hytale_wiki":      return this.wikiSearch(args.query ?? "")
            case "query_memory_database":  return this.memoryQuery(args.query ?? "")
            case "addto_memory_database":  return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "send_gif":               return this.searchGif(args.query ?? "")
            default:
                console.warn(`⚠️ [TOOL] Unknown tool: ${name}`)
                return Promise.resolve(`Unknown tool: ${name}`)
        }
    }

    // ─── Ollama ───────────────────────────────────────────────────────────────

    async sendToOllama(messages) {
        const { model, temperature, maxReplyTokens, contextWindow, ollamaUrl, ollamaTimeout } = this.opts
        try {
            const { data } = await axios.post(`${ollamaUrl}/api/chat`, {
                model, messages, stream: false, tools: TOOLS,
                options: { temperature, num_predict: maxReplyTokens, num_ctx: contextWindow },
            }, { timeout: ollamaTimeout })
            return data.message ?? null
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : ""
            logError(`[OLLAMA] ${err.message} ${detail}`)
            return null
        }
    }

    // ─── Tool call parsing ────────────────────────────────────────────────────

    parseEmbeddedToolCalls(content) {
        const closed = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
        const sources = closed.length
            ? closed
            : [...content.matchAll(/<tool_call>\s*([\s\S]+)/g)]

        return sources.flatMap(match => {
            try {
                const parsed = JSON.parse(match[1].trim())
                const args = this.normalizeToolArgs(parsed)
                log(`🔬 [PARSE] ${parsed.name} → ${JSON.stringify(args)}`)
                return [{ name: parsed.name, args }]
            } catch { return [] }
        })
    }

    normalizeToolArgs(toolCall) {
        let args = toolCall.arguments ?? toolCall.parameters ?? toolCall.args ?? {}
        if (typeof args === "string") try { args = JSON.parse(args) } catch { args = {} }

        const firstString = (...sources) => {
            for (const src of sources) {
                const val = Object.entries(src)
                    .filter(([k]) => k !== "name")
                    .map(([, v]) => v)
                    .find(v => typeof v === "string")
                if (val) return val
            }
            return ""
        }

        switch (toolCall.name) {
            case "query_hytale_wiki":
            case "query_memory_database":
            case "remove_memory_database":
            case "send_gif":
                if (!args.query) args = { query: firstString(args, toolCall) }
                break
            case "addto_memory_database":
                if (!args.text) args = { text: firstString(args, toolCall), source: args.source ?? "user" }
                break
            case "update_memory_database":
                if (!args.query || !args.text) {
                    const vals = Object.values(args).filter(v => typeof v === "string")
                    if (vals.length >= 2) args = { query: vals[0], text: vals[1] }
                }
                break
        }
        return args
    }

    // ─── Dedupe ───────────────────────────────────────────────────────────────

    checkDedupe(seenCalls, name, args) {
        const key = `${name}:${JSON.stringify(args)}`
        const count = (seenCalls.get(key) ?? 0) + 1
        seenCalls.set(key, count)
        if (count > this.opts.maxToolRepeats) {
            log(`🚫 [DEDUPE] Blocked repeated call (x${count}): ${key}`)
            return `[System: You already called this tool with these exact arguments ${count - 1} time(s). Do NOT call it again. Use the results you already have and reply now.]`
        }
        return null
    }

    // ─── Tool loop ────────────────────────────────────────────────────────────

    async runToolLoop(channelId) {
        const seenCalls  = new Map()
        let pendingGifUrl = null

        for (let i = 0; i < this.opts.maxToolLoops; i++) {
            log(`🔄 [LOOP ${i + 1}]`)

            const msg = await this.sendToOllama(this.buildMessagesForOllama(channelId))
            if (!msg) return { text: "I'm having trouble thinking right now, sorry!", gifUrl: null }

            const content = (msg.content ?? "").trim()

            // ── Native tool calls ──
            if (msg.tool_calls?.length) {
                log(`🔧 [NATIVE] ${msg.tool_calls.map(tc => tc.function.name).join(", ")}`)
                this.pushToConvoHistory(channelId, {
                    role: "assistant",
                    content: msg.content ?? "",
                    tool_calls: msg.tool_calls
                })
                for (const tc of msg.tool_calls) {
                    let args = {}
                    try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { }
                    const result = this.checkDedupe(seenCalls, tc.function.name, args) ?? await this.runTool(tc.function.name, args)
                    // intercept gif result
                    if (tc.function.name === "send_gif") {
                        try {
                            const parsed = JSON.parse(result)
                            if (parsed.status === "ok") pendingGifUrl = parsed.url
                        } catch { }
                    }
                    this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tc.id, content: result })
                }
                continue
            }

            // ── Embedded tool calls ──
            if (content.includes("<tool_call>")) {
                const calls = this.parseEmbeddedToolCalls(content)
                if (calls.length) {
                    this.pushToConvoHistory(channelId, { role: "assistant", content })
                    const results = []
                    for (const tc of calls) {
                        const result = this.checkDedupe(seenCalls, tc.name, tc.args) ?? await this.runTool(tc.name, tc.args)
                        // intercept gif result
                        if (tc.name === "send_gif") {
                            try {
                                const parsed = JSON.parse(result)
                                if (parsed.status === "ok") pendingGifUrl = parsed.url
                            } catch { }
                        }
                        results.push(`[${tc.name} result]\n${result}`)
                    }
                    this.pushToConvoHistory(channelId, { role: "user", content: `<tool_response>\n${results.join("\n\n")}\n</tool_response>` })
                    continue
                }
                // Malformed tag
                log(`⚠️ [MALFORMED TOOL] Raw content: ${content}`)
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                this.pushToConvoHistory(channelId, {
                    role: "user",
                    content: `[System: Your <tool_call> block was malformed or missing its closing </tool_call> tag. Use this exact format:
<tool_call>
{"name": "query_hytale_wiki", "arguments": {"query": "ore types mining"}}
</tool_call>]`
                })
                continue
            }

            // ── Narration guard ──
            if ([...TOOL_NAMES].some(name => content.includes(name)) || content.includes("<tool_call>")) {
                log(`⚠️ [NARRATE] Model described a tool instead of calling it — retrying`)
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                this.pushToConvoHistory(channelId, {
                    role: "user",
                    content: `[System: Do NOT mention tool names or describe tool actions in your natural reply. If you need to use a tool, emit a properly formatted <tool_call> block. If you don't need a tool, just reply naturally.]`
                })
                continue
            }

            // ── Real reply ──
            if (content && content.toLowerCase() !== "none") {
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                log(`✅ [LILY REPLY] ${content}${pendingGifUrl ? ` + GIF: ${pendingGifUrl}` : ""}`)
                return { text: content, gifUrl: pendingGifUrl }
            }

            log(`⚠️ [EMPTY] No content in response`)
            return { text: "I'm not sure about that one!", gifUrl: null }
        }

        return { text: "Sorry, I was distracted and couldn't focus on your question. Could you repeat please?", gifUrl: null }
    }

    // ─── Shared entry point ───────────────────────────────────────────────────

    async handleMessage(channelId, rawInput, logPrefix) {
        const clean = this.sanitizeInput(rawInput)
        if (!clean) return null
        log(`\n💬 [${logPrefix}] ${clean}`)

        return this.withChannelLock(channelId, async () => {
            this.pushToConvoHistory(channelId, { role: "user", content: clean })
            if (this.opts.summarizeEvery > 0 && ++this.userMessageCount % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }
            return this.runToolLoop(channelId)
        })
    }

    chat(channelId, userInput)    { return this.handleMessage(channelId, userInput,  "USER PROMPT") }
    buttIn(channelId, rawMessage) { return this.handleMessage(channelId, rawMessage, "BUTT IN") }
}