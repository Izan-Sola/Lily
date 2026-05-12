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
            tickMs:          150,
            ...opts
        }

        // Shared data
        this.players    = {}
        this.lilyPos    = null
        this.lilyHp     = 20
        this.hostiles   = []
        this.duelTarget = null
        this.ai = opts.ai
        // Ability tracking
        this.bindings         = {}        // slot -> ability name
        this.abilityCooldowns = {}        // ability name -> expiry timestamp (ms)
        this.abilityStats     = {}        // ability name -> { range, cooldown }

        // Helpers
        this.sneak = new SneakHelper(mcSend)
        this.move  = new MovementHelper(mcSend)

        // States
        this.states = {
            [State.IDLE]:       new IdleState(this),
            [State.FOLLOWING]:  new FollowingState(this),
            [State.ATTACKING]:  new AttackingState(this),
            [State.RECOVERING]: new RecoveringState(this),
            [State.DUELING]:    new DuelingState(this)
        }

        this.currentStateName = State.IDLE
        this.currentState = this.states[State.IDLE]
        this.tickInterval = null
    }

    start() {
        if (this.tickInterval) return
        console.log('[STATE] Controller started')
        this.tickInterval = setInterval(() => this._tick(), this.opts.tickMs)
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
        const oldName = this.currentStateName
        const newState = this.states[stateName]
        if (!newState) {
            console.error(`[STATE] Unknown state: ${stateName}`)
            return
        }
        if (this.currentState?.onExit) this.currentState.onExit()
        this.currentStateName = stateName
        this.currentState = newState
        if (this.currentState?.onEnter) this.currentState.onEnter()
        console.log(`[STATE] ➡️ ${oldName} → ${stateName}`)
    }

    // Data updaters
    updatePlayers(players) { this.players = players }
    updateLilyState(pos, hp) { this.lilyPos = pos; this.lilyHp = hp }
    updateHostiles(hostiles) { this.hostiles = hostiles }

    setDuelTarget(targetName) {
        if (!targetName || targetName === '') {
            if (this.duelTarget) {
                this.duelTarget = null
                if (this.currentStateName === State.DUELING) this.transitionTo(State.IDLE)
                console.log('[DUEL] Duel ended')
                this.ctx.mcSend('unsprint', {});
            }
            return
        }
        this.duelTarget = targetName
        this.transitionTo(State.DUELING)
        console.log(`[DUEL] Now dueling ${targetName}`)
        // Request fresh bindings from server (optional)
        this.mcSend('get_bindings')
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

    // Ability-related methods
    bindAbility(slot, abilityName) {
        this.bindings[slot] = abilityName
        // console.log(`[BIND] Bound ${abilityName} to slot ${slot}`)
    }

    setAbilityCooldown(abilityName, durationMs) {
        this.abilityCooldowns[abilityName] = Date.now() + durationMs
    }

    updateAbilityStats(statsMap) {
        this.abilityStats = statsMap
        console.log(`[STATS] Updated ability stats for ${Object.keys(statsMap).length} abilities`)
    }

    // Helper methods for states
    getFollowTarget() { return this.players[this.opts.followTarget] ?? null }
    nearestHostile() {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
        let nearestDist = this.opts.attackRange
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

    async _tick() {
        this.mcSend('get_players')
        this.mcSend('get_lily_state')
        this.mcSend('get_hostiles', { range: 16 })
        if (!this.lilyPos) return
        if (this.currentState?.onTick) await this.currentState.onTick()
    }
}