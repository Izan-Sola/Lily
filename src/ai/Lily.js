import axios from "axios"
import { getStateController } from '../minecraft/neoforgemod-way/lilybot.js'
import { log, logError, sanitizeInput, ToolCallTracker } from './utils.js'
import { ConversationHistory, RawBuffer } from './history.js'
import { SYSTEM_PROMPT, SUMMARIZE_PROMPT } from './prompts.js'
import { ToolExecutor, TOOLS, TOOL_NAMES } from './tools.js'

// Channel id used for the Minecraft bridge — see getToolsForChannel().
const MINECRAFT_CHANNEL_ID = "minecraft"

const DEFAULT_OPTIONS = {
    model: "Lily",
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.08,
    max_tokens: 4096,
    maxConvoMessages: 30,
    maxMinecraftConvoMessages: 14,   // smaller window for the minecraft channel: freshness of
    // rule-following matters more there than long banter recall
    maxRawMessages: 30,
    maxToolLoops: 15,
    maxToolRepeats: 3,
    maxUsesPerTool: 2, // generic per-tool-name cap per turn (minecraft_action tools use their own cap, see runOneToolCall)
    memoryQueryMinScore: 0.3,
    memoryRemoveMinScore: 0.70,
    memoryRemoveK: 2,
    episodicQueryMinScore: 0.40,
    episodicRemoveMinScore: 0.80,
    episodicRemoveK: 3,
    // Smaller, more frequent batches — each embedded summary stays topic-focused
    // instead of blurring many unrelated exchanges into one blob.
    summarizeEvery: 20,
    summarizeLastN: 20,
    observeEvery: 20,
    ollamaUrl: "http://localhost:11435",
    memoryDbUrl: "http://localhost:8002",   // single unified DB, replaces knowledgeDbUrl + episodicDbUrl
    blogUrl: "http://localhost:1234",
    ollamaTimeout: 120000,
    dbTimeout: 30000,
}

function isMinecraftActionTool(name) {
    return name === "minecraft_action" || name.startsWith("minecraft_action")
}

// Tools whose effect is invisible in the final natural-language reply — the
// persisted convo-history entry gets a compact [did: ...] marker for these,
// so on later turns she can "see" that the action happened instead of it
// looking identical to a turn where she just talked. Retrieval tools
// (query_memory_database, web_search) are deliberately excluded — their
// result already gets folded into her actual reply, so marking them too
// would just be redundant noise in history.
const SILENT_EFFECT_TOOLS = new Set([
    "addto_memory_database",
    "update_memory_database",
    "remove_memory_database",
    "send_gif",
    "send_meme",
])

const GIF_TOOLS = new Set(["send_gif", "send_meme"])

function isSilentEffectTool(name) {
    return SILENT_EFFECT_TOOLS.has(name) || isMinecraftActionTool(name)
}

export class Lily {
    /**
     * @param {object} options
     * @param {(type: string, params: object) => void} [mcSend] - sends a
     *   command to the Minecraft bridge (same function passed into
     *   startSurvivalLoop). Forwarded to ToolExecutor so the
     *   minecraft_action tool can actually act in-world when someone asks
     *   Lily to do something via chat.
     */
    constructor(options = {}, mcSend = null) {
        this.opts = { ...DEFAULT_OPTIONS, ...options }
        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.channelLocks = new Map()
        this.channelMessageCounts = new Map()   // channelId -> count
        this.observeBuffers = new Map()         // channelId -> string[]
        this.observeParticipants = new Map()    // channelId -> Set<string>
        this.mcSend = mcSend
        this.tools = new ToolExecutor(this.opts, mcSend, getStateController)
        this._resumedIds = new Map()
        this._replayCounts = new Map()
        // Non-minecraft tool list is static, so compute it once instead of
        // filtering on every single loop iteration.
        this._nonMinecraftTools = TOOLS.filter(t => !isMinecraftActionTool(t.function?.name ?? ""))
    }

    getObserveBuffer(channelId) {
        if (!this.observeBuffers.has(channelId)) this.observeBuffers.set(channelId, [])
        return this.observeBuffers.get(channelId)
    }

    /**
     * Wire (or replace) the Minecraft bridge sender after construction —
     * useful if mcSend isn't available yet when Lily is first built.
     */
    setMcSend(mcSend) {
        this.mcSend = mcSend
        this.tools.mcSend = mcSend
    }

    buildSystemPrompt(extraInstructions = null) {
        return extraInstructions ? `${SYSTEM_PROMPT}\n\n${extraInstructions}` : SYSTEM_PROMPT
    }

    getHistory(channelId) {
        if (!this.convoHistories.has(channelId)) {
            const cap = channelId === MINECRAFT_CHANNEL_ID
                ? this.opts.maxMinecraftConvoMessages
                : this.opts.maxConvoMessages
            this.convoHistories.set(channelId, new ConversationHistory(cap))
        }
        return this.convoHistories.get(channelId)
    }

    getRawBuffer(channelId) {
        if (!this.rawBuffers.has(channelId)) {
            this.rawBuffers.set(channelId, new RawBuffer(this.opts.maxRawMessages))
        }
        return this.rawBuffers.get(channelId)
    }

    // Only the Minecraft bridge channel gets minecraft_action tools — every
    // other channel (Discord, etc.) never even sees them in the tool list,
    // so the model structurally cannot call them there regardless of how
    // it interprets the system prompt's "you can't perform in-game actions".
    getToolsForChannel(channelId) {
        return channelId === MINECRAFT_CHANNEL_ID ? TOOLS : this._nonMinecraftTools
    }

    async withChannelLock(channelId, fn) {
        while (this.channelLocks.get(channelId)) await new Promise(r => setTimeout(r, 50))
        this.channelLocks.set(channelId, true)
        try { return await fn() } finally { this.channelLocks.set(channelId, false) }
    }

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

    // suppressActionReminder: once an in-world action has already been dispatched
    // this turn, we stop re-injecting the "call the matching tool now" nudge on
    // every subsequent loop iteration/completion — that reminder was previously
    // rebuilt from scratch and reattached to the same original user message on
    // every single loop, which kept pressuring the model to find *something*
    // else to call even after the requested action was already done.
    buildMessagesForOllama(channelId, systemPromptOverride = null, opts = {}) {
        const { skipHistory = false, skipRawContext = false, suppressActionReminder = false } = opts
        const messages = []

        messages.push({ role: "system", content: systemPromptOverride ?? SYSTEM_PROMPT })

        const history = skipHistory ? [] : [...this.getConvoHistory(channelId)]

        if (!skipRawContext) {
            const rawContext = this.getRawContext(channelId)
            if (rawContext.length) {
                const reminder = (channelId === MINECRAFT_CHANNEL_ID && !suppressActionReminder)
                    ? "\n[If the newest message asks you to do something physical, call the matching tool now — don't just reply in words.]\n"
                    : ""
                const block = `[Recent chat]\n${rawContext.join("\n")}\n[End recent chat]\n${reminder}`

                let injected = false
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === "user" && typeof history[i].content === "string") {
                        history[i] = { ...history[i], content: block + history[i].content }
                        injected = true
                        break
                    }
                }
                if (!injected) {
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

    async summarizeAndStore(lines, { logPrefix, maxTokens = 300, memorySource = "conversation_batch", participants = [], emotions = [], importance = 0.5 }) {
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

            // summary drives the embedding/search; raw is what comes back on a hit
            await this.tools.addEpisodicMemory({
                summary,
                raw: lines.join("\n"),
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

        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE",
            maxTokens: 150,
            memorySource: "conversation_batch",
            importance: 0.5,
        })
    }

    observe(channelId, rawMessage, authorName = null) {
        const clean = sanitizeInput(rawMessage)
        if (!clean) return

        const buffer = this.getObserveBuffer(channelId)
        buffer.push(clean)
        if (authorName && authorName.toLowerCase() !== "lily") {
            if (!this.observeParticipants.has(channelId)) this.observeParticipants.set(channelId, new Set())
            this.observeParticipants.get(channelId).add(authorName)
        }

        if (this.opts.observeEvery > 0 && buffer.length >= this.opts.observeEvery) {
            const batch = buffer.splice(0, this.opts.observeEvery)
            const participants = [...(this.observeParticipants.get(channelId) ?? [])]
            this.summarizeAndStore(batch, {
                logPrefix: "OBSERVE",
                maxTokens: 100,
                memorySource: "observe",
                importance: 0.3,
                participants,
            })
            this.observeParticipants.set(channelId, new Set())
        }
    }

    async sendToOllama(messages, foreignTools = [], noTools = false, baseTools = TOOLS) {
        if (getStateController()?.currentStateName === 'DUELING') {
            return { content: "Lily is currently in a duel, she can't reply right now!" }
        }
        try {
            const payload = {
                model: this.opts.model,
                messages,
                stream: false,
                temperature: this.opts.temperature,
                top_p: this.opts.top_p,
                top_k: this.opts.top_k,
                min_p: this.opts.min_p,
                repeat_penalty: this.opts.repeat_penalty,
                repeat_last_n: this.opts.repeat_last_n,
                max_tokens: this.opts.max_tokens,
            }

            // noTools forces a plain-text completion — no tools field at all —
            // used when we want a guaranteed natural reply (e.g. tool-loop budget exhausted).
            if (!noTools) {
                payload.tools = foreignTools.length ? [...baseTools, ...foreignTools] : baseTools
            }

            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, payload, { timeout: this.opts.ollamaTimeout })
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

    // Two independent checks gate every non-minecraft_action tool call:
    //   1. toolsUsedThisTurn (Map<toolName, count>) — flat cap of
    //      opts.maxUsesPerTool calls to a given tool name per turn,
    //      regardless of arguments. Replaces the old ad-hoc special-casing
    //      of send_gif / send_meme / addto_episodic_memory with one rule,
    //      and closes the hole where a model dodged a per-tool cap by
    //      alternating between addto_memory_database / update_memory_database
    //      / remove_memory_database indefinitely.
    //   2. tracker (ToolCallTracker) — blocks calling the exact same
    //      tool+args pair more than opts.maxToolRepeats times, catching a
    //      model stuck re-issuing an identical call even if it's still
    //      within the flat count budget.
    //
    // minecraft_action tools get their OWN flat cap of 1 per distinct action
    // name per turn (not opts.maxUsesPerTool, and no tracker repeat-check —
    // repeated identical in-world actions like re-attacking the same mob
    // across turns are legitimate and are instead bounded by the early-exit
    // in runToolLoop, see didMinecraftAction there). Without this cap, a
    // model that calls e.g. break, then in a LATER loop iteration calls
    // stop, then eat, then swap, then attack, then follow — none of which
    // repeats a prior tool name — sails through unblocked, since a same-name
    // repeat check can't catch a model inventing a *different* unrequested
    // action each round. The early-exit fix in runToolLoop is what actually
    // stops those later rounds from happening at all; this cap is just a
    // backstop in case a single model response tries to call the same
    // minecraft action tool twice.
    async runOneToolCall(channelId, name, args, tracker, toolsUsedThisTurn, pushFn) {
        const usesSoFar = toolsUsedThisTurn.get(name) ?? 0
        const cap = isMinecraftActionTool(name) ? 1 : this.opts.maxUsesPerTool

        if (usesSoFar >= cap) {
            log(`🚫 [BLOCKED] ${name} already used ${usesSoFar}x this turn (cap: ${cap})`)
            pushFn(isMinecraftActionTool(name)
                ? `You've already done that this turn — don't call another action tool unless the player just asked for something new. Reply in character now.`
                : `You've already used ${name} ${usesSoFar} time(s) this turn — that's the limit. Move on and reply in character now.`)
            return null
        }

        if (!isMinecraftActionTool(name)) {
            const repeatBlock = tracker.check(name, args)
            if (repeatBlock) {
                pushFn(repeatBlock)
                return null
            }
        }

        toolsUsedThisTurn.set(name, usesSoFar + 1)

        const result = await this.tools.execute(name, args)

        let gifUrl = null
        if (GIF_TOOLS.has(name)) {
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
            const allSeen = toolResults.length > 0 && toolResults.every(tr => this._resumedIds.has(tr.tool_call_id))
            if (allSeen) {
                log(`⏭️ [DUPLICATE RESUME] Already answered: ${toolResults.map(t => t.tool_call_id).join(", ")}`)
                return this._resumedIds.get(toolResults[toolResults.length - 1].tool_call_id)
            }

            for (const tr of toolResults) {
                if (this._resumedIds.has(tr.tool_call_id)) continue

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

    // Final fallback used both when the tool-loop budget (maxToolLoops) runs out,
    // AND (new) immediately after a minecraft_action tool has been dispatched —
    // see didMinecraftAction in runToolLoop. Forces one last completion with
    // tools disabled so the model has to produce a normal in-character reply
    // instead of being offered another 14 rounds of "what else could I call".
    async finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl) {
        // suppressActionReminder: if we're here because an action already fired,
        // the "call the matching tool now" nudge would be actively contradictory
        // (tools are disabled for this completion) — see buildMessagesForOllama.
        const baseMessages = this.buildMessagesForOllama(channelId, systemPromptOverride, { ...opts, suppressActionReminder: true })
        let attemptScratch = [...scratch]
        const MAX_RETRIES = 6

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const messages = [...baseMessages, ...attemptScratch]

            if (attempt > 0) {
                messages.push({
                    role: "user",
                    content: `[System: You're out of tool uses for this turn. Reply to the message naturally, in your own words — no <tool_call> tags, no tool syntax, no mention of tools.]`
                })
            }

            const msg = await this.sendToOllama(messages, [], true)
            const raw = (msg?.content ?? "").trim()
            const content = raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim()

            if (content && content.toLowerCase() !== "none") {
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                log(`✅ [LILY REPLY - BUDGET EXHAUSTED] ${content.slice(0, 200)}${pendingGifUrl ? ` + GIF` : ""}`)
                return { text: content, gifUrl: pendingGifUrl }
            }

            log(`⚠️ [BUDGET FALLBACK RETRY ${attempt + 1}] Tool-call-only or empty content, retrying`)
            if (raw) attemptScratch = [...attemptScratch, { role: "assistant", content: raw }]
        }

        logError(`[BUDGET FALLBACK] Exhausted ${MAX_RETRIES} retries without a natural reply`)
        return null
    }

    // Shared by both the native tool_calls path and the embedded <tool_call>
    // path below — runs each call, records it for the silent-effect history
    // marker if applicable, and pushes the result via the caller's pushFn
    // (which differs between the two formats: role:"tool" vs role:"user").
    async runToolCalls(channelId, calls, tracker, toolsUsedThisTurn, actionsThisTurn, pushFn) {
        let pendingGifUrl = null
        for (const { name, args } of calls) {
            if (isSilentEffectTool(name)) {
                actionsThisTurn.push(`${name}(${JSON.stringify(args)})`)
            }
            const gif = await this.runOneToolCall(channelId, name, args, tracker, toolsUsedThisTurn, (text) => pushFn(name, text))
            if (gif) pendingGifUrl = gif
        }
        return pendingGifUrl
    }

    async runToolLoop(channelId, systemPromptOverride = null, opts = {}, images = []) {
        const tracker = new ToolCallTracker(this.opts.maxToolRepeats)
        const baseTools = this.getToolsForChannel(channelId)
        let pendingGifUrl = null
        const toolsUsedThisTurn = new Map()
        let imagesInjected = false
        const foreignTools = opts.tools ?? []
        const foreignToolNames = new Set(foreignTools.map(t => t.function?.name).filter(Boolean))
        const scratch = []

        // Tracks silent-effect tool calls made THIS turn so we can annotate the
        // persisted convo-history entry (not what's actually said) — otherwise a
        // successful action/write and a pure-chat turn look identical in her own
        // history, and over a long session she starts pattern-matching toward
        // "we're just chatting" even on turns where she acted. Works for any
        // channel — minecraft_action tools simply never appear outside the
        // minecraft channel since they're filtered out of the tool list there.
        const actionsThisTurn = []

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

            const msg = await this.sendToOllama(messages, foreignTools, false, baseTools)
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
                    this.pushToConvoHistory(channelId, { role: "assistant", content: msg.content ?? "", tool_calls: [single] })
                    return { text: msg.content ?? "", gifUrl: null, tool_calls: [single] }
                }

                log(`🔧 [NATIVE] ${msg.tool_calls.map(tc => tc.function.name).join(", ")}`)
                scratch.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls })

                const calls = msg.tool_calls.map(tc => {
                    let args = {}
                    try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { }
                    return { id: tc.id, name: tc.function.name, args }
                })

                const gif = await this.runToolCalls(
                    channelId, calls, tracker, toolsUsedThisTurn, actionsThisTurn,
                    (name, text) => {
                        // find matching call's id (calls are unique enough per-turn for this lookup;
                        // falls back to iterating if args collide across ids)
                        const call = calls.find(c => c.name === name && !c._used)
                        if (call) call._used = true
                        scratch.push({ role: "tool", tool_call_id: call?.id, content: text })
                    }
                )
                if (gif) pendingGifUrl = gif

                // Once a real in-world action has been dispatched, end the turn here
                // instead of looping again. A single model response can already
                // contain MULTIPLE tool_calls (e.g. "stop and follow me" → both
                // calls arrive together in msg.tool_calls), so this doesn't break
                // legitimate multi-action requests — it only stops her from being
                // offered a fresh round of tools afterward to invent something new
                // to do, which is what produced the attack/follow/eat/swap spam
                // on unrelated entities and blocks nobody asked about.
                const didMinecraftAction = calls.some(c => isMinecraftActionTool(c.name))
                if (didMinecraftAction) {
                    log(`🎯 [ACTION DISPATCHED] Ending turn, no further tool offers this turn`)
                    return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                }

                continue
            }

            if (content.includes("<tool_call>")) {
                const calls = this.parseEmbeddedToolCalls(content)
                if (calls.length) {
                    scratch.push({ role: "assistant", content })

                    const gif = await this.runToolCalls(
                        channelId, calls, tracker, toolsUsedThisTurn, actionsThisTurn,
                        (_name, text) => scratch.push({ role: "user", content: `<tool_response>\n${text}\n</tool_response>` })
                    )
                    if (gif) pendingGifUrl = gif

                    // Same early-exit rule as the native tool_calls path above —
                    // embedded <tool_call> tags can also contain multiple calls in
                    // one content block (parseEmbeddedToolCalls returns them all),
                    // so multi-action requests are still handled in a single pass.
                    const didMinecraftAction = calls.some(c => isMinecraftActionTool(c.name))
                    if (didMinecraftAction) {
                        log(`🎯 [ACTION DISPATCHED] Ending turn, no further tool offers this turn`)
                        return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
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

            if ([...TOOL_NAMES].some(name => content.includes(name))) {
                log(`⚠️ [NARRATE] Model described tool instead of calling`)
                scratch.push({ role: "assistant", content })
                scratch.push({
                    role: "user",
                    content: `[System: Do NOT mention tool names in your reply. Use <tool_call> if needed, otherwise just reply naturally.]`
                })
                continue
            }

            if (content && content.toLowerCase() !== "none") {
                // Persisted history gets a marker for silent-effect tools so future
                // turns can "see" that she acted/wrote/sent something — the reply
                // actually sent to chat/game (the returned `text`) is untouched.
                const historyContent = actionsThisTurn.length
                    ? `${content} [did: ${actionsThisTurn.join(", ")}]`
                    : content

                this.pushToConvoHistory(channelId, { role: "assistant", content: historyContent })
                log(`✅ [LILY REPLY] ${content.slice(0, 200)}${pendingGifUrl ? ` + GIF` : ""}`)
                return { text: content, gifUrl: pendingGifUrl }
            }

            log(`⚠️ [EMPTY] No content`)
            return { text: "I'm not sure about that one!", gifUrl: null }
        }

        // maxToolLoops budget exhausted — don't error out, just make her talk
        // like a normal turn ending. No mention of hitting a limit.
        log(`⏹️ [LOOP BUDGET EXHAUSTED] Forcing final no-tools reply`)
        return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
    }

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

            const count = (this.channelMessageCounts.get(channelId) ?? 0) + 1
            this.channelMessageCounts.set(channelId, count)
            if (this.opts.summarizeEvery > 0 && count % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }

            const loopResult = await this.runToolLoop(channelId, systemPromptOverride, opts, images)

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