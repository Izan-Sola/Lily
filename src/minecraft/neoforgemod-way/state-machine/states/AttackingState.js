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