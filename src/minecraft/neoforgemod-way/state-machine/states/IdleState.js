export class IdleState {
    constructor(ctx) {
        this.ctx = ctx
    }

    onEnter() {
        this.ctx.move.stop()
        this.ctx.sneak.cancelHold()
        this.ctx.sneak.setSneaking(false)
        console.log('[Idle] Entered')
    }

    onTick() {
        // 1. Duel target exists?
        if (this.ctx.duelTarget && this.ctx.players[this.ctx.duelTarget]) {
            this.ctx.transitionTo('DUELING')
            this.ctx.mcSend('sprint', {});
            return
        }

        // 2. Low HP?
        if (this.ctx.lilyHp <= this.ctx.opts.lowHpThreshold) {
            this.ctx.transitionTo('RECOVERING')
            return
        }

        // 3. Hostile nearby?
        const hostile = this.ctx.nearestHostile()
        if (hostile) {
            this.ctx.transitionTo('ATTACKING')
            return
        }

        // 4. Follow target out of range?
        const target = this.ctx.getFollowTarget()
        if (target) {
            const dist = this.ctx._dist(this.ctx.lilyPos, target)
            if (dist > this.ctx.opts.followDistance) {
                this.ctx.transitionTo('FOLLOWING')
                return
            }
        }

        // Otherwise stay idle – do nothing
    }

    onExit() {
        console.log('[Idle] Exited')
    }
}