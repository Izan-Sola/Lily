import { buildDuelPrompt } from '../prompt-builders/duelPromptBuilder.js';
import { getComboByName, getCombos, isComboAvailable, executeCombo } from '../helpers/comboExecutor.js'

const MAX_BUSY_MS = 4500;
const MAX_NEXT_PROMPT_DELAY = 8000;

export class DuelingState {
    constructor(ctx) {
        this.ctx = ctx;
        this.nextPromptAt = 0;
        this.lastRequest = 0;
        this.requestInterval = 2000;
        this.busy = false;
        this._busySince = null;
        this.minPromptDelay = 2000;
        this.lookInterval = 0;
        this.retreatLookUntil = 0;
        this.retreatLookTarget = null;
        this.sourceLookUntil = 0;
        this.sourceLookTarget = null;
        this._sourceResolve = null;  // resolves the pending promise

        // Forced movement: while forceMoveUntil > now, normal moveTarget logic is suppressed
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null; // 'forward' | 'back' | 'left' | 'right'
    }

    _isComboSlot(slot) {
        return slot >= 10
    }

    _getComboForSlot(slot) {
        const availableCombos = getCombos().filter(c =>
            isComboAvailable(c, this.ctx.bindings, cleanName)
        )
        const idx = slot - 10
        return availableCombos[idx] ?? null
    }

    _getAbilityDuration(slot) {
        const raw = this.ctx.bindings[slot];
        if (!raw) return 2000;
        const ability = cleanName(raw);
        const stats = this.ctx.abilityStats[ability];
        if (!stats?.actionTimes?.length) return 2000;
        return stats.actionTimes.reduce((a, b) => a + b, 0);
    }

    _getMoveDirection(lilyPos, moveTo, targetPos) {
        const forwardX = targetPos.x - lilyPos.x;
        const forwardZ = targetPos.z - lilyPos.z;
        const forwardLen = Math.hypot(forwardX, forwardZ);
        const fx = forwardX / forwardLen;
        const fz = forwardZ / forwardLen;

        const rx = fz;
        const rz = -fx;

        const dx = moveTo.x - lilyPos.x;
        const dz = moveTo.z - lilyPos.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return null;

        const mx = dx / len;
        const mz = dz / len;

        const dotForward = mx * fx + mz * fz;
        const dotRight = mx * rx + mz * rz;

        if (Math.abs(dotForward) >= Math.abs(dotRight)) {
            return dotForward >= 0 ? 'forward' : 'back';
        } else {
            return dotRight >= 0 ? 'right' : 'left';
        }
    }

    _setBusy(val) {
        this.busy = val;
        this._busySince = val ? Date.now() : null;
    }

    onSourceBlock(event) {
        if (!this._sourceResolve) return;  // no one waiting
        this._sourceResolve(event);
        this._sourceResolve = null;
    }

    _setNextPromptAt(delay) {
        // Clamp delay so nextPromptAt can never go further than MAX_NEXT_PROMPT_DELAY
        const clamped = Math.min(Math.max(delay, 0), MAX_NEXT_PROMPT_DELAY);
        this.nextPromptAt = Date.now() + clamped;
    }

    onEnter() {
        console.log(`[Dueling] Facing ${this.ctx.duelTarget}`);
        this.ctx.sneak.setSneaking(false);
        this.ctx.move.stop();
        this.nextPromptAt = 0;
        this._setBusy(false);
        this.lookBusy = false;
        this.moveTarget = null;
        this.lastMoveUpdate = 0;
        this.retreatLookUntil = 0;
        this.retreatLookTarget = null;
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
    }

    onTick() {
        const targetName = this.ctx.duelTarget;
        if (!targetName) {
            this.ctx.transitionTo('IDLE');
            return;
        }
        const target = this.ctx.players[targetName];
        if (!target) {
            console.log(`[Dueling] Target ${targetName} left, ending duel`);
            this.ctx.setDuelTarget(null);
            return;
        }

        const now = Date.now();

        // Watchdog: if busy has been stuck for too long, force-reset
        if (this.busy && this._busySince && now - this._busySince > MAX_BUSY_MS) {
            console.warn(`[Dueling] busy stuck for ${MAX_BUSY_MS}ms — force-resetting`);
            this._setBusy(false);
            this.nextPromptAt = 0;
        }

        // Normal moveTarget tracking — suppressed while a forced move is active
        if (this.moveTarget && this.ctx.lilyPos && now >= this.forceMoveUntil && now - this.lastMoveUpdate >= 1000) {
            this.lastMoveUpdate = now;
            const dx = this.moveTarget.x - this.ctx.lilyPos.x;
            const dz = this.moveTarget.z - this.ctx.lilyPos.z;
            const distToTarget = Math.hypot(dx, dz);

            if (distToTarget < 1.0) {
                this.ctx.mcSend('move', { direction: 'stop' });
                this.moveTarget = null;
            } else {
                const dir = this._getMoveDirection(this.ctx.lilyPos, this.moveTarget, target);
                if (dir) this.ctx.mcSend('move', { direction: dir });
            }
        }

        // Keep duel data fresh
        const requestInterval = this.lastAbilityDuration
            ? Math.max(500, this.lastAbilityDuration / 2)
            : 500;
        if (now - this.lastRequest >= requestInterval) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        // Combat loop
        if (!this.busy && now >= this.nextPromptAt) {
            this._setBusy(true);
            this._sendPrompt(targetName).finally(() => { this._setBusy(false); });
        }

        // Look logic — source lock > retreat > normal
        // Look logic — source lock > retreat > normal
        if (this.sourceLookUntil && now < this.sourceLookUntil && this.sourceLookTarget) {
            this.ctx.mcSend('look_at', this.sourceLookTarget);
        } else if (this.retreatLookUntil && now < this.retreatLookUntil && this.retreatLookTarget) {
            this.ctx.mcSend('look_at', this.retreatLookTarget);
        } else if (this.lockLookUntil && now < this.lockLookUntil) {
            // locked — send nothing, don't touch look
        } else {
            this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1.75, z: target.z });
        }
    }

    async _acquireSource(holdMs) {
        return new Promise((resolve) => {
            this._sourceResolve = resolve;
            this.ctx.mcSend('get_source_block');

            // safety timeout, if Java never replies, resolve with not_found
            setTimeout(() => {
                if (this._sourceResolve) {
                    this._sourceResolve({ found: false });
                    this._sourceResolve = null;
                }
            }, 800);
        }).then(event => {
            if (!event.found) return false;

            // lock look at source block
            this.sourceLookUntil = Date.now() + holdMs;
            this.sourceLookTarget = { x: event.x, y: event.y, z: event.z };
            this.ctx.mcSend('look_at', this.sourceLookTarget);
            return true;
        });
    }

    // Force Lily to walk in a cardinal direction for durationMs,
    // suppressing the normal moveTarget logic for that window.
    _forceMove(direction, durationMs) {
        this.forceMoveUntil = Date.now() + durationMs;
        this.forceMoveDirection = direction;
        this.ctx.mcSend('move', { direction });
        setTimeout(() => {
            if (this.forceMoveDirection === direction) {
                this.forceMoveDirection = null;
                if (!this.moveTarget) {
                    this.ctx.mcSend('move', { direction: 'stop' });
                }
            }
        }, durationMs);
    }

    async _sendPrompt(targetName) {
        const prompt = buildDuelPrompt(this.ctx, targetName);
        console.log("[DUELING PROMPT] ", prompt)
        // buildDuelPrompt returns an error string on failure — bail out safely
        if (!prompt || typeof prompt !== 'string' || prompt === 'Opponent not found.' || prompt === 'Lily position unknown.') {
            console.warn('[Dueling] Prompt not ready:', prompt);
            this._setNextPromptAt(this.minPromptDelay);
            return;
        }

        try {
            const response = await fetch("http://localhost:11435/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "Lily",
                    stream: false,
                    temperature: 0.35,
                    max_tokens: 120,
                    response_format: { type: "json_object" },
                    messages: [
                        {
                            role: "system",
                            content: "Return ONLY valid JSON. No reasoning. No extra text."
                        },
                        {
                            role: "user",
                            content: prompt
                        }
                    ]
                })
            });

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content;

            console.log('[Dueling] Lily decision:', text);
            if (!text) {
                this._setNextPromptAt(this.minPromptDelay);
                return;
            }

            let action;
            try {
                action = JSON.parse(text);
            } catch {
                console.error('[Dueling] AI response was not valid JSON:', text);
                this._setNextPromptAt(2000);
                return;
            }

            if (action.strategy) this.ctx.lastDuelStrategy = action.strategy;

            // Retreat/reposition — look toward move target for 1500ms
            if (action.strategy === 'reposition') {
                const lilyPos = this.ctx.lilyPos;
                const opp = this.ctx.players[targetName];
                if (lilyPos && opp) {
                    const awayX = lilyPos.x - opp.x;
                    const awayZ = lilyPos.z - opp.z;
                    const len = Math.hypot(awayX, awayZ) || 1;
                    const dist = 8 + Math.random() * 4;
                    const angle = (Math.random() - 0.5) * 0.8;
                    const cos = Math.cos(angle), sin = Math.sin(angle);
                    const nx = (awayX / len) * cos - (awayZ / len) * sin;
                    const nz = (awayX / len) * sin + (awayZ / len) * cos;
                    this.retreatLookUntil = Date.now() + 2100;
                    this.retreatLookTarget = {
                        x: lilyPos.x + nx * dist,
                        y: lilyPos.y + 1.75,
                        z: lilyPos.z + nz * dist
                    };
                }
            }

            const target = this.ctx.players[targetName];

            if (action.move_to && this.ctx.lilyPos && target) {
                const dx = action.move_to.x - this.ctx.lilyPos.x;
                const dz = action.move_to.z - this.ctx.lilyPos.z;
                const distToGoal = Math.hypot(dx, dz);

                if (distToGoal <= 0.75) {
                    this.ctx.mcSend('move', { direction: 'stop' });
                    this.moveTarget = null;
                } else {
                    this.ctx.mcSend('move_to', { x: action.move_to.x, z: action.move_to.z });
                    this.moveTarget = action.move_to;
                }
            }

            const slots = Array.isArray(action.slot)
                ? action.slot
                : action.slot != null
                    ? [action.slot]
                    : [];

            if (slots.length > 0) {
                for (const slot of slots) {
                    triggerCooldown(this.ctx, slot);
                    await this._executeAbility(slot);
                }

                this._setNextPromptAt(this.minPromptDelay);
            } else {
                this._setNextPromptAt(this.minPromptDelay);
            }

        } catch (err) {
            console.error('[Dueling] AI error:', err.message);
            this._setNextPromptAt(this.minPromptDelay);
        }
    }

    async _executeAbility(slot) {
        // ----------------------------
        // COMBO SLOT
        // ----------------------------
        if (this._isComboSlot(slot)) {
            const combo = this._getComboForSlot(slot)
            if (!combo) {
                console.warn(`[Dueling] No combo found for virtual slot ${slot}`)
                return
            }

            // calculate total combo duration so next prompt waits for it
            const totalTime = (combo.actionsTime ?? []).reduce((a, b) => a + b, 0)

            await executeCombo(
                combo,
                this.ctx.bindings,
                cleanName,
                this.ctx.mcSend,
                {
                    onLockLook: (duration) => {
                        this.lockLookUntil = Date.now() + duration
                    },
                    onForceMove: (direction, duration) => {
                        this._forceMove(direction, duration)
                    },
                    onSource: (holdMs) => {
                        this._acquireSource(holdMs)
                    }
                }
            )

            this._setNextPromptAt(Math.max(this.minPromptDelay, totalTime + 200))
            return
        }

        // ----------------------------
        // NORMAL ABILITY SLOT
        // ----------------------------
        const raw = this.ctx.bindings[slot]
        if (!raw) return

        const abilityName = cleanName(raw)
        const stats = this.ctx.abilityStats[abilityName]
        if (!stats?.actions?.length) return

        // immediately switch slot
        this.ctx.mcSend('hotbar', { slot })

        const steps = []
        for (const actionStr of stats.actions) {
            const [type, mode, countStr] = actionStr.split(':')
            const count = parseInt(countStr ?? '1')
            for (let i = 0; i < count; i++) steps.push({ type, mode })
        }

        // ----------------------------
        // SOURCE HANDLING (still safe)
        // ----------------------------
        if (steps[0]?.type === 'source') {
            const holdMs = stats.actionTimes?.[0] ?? 700

            const found = await this._acquireSource(holdMs)
            if (!found) {
                console.warn(`[Dueling] No source block found for ${abilityName}, aborting`)
                this._setNextPromptAt(this.minPromptDelay)
                return
            }
        }

        // ----------------------------
        // SEQUENTIAL EXECUTION 
        // ----------------------------
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]
            const holdDuration = stats.actionTimes?.[i] ?? 200

            this._fireAction(step, holdDuration)
            await new Promise(r => setTimeout(r, holdDuration))
            await new Promise(r => setTimeout(r, 100)) // post action gap
        }

        this._setNextPromptAt(this.minPromptDelay)
    }

    _fireAction(step, holdDuration = 200) {
        const { type, mode } = step;

        if (type === 'sneak') {
            this.ctx.mcSend('fire_pk_event', { event: 'sneak' });
            if (mode === 'hold') {
                setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), holdDuration);
            } else {
                // Tap: release almost immediately
                setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), 50);
            }
        } else if (type === 'click') {
            if (mode === 'right') {
                this.ctx.mcSend('use', { mode: 'once' });
            } else {
                this.ctx.mcSend('attack', { mode: 'once' });
            }
        } else if (type === 'jump') {
            this.ctx.mcSend('jump', { mode: 'once' });
        } else if (type === 'forward' || type === 'back' || type === 'left' || type === 'right') {
            // Forced directional movement for holdDuration ms.
            // Suppresses the normal moveTarget logic for that window.
            this._forceMove(type, holdDuration);
        } else if (type === 'locklook') {
            this.lockLookUntil = Date.now() + holdDuration;
        } else {
            console.warn(`[Dueling] Unknown action type "${type}" — ignored`);
        }
    }

    onExit() {
        console.log('[Dueling] Duel ended');
        this.ctx.mcSend('unsprint', {});
        this._setBusy(false);
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
    }
}

function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim();
}

function triggerCooldown(ctx, slot) {
    const raw = ctx.bindings[slot];
    if (!raw) return;
    const ability = cleanName(raw);
    const stats = ctx.abilityStats[ability];
    if (!stats) return;
    ctx.abilityCooldowns[ability] = Date.now() + stats.cooldown;
}

/**
 * DUELING STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1v1 bending combat against a specific player target. On each tick, looks at
 * the opponent and periodically sends a prompt to the AI with the full combat
 * context. The AI responds with JSON deciding which ability slot(s) to use and
 * where to move. Abilities are executed via fire_pk_event (PK Bukkit events).
 *
 * LIFECYCLE:
 *   onEnter  → stops movement and sneak, resets prompt timing
 *   onTick   → looks at opponent, handles movement toward moveTarget,
 *              requests fresh duel data, fires AI prompt if ready
 *   onExit   → clears busy flag, sends unsprint
 *
 * KEY VARIABLES:
 *   this.ctx.duelTarget          → name of the player being dueled, e.g. "shinyshadow_"
 *   this.ctx.players             → { name: { x, y, z, hp } } for all online players
 *   this.ctx.bindings            → { slot: abilityName } e.g. { 1: "FireBall", 2: "FireShots" }
 *   this.ctx.abilityStats        → { abilityName: { range, cooldown, actions, actionTimes, description } }
 *                                  e.g. { FireBall: { range: 20, cooldown: 1500, actions: ["click:left:1"], actionTimes: [200] } }
 *   this.ctx.abilityCooldowns    → { abilityName: expiryTimestamp } e.g. { FireBall: 1716123456789 }
 *   this.ctx.duelDifficulty      → "easy" | "medium" | "hard" — affects how many slots AI can pick
 *   this.nextPromptAt            → timestamp (ms) before which no new AI prompt is sent
 *   this.busy                    → boolean, true while waiting for AI response
 *   this._busySince              → timestamp when busy was last set to true (for watchdog)
 *   this.lastRequest             → timestamp of last get_duel_data request
 *   this.requestInterval         → how often duel data is refreshed, default 2000ms
 *   this.moveTarget              → { x, z } destination Lily is moving toward, or null
 *   this.lastMoveUpdate          → timestamp of last movement direction update
 *   this.forceMoveUntil          → timestamp until which forced movement suppresses moveTarget
 *   this.forceMoveDirection      → current forced direction ('forward'|'back'|'left'|'right'), or null
 *
 * STUCK PREVENTION:
 *   - _setBusy(val) tracks _busySince timestamp alongside busy flag
 *   - onTick watchdog resets busy + nextPromptAt if stuck > MAX_BUSY_MS
 *   - _setNextPromptAt(delay) clamps delay to MAX_NEXT_PROMPT_DELAY
 *   - executeCombo return value guarded against undefined/NaN
 *   - All early-return paths in _sendPrompt call _setNextPromptAt before returning
 *
 * AI RESPONSE FORMAT:
 *   Single slot:  { "slot": 3, "move_to": { "x": 100, "z": 200 } }
 *   Multi slot:   { "slot": [3, 7], "move_to": { "x": 100, "z": 200 } }
 *
 * ACTION TYPES (in abilityStats.actions strings):
 *   click:left:N   → mcSend("attack", { mode: "once" })        ×N
 *   click:right:N  → mcSend("use",    { mode: "once" })        ×N
 *   sneak:hold:N   → fire_pk_event sneak, unsneak after actionTimes[i]
 *   sneak:tap:N    → fire_pk_event sneak + unsneak after 50ms
 *   jump:*:N       → mcSend("jump", { mode: "once" })          ×N
 *   source:*:N     → acquire nearest source block, lock look for actionTimes[0] ms (first step only)
 *   forward:*:N    → _forceMove("forward", actionTimes[i])     ×N
 *   back:*:N       → _forceMove("back",    actionTimes[i])     ×N
 *   left:*:N       → _forceMove("left",    actionTimes[i])     ×N
 *   right:*:N      → _forceMove("right",   actionTimes[i])     ×N
 *
 * TRANSITIONS OUT:
 *   → IDLE  when duelTarget is null or player leaves
 */