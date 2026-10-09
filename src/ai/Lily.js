// src/ai/Lily.js
import { sanitizeInput, parseEmbeddedToolCalls } from './utils.js'
import { ConversationHistory, RawBuffer } from './conversation/history.js'
import { SYSTEM_PROMPT, VTUBE_EXPRESSION_ADDENDUM } from './prompts.js'
import { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL as VOICE_ASSISTANT_CHANNEL_ID } from './tools/toolRouter.js'
import { Logger } from '../utils/Logger.js'
import { getConfig, getSection, getOwnerId } from './config.js'
import { speakToStream } from '../vtubing/youtube/streamTTS.js'
import { CODE_SYSTEM_PROMPT, stripCodeFence } from '../coding/codeEditShared.js'
import { WorkingMemory } from './memory/workingMemory.js'
import { handleExplicitMemory } from './memory/explicitMemory.js'
import { Summarizer } from './memory/summarizer.js'
import { classifyRisk, riskAllowed } from './tools/riskyActionsManagement/riskClassifier.js'
import { TurnContext } from './conversation/TurnContext.js'
import { ChannelLocks } from './conversation/channelLocks.js'
import { FlawlessCapture } from './flawlessCapture.js'
import { chatCompletion } from './llmClient.js'
import { pushHistoryToBlog } from './blogPush.js'

const YOUTUBE_CHANNEL_ID = "youtube"
const MINECRAFT_CHANNEL_ID = "minecraft"
const VRCHAT_CHANNEL_ID = "vrchat"

const GIF_TOOLS = new Set(["send_gif", "send_meme"])
const isMinecraftActionTool = name => name.startsWith("minecraft_action")

const REPLY_STOP = ["</answer>", "<|user|>", "<|endoftext|>"]
const NO_TOOLS_NUDGE = "[System: You cannot tool call more in this turn. Stop attempting to call tools this turn, and naturally reply to the user with a text reply addressing his message.]"
const MALFORMED_NUDGE = `[System: Your <tool_call> was malformed. Use exact format:\n<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>]`
// Voice only: the model says "typing it now~" but never calls the tool, so nothing happens.
const CLAIMED_NUDGE = "[System: You said you did something on the user's computer but called no tool, so nothing happened. Call the tool now (type_text, press_keys, rewrite_text or clipboard), or tell the user you can't.]"
const CLAIMS_ACTION = /\b(typing|typed|pressing|pressed|rewriting|rewrote|copying|copied)\b/i
const NARRATED_NUDGE = "[System: You narrated a tool instead of calling it. Make proper use of the tool calls with the correct format.]"

export class Lily {
    /**
     * @param {object} [o]
     * @param {object} [o.overrides]          config.json overrides for this instance (e.g. { model })
     * @param {Function} [o.onVoiceGif]
     * @param {() => object|null} [o.getStateController]  Minecraft state controller accessor
     * @param {() => string|null} [o.replyGate]            returns a canned reply to short-circuit the model, or null
     * Tool executors are not built here: modules attach them to `this.tools` while they run.
     */
    constructor({ overrides = {}, onVoiceGif = null, getStateController = null, replyGate = null } = {}) {
        this.overrides = overrides
        this._getStateController = getStateController
        this._replyGate = replyGate
        this._onVoiceGif = onVoiceGif

        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.workingMemory = new WorkingMemory()
        this.locks = new ChannelLocks()
        this.flawless = new FlawlessCapture()
        this._lastTurn = new Map()      // channelId -> latest TurnContext (a resume inherits from it)
        this._resumedIds = new Map()    // tool_call_id -> result, dedupes repeated Continue resumes

        this.tools = new ToolRouter({
            editCallback: (filePath, originalContent, instruction) =>
                this.generateFileEdit(filePath, originalContent, instruction),
            completeCallback: (system, user) => this.generateText(system, user),
        })

        this.summarizer = new Summarizer(
            () => this.opts,
            channelId => this.getHistory(channelId),
            memory => this.tools.addEpisodicMemory(memory),
        )
    }

    get opts() {
        return { ...getConfig(), ...this.overrides }
    }

    // ---------- late-bound wiring ----------
    setStateController(getter) { this._getStateController = getter }
    setReplyGate(gate) { this._replyGate = gate }

    _voiceGif(channelId, gifUrl) {
        if (channelId !== VOICE_ASSISTANT_CHANNEL_ID || !gifUrl || !this._onVoiceGif) return
        try { this._onVoiceGif(gifUrl) } catch (err) {
            Logger.error(`Voice GIF callback failed: ${err.message}`, "VOICE GIF")
        }
    }

    // ---------- per-channel state ----------
    getHistory(channelId) {
        if (!this.convoHistories.has(channelId)) {
            const cap = channelId === MINECRAFT_CHANNEL_ID ? this.opts.maxMinecraftConvoMessages : this.opts.maxConvoMessages
            this.convoHistories.set(channelId, new ConversationHistory(cap))
        }
        return this.convoHistories.get(channelId)
    }

    getRawBuffer(channelId) {
        if (!this.rawBuffers.has(channelId)) this.rawBuffers.set(channelId, new RawBuffer(this.opts.maxRawMessages))
        return this.rawBuffers.get(channelId)
    }

    pushToConvoHistory(channelId, message) { this.getHistory(channelId).push(message) }
    getConvoHistory(channelId) { return this.getHistory(channelId).get() }
    getRawContext(channelId) { return this.getRawBuffer(channelId).get() }
    pushRawMessage(channelId, authorName, content) { this.getRawBuffer(channelId).push(authorName, content) }

    injectChannelContext(channelId, recentMessages) {
        const lines = recentMessages.map(m => `${m.authorName}: ${m.content}`)
        this.getRawBuffer(channelId).replace(lines)
        Logger.info(`Injected ${lines.length} messages into raw buffer for channel ${channelId}`, "CONTEXT")
    }

    getToolsForChannel(channelId, context = {}) {
        if ([MINECRAFT_CHANNEL_ID, VRCHAT_CHANNEL_ID, VOICE_ASSISTANT_CHANNEL_ID].includes(channelId)) {
            return this.tools.toolsFor(channelId)
        }

        const trustedDM = this.opts.allowAnyToolViaDM
            && context.isDM
            && context.userId
            && String(context.userId) === String(getOwnerId())
        return trustedDM ? this.tools.allTools : this.tools.toolsFor(channelId)
    }

    // ---------- prompt building ----------
    buildUserContent(text, images = []) {
        if (!images?.length) return text
        const parts = images.map(img => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }))
        if (text) parts.push({ type: "text", text })
        return parts
    }

    buildMessages(ctx, { suppressActionReminder = false } = {}) {
        const { channelId } = ctx
        const { skipHistory = false, skipRawContext = false } = ctx.opts

        let system = ctx.systemPrompt ?? SYSTEM_PROMPT
        if (this.tools.vtubeEnabled) system += `\n\n${VTUBE_EXPRESSION_ADDENDUM}`

        const history = skipHistory ? [] : [...this.getConvoHistory(channelId)]

        if (!skipRawContext) {
            const working = this.workingMemory.renderBlock(channelId)
            const rawContext = this.getRawContext(channelId)

            let block = ""
            if (working) block += `${working}\n`
            if (ctx.autoMemory) {
                block += `[Extra context] Information that might be related to the newest message - ignore if irrelevant${ctx.autoMemory}\n[Extra context]\n`
            }
            if (rawContext.length) {
                const reminder = channelId === MINECRAFT_CHANNEL_ID && !suppressActionReminder
                    ? "\n[If the newest message asks you to do something physical, call the matching tool now — don't just reply in words.]\n"
                    : ""
                block += `[Recent chat]\n${rawContext.join("\n")}\n[End recent chat]\n${reminder}`
            }

            if (block) {
                const i = history.findLastIndex(m => m.role === "user" && typeof m.content === "string")
                if (i >= 0) history[i] = { ...history[i], content: block + history[i].content }
                else history.push({ role: "user", content: block.trim() })
            }
        }

        return [{ role: "system", content: system }, ...history]
    }

    // History + in-turn scratch, with the turn's images attached to the last user message (first pass only).
    _loopMessages(ctx) {
        const messages = [...this.buildMessages(ctx), ...ctx.scratch]
        if (!ctx.imagesInjected && ctx.images.length) {
            ctx.imagesInjected = true
            const j = messages.findLastIndex(m => m.role === "user")
            if (j >= 0) {
                const text = typeof messages[j].content === "string" ? messages[j].content : ""
                messages[j] = { ...messages[j], content: this.buildUserContent(text, ctx.images) }
            }
        }
        return messages
    }

    // ---------- model access ----------
    _channelOverrides(channelId) {
        if (channelId !== MINECRAFT_CHANNEL_ID) return {}
        const llm = getSection('llm')
        return { presence_penalty: llm.presencePenaltyMinecraft, repeat_last_n: llm.repeatLastNMinecraft }
    }

    async sendToOllama(messages, { tools = null, overrides = {} } = {}) {
        const canned = this._replyGate?.()
        if (canned) return { content: canned }
        return chatCompletion(this.opts, messages, { tools, overrides })
    }

    // Single direct completion for the voice "edit the current file" path. The
    // overwrite guard (checkShrinkRatio/checkStubBodies) runs on the result in sttsTools.js.
    async generateFileEdit(filePath, originalContent, instruction) {
        const userPrompt = [
            `File: ${filePath}`,
            `Original content:\n\`\`\`\n${originalContent}\n\`\`\``,
            `Instruction: ${instruction}`,
        ].join('\n\n')

        const { agentMaxTokens, agentTemperature } = getSection('llm')
        const msg = await this.sendToOllama(
            [{ role: 'system', content: CODE_SYSTEM_PROMPT }, { role: 'user', content: userPrompt }],
            { overrides: { max_tokens: agentMaxTokens, temperature: agentTemperature } },
        )
        const content = msg?.content?.trim()
        return content ? stripCodeFence(content) : null
    }

    // One plain completion: no tools, no history, no persona. Used where the model just has to
    // produce text (voice "rewrite what's in this box"). Calls the model directly instead of via
    // sendToOllama, so a canned replyGate answer can never end up typed into the user's app.
    async generateText(system, user) {
        const { agentMaxTokens, summaryTemperature } = getSection('llm')
        const msg = await chatCompletion(
            this.opts,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            { tools: null, overrides: { max_tokens: agentMaxTokens, temperature: summaryTemperature } },
        )
        return (msg?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null
    }

    // ---------- turn endings ----------
    // Every way a loop can end goes through here (voice GIF hook + result).
    _end(ctx, result) {
        this._voiceGif(ctx.channelId, ctx.gifUrl)
        return result
    }

    _reply(ctx, text, label, scratch = ctx.scratch) {
        this.flawless.record(ctx, {
            flawless: this.tools.turnFlawless,
            windowSize: this.opts.trainingTurnWindow,
            finalText: text,
            scratch,
        })
        this.pushToConvoHistory(ctx.channelId, { role: "assistant", content: text })
        Logger.success(`${text}${ctx.gifUrl ? " + GIF" : ""}`, label)
        if (ctx.channelId === YOUTUBE_CHANNEL_ID) speakToStream(text).catch(err => Logger.error(`TTS failed: ${err.message}`, "TTS"))
        return this._end(ctx, { text, gifUrl: ctx.gifUrl })
    }

    // Forces a plain-text reply: retries with tools removed until the model stops emitting tool calls.
    async _finishWithoutTools(ctx) {
        const base = this.buildMessages(ctx, { suppressActionReminder: true })
        const { maxRetries, budgetFallbackRepeatPenalty } = getSection('llm')
        const overrides = {
            ...this._channelOverrides(ctx.channelId),
            stop: [...REPLY_STOP, "<tool_call>"],
            repeat_penalty: budgetFallbackRepeatPenalty,
        }
        let scratch = [...ctx.scratch]

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const messages = [...base, ...scratch]
            if (attempt > 0) {
                this.tools.markFlawed('budget_fallback_retry')
                messages.push({ role: "user", content: NO_TOOLS_NUDGE })
            }

            const msg = await this.sendToOllama(messages, { overrides })
            const raw = (msg?.content ?? "").trim()
            const text = raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim()

            if (text && text.toLowerCase() !== "none") return this._reply(ctx, text, "LILY REPLY - BUDGET EXHAUSTED", scratch)

            Logger.warning(`Tool-call-only or empty content, retrying`, `BUDGET FALLBACK RETRY ${attempt + 1}`)
            if (raw) scratch = [...scratch, { role: "assistant", content: raw }]
        }

        Logger.error(`Exhausted ${maxRetries} retries without a natural reply, using scripted fallback`, "BUDGET FALLBACK")
        const text = "... (•ᴗ•)"
        this.pushToConvoHistory(ctx.channelId, { role: "assistant", content: text })
        return this._end(ctx, { text, gifUrl: ctx.gifUrl })
    }

    // ---------- tool execution ----------
    // Runs calls in order, enforcing per-turn caps and repeat guards.
    // record(call, resultText) stores each result in whatever shape the transport needs.
    async _runCalls(ctx, calls, record) {
        for (const call of calls) {
            const { name, args } = call
            const isAction = isMinecraftActionTool(name)
            const used = ctx.toolUses.get(name) ?? 0
            const cap = isAction ? this.opts.maxUsesPerMinecraftAction
                : this.tools.isInputTool(name) ? (this.opts.maxUsesPerInputTool ?? 12) // form-filling takes many small calls
                    : this.opts.maxUsesPerTool

            let blocked = null
            if (used >= cap) {
                Logger.warning(`${name} already used ${used}x this turn (cap: ${cap})`, "BLOCKED")
                this.tools.markFlawed('tool_cap_exceeded')
                blocked = isAction
                    ? `You've already done that this turn — don't call another action tool unless the player just asked for something new. Reply in character now.`
                    : `You've already used ${name} ${used} time(s) this turn — that's the limit. Move on and reply in character now.`
            } else if (!isAction && (blocked = ctx.tracker.check(name, args))) {
                this.tools.markFlawed('tool_repeat_blocked')
            }

            if (blocked) {
                record(call, blocked)
            } else {
                ctx.toolUses.set(name, used + 1)
                const result = await this.tools.execute(name, args, { channelId: ctx.channelId, isDM: ctx.opts.isDM, userId: ctx.opts.userId })
                if (GIF_TOOLS.has(name)) {
                    try {
                        const parsed = JSON.parse(result)
                        if (parsed.status === "ok") ctx.gifUrl = parsed.url
                    } catch { /* not JSON: no GIF */ }
                }
                record(call, result)
            }
            if (this.tools.shouldHardStop()) break
        }
    }

    // Shared tail of native and embedded tool rounds. Returns a final result, or undefined to keep looping.
    async _afterToolRound(ctx, calls, record) {
        await this._runCalls(ctx, calls, record)

        if (ctx.channelId === VOICE_ASSISTANT_CHANNEL_ID) {
            const images = this.tools.takePendingImages().map(img => ({ mimeType: img.mediaType, base64: img.base64 }))
            if (images.length) ctx.scratch.push({ role: "user", content: this.buildUserContent("", images) })
        }

        if (this.tools.shouldHardStop()) {
            Logger.warning(`Tool budget/limit exhausted this turn, forcing final reply`, "HARD STOP")
            return this._finishWithoutTools(ctx)
        }
        if (calls.some(c => isMinecraftActionTool(c.name))) {
            Logger.info(`Ending turn, no further tool offers this turn`, "ACTION DISPATCHED")
            return this._finishWithoutTools(ctx)
        }
    }

    // A tool the caller (Continue) owns: forward the first call instead of running it.
    _handoff(ctx, msg, foreignCalls) {
        Logger.info(`${foreignCalls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(" | ")} -> Continue`, "HANDOFF")
        if (foreignCalls.length > 1) {
            Logger.warning(`Model tried ${foreignCalls.length} tool calls at once — only forwarding the first`, "MULTI-TOOL")
        }
        const [single] = foreignCalls
        const argStr = typeof single.function.arguments === 'string'
            ? single.function.arguments
            : JSON.stringify(single.function.arguments ?? '')

        if (!riskAllowed()) {
            const { risky, matched } = classifyRisk(argStr)
            if (risky) {
                Logger.warning(`Blocked risky ${single.function.name} call (matched "${matched}"): ${argStr.slice(0, 200)}`, "APPROVAL")
                return this._end(ctx, { text: `I blocked that command because it looks risky ("${matched}").`, gifUrl: null })
            }
        }
        this.pushToConvoHistory(ctx.channelId, { role: "assistant", content: msg.content ?? "", tool_calls: [single] })
        return this._end(ctx, { text: msg.content ?? "", gifUrl: null, tool_calls: [single] })
    }

    _nativeRound(ctx, msg) {
        Logger.success(`Lily called the tool: ${msg.tool_calls.map(tc => tc.function.name).join(", ")}`, "NATIVE")
        ctx.scratch.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls })

        const calls = msg.tool_calls.map(tc => {
            let args = {}
            try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { /* bad args -> {} */ }
            return { id: tc.id, name: tc.function.name, args }
        })
        return this._afterToolRound(ctx, calls, (call, text) =>
            ctx.scratch.push({ role: "tool", tool_call_id: call.id, content: text }))
    }

    _embeddedRound(ctx, content) {
        const calls = parseEmbeddedToolCalls(content)
        if (!calls.length) {
            Logger.warning(`${content.slice(0, 200)}`, "MALFORMED")
            this.tools.markFlawed('malformed_tool_call')
            ctx.scratch.push({ role: "assistant", content }, { role: "user", content: MALFORMED_NUDGE })
            return
        }
        ctx.scratch.push({ role: "assistant", content })
        return this._afterToolRound(ctx, calls, (_call, text) =>
            ctx.scratch.push({ role: "user", content: `<tool_response>\n${text}\n</tool_response>` }))
    }

    _narratedRound(ctx, content) {
        Logger.warning(`Model described tool instead of calling`, "NARRATE")
        ctx.scratch.push({ role: "assistant", content })
        if (this.tools.recordNarration()) {
            Logger.warning(`Narration budget exhausted, forcing final reply`, "HARD STOP")
            return this._finishWithoutTools(ctx)
        }
        ctx.scratch.push({ role: "user", content: NARRATED_NUDGE })
    }

    // ---------- the loop ----------
    // Each round either ends the turn (returns a result) or leaves the loop going (returns undefined).
    async runToolLoop(ctx) {
        for (let i = 0; i < this.opts.maxToolLoops; i++) {
            const tools = [...ctx.baseTools, ...ctx.foreignTools]
            const voice = ctx.channelId === VOICE_ASSISTANT_CHANNEL_ID
            if (voice && i === 0) Logger.info(`${tools.length} tools: ${tools.map(t => t.function.name).join(', ')}`, "VOICE TOOLS")
            const msg = await this.sendToOllama(this._loopMessages(ctx), { tools, overrides: this._channelOverrides(ctx.channelId) })
            if (!msg) return this._end(ctx, { text: "I'm having trouble thinking right now, sorry!", gifUrl: null })

            const content = (msg.content ?? "").trim()
            let done

            if (msg.tool_calls?.length) {
                const foreign = msg.tool_calls.filter(tc => ctx.foreignNames.has(tc.function.name))
                done = foreign.length ? this._handoff(ctx, msg, foreign) : await this._nativeRound(ctx, msg)
            } else if (content.includes("<tool_call>")) {
                done = await this._embeddedRound(ctx, content)
            } else if ([...ALL_TOOL_NAMES].some(name => content.includes(name))) {
                done = await this._narratedRound(ctx, content)
            } else if (voice && i === 0 && !ctx.claimNudged && CLAIMS_ACTION.test(content) && tools.some(t => this.tools.isInputTool(t.function.name))) {
                Logger.warning(`Claimed an action without calling a tool: ${content.slice(0, 120)}`, "CLAIMED")
                ctx.claimNudged = true
                ctx.scratch.push({ role: "assistant", content }, { role: "user", content: CLAIMED_NUDGE })
            } else if (content && content.toLowerCase() !== "none") {
                return this._reply(ctx, content, "LILY REPLY")
            } else {
                Logger.error(`No content`, "EMPTY")
                return this._end(ctx, { text: "I'm not sure about that one!", gifUrl: null })
            }

            if (done) return done
        }

        Logger.warning(`Forcing final no-tools reply`, "LOOP BUDGET EXHAUSTED")
        this.tools.markFlawed('tool_loop_budget_exhausted')
        return this._finishWithoutTools(ctx)
    }

    // Continues a turn after the caller (Continue) ran a tool we handed off.
    async resumeToolLoop(channelId, toolResults, systemPromptOverride = null, opts = {}, images = []) {
        return this.locks.run(channelId, async () => {
            if (toolResults.length && toolResults.every(tr => this._resumedIds.has(tr.tool_call_id))) {
                Logger.warning(`Already answered: ${toolResults.map(t => t.tool_call_id).join(", ")}`, "DUPLICATE RESUME")
                return this._resumedIds.get(toolResults.at(-1).tool_call_id)
            }

            for (const tr of toolResults) {
                if (this._resumedIds.has(tr.tool_call_id)) continue
                let content = tr.content
                if (typeof content === "string" && content.startsWith("Failed to edit")) {
                    content += " The filepath you sent didn't match. Use the exact path shown in your last read_file or read_currently_open_file result — not a shortened or relative guess."
                }
                this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tr.tool_call_id, content })
            }

            const prev = this._lastTurn.get(channelId)
            const ctx = TurnContext.resume(prev, this._turnFields(channelId, systemPromptOverride, opts, images))
            this._lastTurn.set(channelId, ctx)

            const result = await this.runToolLoop(ctx)
            for (const tr of toolResults) this._resumedIds.set(tr.tool_call_id, result)
            if (result?.text) this._pushToBlog(channelId)
            return result
        })
    }

    _turnFields(channelId, systemPrompt, opts, images) {
        return {
            channelId,
            systemPrompt,
            opts,
            images,
            baseTools: this.getToolsForChannel(channelId, opts),
            maxToolRepeats: this.opts.maxToolRepeats,
        }
    }

    _pushToBlog(channelId) {
        pushHistoryToBlog(this.opts.blogUrl, channelId, this.getConvoHistory(channelId))
    }

    // ---------- entry points ----------
    observe(channelId, rawMessage, authorName = null, authorId = null) {
        const clean = sanitizeInput(rawMessage)
        if (!clean) return
        if (authorName && authorName.toLowerCase() !== "lily") {
            this.workingMemory.noteSpeaker(channelId, { name: authorName, id: authorId })
        }
        this.summarizer.observe(channelId, clean, authorName)
    }

    async handleMessage(channelId, rawInput, logPrefix, systemPromptOverride = null, opts = {}, images = []) {
        const clean = sanitizeInput(rawInput)
        if (!clean && images.length === 0) return null

        const authorName = opts.authorName ?? null
        const authorId = opts.userId ?? null

        // Presence is deterministic and recorded even if we skip the turn below.
        this.workingMemory.noteSpeaker(channelId, { name: authorName, id: authorId })

        Logger.info(`${authorName ? `${authorName}: ` : ""}${clean.slice(0, 200)}${images.length ? ` + ${images.length} image(s)` : ""}`, logPrefix)

        const { skipped, result } = await this.locks.tryRun(channelId, async () => {
            const userMessage = { role: "user", content: clean || "[sent an image]" }
            this.pushToConvoHistory(channelId, userMessage)
            this.tools.resetTurn()

            // Explicit "remember that ..." / "forget ..." — written before the model
            // sees the message, outside the turn's tool budget.
            const explicitNote = this.opts.explicitMemoryEnabled
                ? await handleExplicitMemory(clean, {
                    tools: this.tools,
                    authorName,
                    authorId,
                    known: this.workingMemory.presentNames(channelId),
                    idLookup: name => this.workingMemory.idFor(channelId, name),
                })
                : null
            const autoMemory = channelId !== VOICE_ASSISTANT_CHANNEL_ID
                ? await this.tools.autoInjectMemory(clean, { authorName, authorId })
                : null

            const ctx = new TurnContext({
                ...this._turnFields(channelId, systemPromptOverride, opts, images),
                userMessage,
                autoMemory: [explicitNote, autoMemory].filter(Boolean).join("\n") || null,
            })
            this._lastTurn.set(channelId, ctx)

            await this.summarizer.tick(channelId)
            const loopResult = await this.runToolLoop(ctx)
            if (loopResult?.text) this._pushToBlog(channelId)

            // Fire-and-forget: never sits in front of the reply.
            const lines = this.getRawContext(channelId)
            this.workingMemory.update(channelId, {
                lines: lines.length ? lines : [`${authorName ?? "User"}: ${clean}`],
                replyText: loopResult?.text ?? "",
            })
            return loopResult
        })

        if (skipped) {
            Logger.warning(`Ignoring message in channel ${channelId} while Lily is still replying: ${clean.slice(0, 100)}`, "BUSY")
            return null
        }
        return result
    }

    chat(channelId, userInput, systemPromptOverride = null, opts = {}, images = []) {
        return this.handleMessage(channelId, userInput, "USER PROMPT", systemPromptOverride, opts, images)
    }

    buttIn(channelId, rawMessage, systemPromptOverride = null, opts = {}) {
        return this.handleMessage(channelId, rawMessage, "BUTT IN", systemPromptOverride, opts)
    }
}

export { VRCHAT_CHANNEL_ID, MINECRAFT_CHANNEL_ID, VOICE_ASSISTANT_CHANNEL_ID }
