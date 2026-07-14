export class RecoveringState {
  constructor(ctx) {
    this.ctx = ctx
    this.explicit = false
  }

  onEnter(payload = {}) {
    this.explicit = !!payload.explicit
    console.log(this.explicit
      ? `[Recovering] Told to retreat toward ${this.ctx.opts.followTarget}`
      : `[Recovering] Low HP (${this.ctx.lilyHp}) – retreating toward ${this.ctx.opts.followTarget}`)
    this.ctx.sneak.setSneaking(false)
  }

  onTick() {
    if (!this.explicit && this.ctx.lilyHp > this.ctx.opts.lowHpThreshold + 2) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const target = this.ctx.getFollowTarget()
    if (!target) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const dist = this.ctx._dist(this.ctx.lilyPos, target)
    if (dist > this.ctx.opts.followDistance) {
      this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1, z: target.z })
      this.ctx.move.moveToward(this.ctx.lilyPos, target)
    } else {
      this.ctx.move.stop()
      if (this.explicit) this.ctx.transitionTo('IDLE') // autonomous case waits for HP to recover instead
    }
  }

  onExit() {
    this.ctx.move.stop()
    this.explicit = false
  }
}