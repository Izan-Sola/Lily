export class FollowingState {
  constructor(ctx) {
    this.ctx = ctx
  }
  
  onEnter() {
    console.log('[Following] Started following')
  }
  
  onTick() {
    const target = this.ctx.getFollowTarget()
    if (!target) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const dist = this.ctx._dist(this.ctx.lilyPos, target)
    if (dist > this.ctx.opts.followDistance) {
      this.ctx.mcSend('look_at', { x: target.x, y: target.y+1, z: target.z })
      this.ctx.move.moveToward(this.ctx.lilyPos, target)
    } else {
      this.ctx.move.stop()
      this.ctx.transitionTo('IDLE')
    }
  }
  
  onExit() {
    this.ctx.move.stop()
  }
}
/**
 * FOLLOWING STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * Activated when the follow target (default: shinyshadow_) is beyond
 * followDistance blocks. Lily looks at and moves toward the target each tick.
 * Returns to IDLE once within range.
 *
 * LIFECYCLE:
 *   onEnter → logs start
 *   onTick  → checks distance, looks at and moves toward target if too far,
 *             stops and transitions to IDLE if close enough
 *   onExit  → stops movement
 *
 * KEY VARIABLES:
 *   this.ctx.getFollowTarget()       → follow target player object or null
 *                                      e.g. { x: 100, y: 64, z: 200, hp: 20 }
 *   this.ctx.opts.followDistance     → distance threshold in blocks, default 3
 *   this.ctx.lilyPos                 → Lily's current position { x, y, z }
 *   this.ctx._dist(a, b)             → euclidean distance between two {x,y,z} points
 *   this.ctx.move.moveToward(a, b)   → sends move command toward b from a
 *   this.ctx.move.stop()             → sends stop command
 *
 * TRANSITIONS OUT:
 *   → IDLE  when follow target not found or within followDistance
 */