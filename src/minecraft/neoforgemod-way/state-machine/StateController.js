import { IdleState } from './states/IdleState.js'
import { FollowingState } from './states/FollowingState.js'
import { AttackingState } from './states/AttackingState.js'
import { RecoveringState } from './states/RecoveringState.js'
import { DuelingState } from './states/DuelingState.js'
import { SneakHelper } from './helpers/sneak.js'
import { MovementHelper } from './helpers/movement.js'

export const State = {
  IDLE:       'IDLE',
  FOLLOWING:  'FOLLOWING',
  ATTACKING:  'ATTACKING',
  RECOVERING: 'RECOVERING',
  DUELING:    'DUELING'
}

export class StateController {
  constructor(mcSend, opts = {}) {
    this.mcSend = mcSend
    this.opts = {
      followTarget:    'shinyshadow_',
      followDistance:  3,
      attackRange:     4,
      lowHpThreshold:  6,
      ...opts
    }

    // Shared data (updated from mod)
    this.players    = {}       // { name: { x, y, z, hp } }
    this.lilyPos    = null     // { x, y, z }
    this.lilyHp     = 20
    this.hostiles   = []       // [{ x, y, z, type, id }]
    
    // Duel target (name)
    this.duelTarget = null
    
    // Helpers
    this.sneak      = new SneakHelper(mcSend)
    this.move       = new MovementHelper(mcSend)
    
    // States registry
    this.states = {
      [State.IDLE]:       new IdleState(this),
      [State.FOLLOWING]:  new FollowingState(this),
      [State.ATTACKING]:  new AttackingState(this),
      [State.RECOVERING]: new RecoveringState(this),
      [State.DUELING]:    new DuelingState(this)
    }
    
    this.currentStateName = State.IDLE

    this.tickInterval = null
        this.currentState = this.states[this.currentStateName]
  }
  
  // --- Public API ---
  start() {
    if (this.tickInterval) return
    console.log('[STATE] Controller started')
    this.tickInterval = setInterval(() => this._tick(), this.opts.tickMs || 500)
  }
  
  stop() {
    clearInterval(this.tickInterval)
    this.tickInterval = null
    this.sneak.cancelHold()
    this.sneak.setSneaking(false)
    this.move.stop()
    this.transitionTo(State.IDLE)
    console.log('[STATE] Controller stopped')
  }
  
  transitionTo(stateName) {
    if (this.currentStateName === stateName) return
    const oldState = this.currentState
    const newState = this.states[stateName]
    if (!newState) {
      console.error(`[STATE] Unknown state: ${stateName}`)
      return
    }
    if (this.currentState && this.currentState.onExit) this.currentState.onExit()
    this.currentStateName = stateName
    this.currentState = newState
    if (this.currentState.onEnter) this.currentState.onEnter()
    console.log(`[STATE] ➡️ ${oldState?.constructor.name || 'None'} → ${this.currentState.constructor.name}`)
  }
  
  // Called by lilybot.js when game data arrives
  updatePlayers(players) { this.players = players }
  updateLilyState(pos, hp) { this.lilyPos = pos; this.lilyHp = hp }
  updateHostiles(hostiles) { this.hostiles = hostiles }
  
  setDuelTarget(targetName) {
    if (!targetName || targetName === '') {
      if (this.duelTarget) {
        this.duelTarget = null
        if (this.currentStateName === State.DUELING) this.transitionTo(State.IDLE)
        console.log('[DUEL] Duel ended')
      }
      return
    }
    this.duelTarget = targetName
    this.transitionTo(State.DUELING)
    console.log(`[DUEL] Now dueling ${targetName}`)
  }
  
  setFollowTarget(name) {
    this.opts.followTarget = name
    console.log(`[STATE] Follow target → ${name}`)
  }
  
  getStatus() {
    return {
      state:      this.currentStateName,
      lilyHp:     this.lilyHp,
      lilyPos:    this.lilyPos,
      players:    Object.keys(this.players),
      hostiles:   this.hostiles.length,
      isSneaking: this.sneak.isSneaking
    }
  }
  
  // Helper methods for states
  getFollowTarget()   { return this.players[this.opts.followTarget] ?? null }
  nearestHostile() {
    if (!this.lilyPos || !this.hostiles.length) return null
    let nearest = null, nearestDist = this.opts.attackRange
    for (const h of this.hostiles) {
      const d = this._dist(this.lilyPos, h)
      if (d < nearestDist) {
        nearest = h
        nearestDist = d
      }
    }
    return nearest
  }
  _dist(a, b) {
    if (!a || !b) return Infinity
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  }
  
  // Main tick loop – delegates to current state
  async _tick() {
    // Fetch fresh data from the mod
    this.mcSend('get_players')
    this.mcSend('get_lily_state')
    this.mcSend('get_hostiles', { range: 16 })
    
    if (!this.lilyPos) return
    
    if (this.currentState && this.currentState.onTick) {
      await this.currentState.onTick()
    }
  }
}