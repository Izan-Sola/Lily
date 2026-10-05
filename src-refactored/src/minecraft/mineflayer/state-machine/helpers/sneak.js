import { Logger } from "../../../../utils/Logger.js"

/**
 * SneakHelper (mineflayer port)
 * Same pulse/hold/cancel API as the original — just drives bot.setControlState
 * instead of sending a 'sneak' WS event to the Java mod.
 */
export class SneakHelper {
  constructor(bot) {
    this.bot = bot
    this.isSneaking = false
    this._holdTimer = null
  }

  setSneaking(value) {
    if (this.isSneaking === value) return
    this.isSneaking = value
    this.bot.setControlState('sneak', value)
    Logger.info(`${value ? 'ON' : 'OFF'}`, "SNEAK")
  }

  pulse(ms = 100) {
    this.cancelHold()
    this.setSneaking(false)
    setTimeout(() => {
      this.setSneaking(true)
      this._holdTimer = setTimeout(() => {
        this.setSneaking(false)
        this._holdTimer = null
      }, ms)
    }, 50)
  }

  hold(ms = 0) {
    this.cancelHold()
    this.setSneaking(false)
    setTimeout(() => {
      this.setSneaking(true)
      if (ms > 0) {
        this._holdTimer = setTimeout(() => {
          this.setSneaking(false)
          this._holdTimer = null
        }, ms)
      }
    }, 50)
  }

  cancelHold() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer)
      this._holdTimer = null
    }
  }
}
