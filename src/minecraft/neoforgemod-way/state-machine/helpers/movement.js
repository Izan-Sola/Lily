export class MovementHelper {
  constructor(mcSend) {
    this.mcSend = mcSend
    this.lastMove = null
  }
  
  moveToward(from, to) {
    if (!from || !to) return
    const dx = to.x - from.x
    const dz = to.z - from.z
    // For now always move forward 
    const direction = 'forward'
    if (this.lastMove !== direction) {
      if (this.lastMove) this.mcSend('stop')
      this.mcSend('move', { direction })
      this.lastMove = direction
    }
  }
  
  stop() {
    if (this.lastMove) {
      this.mcSend('stop')
      this.lastMove = null
    }
  }
}