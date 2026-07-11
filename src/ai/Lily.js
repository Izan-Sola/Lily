import axios from "axios"
import { getStateController } from '../minecraft/neoforgemod-way/lilybot.js'
import { log, logError, sanitizeInput, ToolCallTracker } from './utils.js'
import { ConversationHistory, RawBuffer } from './history.js'
import { SYSTEM_PROMPT, SUMMARIZE_PROMPT } from './prompts.js'
import { ToolExecutor, TOOLS, TOOL_NAMES } from './tools.js'

const DEFAULT_OPTIONS = {
    model: "Lily",
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.08,
    repeat_penalty: 1.08,
    frequency_penalty: 0.15,
    repeat_last_n: 256,
    presence_penalty: 0.35, 
    max_tokens: 4096,       
    maxConvoMessages: 20,
    maxRawMessages: 24,
    maxToolLoops: 15,
    maxToolRepeats: 1,
    memoryDuplicateMinScore: 0.75,
    memoryRemoveMinScore: 0.70,
    memoryQueryMinScore: 0.3,
    memoryRemoveK: 2,
    // Raised from 0.40 — was loose enough that tangential queries (e.g.
    // "server members") kept pulling back unrelated, already-resolved
    // episodic entries (the Kiss Marry Kill saga) into every reply.
    episodicQueryMinScore: 0.60,
    // Lowered from 0.90 — was strict enough that reworded versions of the
    // same event ("challenge involves..." vs "challenge involved...")
    // were treated as distinct memories instead of duplicates, so the
    // same event kept getting re-stored instead of collapsed.
    episodicDuplicateScore: 0.78,
    // Matches the episodic DB's own /remove_by_query defaults (k=3,
    // min_score=0.70). Used by the new remove_episodic_memory tool.
    episodicRemoveMinScore: 0.70,
    episodicRemoveK: 3,
    summarizeEvery: 16,
    summarizeLastN: 16,
    observeEvery: 22,
    ollamaUrl: "http://localhost:11435",
    vectorDbUrl: "http://localhost:8000",
    knowledgeDbUrl: "http://localhost:8001",
    episodicDbUrl: "http://localhost:8002",
    blogUrl: "http://localhost:1234",
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
        this._resumedIds = new Map()
        this._replayCounts = new Map()
    }
    buildSystemPrompt(extraInstructions = null) {
        return extraInstructions ? `${SYSTEM_PROMPT}\n\n${extraInstructions}` : SYSTEM_PROMPT
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

    /**
     * Like withChannelLock, but never waits. If the channel is already
     * locked (Lily is still generating a reply / running tools), the
     * caller is told to skip instead of queueing up behind it. This is
     * what prevents two near-simultaneous messages from both feeding
     * into her context — the second one is dropped rather than replayed
     * after the first reply completes.
     *
     * NOTE: the check-then-set below is synchronous (no await between
     * them), so it's safe from races in Node's single-threaded event loop.
     */
    async tryChannelLock(channelId, fn) {
        if (this.channelLocks.get(channelId)) {
            return { skipped: true }
        }
        this.channelLocks.set(channelId, true)
        try {
            return { skipped: false, result: await fn() }
        } finally {
            this.channelLocks.set(channelId, false)
        }
    }

    pushRawMessage(channelId, authorName, content) {
        this.getRawBuffer(channelId).push(authorName, content)
    }

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

    /**
     * Build the messages array for Ollama.
     *
     * KEY CHANGE: RECENT CHAT is no longer a separate `system` block.
     * Instead, it's prepended as a "[Recent chat]" section on the FIRST
     * user-turn content (or as its own leading user turn if history is
     * empty). Chat models attend to user/assistant turns far better than
     * to stacked system messages — this keeps the model's attention on
     * "this is part of the conversation" rather than "this is an
     * instruction".
     */
    buildMessagesForOllama(channelId, systemPromptOverride = null, opts = {}) {
        const { skipHistory = false, skipRawContext = false } = opts
        const messages = []

        messages.push({ role: "system", content: systemPromptOverride ?? SYSTEM_PROMPT })

        const history = skipHistory ? [] : [...this.getConvoHistory(channelId)]

        if (!skipRawContext) {
            const rawContext = this.getRawContext(channelId)
            if (rawContext.length) {
                const block = `[Recent chat]\n${rawContext.join("\n")}\n[End recent chat]\n\n`

                // Find the last user-role message and prepend the block to it.
                // This keeps RECENT CHAT as part of the live conversation flow
                // instead of a detached system instruction.
                let injected = false
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === "user" && typeof history[i].content === "string") {
                        history[i] = { ...history[i], content: block + history[i].content }
                        injected = true
                        break
                    }
                }
                if (!injected) {
                    // No prior user turn (fresh channel) — add it as its own turn
                    history.push({ role: "user", content: block.trim() })
                }
            }
        }

        messages.push(...history)
        return messages
    }

    buildUserContent(text, images = []) {
        if (!images || images.length === 0) return text
        const parts = []
        for (const img of images) {
            parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
        }
        if (text) parts.push({ type: "text", text })
        return parts
    }

    async summarizeAndStore(lines, { logPrefix, maxTokens = 300, memoryTitle, memorySource = "summary", participants = [], emotions = [], importance = 0.5 }) {
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

            await this.tools.episodicAdd({ title: memoryTitle, summary, participants, emotions, importance, source: memorySource })
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

        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE",
            maxTokens: 300,
            memoryTitle: `Conversation summary — ${new Date().toISOString().slice(0, 10)}`,
            memorySource: "summary",
            importance: 0.5,
        })
    }

    observe(rawMessage) {
        const clean = sanitizeInput(rawMessage)
        if (!clean) return
        this.observeBuffer.push(clean)
        if (this.opts.observeEvery > 0 && this.observeBuffer.length >= this.opts.observeEvery) {
            this.summarizeAndStore(this.observeBuffer.splice(0, this.opts.observeEvery), {
                logPrefix: "OBSERVE",
                maxTokens: 150,
                memoryTitle: `Observed chat — ${new Date().toISOString().slice(0, 10)}`,
                memorySource: "observe",
                importance: 0.3,
            })
        }
    }

    async sendToOllama(messages, foreignTools = []) {
        if (getStateController()?.currentStateName === 'DUELING') {
            return { content: "Lily is currently in a duel, she can't reply right now!" }
        }
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, {
                model: this.opts.model,
                messages,
                stream: false,
                tools: foreignTools.length ? [...TOOLS, ...foreignTools] : TOOLS,
                temperature: this.opts.temperature,
                top_p: this.opts.top_p,
                top_k: this.opts.top_k,
                min_p: this.opts.min_p,
                repeat_penalty: this.opts.repeat_penalty,
                repeat_last_n: this.opts.repeat_last_n,
                max_tokens: this.opts.max_tokens,
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

    /**
     * Run one tool/reply turn for a tool call. Returns true if it produced
     * a result that was pushed to history, false if blocked.
     */
    async runOneToolCall(channelId, name, args, tracker, toolsUsedThisTurn, pushFn) {
        if ((name === "send_gif" || name === "send_meme") && toolsUsedThisTurn.has(name)) {
            log(`🚫 [BLOCKED] ${name} already used this turn`)
            pushFn(`You already sent a ${name === "send_gif" ? "GIF" : "meme"} this turn. Reply in text only.`)
            return null
        }
        if (name === "addto_episodic_memory" && toolsUsedThisTurn.has(name)) {
            log(`🚫 [BLOCKED] addto_episodic_memory already used this turn`)
            pushFn("Already stored an episodic memory this turn. Do not store another.")
            return null
        }

        const blocked = tracker.check(name, args)
        if (blocked) {
            pushFn(blocked)
            return null
        }

        toolsUsedThisTurn.add(name)
        const result = await this.tools.execute(name, args)

        let gifUrl = null
        if (name === "send_gif" || name === "send_meme") {
            try {
                const parsed = JSON.parse(result)
                if (parsed.status === "ok") gifUrl = parsed.url
            } catch { }
        }

        pushFn(result)
        return gifUrl
    }

    async resumeToolLoop(channelId, toolResults, systemPromptOverride = null, opts = {}, images = []) {
        return this.withChannelLock(channelId, async () => {
            // Duplicate resend from the client — every id already has a final
            // answer, just hand it back instead of re-running inference.
            const allSeen = toolResults.length > 0 && toolResults.every(tr => this._resumedIds.has(tr.tool_call_id))
            if (allSeen) {
                log(`⏭️ [DUPLICATE RESUME] Already answered: ${toolResults.map(t => t.tool_call_id).join(", ")}`)
                return this._resumedIds.get(toolResults[toolResults.length - 1].tool_call_id)
            }

            for (const tr of toolResults) {
                if (this._resumedIds.has(tr.tool_call_id)) continue

                // "Failed to edit undefined" / "Failed to edit file://..." means
                // the filepath the model sent didn't match the file the editor
                // actually has open. Without this hint the model just retries
                // the same relative path forever.
                let content = tr.content
                if (typeof content === "string" && content.startsWith("Failed to edit")) {
                    content += " The filepath you sent didn't match. Use the exact path shown in your last read_file or read_currently_open_file result — not a shortened or relative guess."
                }

                this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tr.tool_call_id, content })
            }

            const result = await this.runToolLoop(channelId, systemPromptOverride, opts, images)
            for (const tr of toolResults) this._resumedIds.set(tr.tool_call_id, result)

            if (result?.text) this.pushHistoryToBlog(channelId)
            return result
        })
    }

    /**
     * Run the tool loop for one turn.
     *
     * IMPORTANT: native tool round-trips (memory lookups, GIF/meme
     * searches, malformed-call corrections, narration-guard nudges) are
     * kept in a *local scratch array* for this turn only — they're used
     * to build the messages sent to Ollama during the loop, but they are
     * NOT written into the persisted ConversationHistory. Only the final
     * user-visible reply gets persisted.
     *
     * Why: previously every raw tool result (e.g. a full episodic memory
     * dump) got permanently pushed into history. That meant one hot topic
     * (e.g. a Kiss/Marry/Kill drama) could dominate the next several
     * turns' context verbatim, causing Lily to keep dragging the
     * conversation back to it even when the topic had clearly moved on —
     * the model was just being handed the same raw text again and again
     * as if it were freshly relevant. The final reply already incorporates
     * whatever the tool found, so there's no need to keep the scratch
     * work around after the turn ends.
     *
     * The one exception is a "foreign tool" handoff (an external/MCP tool
     * call that this function returns early to await) — that DOES get
     * persisted, because resumeToolLoop needs it later to match up the
     * tool_call_id when the result comes back.
     */
    async runToolLoop(channelId, systemPromptOverride = null, opts = {}, images = []) {
        const tracker = new ToolCallTracker(this.opts.maxToolRepeats)
        let pendingGifUrl = null
        const toolsUsedThisTurn = new Set()
        let imagesInjected = false
        const foreignTools = opts.tools ?? []
        const foreignToolNames = new Set(foreignTools.map(t => t.function?.name).filter(Boolean))
        const scratch = []

        for (let i = 0; i < this.opts.maxToolLoops; i++) {
            log(`🔄 [LOOP ${i + 1}]`)
            let messages = this.buildMessagesForOllama(channelId, systemPromptOverride, opts)
            messages.push(...scratch)

            if (!imagesInjected && images.length > 0) {
                imagesInjected = true
                for (let j = messages.length - 1; j >= 0; j--) {
                    if (messages[j].role === "user") {
                        const originalText = typeof messages[j].content === "string" ? messages[j].content : ""
                        messages[j] = { ...messages[j], content: this.buildUserContent(originalText, images) }
                        break
                    }
                }
            }

            const msg = await this.sendToOllama(messages, foreignTools)
            if (!msg) return { text: "I'm having trouble thinking right now, sorry!", gifUrl: null }

            const content = (msg.content ?? "").trim()

            if (msg.tool_calls?.length) {
                const foreignCalls = msg.tool_calls.filter(tc => foreignToolNames.has(tc.function.name))

                if (foreignCalls.length) {
                    log(`🔌 [HANDOFF] ${foreignCalls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(" | ")} -> Continue`)
                    if (foreignCalls.length > 1) {
                        log(`⚠️ [MULTI-TOOL] Model tried ${foreignCalls.length} tool calls at once — only forwarding the first`)
                    }
                    const single = foreignCalls[0]
                    // Persisted: this genuinely needs to survive until the
                    // external tool result comes back via resumeToolLoop.
                    this.pushToConvoHistory(channelId, { role: "assistant", content: msg.content ?? "", tool_calls: [single] })
                    return { text: msg.content ?? "", gifUrl: null, tool_calls: [single] }
                }

                log(`🔧 [NATIVE] ${msg.tool_calls.map(tc => tc.function.name).join(", ")}`)
                scratch.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls })

                for (const tc of msg.tool_calls) {
                    let args = {}
                    try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { }
                    const gif = await this.runOneToolCall(
                        channelId, tc.function.name, args, tracker, toolsUsedThisTurn,
                        (text) => scratch.push({ role: "tool", tool_call_id: tc.id, content: text })
                    )
                    if (gif) pendingGifUrl = gif
                }
                continue
            }

            // Embedded tool calls
            if (content.includes("<tool_call>")) {
                const calls = this.parseEmbeddedToolCalls(content)
                if (calls.length) {
                    scratch.push({ role: "assistant", content })

                    for (const tc of calls) {
                        const gif = await this.runOneToolCall(
                            channelId, tc.name, tc.args, tracker, toolsUsedThisTurn,
                            (text) => scratch.push({ role: "user", content: `<tool_response>\n${text}\n</tool_response>` })
                        )
                        if (gif) pendingGifUrl = gif
                    }
                    continue
                }

                log(`⚠️ [MALFORMED] ${content.slice(0, 200)}`)
                scratch.push({ role: "assistant", content })
                scratch.push({
                    role: "user",
                    content: `[System: Your <tool_call> was malformed. Use exact format:\n<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>]`
                })
                continue
            }

            // Narration guard
            if ([...TOOL_NAMES].some(name => content.includes(name))) {
                log(`⚠️ [NARRATE] Model described tool instead of calling`)
                scratch.push({ role: "assistant", content })
                scratch.push({
                    role: "user",
                    content: `[System: Do NOT mention tool names in your reply. Use <tool_call> if needed, otherwise just reply naturally.]`
                })
                continue
            }

            // Real reply — only this gets persisted into ConversationHistory.
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

    // ── Blog history push ──────────────────────────────────────────────────────
    // Fire-and-forget: push the user↔lily exchange to the blog server so it
    // can weave real conversation into the daily blog post.
    pushHistoryToBlog(channelId) {
        const messages = this.getHistory(channelId).get()
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .map(m => ({ role: m.role, content: m.content.trim() }))

        if (!messages.length) return

        axios.post(`${this.opts.blogUrl}/api/history`, {
            channelId,
            messages,
        }, { timeout: 3000 }).catch(err => {
            log(`📝 [BLOG HISTORY] Push failed (non-fatal): ${err.message}`)
        })
    }

    /**
     * Handle an incoming message. If Lily is already mid-reply for this
     * channel (still generating / running tools from a previous message),
     * the new message is dropped rather than queued. This is intentional:
     * queueing meant a second, near-simultaneous message would still get
     * processed right after the first reply finished, feeding Lily a
     * "new" turn that was really written before she'd even replied to the
     * first one — that's what was causing her to confuse herself.
     */
    async handleMessage(channelId, rawInput, logPrefix, systemPromptOverride = null, opts = {}, images = []) {
        const clean = sanitizeInput(rawInput)
        if (!clean && images.length === 0) return null

        if (this.channelLocks.get(channelId)) {
            log(`🚫 [BUSY] Ignoring message in channel ${channelId} while Lily is still replying: ${clean.slice(0, 100)}`)
            return null
        }

        log(`\n💬 [${logPrefix}] ${clean.slice(0, 200)}${images.length ? ` + ${images.length} image(s)` : ""}`)

        const { skipped, result } = await this.tryChannelLock(channelId, async () => {
            this.pushToConvoHistory(channelId, { role: "user", content: clean || "[sent an image]" })

            if (this.opts.summarizeEvery > 0 && ++this.userMessageCount % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }

            const loopResult = await this.runToolLoop(channelId, systemPromptOverride, opts, images)

            // Push exchange to blog (fire and forget — blog might be down, that's fine)
            if (loopResult?.text) {
                this.pushHistoryToBlog(channelId)
            }

            return loopResult
        })

        if (skipped) {
            log(`🚫 [BUSY] Ignoring message in channel ${channelId} while Lily is still replying (race)`)
            return null
        }

        return result
    }

    chat(channelId, userInput, systemPromptOverride = null, opts = {}, images = []) {
        return this.handleMessage(channelId, userInput, "USER PROMPT", systemPromptOverride, opts, images)
    }

    buttIn(channelId, rawMessage) {
        return this.handleMessage(channelId, rawMessage, "BUTT IN")
    }
}