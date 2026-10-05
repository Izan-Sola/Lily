import { Logger } from "../../../../utils/Logger.js"

export class FollowingState {
  constructor(ctx) {
    this.ctx = ctx
  }

  onEnter() {
    Logger.info(`[Following] Started following ${this.ctx.opts.followTarget}`, "FOLLOWING")
  }

  onTick() {
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
      this.ctx.transitionTo('IDLE')
    }
  }

  onExit() {
    this.ctx.move.stop()
  }
}
