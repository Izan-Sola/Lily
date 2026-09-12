// toolRouter.js
import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'
import { VrchatToolExecutor, VRCHAT_TOOL_NAMES } from './vrchatTools.js'
import { SttsToolExecutor, STTS_TOOL_NAMES } from './sttsTools.js'
import { BrowserToolExecutor, BROWSER_TOOL_NAMES } from './browserTools.js'
import { getConfig } from '../config.js'

const VOICE_ASSISTANT_CHANNEL = 'voiceAssistant'
const TOGGLEABLE_MODULES = ['minecraft', 'vtube', 'vrchat', 'stts', 'browser']

class ToolRouter {
    constructor({ mcSend = null, getStateController = null, vtsClient = null, sttsConfig = {}, flags = {} }) {
        const {
            minecraft = false,
            vtube = false,
            vrchat = false,
            stts = false,
            browser = false,
        } = flags

        this.chat = new ChatToolExecutor()

        this.minecraft = minecraft ? new MinecraftToolExecutor(mcSend, getStateController) : null
        this.vtube = vtube ? new VtubeToolExecutor(vtsClient) : null
        this.vrchat = vrchat ? new VrchatToolExecutor() : null
        this.stts = stts ? new SttsToolExecutor(
            sttsConfig.enabled,
            sttsConfig.pidevEnabled,
            sttsConfig.codingEnabled,
            sttsConfig.editCallback,
        ) : null
        this.browser = browser ? new BrowserToolExecutor() : null

        // Runtime on/off switch per module. Only meaningful for modules whose
        // executor actually exists (was started with its flag at boot) — this
        // never starts or stops a bridge, it only controls whether that
        // module's tools are offered to the model / allowed to execute.
        this._enabled = {
            minecraft: true,
            vtube: true,
            vrchat: true,
            stts: true,
            browser: true,
        }

        this._byName = new Map()
        this._moduleByName = new Map() // toolName -> module key, or null for chat (never toggleable)

        const register = (executor, moduleKey) => {
            for (const name of executor.toolNames) {
                this._byName.set(name, executor)
                this._moduleByName.set(name, moduleKey)
            }
        }

        register(this.chat, null)
        if (this.minecraft) register(this.minecraft, 'minecraft')
        if (this.vtube) register(this.vtube, 'vtube')
        if (this.vrchat) register(this.vrchat, 'vrchat')
        if (this.stts) register(this.stts, 'stts')
        if (this.browser) register(this.browser, 'browser')
    }

    // ---- setters (preserved) ----
    get mcSend() { return this.minecraft?.mcSend ?? null }
    set mcSend(fn) { if (this.minecraft) this.minecraft.setMcSend(fn) }
    setMcSend(fn) { this.mcSend = fn }

    setVtsClient(vtsClient) { if (this.vtube) this.vtube.setVtsClient(vtsClient) }
    setBrowserClient(client) { if (this.browser) this.browser.setClient(client) }
    refreshExpressions() { return this.vtube ? this.vtube.refreshExpressions() : Promise.resolve() }
    get vtubeEnabled() { return !!this.vtube && this._enabled.vtube }

    // ---- runtime module toggle ----
    // Returns { ok: boolean, reason?: string }
    setEnabled(moduleName, enabled) {
        if (!TOGGLEABLE_MODULES.includes(moduleName)) {
            return { ok: false, reason: `"${moduleName}" isn't a toggleable module.` }
        }
        if (!this[moduleName]) {
            return { ok: false, reason: `${moduleName} wasn't started with its flag at boot, so there's no bridge to toggle. Restart the process with that flag to make it available.` }
        }
        this._enabled[moduleName] = !!enabled
        Logger.info(`${moduleName} tools ${enabled ? 'ENABLED' : 'DISABLED'}`, "MODULE TOGGLE")
        return { ok: true }
    }

    // Status for every toggleable module, for the control panel.
    getStatus() {
        const status = {}
        for (const key of TOGGLEABLE_MODULES) {
            status[key] = {
                available: !!this[key],
                enabled: !!this[key] && this._enabled[key],
            }
        }
        return status
    }

    // ---- core methods (delegated) ----
    resetTurn() { this.chat.resetTurn() }
    shouldHardStop() { return this.chat.shouldHardStop() }
    markFlawed(reason) { this.chat.markFlawed(reason) }
    recordNarration() { return this.chat.recordNarration() }
    get turnFlawless() { return this.chat.turnFlawless }
    autoInjectMemory(queryText) { return this.chat.autoInjectMemory(queryText) }
    addEpisodicMemory(payload) { return this.chat.addEpisodicMemory(payload) }

    // ---- Tool lists – only include enabled executors ----
    get tools() {
        const base = [...this.chat.tools]
        if (this.minecraft && this._enabled.minecraft) base.push(...this.minecraft.tools)
        if (this.vtube && this._enabled.vtube) base.push(...this.vtube.tools)
        return base
    }

    get nonMinecraftTools() {
        const base = [...this.chat.tools]
        if (this.vtube && this._enabled.vtube) base.push(...this.vtube.tools)
        return base
    }

    get vrchatTools() {
        const base = [...this.chat.tools]
        if (this.vtube && this._enabled.vtube) base.push(...this.vtube.tools)
        if (this.vrchat && this._enabled.vrchat) base.push(...this.vrchat.tools)
        return base
    }

    get voiceAssistantTools() {
        const base = [...this.chat.tools]
        if (this.vtube && this._enabled.vtube) base.push(...this.vtube.tools)
        if (this.stts && this._enabled.stts) base.push(...this.stts.tools)
        if (this.browser && this._enabled.browser) base.push(...this.browser.tools)
        return base
    }

    // ---- Full tool list – union of every enabled executor, deduped by name.
    get allTools() {
        const seen = new Map()
        const executors = [this.chat, this.minecraft, this.vtube, this.vrchat, this.stts, this.browser]
            .filter(Boolean)
        for (const executor of executors) {
            const moduleKey = executor === this.chat ? null : this._moduleName(executor)
            if (moduleKey && !this._enabled[moduleKey]) continue
            for (const tool of executor.tools) {
                seen.set(tool.function.name, tool)
            }
        }
        return [...seen.values()]
    }

    _moduleName(executor) {
        if (executor === this.minecraft) return 'minecraft'
        if (executor === this.vtube) return 'vtube'
        if (executor === this.vrchat) return 'vrchat'
        if (executor === this.stts) return 'stts'
        if (executor === this.browser) return 'browser'
        return null
    }

    // ---- tool name checks (safe) ----
    isChatTool(name) { return CHAT_TOOL_NAMES.has(name) }
    isMinecraftTool(name) { return this.minecraft && MINECRAFT_TOOL_NAMES.has(name) }
    isVtubeTool(name) { return this.vtube && VTUBE_TOOL_NAMES.has(name) }
    isVrchatTool(name) { return this.vrchat && VRCHAT_TOOL_NAMES.has(name) }
    isSttsTool(name) { return this.stts && STTS_TOOL_NAMES.has(name) }
    isBrowserTool(name) { return this.browser && BROWSER_TOOL_NAMES.has(name) }

    // ---- screenshot drain (only if stts enabled) ----
    takePendingImages() {
        return this.stts ? this.stts.takePendingImages() : []
    }

    // ---- execute – only if executor exists AND its module is enabled ----
    async execute(name, args, context = {}) {
        const executor = this._byName.get(name)
        if (!executor) {
            Logger.warning(`Unknown: ${name}`, "TOOL")
            this.chat.markFlawed('unknown_tool')
            return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` })
        }

        const moduleKey = this._moduleByName.get(name)
        if (moduleKey && !this._enabled[moduleKey]) {
            Logger.warning(`Blocked "${name}" — ${moduleKey} module is disabled`, "TOOL")
            this.chat.markFlawed('module_disabled')
            return JSON.stringify({ status: "error", message: `${moduleKey} is currently disabled.` })
        }

        const isStts = this.stts && this.isSttsTool(name)
        const isBrowser = this.browser && this.isBrowserTool(name)

        if (isStts || isBrowser) {
            const inVoiceChannel = context.channelId === VOICE_ASSISTANT_CHANNEL
            const opts = getConfig()
            const isTrustedDM = opts.allowAnyToolViaDM
                && context.isDM
                && context.userId
                && String(context.userId) === String(opts.discordUserID)

            if (!inVoiceChannel && !isTrustedDM) {
                Logger.warning(`Blocked "${name}" outside voiceAssistant channel (channelId=${context.channelId}, isDM=${context.isDM}, userId=${context.userId})`, "TOOL")
                this.chat.markFlawed(isStts ? 'stts_tool_wrong_channel' : 'browser_tool_wrong_channel')
                return JSON.stringify({ status: "error", message: `${name} is only available in voice conversations or trusted DMs.` })
            }
        }

        return executor.execute(name, args)
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

export { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL, TOGGLEABLE_MODULES }