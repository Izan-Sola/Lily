// ─── Action States ────────────────────────────────────────────────────────────

export const State = {
    IDLE: "IDLE",
    FOLLOWING: "FOLLOWING",
    ATTACKING: "ATTACKING",
    RECOVERING: "RECOVERING",  // low hp, backing off
}

// ─── State Machine ────────────────────────────────────────────────────────────

export class LilyStateMachine {
    constructor(bot, opts = {}, goals) {
        this.bot = bot
        this.goals = goals
        this.state = State.IDLE
        this.target = null   // entity currently being attacked
        this.followTarget = opts.followTarget ?? "shinyshadow_"  // who to always follow
        this.tickInterval = null

        this.opts = {
            followDistance: 3,     // stay this many blocks away when following
            attackRange: 4,     // attack if hostile within this range
            lowHpThreshold: 6,     // recover if hp drops below this (out of 20)
            tickMs: 1000,  // how often the state machine runs (ms)
            ...opts
        }
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
        this.state = State.IDLE
        console.log("⚙️ [STATE] State machine stopped")
    }

    // ─── Main tick ────────────────────────────────────────────────────────────

    async _tick() {

        mcSend("get_players")
        mcSend("get_lily_state")
        mcSend("get_hostiles", { range: 16 })
        
        try {
            const hp = this.bot.health ?? 20

            // ── Low HP — stop everything and back off ──
            if (hp <= this.opts.lowHpThreshold && this.state !== State.RECOVERING) {
                await this._enterRecovering()
                return
            }

            // ── Recovering — wait until hp is back up ──
            if (this.state === State.RECOVERING) {
                if (hp > this.opts.lowHpThreshold + 2) {
                    console.log("⚙️ [STATE] HP recovered, resuming")
                    this._transition(State.IDLE)
                } else {
                    // keep moving away from danger
                    await this._flee()
                    return
                }
            }

            // ── Check for hostile mobs nearby ──
            const hostile = this._findNearestHostile()
            if (hostile) {
                if (this.state !== State.ATTACKING) {
                    await this._enterAttacking(hostile)
                } else {
                    await this._continueAttacking()
                }
                return
            }

            // ── No hostile — clear attack state ──
            if (this.state === State.ATTACKING) {
                console.log("⚙️ [STATE] No more hostiles, returning to follow")
                this.target = null
                this._transition(State.IDLE)
            }

            // ── Follow shinyshadow ──
            const leader = this._findPlayer(this.followTarget)
            if (leader) {
                await this._follow(leader)
            }

        } catch (err) {
            // pathfinder errors are common and noisy, swallow them
            if (!err.message?.includes("pathfinder")) {
                console.error("⚙️ [STATE] Tick error:", err.message)
            }
        }
    }

    // ─── States ───────────────────────────────────────────────────────────────

    async _enterAttacking(entity) {
        this._transition(State.ATTACKING)
        this.target = entity
        console.log(`⚙️ [STATE] Attacking ${entity.name ?? entity.type}`)
        // stop pathfinding so we can control movement for combat
        this.bot.pathfinder.stop()
        await this._continueAttacking()
    }

    async _continueAttacking() {
        if (!this.target || !this.target.isValid) {
            this.target = null
            this._transition(State.IDLE)
            return
        }

        const dist = this.bot.entity.position.distanceTo(this.target.position)

        // look at target always
        await this.bot.lookAt(this.target.position.offset(0, this.target.height ?? 1.6, 0))

        if (dist <= 2.5) {
            // close enough — swing
            this.bot.attack(this.target)
        } else {
            // move closer
            const { GoalFollow } = this.bot.pathfinder.goals ?? {}
            if (GoalFollow) {
                this.bot.pathfinder.setGoal(new GoalFollow(this.target, 1.5), true)
            } else {
                // fallback if goals not available
                await this.bot.pathfinder.goto(
                    new (require("mineflayer-pathfinder").goals.GoalNear)(
                        this.target.position.x,
                        this.target.position.y,
                        this.target.position.z,
                        1.5
                    )
                )
            }
        }
    }

    async _enterRecovering() {
        this._transition(State.RECOVERING)
        this.target = null
        this.bot.pathfinder.stop()
        console.log(`⚙️ [STATE] Low HP (${this.bot.health}), recovering`)
        await this._flee()
    }

    async _flee() {
        // run toward follow target if they exist, otherwise just back off
        const leader = this._findPlayer(this.followTarget)
        if (leader) {
            await this._follow(leader)
        }
    }

    async _follow(playerEntity) {
        const dist = this.bot.entity.position.distanceTo(playerEntity.position)

        if (dist <= this.opts.followDistance) {
            // close enough, stop moving
            if (this.state === State.FOLLOWING) {
                this.bot.pathfinder.stop()
                this._transition(State.IDLE)
            }
            return
        }

        if (this.state !== State.FOLLOWING) {
            this._transition(State.FOLLOWING)
        }

        this.bot.pathfinder.setGoal(
            new this.goals.GoalFollow(playerEntity, this.opts.followDistance),
            true  // dynamic — updates as player moves
        )
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _transition(newState) {
        if (this.state === newState) return
        console.log(`⚙️ [STATE] ${this.state} → ${newState}`)
        this.state = newState
    }

    _findPlayer(username) {
        const player = this.bot.players[username]
        return player?.entity ?? null
    }

    _findNearestHostile() {
        const hostileTypes = new Set([
            "zombie", "skeleton", "creeper", "spider", "cave_spider",
            "witch", "pillager", "vindicator", "enderman", "phantom",
            "drowned", "husk", "stray", "blaze", "ghast", "slime",
            "magma_cube", "silverfish", "endermite", "guardian",
            "elder_guardian", "shulker", "wither_skeleton"
        ])

        let nearest = null
        let nearestDist = this.opts.attackRange

        for (const entity of Object.values(this.bot.entities)) {
            if (!entity || entity === this.bot.entity) continue
            if (!hostileTypes.has(entity.name?.toLowerCase())) continue

            const dist = this.bot.entity.position.distanceTo(entity.position)
            if (dist < nearestDist) {
                nearest = entity
                nearestDist = dist
            }
        }

        return nearest
    }

    _goals() {
        // lazy load goals to avoid import issues
        return require("mineflayer-pathfinder").goals
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    getStatus() {
        return {
            state: this.state,
            target: this.target?.name ?? this.target?.type ?? null,
            hp: this.bot.health,
            food: this.bot.food,
            pos: this.bot.entity?.position,
        }
    }

    setFollowTarget(username) {
        this.followTarget = username
        console.log(`⚙️ [STATE] Follow target set to ${username}`)
    }
}