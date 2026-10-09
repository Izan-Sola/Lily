// Everything one pass of the tool loop needs, created per handleMessage /
// resumeToolLoop and passed down instead of living in per-channel Maps.
import { ToolCallTracker } from '../utils.js'

export class TurnContext {
    /**
     * @param {object} p
     * @param {string} p.channelId
     * @param {string|null} p.systemPrompt  override for the base system prompt
     * @param {object} p.opts               caller options (isDM, userId, tools, skipHistory, ...)
     * @param {Array}  p.images
     * @param {Array}  p.baseTools          tool schemas allowed on this channel
     * @param {number} p.maxToolRepeats
     * @param {object|null} p.userMessage   message that started the turn (training capture)
     * @param {string|null} p.autoMemory    injected memory block for this turn
     */
    constructor({ channelId, systemPrompt = null, opts = {}, images = [], baseTools = [], maxToolRepeats, userMessage = null, autoMemory = null }) {
        this.channelId = channelId
        this.systemPrompt = systemPrompt
        this.opts = opts
        this.images = images
        this.baseTools = baseTools
        this.foreignTools = opts.tools ?? []
        this.foreignNames = new Set(this.foreignTools.map(t => t.function?.name).filter(Boolean))
        this.userMessage = userMessage
        this.autoMemory = autoMemory
        this.scratch = []                       // in-turn messages not yet in history
        this.tracker = new ToolCallTracker(maxToolRepeats)
        this.toolUses = new Map()               // tool name -> calls this pass
        this.gifUrl = null
        this.imagesInjected = false
    }

    /** Context for a continuation pass that inherits the originating turn's message and memory. */
    static resume(prev, fields) {
        return new TurnContext({ ...fields, userMessage: prev?.userMessage ?? null, autoMemory: prev?.autoMemory ?? null })
    }
}
