import { mcSend } from "./lilybot.js"

export const State = {
    IDLE:       "IDLE",
    FOLLOWING:  "FOLLOWING",
    ATTACKING:  "ATTACKING",
    RECOVERING: "RECOVERING",
    DUELING:    "DUELING"   // 1V1 BENDING DUEL with another player
}

// Sneak trigger modes
export const SneakMode = {
    PULSE: "pulse",   
    HOLD:  "hold",    
}

export class LilyStateMachine {
    constructor(opts = {}) {
        this.state          = State.IDLE
        this.tickInterval   = null
        this.lastMove       = null
        this.attackInterval = null
        this._sneakHoldTimer = null
        this._isSneaking     = false

        this.opts = {
            followTarget:    "shinyshadow_",
            followDistance:  3,
            attackRange:     4,
            lowHpThreshold:  6,
            tickMs:          150,
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

                //  this.sneakHold(6000) // TEST: hold sneak for 3 seconds on start
                // ========== FIRESPIN COMBO TEST ==========
                // Slot 7: 2 clicks
                console.log("🔥 [COMBO] FireSpin - slot 7, 2 clicks")
                mcSend("hotbar", { slot: 7 })
                setTimeout(() => mcSend("attack", { mode: "once" }), 500)
                setTimeout(() => mcSend("attack", { mode: "once" }), 1000)
                
                // Slot 6: 1 click then tap shift
                setTimeout(() => {
                    console.log("🔥 [COMBO] FireSpin - slot 6, click then shift")
                    mcSend("hotbar", { slot: 6 })
                    setTimeout(() => {
                        mcSend("attack", { mode: "once" })
                        // tap shift using sneakPulse method
                        setTimeout(() => this.sneakPulse(100), 250)
                    }, 100)
                }, 1500)
        // ==========================================
    }

    stop() {
        clearInterval(this.tickInterval)
        this.tickInterval = null
        this._cancelSneakHold()
        this._setSneaking(false)
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
            // ========== DUELING STATE ==========
                    if (this.state === State.DUELING && this.duelTarget) {
                        const target = this.players[this.duelTarget]
                        if (target) {
                            // Only look at the target – no movement, no attacking, no sneaking
                            mcSend("look_at", { x: target.x, y: target.y + 1.5, z: target.z })
                            // Ensure we aren't moving or sneaking
                            if (this.lastMove) this._sendStop()
                            if (this._isSneaking) this._setSneaking(false)
                            return  // skip all other behaviour
                        } else {
                            // Target vanished – end duel automatically
                            console.log(`⚔️ [DUEL] Target ${this.duelTarget} left, ending duel`)
                            this.ctx.mcSend('unsprint', {});
                            this.setDuelTarget(null)
                            return
                        }
                    }
            // ── Low HP — stop everything and recover ──
            if (this.lilyHp <= this.opts.lowHpThreshold) {
                if (this.state !== State.RECOVERING && this.state !== State.DUELING) {
                    this._transition(State.RECOVERING)
                    this._cancelSneakHold()
                    this._setSneaking(false)
                    this._sendStop()
                    console.log(`⚙️ [STATE] Low HP (${this.lilyHp}/20), recovering`)
                }
                // flee toward follow target while recovering
                const target = this._getFollowTarget()
                if (target) {
                    mcSend("look_at", { x: target.x, y: target.y + 1.5, z: target.z })
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
                //     mcSend("attack", { mode: "once" })
                //     setTimeout(() => mcSend("attack", { mode: "once" }), 500)
                //     // mcSend("sneak")
                //   setTimeout(() => this.sneakHold(3000), 1000)
                //   setTimeout(() => mcSend("attack", { mode: "once" }), 1500)
                 //TEST COMBO HERE DONT REMOVE NAY COMMENTS
                //  this.sneakHold(5000)

                    console.log(`⚙️ [STATE] Attacking ${hostile.type ?? "hostile"} at ${Math.floor(hostile.x)} ${Math.floor(hostile.y)} ${Math.floor(hostile.z)}`)
                }

                // always track the hostile with look
                mcSend("look_at", { x: hostile.x, y: hostile.y + 1.5, z: hostile.z })

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
                //   this.attackInterval = setInterval(() =>  mcSend("attack", { mode: "once" }), 1200)
                // mcSend("sneak")
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
                mcSend("look_at", { x: target.x, y: target.y + 1.5, z: target.z })
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

    // ─── Sneak API ────────────────────────────────────────────────────────────


    sneakPulse(pulseMs = 100) {
        this._cancelSneakHold()
        this._isSneaking = false
        mcSend("sneak", { value: false })
        setTimeout(() => {
            this._setSneaking(true)
            this._sneakHoldTimer = setTimeout(() => {
                this._setSneaking(false)
                this._sneakHoldTimer = null
            }, pulseMs)
        }, 100)
        console.log(`⚙️ [SNEAK] Pulse (${pulseMs}ms)`)
    }

    sneakHold(holdMs = 0) {
        this._cancelSneakHold()
        this._isSneaking = false
        mcSend("sneak", { value: false })
        setTimeout(() => {
            this._setSneaking(true)
            if (holdMs > 0) {
                this._sneakHoldTimer = setTimeout(() => {
                    this._setSneaking(false)
                    this._sneakHoldTimer = null
                }, holdMs)
            }
        }, 100)
        console.log(`⚙️ [SNEAK] Hold (${holdMs > 0 ? holdMs + "ms" : "indefinite"})`)
    }

    /**
     * Manually release a sneak hold early.
     */
    sneakRelease() {
        this._cancelSneakHold()
        this._setSneaking(false)
        console.log("⚙️ [SNEAK] Released")
    }

    // ─── Internal sneak helpers ───────────────────────────────────────────────

_setSneaking(value) {
    this._isSneaking = value
    mcSend("sneak", { value })
}

    _cancelSneakHold() {
        if (this._sneakHoldTimer) {
            clearTimeout(this._sneakHoldTimer)
            this._sneakHoldTimer = null
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
            state:      this.state,
            lilyHp:     this.lilyHp,
            lilyPos:    this.lilyPos,
            players:    Object.keys(this.players),
            hostiles:   this.hostiles.length,
            isSneaking: this._isSneaking,
        }
    }
}