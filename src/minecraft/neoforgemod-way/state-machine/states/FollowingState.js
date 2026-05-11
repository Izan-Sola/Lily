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