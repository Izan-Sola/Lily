export class RecoveringState {
  constructor(ctx) {
    this.ctx = ctx
  }
  
  onEnter() {
    console.log('[Recovering] Low HP – retreating')
    this.ctx.sneak.setSneaking(false)
    this.ctx.move.stop()
  }
  
  onTick() {
    // if (this.ctx.lilyHp > this.ctx.opts.lowHpThreshold + 2) {
    //   this.ctx.transitionTo('IDLE')
    //   return
    // }
    // const target = this.ctx.getFollowTarget()
    // if (target) {
    //   this.ctx.mcSend('look_at', { x: target.x, y: target.y+1, z: target.z })
    //   this.ctx.move.moveToward(this.ctx.lilyPos, target)
    // }
  }
  
  onExit() {
    this.ctx.move.stop()
  }
}
/**
 * RECOVERING STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * Activated when Lily's HP drops to or below lowHpThreshold (default: 6/20).
 * Intended to make Lily stop fighting and flee toward the follow target.
 *
 * NOTE: Recovery logic is currently commented out — the state enters and stays
 * until manually transitioned. Re-enable the onTick body to restore flee behavior:
 *   - Checks if HP has recovered above (lowHpThreshold + 2)
 *   - Flees toward follow target (shinyshadow_ by default) while still low
 *
 * LIFECYCLE:
 *   onEnter  → cancels sneak, stops movement
 *   onTick   → runs to player
 *   onExit   → stops movement
 *
 * KEY VARIABLES:
 *   this.ctx.lilyHp              → Lily's current HP (0–20), e.g. 5
 *   this.ctx.opts.lowHpThreshold → HP value that triggered this state, default 6
 *   this.ctx.getFollowTarget()   → returns the follow target player object or null
 *                                  e.g. { x: 150, y: 64, z: 300, hp: 20 }
 *
 * TRANSITIONS OUT:
 *   → IDLE  when HP > lowHpThreshold + 2 (currently disabled)
 */