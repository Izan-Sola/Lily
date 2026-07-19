export class MiningState {
    constructor(ctx) { this.ctx = ctx }

    onEnter({ blocks = [] } = {}) {
        this.queue = [...blocks]
        this.current = null
        this.mining = false
    }

    onExit() {
        this.ctx.move.stop()
        // If a block was still being broken when we left this state (e.g.
        // interrupted by combat), tell Java to stop swinging at it — otherwise
        // she'd keep holding attack at a target she's no longer near.
        if (this.mining) this.ctx.mcSend('cancel_break')
        this.queue = []
        this.current = null
        this.mining = false
    }

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

        if (dist > 3) {
            ctx.move.moveToward(ctx.lilyPos, this.current)
            return
        }

        ctx.move.stop()
        if (!this.mining) {
            this.mining = true
            ctx.mcSend('break', { x: this.current.x, y: this.current.y, z: this.current.z })
        }

        // No timer here — Java equips the right tool, holds real "attack continue"
        // against the block, and only reports back (see onBlockBroken) once it's
        // actually gone, so break speed matches the block's real hardness/tool
        // instead of a guessed duration.
    }

    onBlockBroken(event) {
        if (!this.mining) return
        this.mining = false
        // Advance the queue whether it broke or Java gave up on a safety-net
        // timeout (bad/missing tool, obstruction) — either way there's nothing
        // more to do with this target, so move on to the next queued block.
        this.current = null
    }
}