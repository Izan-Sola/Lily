import axios from "axios"
import { getStateController } from '../minecraft/neoforgemod-way/lilybot.js'
import { log, logError, sanitizeInput, ToolCallTracker } from './utils.js'
import { ConversationHistory, RawBuffer } from './history.js'
import { SYSTEM_PROMPT, MINECRAFT_SYSTEM_PROMPT, SUMMARIZE_PROMPT } from './prompts.js'
import { ToolExecutor, TOOLS, TOOL_NAMES } from './tools.js'

const DEFAULT_OPTIONS = {
    model: "Lily",
    truncation: true,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    repeatLastN: 64,
    maxReplyTokens: 2048,
    contextWindow: 8000,
    maxConvoMessages: 15,
    maxRawMessages: 15,
    maxToolLoops: 10,
    maxToolRepeats: 1,
    memoryDuplicateMinScore: 0.75,
    memoryRemoveMinScore: 0.70,
    memoryQueryMinScore: 0.35,
    memoryRemoveK: 2,
    episodicQueryMinScore: 0.40,
    episodicDuplicateScore: 0.90,
    summarizeEvery: 16,
    summarizeLastN: 16,
    observeEvery: 22,
    ollamaUrl: "http://localhost:11435",
    vectorDbUrl: "http://localhost:8000",
    knowledgeDbUrl: "http://localhost:8001",
    episodicDbUrl: "http://localhost:8002",
    ollamaTimeout: 120000,
    dbTimeout: 30000,
}

export class Lily {
    constructor(options = {}) {
        this.opts = { ...DEFAULT_OPTIONS, ...options }
        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.channelLocks = new Map()
        this.userMessageCount = 0
        this.observeBuffer = []

        this.tools = new ToolExecutor(this.opts)
    }

    getHistory(channelId) {
        if (!this.convoHistories.has(channelId)) {
            this.convoHistories.set(channelId, new ConversationHistory(this.opts.maxConvoMessages))
        }
        return this.convoHistories.get(channelId)
    }

    getRawBuffer(channelId) {
        if (!this.rawBuffers.has(channelId)) {
            this.rawBuffers.set(channelId, new RawBuffer(this.opts.maxRawMessages))
        }
        return this.rawBuffers.get(channelId)
    }

    async withChannelLock(channelId, fn) {
        while (this.channelLocks.get(channelId)) await new Promise(r => setTimeout(r, 50))
        this.channelLocks.set(channelId, true)
        try { return await fn() } finally { this.channelLocks.set(channelId, false) }
    }

    pushRawMessage(channelId, authorName, content) {
        this.getRawBuffer(channelId).push(authorName, content)
    }

    /**
     * Called before chat() when Lily is pinged or replied to in a channel.
     * Replaces the raw buffer for that channel with the exact messages
     * that appeared before the ping, so Lily always has real context.
     *
     * @param {string} channelId
     * @param {Array<{ authorName: string, content: string }>} recentMessages - oldest first
     */
    injectChannelContext(channelId, recentMessages) {
        const lines = recentMessages.map(m => `${m.authorName}: ${m.content}`)
        this.getRawBuffer(channelId).replace(lines)
        log(`📥 [CONTEXT] Injected ${lines.length} messages into raw buffer for channel ${channelId}`)
    }

    pushToConvoHistory(channelId, message) {
        this.getHistory(channelId).push(message)
    }

    getConvoHistory(channelId) {
        return this.getHistory(channelId).get()
    }

    getRawContext(channelId) {
        return this.getRawBuffer(channelId).get()
    }

    buildMessagesForOllama(channelId, systemPromptOverride = null, opts = {}) {
        const { skipHistory = false, skipRawContext = false } = opts
        const messages = []

        messages.push({ role: "system", content: systemPromptOverride ?? SYSTEM_PROMPT })

        if (!skipRawContext) {
            const rawContext = this.getRawContext(channelId)
            if (rawContext.length) {
                messages.push({
                    role: "system",
                    content: `RECENT CHAT (last ${rawContext.length} messages):\n${rawContext.join("\n")}`
                })
            }
        }

        const history = skipHistory ? [] : this.getConvoHistory(channelId)
        messages.push(...history)

        return messages
    }

    buildUserContent(text, images = []) {
        if (!images || images.length === 0) return text

        const parts = []
        for (const img of images) {
            parts.push({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
            })
        }
        if (text) parts.push({ type: "text", text })
        return parts
    }

    async summarizeAndStore(lines, { logPrefix, maxTokens = 512, memoryTitle, memorySource = "summary", participants = [], emotions = [], importance = 0.5 }) {
        if (lines.length < 2) return
        log(`📝 [${logPrefix}] Summarizing ${lines.length} entries...`)
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, {
                model: this.opts.model,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user", content: lines.join("\n") }
                ],
                stream: false,
                temperature: 0.3,
                max_tokens: maxTokens,
            }, { timeout: this.opts.ollamaTimeout })

            const summary = data.choices?.[0]?.message?.content?.trim()
            if (!summary) return

            await this.tools.episodicAdd({
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
        const history = this.getHistory(channelId)
        const lines = history.lastN(this.opts.summarizeLastN)
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .map(m => `${m.role === "user" ? "User" : "Lily"}: ${m.content}`)

        if (lines.length < 2) return

        const title = `Conversation summary — ${new Date().toISOString().slice(0, 10)}`
        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE",
            maxTokens: 512,
            memoryTitle: title,
            memorySource: "summary",
            importance: 0.5,
        })
    }

    observe(rawMessage) {
        const clean = sanitizeInput(rawMessage)
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

    async sendToOllama(messages) {
        if (getStateController()?.currentStateName === 'DUELING') {
            return { content: "Lily is currently in a duel, she can't reply right now!" }
        }

        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, {
                model: this.opts.model,
                messages,
                stream: false,
                tools: TOOLS,
                temperature: this.opts.temperature,
                top_p: this.opts.topP,
                top_k: this.opts.topK,
                repeat_penalty: this.opts.repeatPenalty,
                repeat_last_n: this.opts.repeatLastN,
                max_tokens: this.opts.maxReplyTokens,
            }, { timeout: this.opts.ollamaTimeout })

            return data.choices?.[0]?.message ?? null
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : ""
            logError(`[OLLAMA] ${err.message} ${detail}`)
            return null
        }
    }

    parseEmbeddedToolCalls(content) {
        const matches = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
        return matches.flatMap(match => {
            try {
                const parsed = JSON.parse(match[1].trim())
                let args = parsed.arguments ?? parsed.args ?? {}
                if (typeof args === "string") try { args = JSON.parse(args) } catch { args = {} }
                return [{ name: parsed.name, args }]
            } catch { return [] }
        })
    }

  async runToolLoop(channelId, systemPromptOverride = null, opts = {}, images = []) {
    const tracker = new ToolCallTracker(this.opts.maxToolRepeats)
    let pendingGifUrl = null
    let firstIteration = true
    const toolsUsedThisTurn = new Set()

    for (let i = 0; i < this.opts.maxToolLoops; i++) {
        log(`🔄 [LOOP ${i + 1}]`)

        let messages = this.buildMessagesForOllama(channelId, systemPromptOverride, opts)

        if (firstIteration && images.length > 0) {
            firstIteration = false
            for (let j = messages.length - 1; j >= 0; j--) {
                if (messages[j].role === "user") {
                    const originalText = typeof messages[j].content === "string" ? messages[j].content : ""
                    messages[j] = {
                        ...messages[j],
                        content: this.buildUserContent(originalText, images)
                    }
                    log(`🖼️ [VISION] Injected ${images.length} image(s) into user message`)
                    break
                }
            }
        } else {
            firstIteration = false
        }

        const msg = await this.sendToOllama(messages)
        if (!msg) return { text: "I'm having trouble thinking right now, sorry!", gifUrl: null }

        const content = (msg.content ?? "").trim()

        // Native tool calls
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

                const name = tc.function.name

                // Block media tools to one per turn
                if ((name === "send_gif" || name === "send_meme") && toolsUsedThisTurn.has(name)) {
                    log(`🚫 [BLOCKED] ${name} already used this turn`)
                    this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tc.id, content: `You already sent a ${name === "send_gif" ? "GIF" : "meme"} this turn. Reply in text only.` })
                    continue
                }

                // Block episodic to one per turn
                if (name === "addto_episodic_memory" && toolsUsedThisTurn.has(name)) {
                    log(`🚫 [BLOCKED] addto_episodic_memory already used this turn`)
                    this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tc.id, content: "Already stored an episodic memory this turn. Do not store another." })
                    continue
                }

                const blocked = tracker.check(name, args, log)
                if (blocked) {
                    this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tc.id, content: blocked })
                    continue
                }

                toolsUsedThisTurn.add(name)
                const result = await this.tools.execute(name, args)

                if (name === "send_gif" || name === "send_meme") {
                    try {
                        const parsed = JSON.parse(result)
                        if (parsed.status === "ok") pendingGifUrl = parsed.url
                    } catch { }
                }

                this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tc.id, content: result })
            }
            continue
        }

        // Embedded tool calls
        if (content.includes("<tool_call>")) {
            const calls = this.parseEmbeddedToolCalls(content)
            if (calls.length) {
                this.pushToConvoHistory(channelId, { role: "assistant", content })

                for (const tc of calls) {
                    const name = tc.name

                    if ((name === "send_gif" || name === "send_meme") && toolsUsedThisTurn.has(name)) {
                        log(`🚫 [BLOCKED] ${name} already used this turn`)
                        this.pushToConvoHistory(channelId, {
                            role: "user",
                            content: `<tool_response>\nYou already sent a ${name === "send_gif" ? "GIF" : "meme"} this turn. Reply in text only.\n</tool_response>`
                        })
                        continue
                    }

                    if (name === "addto_episodic_memory" && toolsUsedThisTurn.has(name)) {
                        log(`🚫 [BLOCKED] addto_episodic_memory already used this turn`)
                        this.pushToConvoHistory(channelId, {
                            role: "user",
                            content: `<tool_response>\nAlready stored an episodic memory this turn. Do not store another.\n</tool_response>`
                        })
                        continue
                    }

                    const blocked = tracker.check(name, tc.args, log)
                    if (blocked) {
                        this.pushToConvoHistory(channelId, {
                            role: "user",
                            content: `<tool_response>\n${blocked}\n</tool_response>`
                        })
                        continue
                    }

                    toolsUsedThisTurn.add(name)
                    const result = await this.tools.execute(name, tc.args)

                    if (name === "send_gif" || name === "send_meme") {
                        try {
                            const parsed = JSON.parse(result)
                            if (parsed.status === "ok") pendingGifUrl = parsed.url
                        } catch { }
                    }

                    this.pushToConvoHistory(channelId, {
                        role: "user",
                        content: `<tool_response>\n${result}\n</tool_response>`
                    })
                }
                continue
            }

            // Malformed tag
            log(`⚠️ [MALFORMED] ${content.slice(0, 200)}`)
            this.pushToConvoHistory(channelId, { role: "assistant", content })
            this.pushToConvoHistory(channelId, {
                role: "user",
                content: `[System: Your <tool_call> was malformed. Use exact format:\n<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>]`
            })
            continue
        }

        // Narration guard
        if ([...TOOL_NAMES].some(name => content.includes(name))) {
            log(`⚠️ [NARRATE] Model described tool instead of calling`)
            this.pushToConvoHistory(channelId, { role: "assistant", content })
            this.pushToConvoHistory(channelId, {
                role: "user",
                content: `[System: Do NOT mention tool names in your reply. Use <tool_call> if needed, otherwise just reply naturally.]`
            })
            continue
        }

        // Real reply
        if (content && content.toLowerCase() !== "none") {
            this.pushToConvoHistory(channelId, { role: "assistant", content })
            log(`✅ [LILY REPLY] ${content.slice(0, 200)}${pendingGifUrl ? ` + GIF` : ""}`)
            return { text: content, gifUrl: pendingGifUrl }
        }

        log(`⚠️ [EMPTY] No content`)
        return { text: "I'm not sure about that one!", gifUrl: null }
    }

    return { text: "Sorry, I got a bit lost. Could you repeat that?", gifUrl: null }
}

    async handleMessage(channelId, rawInput, logPrefix, systemPromptOverride = null, opts = {}, images = []) {
        const clean = sanitizeInput(rawInput)
        if (!clean && images.length === 0) return null

        log(`\n💬 [${logPrefix}] ${clean.slice(0, 200)}${images.length ? ` + ${images.length} image(s)` : ""}`)

        return this.withChannelLock(channelId, async () => {
            this.pushToConvoHistory(channelId, { role: "user", content: clean || "[sent an image]" })

            if (this.opts.summarizeEvery > 0 && ++this.userMessageCount % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }

            return await this.runToolLoop(channelId, systemPromptOverride, opts, images)
        })
    }

    chat(channelId, userInput, systemPromptOverride = null, opts = {}, images = []) {
        return this.handleMessage(channelId, userInput, "USER PROMPT", systemPromptOverride, opts, images)
    }

    buttIn(channelId, rawMessage) {
        return this.handleMessage(channelId, rawMessage, "BUTT IN")
    }
}

export { MINECRAFT_SYSTEM_PROMPT }