//* Comments added by Lily herself lol
// Mining state manages breaking blocks
// Tracks whether mining has started and handles transitions
export class MiningState {
    constructor(ctx) {
        this.ctx = ctx
    }

    // Initializes state variables and handles entry logic
    onEnter({ payload = null } = {}) {
        this.payload = payload
        this.started = false
    }

    // Cleans up state when exiting
    onExit() {
        if (this.started) this.ctx.mcSend('cancel_break')
        this.payload = null
        this.started = false
    }

    // Main tick method, handles continuous actions
    async onTick() {
        const { ctx } = this

        // Exit if no payload is set (no block to mine)
        if (!this.payload) {
            ctx.transitionTo('IDLE')
            return
        }

        // Start mining if not already started
        if (!this.started) {
            this.started = true
            ctx.mcSend('break', this.payload)
        }
    }

    // Called when mining action is initiated
    onMiningStarted() {
        // Empty placeholder, you'd implement actual logic here if needed
    }

    // Handles block breaking events
    onBlockBroken(event) {
        // Early exit if not started or if nextX is null (invalid break)
        if (!this.started) return
        if (event.done === false && event.nextX != null) return

        // Stop mining and transition to idle on successful break
        this.started = false
        this.payload = null
        this.ctx.transitionTo('IDLE')
    }
}