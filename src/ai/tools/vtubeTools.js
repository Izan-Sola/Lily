import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'

const EXPRESSION_COOLDOWN_MS = 800

// ─── Vtube Tool Executor ────────────────────────────────────────────────
//
// Wraps a persistent, already-authenticated VTSClient connection.
// Deliberately independent of the chat-turn budget in chatTools.js and
// the minecraft cooldowns in minecraftTools.js — expressions have their
// own short cooldown and can fire alongside either domain (mining +
// expression, chatting + expression, etc.) since ToolRouter always
// exposes this executor's tool regardless of what else is active.
class VtubeToolExecutor {
    constructor(vtsClient = null) {
        this.vts = vtsClient
        this.expressionCache = []
        this.lastTrigger = 0
    }

    // Lily/index wiring calls this after the VTS connection is
    // (re)established, or on a timer to pick up new hotkeys added in
    // VTube Studio without restarting the process.
    async refreshExpressions() {
        if (!this.vts) return
        try {
            this.expressionCache = await this.vts.listHotkeys()
        } catch (e) {
            Logger.error(e.message, "VTUBE")
        }
    }

    setVtsClient(vtsClient) {
        this.vts = vtsClient
        this.expressionCache = []
    }

    get toolNames() {
        return VTUBE_TOOL_NAMES
    }

    // Built fresh on every access so the enum always reflects whatever is
    // currently in expressionCache — no separate static tool-def array to
    // keep in sync like chat/minecraft tools have, since this one field
    // (the enum) is the only thing that ever changes.
    get tools() {
        return [{
            type: "function",
            function: {
                name: "trigger_expression",
                description: "Trigger a facial expression/animation on your VTuber model. Fires independently of whatever else you're doing (chatting, mining, etc) — use it any time an expression fits the moment.",
                parameters: {
                    type: "object",
                    properties: {
                        expression: {
                            type: "string",
                            enum: this.expressionCache.map(h => h.name),
                            description: "Name of the expression to trigger."
                        }
                    },
                    required: ["expression"]
                }
            }
        }]
    }

    async triggerExpression(args = {}) {
        if (!this.vts) {
            return err("VTuber model isn't connected right now.")
        }

        if (Date.now() - this.lastTrigger < EXPRESSION_COOLDOWN_MS) {
            return JSON.stringify({ status: "cooldown", message: "Expression triggered too recently, skip it." })
        }

        // Lazy refresh: if nothing has populated the cache yet (e.g. this
        // is the very first call before any periodic refresh ran), try
        // once here instead of permanently offering an empty enum.
        if (!this.expressionCache.length) {
            await this.refreshExpressions()
        }

        const match = this.expressionCache.find(h => h.name === args?.expression)
        if (!match) return err("Unknown expression.")

        try {
            await this.vts.triggerHotkeyID(match.hotkeyID)
        } catch (e) {
            Logger.error(e.message, "VTUBE")
            return err("Failed to trigger expression.")
        }

        this.lastTrigger = Date.now()
        Logger.info(`Triggered expression: ${match.name}`, "VTUBE")
        return ok(`Triggered ${match.name}.`)
    }

    async execute(name, args) {
        switch (name) {
            case "trigger_expression": return this.triggerExpression(args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

const VTUBE_TOOL_NAMES = new Set(['trigger_expression'])

export { VtubeToolExecutor, VTUBE_TOOL_NAMES }