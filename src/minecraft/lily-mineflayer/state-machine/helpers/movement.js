import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

/**
 * MovementHelper (mineflayer port)
 * ─────────────────────────────────────────────────────────────────────────────
 * Same throttling idea as the original WebSocket-based helper: don't spam
 * bot.pathfinder.setGoal() every tick. mineflayer-pathfinder owns the actual
 * A BFS pathing + stuck-recovery once a goal is set — resetting the goal
 * constantly (like the original comment about LilyTasks.startMoveTo()) would
 * starve it of the time it needs to actually get somewhere.
 *
 * Only re-issues a goal if the target has drifted more than RETARGET_DIST
 * blocks since the last one we sent.
 */
export class MovementHelper {
  constructor(bot) {
    this.bot = bot
    this.movingToTarget = false
    this.lastTarget = null
    this.RETARGET_DIST = 2
  }

  /**
   * @param {{x,y,z}} from  current position (kept for API parity w/ original; unused here)
   * @param {{x,y,z}} to    target position
   * @param {number} range  how close is "close enough" (GoalNear radius), default 1.5
   */
  moveToward(from, to, range = 1.5) {
    if (!from || !to) return

    if (this.movingToTarget && this.lastTarget) {
      const shifted = Math.hypot(to.x - this.lastTarget.x, to.z - this.lastTarget.z)
      if (shifted < this.RETARGET_DIST) return
    }

    this.bot.pathfinder.setGoal(new goals.GoalNear(to.x, to.y, to.z, range))
    this.movingToTarget = true
    this.lastTarget = { x: to.x, z: to.z }
  }

  /** Follow a moving entity directly (used by FollowingState — smoother than re-polling GoalNear). */
  followEntity(entity, range = 3) {
    if (!entity) return
    this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
    this.movingToTarget = true
    this.lastTarget = entity.position
  }

  stop() {
    if (this.movingToTarget) {
      this.bot.pathfinder.setGoal(null)
      this.movingToTarget = false
      this.lastTarget = null
    }
  }
}
