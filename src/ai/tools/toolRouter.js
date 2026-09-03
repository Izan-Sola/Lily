import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'

class ToolRouter {

    constructor(mcSend = null, getStateController = null, vtsClient = null) {
        this.chat = new ChatToolExecutor()
        this.minecraft = new MinecraftToolExecutor(mcSend, getStateController)
        this.vtube = new VtubeToolExecutor(vtsClient)

        this._byName = new Map()
        for (const executor of [this.chat, this.minecraft, this.vtube]) {
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

    isChatTool(name) {
        return CHAT_TOOL_NAMES.has(name)
    }

    isMinecraftTool(name) {
        return MINECRAFT_TOOL_NAMES.has(name)
    }

    isVtubeTool(name) {
        return VTUBE_TOOL_NAMES.has(name)
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
])

export { ToolRouter, ALL_TOOL_NAMES }