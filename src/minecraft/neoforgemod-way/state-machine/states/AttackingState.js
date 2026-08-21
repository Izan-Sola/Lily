import { Logger } from "../../../../utils/Logger.js"

export class AttackingState {
  constructor(ctx) {
    this.ctx = ctx
    this.attackInterval = null
    this.targetId = null
  }

  onEnter(payload = {}) {
    this.targetId = payload.entityId ?? null
    Logger.info(`Engaging ${this.targetId != null ? `target id:${this.targetId}` : 'nearest hostile (autonomous)'}`, "ATTACKING")

    if (this.attackInterval) clearInterval(this.attackInterval)
    this.attackInterval = setInterval(() => {
      if (this.ctx.currentStateName !== 'ATTACKING') return
      const target = this.targetId != null
        ? this.ctx.findEntityById(this.targetId)
        : this.ctx.nearestHostile()
      if (!target) return
      this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1, z: target.z })
      this.ctx.mcSend('attack', { mode: 'once' })
    }, 500)
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
    Logger.info('Exited', "ATTACKING")
  }
}