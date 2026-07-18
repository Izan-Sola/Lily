import { IdleState } from './states/IdleState.js'
import { FollowingState } from './states/FollowingState.js'
import { AttackingState } from './states/AttackingState.js'
import { RecoveringState } from './states/RecoveringState.js'
import { DuelingState } from './states/DuelingState.js'
import { SneakHelper } from './helpers/sneak.js'
import { MovementHelper } from './helpers/movement.js'
import { MiningState } from './states/MiningState.js'

export const State = {
    IDLE: 'IDLE',
    FOLLOWING: 'FOLLOWING',
    ATTACKING: 'ATTACKING',
    RECOVERING: 'RECOVERING',
    DUELING: 'DUELING',
    MINING: 'MINING'
}

export class StateController {
    constructor(mcSend, opts = {}) {
        this.mcSend = mcSend
        this.opts = {
            followTarget: 'shinyshadow_',
            followDistance: 3,
            attackRange: 4,
            lowHpThreshold: 6,
            tickMs: 25,
            ...opts
        }

        // Shared data
        this.players = {}
        this.lilyPos = null
        this.lilyHp = 20
        this.lilyHunger = 20
        this.lilyArmor = 0
        this.hostiles = []
        this.passives = []
        this.blocksOfInterest = []
        this.duelTarget = null
        this.ai = opts.ai
        // Ability tracking
        this.bindings = {}   // slot -> raw ability name
        this.abilityCooldowns = {}   // ability name -> expiry timestamp (ms)
        this.abilityStats = {}   // ability name -> { range, cooldown, actions, actionTimes, description }
        this.currentElement = ""
        // Helpers
        this.sneak = new SneakHelper(mcSend)
        this.move = new MovementHelper(mcSend)

        // States
        this.states = {
            [State.IDLE]: new IdleState(this),
            [State.FOLLOWING]: new FollowingState(this),
            [State.ATTACKING]: new AttackingState(this),
            [State.RECOVERING]: new RecoveringState(this),
            [State.DUELING]: new DuelingState(this),
            [State.MINING]: new MiningState(this)
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

    transitionTo(stateName, payload = {}) {
        if (this.currentStateName === stateName) {
            // Already in this state — let it re-enter with fresh payload instead
            // of no-op'ing, so e.g. "follow Bob" while already following Alice
            // actually retargets instead of being silently ignored.
            if (this.currentState?.onEnter) this.currentState.onEnter(payload)
            return
        }
        const oldName = this.currentStateName
        const newState = this.states[stateName]
        if (!newState) {
            console.error(`[STATE] Unknown state: ${stateName}`)
            return
        }
        if (this.currentState?.onExit) this.currentState.onExit()
        this.currentStateName = stateName
        this.currentState = newState
        if (this.currentState?.onEnter) this.currentState.onEnter(payload)
        console.log(`[STATE] ➡️ ${oldName} → ${stateName}${payload?.player ? ` (${payload.player})` : ''}`)
    }

    getPlayerByName(name) {
        return this.players[name] ?? null
    }
    /**
 * Single entry point for explicit, player-requested actions (from
 * ToolExecutor.minecraftAction). Autonomous entry into these same states
 * still happens however your decision logic (IdleState, etc.) already
 * does it — this just gives chat-triggered requests the same doorway in,
 * so both paths end up going through transitionTo() instead of chat
 * requests bypassing the state machine with raw mcSend calls.
 *
 * One-shot commands (use/swap_slot/drop/look_at) don't need a persistent
 * state, so they still pass straight through to mcSend.
 */_findBlockType({ x, y, z }) {
        const match = this.blocksOfInterest?.find(b => b.x === x && b.y === y && b.z === z)
        return match?.type ?? null
    }

    _collectMiningCluster(targetBlock, maxBlocks = 8, maxRadius = 6) {
        const cluster = [targetBlock]
        if (!targetBlock.type || !this.blocksOfInterest?.length) return cluster

        const rest = this.blocksOfInterest
            .filter(b => b.type === targetBlock.type &&
                !(b.x === targetBlock.x && b.y === targetBlock.y && b.z === targetBlock.z))
            .map(b => ({ ...b, dist: this._dist(targetBlock, b) }))
            .filter(b => b.dist <= maxRadius)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, maxBlocks - 1)
        console.log('[MINE] cluster built:', cluster.length + rest.length, 'blocks')

        return [...cluster, ...rest]
        
    }
    dispatchAction(action, args = {}) {
        switch (action) {
            case 'follow':
                if (!args.player) return { ok: false, message: 'follow needs a player name.' }
                this.setFollowTarget(args.player)
                this.transitionTo(State.FOLLOWING)
                return { ok: true }
            case 'break': {
                if (args.x == null || args.y == null || args.z == null) {
                    return { ok: false, message: 'break needs x, y, and z.' }
                }
                const targetBlock = {
                    x: args.x, y: args.y, z: args.z,
                    type: args.blockType ?? this._findBlockType(args)
                }
                const cluster = this._collectMiningCluster(targetBlock)
                this.transitionTo(State.MINING, { blocks: cluster })
                return { ok: true }
            }
            case 'attack': {
                if (!args.slot) return { ok: false, message: 'attack needs a weapon slot.' }
                const hostile = this.nearestHostile()
                if (!hostile) return { ok: false, message: 'No hostile nearby to attack.' }
                this.mcSend('swap_slot', { slot: args.slot })
                this.transitionTo(State.ATTACKING)
                return { ok: true }
            }

            case 'retreat':
                if (args.player) this.setFollowTarget(args.player)
                this.transitionTo(State.RECOVERING, { explicit: true })
                return { ok: true }

            case 'stop':
                this.transitionTo(State.IDLE)
                return { ok: true }

            case 'move_to':
                if (args.x == null || args.z == null) return { ok: false, message: 'move_to needs x and z.' }
                this.mcSend('move_to', { x: args.x, z: args.z })
                return { ok: true }

            case 'use': {
                if (args.slot) {
                    // Pass slot to Java so it swaps first
                    this.mcSend('use', { mode: 'once', slot: args.slot });
                } else {
                    this.mcSend('use', { mode: 'once' });
                }
                return { ok: true };
            }

            case 'swap_slot': {
                if (!args.slot) return { ok: false, message: 'swap_slot needs a slot number.' };
                this.mcSend('swap_slot', { slot: args.slot });
                return { ok: true };
            }

            case 'drop': {
                if (!args.slot) return { ok: false, message: 'drop needs a slot number.' };
                this.mcSend('drop', { slot: args.slot });
                return { ok: true };
            }

            default:
                return { ok: false, message: `Unknown action: ${action}` }
        }
    }

    // Data updaters
    updatePlayers(players) { this.players = players }
    updateLilyState(pos, hp, hunger) {
        this.lilyPos = pos
        this.lilyHp = hp
        if (hunger != null) this.lilyHunger = hunger
    }
    updateHostiles(hostiles) { this.hostiles = hostiles }

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
            state: this.currentStateName,
            lilyHp: this.lilyHp,
            lilyPos: this.lilyPos,
            players: Object.keys(this.players),
            hostiles: this.hostiles.length,
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

    handleSourceBlock(event) {
        if (this.currentStateName === 'DUELING') {
            this.currentState.onSourceBlock(event);
        }
    }

    nearestHostile() {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
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