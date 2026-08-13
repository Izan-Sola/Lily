import { Logger } from "../../../../utils/Logger.js"

export class RecoveringState {
  constructor(ctx) {
    this.ctx = ctx
    this.explicit = false
  }

  onEnter(payload = {}) {
    this.explicit = !!payload.explicit
    Logger.info(this.explicit
      ? `Told to retreat toward ${this.ctx.opts.followTarget}`
      : `[Recovering] Low HP (${this.ctx.lilyHp}) – retreating toward ${this.ctx.opts.followTarget}`, "RECOVERING")
    this.ctx.sneak.setSneaking(false)
  }

  onTick() {
    if (!this.explicit && this.ctx.lilyHp > this.ctx.opts.lowHpThreshold + 2) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const targetEntity = this.ctx.getFollowTargetEntity()
    if (!targetEntity) {
      this.ctx.transitionTo('IDLE')
      return
    }
    const target = targetEntity.position
    const dist = this.ctx._dist(this.ctx.lilyPos, target)
    if (dist > this.ctx.opts.followDistance) {
      this.ctx.move.followEntity(targetEntity, this.ctx.opts.followDistance - 1)
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
