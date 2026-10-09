// toolRouter.js
import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'
import { VRCHAT_TOOL_NAMES } from './vrchatTools.js'
import { SttsToolExecutor, STTS_TOOL_NAMES } from './stts/sttsTools.js'
import { BROWSER_TOOL_NAMES } from './browserTools.js'
import { INPUT_TOOL_NAMES } from './stts/inputTools.js'
import { getConfig, getOwnerId } from '../config.js'

const VOICE_ASSISTANT_CHANNEL = 'voiceAssistant'
const MINECRAFT_CHANNEL = 'minecraft'

// Executors are attached by modules when they start and detached when they stop,
// so the tool lists (and what execute() accepts) always mirror what is running.
//   channels:  '*' (every channel) or an array of channel ids that see the tools
//   voiceOnly: calls are refused outside the voice channel / trusted owner DMs
class ToolRouter {
    constructor({ editCallback = null, completeCallback = null } = {}) {
        this._mods = new Map() // name -> { exec, channels, voiceOnly }
        this._sttsCallbacks = { editCallback, completeCallback }
        this.chat = new ChatToolExecutor()
        this.attach('chat', this.chat)
    }

    // Router for the in-process survival loops: Minecraft tools (+ VTube when a client is given).
    static forMinecraft(getStateController, vtsClient = null) {
        const router = new ToolRouter()
        router.attach('minecraft', new MinecraftToolExecutor(null, getStateController), { channels: [MINECRAFT_CHANNEL] })
        if (vtsClient) router.attach('vtube', new VtubeToolExecutor(vtsClient))
        return router
    }

    // ---- module attach / detach ----
    attach(name, exec, { channels = '*', voiceOnly = false } = {}) {
        if (this._mods.get(name)?.exec !== exec) Logger.info(`${name} tools attached`, "TOOLS")
        this._mods.set(name, { exec, channels, voiceOnly })
    }
    detach(name) {
        if (this._mods.delete(name)) Logger.info(`${name} tools detached`, "TOOLS")
    }
    has(name) { return this._mods.has(name) }
    get(name) { return this._mods.get(name)?.exec ?? null }

    // STTS tool groups (screenshot / pidev / coding / input) share one executor,
    // attached while at least one group is on.
    sttsSet(group, on) {
        const { editCallback, completeCallback } = this._sttsCallbacks
        const stts = this.get('stts') ?? new SttsToolExecutor(editCallback, completeCallback)
        stts.setActive(group, on)
        if (stts.hasActive) this.attach('stts', stts, { channels: [VOICE_ASSISTANT_CHANNEL], voiceOnly: true })
        else this.detach('stts')
    }

    get vtubeEnabled() { return this.has('vtube') }
    refreshExpressions() { return this.get('vtube')?.refreshExpressions() ?? Promise.resolve() }

    // ---- turn bookkeeping (delegated to chat) ----
    resetTurn() { for (const { exec } of this._mods.values()) exec.resetTurn?.() }
    shouldHardStop() { return this.chat.shouldHardStop() }
    markFlawed(reason) { this.chat.markFlawed(reason) }
    recordNarration() { return this.chat.recordNarration() }
    get turnFlawless() { return this.chat.turnFlawless }
    autoInjectMemory(queryText, speaker = {}) { return this.chat.autoInjectMemory(queryText, speaker) }
    addEpisodicMemory(payload) { return this.chat.addEpisodicMemory(payload) }
    addFactOutOfBand(payload) { return this.chat.addFactOutOfBand(payload) }
    removeFactOutOfBand(query) { return this.chat.removeFactOutOfBand(query) }
    takePendingImages() { return this.get('stts')?.takePendingImages() ?? [] }

    // ---- tool lists: union of attached executors, deduped by name ----
    _collect(visible) {
        const seen = new Map()
        for (const m of this._mods.values()) {
            if (!visible(m)) continue
            for (const tool of m.exec.tools) seen.set(tool.function.name, tool)
        }
        return [...seen.values()]
    }
    toolsFor(channelId) { return this._collect(m => m.channels === '*' || m.channels.includes(channelId)) }
    get tools() { return this.toolsFor(MINECRAFT_CHANNEL) }
    get allTools() { return this._collect(() => true) }

    // ---- tool name checks ----
    isInputTool(name) { return INPUT_TOOL_NAMES.has(name) }
    isMinecraftTool(name) { return MINECRAFT_TOOL_NAMES.has(name) }
    isVtubeTool(name) { return VTUBE_TOOL_NAMES.has(name) }

    // ---- execute: only tools of attached executors run ----
    async execute(name, args, context = {}) {
        const mod = [...this._mods.values()].find(m => m.exec.toolNames.has(name))
        if (!mod) {
            const known = ALL_TOOL_NAMES.has(name)
            Logger.warning(known ? `Blocked "${name}" — its module isn't running` : `Unknown: ${name}`, "TOOL")
            this.chat.markFlawed(known ? 'module_disabled' : 'unknown_tool')
            return JSON.stringify({ status: "error", message: known ? `${name} is currently disabled.` : `Unknown tool: ${name}` })
        }

        if (mod.voiceOnly) {
            const inVoiceChannel = context.channelId === VOICE_ASSISTANT_CHANNEL
            const isTrustedDM = getConfig().allowAnyToolViaDM
                && context.isDM
                && context.userId
                && String(context.userId) === String(getOwnerId())

            if (!inVoiceChannel && !isTrustedDM) {
                Logger.warning(`Blocked "${name}" outside voiceAssistant channel (channelId=${context.channelId}, isDM=${context.isDM}, userId=${context.userId})`, "TOOL")
                this.chat.markFlawed('voice_tool_wrong_channel')
                return JSON.stringify({ status: "error", message: `${name} is only available in voice conversations or trusted DMs.` })
            }
        }

        for (const { exec } of this._mods.values()) exec.noteTool?.(name) // typing tools track whether the turn read outside content
        return mod.exec.execute(name, args, context)
    }
}

const ALL_TOOL_NAMES = new Set([
    ...CHAT_TOOL_NAMES,
    ...MINECRAFT_TOOL_NAMES,
    ...VTUBE_TOOL_NAMES,
    ...VRCHAT_TOOL_NAMES,
    ...STTS_TOOL_NAMES,
    ...BROWSER_TOOL_NAMES,
])

export { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL }