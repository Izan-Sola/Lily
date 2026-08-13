import { Logger } from "../../../../utils/Logger.js"

const ATTACK_RANGE = 2.5
const ATTACK_INTERVAL_MS = 650 // ~ vanilla sword cooldown; original used 1100ms for a slower PK weapon swing

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
      const stillFighting = this.targetId != null
        ? this.ctx.findEntityById(this.targetId)
        : this.ctx.nearestHostile()
      if (stillFighting && this.ctx._dist(this.ctx.lilyPos, stillFighting) <= ATTACK_RANGE) {
        this.ctx.bot.attack(stillFighting)
      }
    }, ATTACK_INTERVAL_MS)
  }

  onTick() {
    if (this.targetId != null) {
      const locked = this.ctx.findEntityById(this.targetId)
      if (!locked) { this.ctx.transitionTo('IDLE'); return }

      this.ctx.bot.lookAt(locked.position.offset(0, locked.height ?? 1, 0), true)
      const dist = this.ctx._dist(this.ctx.lilyPos, locked.position)
      if (dist > ATTACK_RANGE) this.ctx.move.moveToward(this.ctx.lilyPos, locked.position, ATTACK_RANGE - 0.5)
      else this.ctx.move.stop()
      return
    }

    // Autonomous — pick whatever's nearest within attackRange every tick
    const hostile = this.ctx.nearestHostile()
    if (!hostile) { this.ctx.transitionTo('IDLE'); return }
    this.ctx.bot.lookAt(hostile.position.offset(0, hostile.height ?? 1, 0), true)
    if (this.ctx._dist(this.ctx.lilyPos, hostile.position) > ATTACK_RANGE) {
      this.ctx.move.moveToward(this.ctx.lilyPos, hostile.position, ATTACK_RANGE - 0.5)
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
