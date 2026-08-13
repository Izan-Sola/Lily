import { Logger } from "../../../../utils/Logger.js"

export class IdleState {
    constructor(ctx) {
        this.ctx = ctx
    }

    onEnter() {
        this.ctx.move.stop()
        this.ctx.sneak.cancelHold()
        this.ctx.sneak.setSneaking(false)
        Logger.info('Entered Idle state', "IDLE")
    }

    onTick() {
        // 1. Low HP?
        if (this.ctx.lilyHp <= this.ctx.opts.lowHpThreshold) {
            this.ctx.transitionTo('RECOVERING')
            return
        }

        // 2. Hostile nearby?
        const hostile = this.ctx.nearestHostile()
        if (hostile) {
            this.ctx.transitionTo('ATTACKING')
            return
        }

        // 3. Follow target out of range?
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
        Logger.info('Exited Idle state', "IDLE")
    }
}
/**
 * IDLE STATE (mineflayer port)
 * ─────────────────────────────────────────────────────────────────────────────
 * Same central decision hub as the original. DUELING was dropped from the
 * priority list — it was built entirely around ProjectKorra bending combos,
 * which don't exist on a vanilla-ish cracked plugin server. Everything else
 * (RECOVERING > ATTACKING > FOLLOWING > idle) carries over unchanged.
 */
