import { mcSend } from "./lilybot.js"

export const State = {
    IDLE:       "IDLE",
    FOLLOWING:  "FOLLOWING",
    ATTACKING:  "ATTACKING",
    RECOVERING: "RECOVERING",
}

export class LilyStateMachine {
    constructor(opts = {}) {
        this.state        = State.IDLE
        this.tickInterval = null
        this.lastMove     = null 
        this.attackInterval = null  

        this.opts = {
            followTarget:    "shinyshadow_",
            followDistance:  3,
            attackRange:     4,
            lowHpThreshold:  6,
            tickMs:          500,
            ...opts
        }

        // game state — updated by lilybot.js when mod sends events
        this.players  = {}    // { name: { x, y, z, hp } }
        this.lilyPos  = null  // { x, y, z }
        this.lilyHp   = 20
        this.hostiles = []    // [{ x, y, z, type, id }]
    }

    // ─── State updates from mod ───────────────────────────────────────────────

    updatePlayers(players) {
        this.players = players
    }

    updateLilyState(pos, hp) {
        this.lilyPos = pos
        this.lilyHp  = hp
    }

    updateHostiles(hostiles) {
        this.hostiles = hostiles
    }

    // ─── Start / Stop ─────────────────────────────────────────────────────────

    start() {
        if (this.tickInterval) return
        console.log("⚙️ [STATE] State machine started")
        this.tickInterval = setInterval(() => this._tick(), this.opts.tickMs)
    }

    stop() {
        clearInterval(this.tickInterval)
        this.tickInterval = null
        this._sendStop()
        this._transition(State.IDLE)
        console.log("⚙️ [STATE] State machine stopped")
    }

    // ─── Main tick ────────────────────────────────────────────────────────────

    async _tick() {
        try {
            // request fresh state from mod every tick
            mcSend("get_players")
            mcSend("get_lily_state")
            mcSend("get_hostiles", { range: 16 })

            // can't do anything without knowing where Lily is
            if (!this.lilyPos) return

            // ── Low HP — stop everything and recover ──
            if (this.lilyHp <= this.opts.lowHpThreshold) {
                if (this.state !== State.RECOVERING) {
                    this._transition(State.RECOVERING)
                    this._sendStop()
                    console.log(`⚙️ [STATE] Low HP (${this.lilyHp}/20), recovering`)
                }
                // flee toward follow target while recovering
                const target = this._getFollowTarget()
                if (target) {
                    mcSend("look_at", { x: target.x, y: target.y + 1, z: target.z })
                    this._moveToward(target)
                }
                return
            }

            // ── Recovered ──
            if (this.state === State.RECOVERING) {
                if (this.lilyHp > this.opts.lowHpThreshold + 2) {
                    console.log(`⚙️ [STATE] HP recovered (${this.lilyHp}/20)`)
                    this._sendStop()
                    this._transition(State.IDLE)
                } else {
                    return  // still recovering
                }
            }

            // ── Check for nearby hostiles ──
            const hostile = this._nearestHostile()

            if (hostile) {
                if (this.state !== State.ATTACKING) {
                    this._transition(State.ATTACKING)
                     this.attackInterval = setInterval(() =>  mcSend("attack", { mode: "once" }), 1200)
                    console.log(`⚙️ [STATE] Attacking ${hostile.type ?? "hostile"} at ${Math.floor(hostile.x)} ${Math.floor(hostile.y)} ${Math.floor(hostile.z)}`)
                }

                // always track the hostile with look
                mcSend("look_at", { x: hostile.x, y: hostile.y + 1, z: hostile.z })

                const dist = this._dist(this.lilyPos, hostile)
                if (dist > 2.5) {
                    // close the gap
                    this._moveToward(hostile)
                } else {
                    // in melee range, stop moving and just attack
                    if (this.lastMove) this._sendStop()
                }
                return
            }

            // ── No hostiles — clean up attack state ──
            if (this.state === State.ATTACKING) {
                console.log("⚙️ [STATE] No more hostiles, returning to follow")
                this._sendStop()        
                // this.attackInterval = setInterval(() =>  mcSend("attack", { mode: "once" }), 200)
                this._transition(State.IDLE)
            }

            // ── Follow target ──
            const target = this._getFollowTarget()
            if (!target) return

            const dist = this._dist(this.lilyPos, target)

            if (dist > this.opts.followDistance) {
                if (this.state !== State.FOLLOWING) {
                    this._transition(State.FOLLOWING)
                }
                mcSend("look_at", { x: target.x, y: target.y + 1, z: target.z })
                this._moveToward(target)
            } else {
                // close enough — idle
                if (this.state === State.FOLLOWING) {
                    this._sendStop()
                    this._transition(State.IDLE)
                }
            }

        } catch (err) {
            console.error("⚙️ [STATE] Tick error:", err.message)
        }
    }

    // ─── Movement ─────────────────────────────────────────────────────────────

    _moveToward(target) {
        if (!target || !this.lilyPos) return

        const dx = target.x - this.lilyPos.x
        const dz = target.z - this.lilyPos.z

        // pick the dominant axis
        let direction
        // if (Math.abs(dx) >= Math.abs(dz)) {
        //     direction = dx > 0 ? "right" : "left"
        // } else {
        //     direction = dz > 0 ? "forward" : "back"
        // }
        direction = "forward"
        // only send if direction changed — avoid spamming identical commands
        if (this.lastMove !== direction) {
            // stop previous direction first
            if (this.lastMove) mcSend("stop")
            mcSend("move", { direction })
            this.lastMove = direction
        }
    }

    _sendStop() {
        if (this.lastMove) {
            mcSend("stop")
            this.lastMove = null
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _transition(newState) {
        if (this.state === newState) return
        console.log(`⚙️ [STATE] ${this.state} → ${newState}`)
        clearInterval(this.attackInterval)
        this.state = newState
    }

    _getFollowTarget() {
        return this.players[this.opts.followTarget] ?? null
    }

    _nearestHostile() {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest     = null
        let nearestDist = this.opts.attackRange
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h)
            if (d < nearestDist) {
                nearest     = h
                nearestDist = d
            }
        }
        return nearest
    }

    _dist(a, b) {
        if (!a || !b) return Infinity
        return Math.sqrt(
            Math.pow(a.x - b.x, 2) +
            Math.pow(a.y - b.y, 2) +
            Math.pow(a.z - b.z, 2)
        )
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    setFollowTarget(name) {
        this.opts.followTarget = name
        console.log(`⚙️ [STATE] Follow target → ${name}`)
    }

    getStatus() {
        return {
            state:    this.state,
            lilyHp:   this.lilyHp,
            lilyPos:  this.lilyPos,
            players:  Object.keys(this.players),
            hostiles: this.hostiles.length,
        }
    }
}