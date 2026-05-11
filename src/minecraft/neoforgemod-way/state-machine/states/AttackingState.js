export class AttackingState {
  constructor(ctx) {
    this.ctx = ctx
  }
  
  onEnter() {
    console.log('[Attacking] Engaging hostile')
  }
  
  onTick() {
    const hostile = this.ctx.nearestHostile()
    if (!hostile) {
      this.ctx.transitionTo('IDLE')
      return
    }
    this.ctx.mcSend('look_at', { x: hostile.x, y: hostile.y+1, z: hostile.z })
    const dist = this.ctx._dist(this.ctx.lilyPos, hostile)
    if (dist > 2.5) {
      this.ctx.move.moveToward(this.ctx.lilyPos, hostile)
    } else {
      this.ctx.move.stop()
      // Optionally attack here
    }
  }
  
  onExit() {
    this.ctx.move.stop()
  }
}