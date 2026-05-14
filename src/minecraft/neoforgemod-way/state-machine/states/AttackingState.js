export class AttackingState {
  constructor(ctx) {
    this.ctx = ctx
    this.attackInterval = null
  }

  onEnter() {
    console.log('[Attacking] Engaging hostile')
    // Start attack interval: every 1500ms
    if (this.attackInterval) clearInterval(this.attackInterval)
    this.attackInterval = setInterval(() => {
      // Only attack if still in attacking state and have a valid hostile
      if (this.ctx.currentStateName === 'ATTACKING') {
        const hostile = this.ctx.nearestHostile()
        if (hostile) {
          this.ctx.mcSend('attack', { mode: 'once' })
        }
      }
    }, 1500)
  }
// onEnter() {
//     console.log('[Attacking] Engaging hostile — testing FireKick combo')

//       setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'sneak' }),  200)
// }
  onTick() {
    const hostile = this.ctx.nearestHostile()
    if (!hostile) {
      this.ctx.transitionTo('IDLE')
      return
    }
    // Always look at hostile
    this.ctx.mcSend('look_at', { x: hostile.x, y: hostile.y + 1, z: hostile.z })

    const dist = this.ctx._dist(this.ctx.lilyPos, hostile)
    if (dist > 2.5) {
      this.ctx.move.moveToward(this.ctx.lilyPos, hostile)
    } else {
      this.ctx.move.stop()
    }
  }

  onExit() {
    if (this.attackInterval) {
      clearInterval(this.attackInterval)
      this.attackInterval = null
    }
    this.ctx.move.stop()
    console.log('[Attacking] Exited')
  }
}
/**
 * ATTACKING STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * Activated when a hostile mob is detected within attackRange blocks.
 * Handles melee combat: looks at the hostile, closes the gap, and swings.
 *
 * LIFECYCLE:
 *   onEnter  → starts a repeating attack interval (every 1500ms)
 *   onTick   → called every tickMs (75ms) — tracks hostile position, moves toward it
 *   onExit   → clears the attack interval, stops movement
 *
 * KEY VARIABLES:
 *   this.ctx                     → StateController instance (shared state)
 *   this.attackInterval          → setInterval handle, fires attack every 1500ms
 *   this.ctx.nearestHostile()    → returns nearest hostile entity or null
 *                                  e.g. { x: 100, y: 64, z: 200, type: "zombie", id: 42, hp: 10 }
 *   this.ctx.lilyPos             → Lily's current position { x, y, z }
 *   this.ctx._dist(a, b)         → euclidean distance between two {x,y,z} points
 *   dist > 2.5                   → threshold to close gap vs stand and swing
 *
 * TRANSITIONS OUT:
 *   → IDLE  when no hostile is found within range on tick
 */