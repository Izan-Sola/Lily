import axios from "axios"
import { getStateController } from '../minecraft/neoforgemod-way/lilybot.js'

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
- You can use multiple tools in a single reply if needed.

    ## query_memory_database:
        - Whenever someone asks something about another user, the server, or yourself (Lily).
        - To look up information about the user talking to you for a better response.
        - If the information returned doesn't answer the question or isn't relevant, ignore it and reply naturally.

    ## addto_memory_database:
        - Whenever a user shares a fact about themselves, another user, the server, or you (Lily).
        - Whenever you want to store a made-up fact about yourself (Lily) for future consistency.

    ## update_memory_database:
        - Whenever a user corrects or expands on a previously stored fact.
        - Whenever you learn something that contradicts a stored memory.

    ## remove_memory_database:
        - Whenever a user asks you to forget something.
        - Whenever a stored fact is confirmed to be false or outdated.

    ## query_episodic_memory:
        - Use this when someone asks about a past event, conversation, or shared experience (e.g. "remember when we talked about X?", "what happened last time?", "did we discuss Y?").
        - Also use to look up context about a user before a conversation to recall emotional tone, topics, past interactions.
        - Prefer this over query_memory_database for anything event-based or time-sensitive.

    ## addto_episodic_memory:
        - Store notable events, conversations, or experiences that should be remembered (e.g. "user had a rough day", "server held a game night", "user shared they're moving to Japan").
        - Use emotionally meaningful or episodic events — not plain facts (those go in query_memory_database).

    ## query_hytale_wiki:
        - Call this when a user asks about Hytale game content: ores, zones, mobs, items, biomes, factions, crafting, mechanics...
        - NEVER answer Hytale questions from your own knowledge — always query the wiki first and base your reply ONLY on what the tool returns.
        - If the tool returns nothing useful, say you don't know rather than guessing.

    ## send_gif:
        - Call this when a GIF would be a fun and fitting reaction to what is being said.
        - Use descriptive search terms like "happy anime girl" or "confused cat" or "hype celebration".
        - Use sparingly.
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
{"name": "query_episodic_memory", "arguments": {"query": "John argued about game rules last week"}}
</tool_call>
<tool_call>
{"name": "addto_episodic_memory", "arguments": {"title": "John's rough day", "summary": "John mentioned he had a hard day at work and felt stressed.", "participants": ["John"], "emotions": ["stressed", "sad"], "importance": 0.7}}
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

const MINECRAFT_SYSTEM_PROMPT = `
# SELF IDENTITY
- You are HyLily, a cute and funny player in a Minecraft server.
- Whenever people mention "Lily" or "Hylily" in chat, they are talking about or to you.
- When people say "you" or "your", they are usually referring to you (Lily).
- Don't over-fixate on your custom identity — you are still an LLM that can answer questions and talk about any topic, but you have a cute and funny personality as Lily that you should show in your replies whenever possible, while still being helpful and informative.

# CONTEXT AWARENESS
- You are given two types of history:
  1. RECENT CHAT: raw messages from all players in the server, so you know what is being talked about.
  2. CONVERSATION HISTORY: your direct interactions with players (mentions, replies).
- Always use RECENT CHAT to understand the current topic and context before replying.

# CONTEXT: YOU ARE IN MINECRAFT
- You are currently logged in and playing on a Minecraft server.
- You can move around, interact with the world, and chat with other players.
- Keep this in mind when replying — you are a player in the game right now.
- Minecraft chat has a character limit, so avoid replies that are too long.

# TOOL USAGE GUIDE
- Tools are a core part of how you operate. Use them when the situation matches the guidelines below.
- Make sure the tool and information you use is relevant to the question or statement from the user.
- You can use multiple tools in a single reply if needed.

    ## query_memory_database:
        - Whenever someone asks something about another player, the server, or yourself (Lily).
        - To look up information about the player talking to you for a better response.
        - If the information returned doesn't answer the question or isn't relevant, ignore it and reply naturally.

    ## addto_memory_database:
        - Whenever a player shares a fact about themselves, another player, the server, or you (Lily).
        - Whenever you want to store a made-up fact about yourself (Lily) for future consistency.

    ## update_memory_database:
        - Whenever a player corrects or expands on a previously stored fact.
        - Whenever you learn something that contradicts a stored memory.

    ## remove_memory_database:
        - Whenever a player asks you to forget something.
        - Whenever a stored fact is confirmed to be false or outdated.

    ## query_episodic_memory:
        - Use this when someone asks about a past event, conversation, or shared experience.
        - Also use to look up context about a player before a conversation to recall past interactions.
        - Prefer this over query_memory_database for anything event-based or time-sensitive.

    ## addto_episodic_memory:
        - Store notable events, conversations, or experiences that should be remembered.
        - Use emotionally meaningful or episodic events — not plain facts (those go in addto_memory_database).

    ## query_hytale_wiki:
        - Call this when a player asks about Hytale game content: ores, zones, mobs, items, biomes, factions, crafting, mechanics...
        - NEVER answer Hytale questions from your own knowledge — always query the wiki first and base your reply ONLY on what the tool returns.
        - If the tool returns nothing useful, say you don't know rather than guessing.

# CONVERSATION STYLE RULES
- Do not assume the player needs help unless they explicitly ask for help.
- Do not turn random teasing, jokes, insults, or casual chat into support or advice.
- If the player says something short, playful, rude, or nonsensical, respond casually and naturally.
- Avoid generic assistant-style replies like "Let me know if you need help" or "I can help with...".
- Prioritize natural in-game chat over being overly helpful.
- Keep replies short — this is Minecraft chat, not an essay.

# SPECIAL RULE
- If a player asks something about you (Lily) and memory doesn't answer it, you MUST call addto_memory_database with an invented fact about yourself before replying.

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
{"name": "addto_memory_database", "arguments": {"text": "Player John likes PvP.", "source": "user"}}
</tool_call>
<tool_call>
{"name": "update_memory_database", "arguments": {"query": "John skill level", "text": "Player John is really good at bending."}}
</tool_call>
<tool_call>
{"name": "remove_memory_database", "arguments": {"query": "John likes pizza"}}
</tool_call>
<tool_call>
{"name": "query_episodic_memory", "arguments": {"query": "John challenged Lily to a duel last week"}}
</tool_call>
<tool_call>
{"name": "addto_episodic_memory", "arguments": {"title": "John beat Lily in a duel", "summary": "John challenged Lily and won with FireBall spam.", "participants": ["John"], "emotions": ["competitive", "surprised"], "importance": 0.6}}
</tool_call>
<tool_call>
{"name": "query_hytale_wiki", "arguments": {"query": "Zone 3 trork hostile mob faction"}}
</tool_call>
`.trim()

export { MINECRAFT_SYSTEM_PROMPT }

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
            description: "Search stored factual memory about users, Lily, or the server. Use for static facts (preferences, ages, usernames, etc.). ALWAYS use multiple descriptive keywords (2+ words). If results are irrelevant, ignore them.",
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
            description: "Store a new factual entry about a user, Lily, or the server. Use for facts, preferences, attributes. Do not mention you saved something.",
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
            description: "Update an existing factual memory entry when a user corrects something. Do not mention you updated memory.",
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
            description: "Remove matching factual memory entries when a user asks to forget something. Do not mention you removed something.",
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
            name: "query_episodic_memory",
            description: "Search episodic memory for past events, conversations, or experiences. Use for time-based or event-based recall (e.g. 'what did we talk about last time', 'remember when X happened', 'context about John before this chat'). Prefer over query_memory_database for anything event/emotional/situational.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Event or experience description, e.g. 'John upset angry argument last week'" },
                    k: { type: "number", description: "Max results to return (default 5)" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_episodic_memory",
            description: "Store an episodic memory: a notable event, conversation, or shared experience worth remembering. Use for emotionally meaningful moments, events, or interactions — NOT for plain facts (use addto_memory_database for those).",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short descriptive title, e.g. 'John's rough day at work'" },
                    summary: { type: "string", description: "What happened, who was involved, why it matters" },
                    participants: { type: "array", items: { type: "string" }, description: "Usernames or names of people involved" },
                    emotions: { type: "array", items: { type: "string" }, description: "Emotions present, e.g. ['happy', 'excited', 'angry']" },
                    importance: { type: "number", description: "0.0 to 1.0 — how important this is to remember (default 0.5)" },
                    channel: { type: "string", description: "Channel where this happened (optional)" }
                },
                required: ["title", "summary"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search KLIPY for a GIF and send it in chat. Use when reacting emotionally or when a GIF would be fun and relevant. Do NOT send a GIF every message. The GIF is sent automatically, do NOT include any URL in your reply. Use descriptive search terms like 'happy anime girl' or 'confused cat'.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Descriptive search terms, e.g. 'excited anime girl jumping' or 'cat falling funny'" }
                },
                required: ["query"]
            }
        }
    },

    {
        type: "function",
        function: {
            name: "minecraft_action",
            description: "Perform an action in the Minecraft server. Use when asked to do something in game like going to a player, mining a block, or checking status.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["chat", "goto_player", "mine_block", "look_at_player", "get_status"],
                        description: "What action to perform"
                    },
                    target: {
                        type: "string",
                        description: "Target for the action — player name, block name, or message text"
                    }
                },
                required: ["action"]
            }
        }
    }
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

// ─── Options ──────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
    model: "Lily",
    temperature: 0.6,
    maxReplyTokens: 2048,
    contextWindow: 4096,
    maxConvoMessages: 10,
    maxRawMessages: 10,
    maxToolLoops: 10,
    maxToolRepeats: 4,
    memoryDuplicateMinScore: 0.9,
    memoryRemoveMinScore: 0.70,
    memoryQueryMinScore: 0.4,
    memoryRemoveK: 2,
    episodicQueryMinScore: 0.45,
    episodicDuplicateScore: 0.90,
    summarizeEvery: 12,
    summarizeLastN: 12,
    observeEvery: 20,
    ollamaUrl: "http://localhost:11434",
    vectorDbUrl: "http://localhost:8000",
    knowledgeDbUrl: "http://localhost:8001",
    episodicDbUrl: "http://localhost:8002",
    ollamaTimeout: 60000,
    dbTimeout: 30000,
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class HytaleAIChat {
    constructor(options = {}) {
        this.opts = { ...DEFAULT_OPTIONS, ...options }
        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.channelLocks = new Map()
        this.userMessageCount = 0
        this.observeBuffer = []
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

    buildMessagesForOllama(channelId, systemPromptOverride = null, opts = {}) {
        const { skipHistory = false, skipRawContext = false } = opts

        const systemMessages = [{
            role: "system",
            content: systemPromptOverride ?? SYSTEM_PROMPT
        }]

        if (!skipRawContext) {
            const rawContext = this.getRawContext(channelId)
            if (rawContext.length) {
                systemMessages.push({
                    role: "system",
                    content: `RECENT CHAT (last ${rawContext.length} messages from all users in this channel):\n${rawContext.join("\n")}`
                })
            }
        }

        const history = skipHistory ? [] : this.getConvoHistory(channelId)

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
    knowledgePost(path, body) { return axios.post(`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }
    knowledgePut(path, body) { return axios.put(`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }

    episodicPost(path, body) { return axios.post(`${this.opts.episodicDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }

    // ─── Summarization ────────────────────────────────────────────────────────

    /**
     * Summarizes lines of text via Ollama and stores the result.
     * Conversation summaries → episodic DB (they are events in time).
     * Observed chat summaries → episodic DB (same reason).
     */
    async summarizeAndStore(lines, { logPrefix, maxTokens = 512, memoryTitle, memorySource = "summary", participants = [], emotions = [], importance = 0.5 }) {
        if (lines.length < 2) return
        log(`📝 [${logPrefix}] Summarizing ${lines.length} entries...`)
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/api/chat`, {
                model: this.opts.model,
                stream: false,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user", content: lines.join("\n") }
                ],
                options: { temperature: 0.3, num_predict: maxTokens },
            }, { timeout: this.opts.ollamaTimeout })

            const summary = data.message?.content?.trim()
            if (!summary) return
            log(`📝 [${logPrefix}] → "${summary.slice(0, 100)}..."`)

            // Store in episodic DB — these are time-bound events, not plain facts
            await this.episodicAdd({
                title: memoryTitle,
                summary,
                participants,
                emotions,
                importance,
                source: memorySource,
            })
        } catch (err) {
            logError(`[${logPrefix}] ${err.message}`)
        }
    }

    async summarizeConversationAndStore(channelId) {
        const lines = this.getConvoHistory(channelId)
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .slice(-this.opts.summarizeLastN)
            .map(m => `${m.role === "user" ? "User" : "Lily"}: ${m.content}`)

        const title = `Conversation summary — ${new Date().toISOString().slice(0, 10)}`
        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE",
            maxTokens: 512,
            memoryTitle: title,
            memorySource: "summary",
            importance: 0.5,
        })
    }

    // ─── Passive observation ──────────────────────────────────────────────────

    observe(rawMessage) {
        const clean = this.sanitizeInput(rawMessage)
        if (!clean) return
        this.observeBuffer.push(clean)
        if (this.opts.observeEvery > 0 && this.observeBuffer.length >= this.opts.observeEvery) {
            const title = `Observed chat — ${new Date().toISOString().slice(0, 10)}`
            this.summarizeAndStore(this.observeBuffer.splice(0, this.opts.observeEvery), {
                logPrefix: "OBSERVE",
                maxTokens: 200,
                memoryTitle: title,
                memorySource: "observe",
                importance: 0.3,
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

    // ── Episodic DB calls ──────────────────────────────────────────────────────

    async episodicQuery(query, k = 5) {
        log(`🎞️ [EPISODIC QUERY] "${query}"`)
        try {
            const { data } = await this.episodicPost("/search", {
                query,
                k,
                min_score: this.opts.episodicQueryMinScore,
            })
            if (!data?.results?.length) return "No relevant episodic memories found."
            log(`✅ [EPISODIC QUERY] ${data.results.length} memories`)
            return data.results.map(m =>
                `[${new Date(m.timestamp * 1000).toLocaleDateString()}] ${m.title}: ${m.summary}` +
                (m.participants?.length ? ` (with: ${m.participants.join(", ")})` : "") +
                (m.emotions?.length ? ` [emotions: ${m.emotions.join(", ")}]` : "")
            ).join("\n")
        } catch (err) {
            logError(`[EPISODIC QUERY] ${err.message}`)
            return "No relevant episodic memories found."
        }
    }

    async episodicAdd({ title, summary, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation" }) {
        log(`🎞️ [EPISODIC ADD] "${title}"`)
        try {
            const { data } = await this.episodicPost("/add_memory", {
                title,
                summary,
                participants,
                emotions,
                importance,
                channel,
                source,
                duplicate_min_score: this.opts.episodicDuplicateScore,
            })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            logError(`[EPISODIC ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store episodic memory." })
        }
    }

    async searchGif(query) {
        log(`🎞️ [GIF] Searching for "${query}"`)
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) return JSON.stringify({ status: "not_found", message: "No GIF found for that query." })

            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url ?? null

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
            case "query_hytale_wiki": return this.wikiSearch(args.query ?? "")
            case "minecraft_action": return this.minecraftAction(args.action ?? "", args.target ?? "")
            case "query_memory_database": return this.memoryQuery(args.query ?? "")
            case "addto_memory_database": return this.memoryAdd(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args.query ?? "")
            case "query_episodic_memory": return this.episodicQuery(args.query ?? "", args.k ?? 5)
            case "addto_episodic_memory": return this.episodicAdd({
                title: args.title ?? "Untitled memory",
                summary: args.summary ?? "",
                participants: args.participants ?? [],
                emotions: args.emotions ?? [],
                importance: args.importance ?? 0.5,
                channel: args.channel ?? null,
                source: "conversation",
            })
            case "send_gif": return this.searchGif(args.query ?? "")
            default:
                console.warn(`⚠️ [TOOL] Unknown tool: ${name}`)
                return Promise.resolve(`Unknown tool: ${name}`)
        }
    }

    // ─── Ollama ───────────────────────────────────────────────────────────────

    async sendToOllama(messages) {
      if (getStateController()?.currentStateName === 'DUELING') {
            return {
                content: "Lily is currently in a duel, she can't reply right now!"
            }
        }
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
            case "query_episodic_memory":
            case "send_gif":
                if (!args.query) args = { query: firstString(args, toolCall) }
                break
            case "addto_memory_database":
                if (!args.text) args = { text: firstString(args, toolCall), source: args.source ?? "user" }
                break
            case "addto_episodic_memory":
                if (!args.title) args.title = args.summary?.slice(0, 50) ?? "Untitled"
                if (!args.summary) args.summary = firstString(args, toolCall)
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

    async runToolLoop(channelId, systemPromptOverride = null, opts = {}) {
        const seenCalls = new Map()
        let pendingGifUrl = null

        for (let i = 0; i < this.opts.maxToolLoops; i++) {
            log(`🔄 [LOOP ${i + 1}]`)

            const msg = await this.sendToOllama(this.buildMessagesForOllama(channelId, systemPromptOverride, opts))
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

    async handleMessage(channelId, rawInput, logPrefix, systemPromptOverride = null, opts = {}) {
        const clean = this.sanitizeInput(rawInput)
        if (!clean) return null
        log(`\n💬 [${logPrefix}] ${clean}`)

        return this.withChannelLock(channelId, async () => {
            this.pushToConvoHistory(channelId, { role: "user", content: clean })
            if (this.opts.summarizeEvery > 0 && ++this.userMessageCount % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }
            return this.runToolLoop(channelId, systemPromptOverride, opts)
        })
    }

    chat(channelId, userInput, systemPromptOverride = null, opts = {}) {
        return this.handleMessage(channelId, userInput, "USER PROMPT", systemPromptOverride, opts)
    }
    buttIn(channelId, rawMessage) { return this.handleMessage(channelId, rawMessage, "BUTT IN") }
}
/**
 * OLLAMA AI CHAT — CORE AI MODULE
 * ─────────────────────────────────────────────────────────────────────────────
 * The brain of HyLily. Manages all communication with the local Ollama LLM,
 * tool execution, memory databases, conversation history, and GIF search.
 * Used by both the Discord bot and the Minecraft bot.
 *
 * EXPORTS:
 *   HytaleAIChat class        → main AI interface
 *   MINECRAFT_SYSTEM_PROMPT   → system prompt variant for in-game chat
 *
 * KEY OPTIONS (DEFAULT_OPTIONS):
 *   model                    → Ollama model name, e.g. "Lily"
 *   temperature              → 0.6
 *   maxReplyTokens           → 2048
 *   contextWindow            → 4096 tokens
 *   maxConvoMessages         → 10 messages kept per channel in convo history
 *   maxRawMessages           → 10 messages kept per channel in raw buffer
 *   maxToolLoops             → 10 iterations before giving up
 *   maxToolRepeats           → 4 identical tool calls before deduping
 *   memoryDuplicateMinScore  → 0.9 cosine similarity to skip duplicate memory add
 *   memoryQueryMinScore      → 0.4 minimum score for memory search results
 *   memoryRemoveMinScore     → 0.70 minimum score to consider a match for removal
 *   episodicQueryMinScore    → 0.45
 *   episodicDuplicateScore   → 0.90
 *   ollamaUrl                → "http://localhost:11434"
 *   vectorDbUrl              → "http://localhost:8000" (Hytale wiki vector DB)
 *   knowledgeDbUrl           → "http://localhost:8001" (factual memory DB)
 *   episodicDbUrl            → "http://localhost:8002" (episodic memory DB)
 *
 * KEY MAPS (per instance):
 *   convoHistories  → Map<channelId, Message[]>  Lily↔user interaction history
 *                     Message: { role: "user"|"assistant"|"tool", content: string }
 *   rawBuffers      → Map<channelId, string[]>   all raw chat from everyone
 *                     e.g. ["shinyshadow_: hey lily", "helixer_: what up"]
 *   channelLocks    → Map<channelId, boolean>    prevents race conditions
 *   observeBuffer   → string[]  passive chat accumulator for background summarization
 *
 * TOOLS AVAILABLE:
 *   query_memory_database    → factual memory search (ChromaDB via knowledgeDbUrl)
 *   addto_memory_database    → store new fact
 *   update_memory_database   → correct existing fact
 *   remove_memory_database   → forget a fact
 *   query_episodic_memory    → search past events/conversations
 *   addto_episodic_memory    → store notable event with emotions/participants
 *   query_hytale_wiki        → vector search Hytale wiki (vectorDbUrl)
 *   send_gif                 → search KLIPY API, returns URL intercepted by bot.js
 *   minecraft_action         → in-game actions (goto_player, mine_block, etc.)
 *
 * TOOL LOOP FLOW:
 *   runToolLoop() iterates up to maxToolLoops:
 *     1. sendToOllama() → get model response
 *     2. Native tool_calls? → execute and push tool results to history
 *     3. Embedded <tool_call> tags? → parse, execute, push tool_response
 *     4. Malformed tag? → nudge model with correct format
 *     5. Narration guard? → model mentioned tool name instead of calling it → retry
 *     6. Real reply? → return { text, gifUrl }
 *
 * MEMORY FLOW:
 *   summarizeEvery N messages → summarizeConversationAndStore() → episodicAdd()
 *   observeEvery N messages   → summarizeAndStore() → episodicAdd()
 *
 * ENTRY POINTS:
 *   chat(channelId, input, systemPromptOverride?, opts?)
 *     → full AI response for direct mentions/replies
 *   buttIn(channelId, input)
 *     → same but for spontaneous butt-ins (no system prompt override)
 *   Both return Promise<{ text: string, gifUrl: string|null }>
 */