export class DuelingState {
  constructor(ctx) {
    this.ctx = ctx
  }
  
  onEnter() {
    console.log(`[Dueling] Facing ${this.ctx.duelTarget}`)
    this.ctx.sneak.setSneaking(false)
    this.ctx.move.stop()
  }
  
  onTick() {
    const target = this.ctx.players[this.ctx.duelTarget]
    if (!target) {
      this.ctx.setDuelTarget(null)  // ends duel
      return
    }
    this.ctx.mcSend('look_at', { x: target.x, y: target.y+1, z: target.z })
    // No movement, no attacks – just stare
  }
  
  onExit() {
    console.log('[Dueling] Duel ended')
  }
}