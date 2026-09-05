import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'
import { VrchatToolExecutor, VRCHAT_TOOL_NAMES } from './vrchatTools.js'

class ToolRouter {

    constructor(mcSend = null, getStateController = null, vtsClient = null) {
        this.chat = new ChatToolExecutor()
        this.minecraft = new MinecraftToolExecutor(mcSend, getStateController)
        this.vtube = new VtubeToolExecutor(vtsClient)
        this.vrchat = new VrchatToolExecutor()

        this._byName = new Map()
        for (const executor of [this.chat, this.minecraft, this.vtube, this.vrchat]) {
            for (const name of executor.toolNames) {
                this._byName.set(name, executor)
            }
        }
    }

    get mcSend() {
        return this.minecraft.mcSend
    }
    set mcSend(fn) {
        this.minecraft.setMcSend(fn)
    }
    setMcSend(fn) {
        this.minecraft.setMcSend(fn)
    }

    setVtsClient(vtsClient) {
        this.vtube.setVtsClient(vtsClient)
    }
    refreshExpressions() {
        return this.vtube.refreshExpressions()
    }
    get vtubeEnabled() {
        return this.vtube.isEnabled
    }

    resetTurn() {
        this.chat.resetTurn()
    }

    shouldHardStop() {
        return this.chat.shouldHardStop()
    }

    markFlawed(reason) {
        this.chat.markFlawed(reason)
    }

    recordNarration() {
        return this.chat.recordNarration()
    }

    get turnFlawless() {
        return this.chat.turnFlawless
    }

    autoInjectMemory(queryText) {
        return this.chat.autoInjectMemory(queryText)
    }

    addEpisodicMemory(payload) {
        return this.chat.addEpisodicMemory(payload)
    }

    get tools() {

        return [...this.chat.tools, ...this.minecraft.tools, ...this.vtube.tools]
    }

    get nonMinecraftTools() {

        return [...this.chat.tools, ...this.vtube.tools]
    }

    // Chat + VTube expressions + the VRChat avatar-action tool, but never
    // the Minecraft tools — mirrors nonMinecraftTools' shape but is its
    // own getter (rather than reusing nonMinecraftTools) so a future
    // channel-specific tool for one domain never silently leaks into the
    // other.
    get vrchatTools() {
        return [...this.chat.tools, ...this.vtube.tools, ...this.vrchat.tools]
    }

    isChatTool(name) {
        return CHAT_TOOL_NAMES.has(name)
    }

    isMinecraftTool(name) {
        return MINECRAFT_TOOL_NAMES.has(name)
    }

    isVtubeTool(name) {
        return VTUBE_TOOL_NAMES.has(name)
    }

    isVrchatTool(name) {
        return VRCHAT_TOOL_NAMES.has(name)
    }

    async execute(name, args) {
        const executor = this._byName.get(name)
        if (!executor) {
            Logger.warning(`Unknown: ${name}`, "TOOL")
            this.chat.markFlawed('unknown_tool')
            return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` })
        }
        return executor.execute(name, args)
    }
}

const ALL_TOOL_NAMES = new Set([
    ...CHAT_TOOL_NAMES,
    ...MINECRAFT_TOOL_NAMES,
    ...VTUBE_TOOL_NAMES,
    ...VRCHAT_TOOL_NAMES,
])

export { ToolRouter, ALL_TOOL_NAMES }
