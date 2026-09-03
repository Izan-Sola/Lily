import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'


// ─── Tool Router ─────────────────────────────────────────────────────────
//
// Composes the three domain executors (chat / minecraft / vtube) behind
// the single flat interface lily.js used to talk to the old monolithic
// ToolExecutor in tools.js. Nothing about the lily.js call-site contract
// changes — resetTurn() / execute() / shouldHardStop() / recordNarration()
// / markFlawed() / turnFlawless all still work exactly as before — this
// class just fans them out to the right domain object instead of being
// the domain object itself.
//
// Why a router instead of one big class: the three domains are already
// independent (see the "deliberately independent" note atop
// vtubeTools.js) — mining cooldowns, chat turn-budget, and expression
// cooldowns never need to know about each other. A router lets tools MIX
// FREELY within a single model turn: e.g. the model can call
// minecraft_action_break AND trigger_expression AND send_gif in the same
// turn, and each call is dispatched to its own executor purely by name —
// nobody has to pre-decide "this is a minecraft turn" or "this is a vtube
// turn". Only chat-domain tools spend from the chat turn-budget; mc/vtube
// calls bypass it entirely, same as before the split.
//
// Tool-list composition (see the getters below):
//   - chat tools:      always available
//   - vtube tools:     always available, independent of channel/context
//   - minecraft tools: only added by the caller for the minecraft channel
//                       (lily.js's getToolsForChannel still decides this —
//                       the router just exposes both a full list and a
//                       minecraft-free list so that decision stays simple)
class ToolRouter {
    // mcSend / getStateController: forwarded to MinecraftToolExecutor,
    // same contract as the old ToolExecutor constructor (minus the unused
    // legacy first arg, which nothing ever read from — see tools.js).
    // vtsClient is optional at construction time since the VTS connection
    // is often established async after Lily is built; wire it later with
    // setVtsClient().
    constructor(mcSend = null, getStateController = null, vtsClient = null) {
        this.chat = new ChatToolExecutor()
        this.minecraft = new MinecraftToolExecutor(mcSend, getStateController)
        this.vtube = new VtubeToolExecutor(vtsClient)

        // tool name -> owning executor, so execute() can dispatch in O(1)
        // without caring which domain a name belongs to.
        this._byName = new Map()
        for (const executor of [this.chat, this.minecraft, this.vtube]) {
            for (const name of executor.toolNames) {
                this._byName.set(name, executor)
            }
        }
    }

    // ─── Minecraft bridge wiring ────────────────────────────────────────
    // Kept as both a property-style passthrough (this.tools.mcSend = fn,
    // the old call-site pattern in lily.js's setMcSend) and an explicit
    // method, since both styles were used across the codebase.
    get mcSend() {
        return this.minecraft.mcSend
    }
    set mcSend(fn) {
        this.minecraft.setMcSend(fn)
    }
    setMcSend(fn) {
        this.minecraft.setMcSend(fn)
    }

    // ─── VTS client wiring ──────────────────────────────────────────────
    // Called by Lily/index wiring once the VTS websocket is (re)authenticated
    // — see the comment atop VtubeToolExecutor. refreshExpressions() can
    // also be called on a timer to pick up new hotkeys without a reconnect.
    setVtsClient(vtsClient) {
        this.vtube.setVtsClient(vtsClient)
    }
    refreshExpressions() {
        return this.vtube.refreshExpressions()
    }
    get vtubeEnabled() {
        return this.vtube.isEnabled
    }
    // ─── Turn/flaw state — owned by chat, forwarded 1:1 ─────────────────
    // Minecraft and vtube tools don't have their own turn concept (they're
    // gated by per-action cooldowns instead), so all turn/flawless
    // bookkeeping lives on the chat executor and is just exposed here
    // under the same names lily.js already calls on `this.tools`.
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

    // ─── Chat-only passthroughs used directly by lily.js ────────────────
    autoInjectMemory(queryText) {
        return this.chat.autoInjectMemory(queryText)
    }

    addEpisodicMemory(payload) {
        return this.chat.addEpisodicMemory(payload)
    }

    // ─── Tool-definition lists ───────────────────────────────────────────
    // All built live off each domain's own `tools` getter (never cached
    // here) because vtube's tool definition changes at runtime as
    // expressionCache is refreshed — a stale precomputed array would keep
    // offering an old/empty expression enum.
    get tools() {
        // Everything, every domain — parity with the old flat TOOLS export.
        return [...this.chat.tools, ...this.minecraft.tools, ...this.vtube.tools]
    }

    get nonMinecraftTools() {
        // Chat + vtube, no minecraft_action_* — what every non-minecraft
        // channel gets. Vtube tools are included here too so a Discord
        // (or any other) chat channel can still trigger expressions.
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

    // ─── Dispatch ────────────────────────────────────────────────────────
    // Routes purely by tool name. This — not any notion of "current mode"
    // — is what lets tools mix freely within one turn: a call to
    // trigger_expression is routed to the vtube executor regardless of
    // whether a minecraft_action_* or a chat tool was also called earlier
    // in the same tool loop.
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

// Flat union of every domain's tool names — parity with the old TOOL_NAMES
// export from tools.js, used by lily.js to sniff for a narrated-not-called
// tool name in plain-text model output.
const ALL_TOOL_NAMES = new Set([
    ...CHAT_TOOL_NAMES,
    ...MINECRAFT_TOOL_NAMES,
    ...VTUBE_TOOL_NAMES,
])

export { ToolRouter, ALL_TOOL_NAMES }