export class MiningState {
    constructor(ctx) { this.ctx = ctx }

    onEnter({ payload = null } = {}) {
        this.payload = payload
        this.started = false
    }

    onExit() {
        if (this.started) this.ctx.mcSend('cancel_break')
        this.payload = null
        this.started = false
    }

    async onTick() {
        const { ctx } = this
        if (!this.payload) {
            ctx.transitionTo('IDLE')
            return
        }
        // Java owns approach, facing, and attacking entirely now.
        if (!this.started) {
            this.started = true
            ctx.mcSend('break', this.payload)
        }
    }

    onMiningStarted() { } // purely informational now, nothing to drive here

    onBlockBroken(event) {
        if (!this.started) return
        if (event.done === false && event.nextX != null) return // chaining, Java's already on it

        this.started = false
        this.payload = null
        this.ctx.transitionTo('IDLE')
    }
}