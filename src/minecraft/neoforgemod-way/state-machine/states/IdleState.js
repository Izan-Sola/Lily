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
/**
 * IDLE STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * The default resting state. Acts as the central decision hub — checks all
 * conditions on every tick and transitions to the appropriate state.
 * Priority order (highest to lowest):
 *   1. DUELING   — duelTarget is set and visible
 *   2. RECOVERING — HP at or below lowHpThreshold
 *   3. ATTACKING  — hostile mob within attackRange
 *   4. FOLLOWING  — follow target out of followDistance range
 *   5. Stay IDLE  — nothing to do
 *
 * LIFECYCLE:
 *   onEnter → stops movement, cancels any sneak hold
 *   onTick  → evaluates all conditions and transitions if needed
 *   onExit  → logs exit
 *
 * KEY VARIABLES:
 *   this.ctx.duelTarget          → player name being dueled or null, e.g. "shinyshadow_"
 *   this.ctx.players             → all online players { name: { x, y, z, hp } }
 *                                  e.g. { shinyshadow_: { x: 100, y: 64, z: 200, hp: 20 } }
 *   this.ctx.lilyHp              → Lily's current HP (0–20)
 *   this.ctx.opts.lowHpThreshold → HP floor before recovering, default 6
 *   this.ctx.nearestHostile()    → nearest hostile within attackRange or null
 *   this.ctx.getFollowTarget()   → follow target player object or null
 *   this.ctx.opts.followDistance → max blocks before following kicks in, default 3
 *   this.ctx._dist(a, b)         → distance between two {x,y,z} points
 *
 * TRANSITIONS OUT:
 *   → DUELING    when duelTarget is set and present in players
 *   → RECOVERING when lilyHp <= lowHpThreshold
 *   → ATTACKING  when hostile detected within range
 *   → FOLLOWING  when follow target is beyond followDistance
 */