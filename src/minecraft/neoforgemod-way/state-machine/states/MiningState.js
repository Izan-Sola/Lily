export class MiningState {
    constructor(ctx) { this.ctx = ctx }

    onEnter({ blocks = [] } = {}) {
        console.log('[MINE] onEnter received', blocks.length, 'blocks:', blocks.map(b => `${b.x},${b.y},${b.z}`))

        this.queue = [...blocks]
        this.current = null
        this.mining = false
        this.readyAt = 0
    }

    onExit() {
        this.ctx.move.stop()
        this.queue = []
        this.current = null
        this.mining = false
    }

    // MiningState.js
    async onTick() {
        const { ctx } = this

        if (!this.current) {
            this.current = this.queue.shift()
            if (!this.current) {
                ctx.transitionTo('IDLE')
                return
            }
            this.mining = false
        }

        const dist = ctx._dist(ctx.lilyPos, this.current)

        // resend every tick, same as FollowingState — a one-shot look call
        // gets overridden by movement each tick, so it has to keep fighting for it
        ctx.mcSend('look_at', { x: this.current.x, y: this.current.y + 0.5, z: this.current.z })

        if (dist > 1) {
            ctx.move.moveToward(ctx.lilyPos, this.current)
            return
        }

        ctx.move.stop()
        if (!this.mining) {
            this.mining = true
            ctx.mcSend('break', { x: this.current.x, y: this.current.y, z: this.current.z })
            this.readyAt = Date.now() + (ctx.opts.mineDurationMs ?? 1600)
        }

        if (Date.now() >= this.readyAt) {
            this.current = null
        }
    }
}