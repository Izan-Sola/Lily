export class AttackingState {
  constructor(ctx) {
    this.ctx = ctx
    this.attackInterval = null
    this.targetId = null
  }

  onEnter(payload = {}) {
    this.targetId = payload.entityId ?? null
    console.log(`[Attacking] Engaging ${this.targetId != null ? `target id:${this.targetId}` : 'nearest hostile (autonomous)'}`)

    if (this.attackInterval) clearInterval(this.attackInterval)
    this.attackInterval = setInterval(() => {
      if (this.ctx.currentStateName !== 'ATTACKING') return
      // Swing at whatever she's currently facing, but only if there's still
      // something to actually be fighting — locked target still alive/in range,
      // or (autonomous mode) a hostile still exists at all.
      const stillFighting = this.targetId != null
        ? this.ctx.findEntityById(this.targetId)
        : this.ctx.nearestHostile()
      if (stillFighting) this.ctx.mcSend('attack', { mode: 'once' })
    }, 1500)
  }

  onTick() {
    const nearest = this.ctx.nearestHostileWithin(2.5)

    if (this.targetId != null) {
      const locked = this.ctx.findEntityById(this.targetId)
      if (!locked) { this.ctx.transitionTo('IDLE'); return }

      if (nearest && nearest.id !== locked.id) {
        this.ctx.mcSend('look_at', { x: nearest.x, y: nearest.y + 1, z: nearest.z })
        this.ctx.move.stop()
        return
      }

      this.ctx.mcSend('look_at', { x: locked.x, y: locked.y + 1, z: locked.z })
      const dist = this.ctx._dist(this.ctx.lilyPos, locked)
      if (dist > 2.5) this.ctx.move.moveToward(this.ctx.lilyPos, locked)
      else this.ctx.move.stop()
      return
    }

    // Autonomous — original behavior, now using the shared attackRange-bound nearestHostile()
    const hostile = this.ctx.nearestHostile()
    if (!hostile) { this.ctx.transitionTo('IDLE'); return }
    this.ctx.mcSend('look_at', { x: hostile.x, y: hostile.y + 1, z: hostile.z })
    if (this.ctx._dist(this.ctx.lilyPos, hostile) > 2.5) {
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
    this.targetId = null
    this.ctx.move.stop()
    console.log('[Attacking] Exited')
  }
}