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
    if (this.ctx.lilyHp > this.ctx.opts.lowHpThreshold + 2) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const target = this.ctx.getFollowTarget()
    if (target) {
      this.ctx.mcSend('look_at', { x: target.x, y: target.y+1, z: target.z })
      this.ctx.move.moveToward(this.ctx.lilyPos, target)
    }
  }
  
  onExit() {
    this.ctx.move.stop()
  }
}