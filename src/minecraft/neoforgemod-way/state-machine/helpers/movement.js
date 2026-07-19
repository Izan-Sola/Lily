export class MovementHelper {
  constructor(mcSend) {
    this.mcSend = mcSend
    this.movingToTarget = false
    this.lastTarget = null
    // Only re-issue move_to if the target has shifted more than this many
    // blocks since the last one we sent. move_to on the Java side owns the
    // actual BFS pathfinding + retry/anti-stuck loop once it starts — if we
    // resend it every single onTick() call, LilyTasks.startMoveTo() resets
    // its stuck-counter and jump/safety tasks constantly, which starves the
    // anti-stuck logic of the time it needs to actually detect being stuck.
    this.RETARGET_DIST = 2
  }

  moveToward(from, to) {
    if (!from || !to) return

    if (this.movingToTarget && this.lastTarget) {
      const shifted = Math.hypot(to.x - this.lastTarget.x, to.z - this.lastTarget.z)
      if (shifted < this.RETARGET_DIST) return
    }

    this.mcSend('move_to', { x: to.x, z: to.z })
    this.movingToTarget = true
    this.lastTarget = { x: to.x, z: to.z }
  }

  stop() {
    if (this.movingToTarget) {
      this.mcSend('stop')
      this.movingToTarget = false
      this.lastTarget = null
    }
  }
}