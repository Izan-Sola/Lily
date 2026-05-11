export class SneakHelper {
  constructor(mcSend) {
    this.mcSend = mcSend
    this.isSneaking = false
    this._holdTimer = null
  }
  
  setSneaking(value) {
    if (this.isSneaking === value) return
    this.isSneaking = value
    this.mcSend('sneak', { value })
    console.log(`[SNEAK] ${value ? 'ON' : 'OFF'}`)
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