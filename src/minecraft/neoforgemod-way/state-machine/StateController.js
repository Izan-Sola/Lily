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
            tickMs:          25,
            ...opts
        }

        // Shared data
        this.players    = {}
        this.lilyPos    = null
        this.lilyHp     = 20
        this.hostiles   = []
        this.duelTarget = null
        this.ai         = opts.ai

        // Ability tracking
        this.bindings         = {}   // slot -> raw ability name
        this.abilityCooldowns = {}   // ability name -> expiry timestamp (ms)
        this.abilityStats     = {}   // ability name -> { range, cooldown, actions, actionTimes, description }

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
        this.currentState     = this.states[State.IDLE]
        this.tickInterval     = null
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
        const oldName  = this.currentStateName
        const newState = this.states[stateName]
        if (!newState) {
            console.error(`[STATE] Unknown state: ${stateName}`)
            return
        }
        if (this.currentState?.onExit)  this.currentState.onExit()
        this.currentStateName = stateName
        this.currentState     = newState
        if (this.currentState?.onEnter) this.currentState.onEnter()
        console.log(`[STATE] ➡️ ${oldName} → ${stateName}`)
    }

    // Data updaters
    updatePlayers(players)          { this.players = players }
    updateLilyState(pos, hp)        { this.lilyPos = pos; this.lilyHp = hp }
    updateHostiles(hostiles)        { this.hostiles = hostiles }

    setDuelTarget(targetName) {
        if (!targetName || targetName === '') {
            if (this.duelTarget) {
                this.duelTarget = null
                if (this.currentStateName === State.DUELING) this.transitionTo(State.IDLE)
                console.log('[DUEL] Duel ended')
                this.mcSend('unsprint', {})   // fixed: was this.ctx.mcSend
            }
            return
        }
        this.duelTarget = targetName
        this.transitionTo(State.DUELING)
        console.log(`[DUEL] Now dueling ${targetName}`)
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
        let nearest     = null
        let nearestDist = this.opts.attackRange
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h)
            if (d < nearestDist) { nearest = h; nearestDist = d }
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

/**
 * STATE CONTROLLER
 * ─────────────────────────────────────────────────────────────────────────────
 * Central orchestrator for Lily's in-game behavior. Owns all shared game state,
 * manages state transitions, runs the main tick loop, and provides helper
 * methods used by individual states.
 *
 * ARCHITECTURE:
 *   Each behavior is a separate state class (IdleState, FollowingState, etc.)
 *   The controller delegates onTick() to the current active state every tickMs.
 *   States call back into the controller via this.ctx for shared data and helpers.
 *
 * KEY OPTIONS (opts):
 *   followTarget    → username to follow, default "shinyshadow_"
 *   followDistance  → blocks before following kicks in, default 3
 *   attackRange     → blocks to scan for hostiles, default 4
 *   lowHpThreshold  → HP floor for recovering state, default 6
 *   tickMs          → tick interval in ms, default 25
 *
 * SHARED STATE:
 *   this.players         → { name: { x, y, z, hp } } updated every tick from mod
 *   this.lilyPos         → { x, y, z } Lily's position, null until first update
 *   this.lilyHp          → Lily's HP 0–20, default 20
 *   this.hostiles        → [{ x, y, z, type, id, hp }] nearby hostile entities
 *   this.duelTarget      → player name being dueled or null
 *   this.bindings        → { slot: rawAbilityName }
 *   this.abilityCooldowns → { abilityName: expiryMs }
 *   this.abilityStats    → { abilityName: { range, cooldown, actions, actionTimes, description } }
 *
 * HELPERS AVAILABLE TO STATES:
 *   this.sneak           → SneakHelper — setSneaking(bool), cancelHold()
 *   this.move            → MovementHelper — moveToward(from, to), stop()
 *   this.mcSend(type, data) → sends WebSocket command to Java mod
 *   this.getFollowTarget()  → returns players[followTarget] or null
 *   this.nearestHostile()   → nearest hostile within attackRange or null
 *   this._dist(a, b)        → Math.hypot distance between two {x,y,z} points
 *   this.transitionTo(name) → triggers onExit → onEnter for state change
 */