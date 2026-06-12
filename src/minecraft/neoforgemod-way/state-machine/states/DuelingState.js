import { buildDuelPrompt } from '../prompt-builders/duelPromptBuilder.js';
import {
    getCombos,
    isComboAvailable,
    executeCombo,
    comboDuration,
    abilityAsCombo,
} from '../helpers/comboExecutor.js'

const MAX_BUSY_MS = 6000;
const MAX_NEXT_PROMPT_DELAY = 8000;
const MIN_PROMPT_DELAY = 2500;
const DATA_REQUEST_INTERVAL = 500;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// DUELING STATE
// ─────────────────────────────────────────────────────────────────────────────

export class DuelingState {
    constructor(ctx) {
        this.ctx = ctx;

        this.nextPromptAt = 0;
        this.lastRequest = 0;

        this.fetchBusy = false;
        this._fetchBusySince = null;

        this._actionQueue = [];
        this._executing = false;

        this.moveTarget = null;
        this.lastMoveUpdate = 0;
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;

        this.retreatLookUntil = 0;
        this.retreatLookTarget = null;
        this.sourceLookUntil = 0;
        this.sourceLookTarget = null;
        this.lockLookUntil = 0;
        this.lookOffset = null;  // { direction, degrees, until }
        this._sourceResolve = null;
        this.moveLocked = false;
    }

    onEnter() {
        console.log(`[Dueling] Facing ${this.ctx.duelTarget}`);
        this.ctx.sneak.setSneaking(false);
        this.ctx.move.stop();

        this.nextPromptAt = 0;
        this.fetchBusy = false;
        this._fetchBusySince = null;
        this._actionQueue = [];
        this._executing = false;
        this.moveTarget = null;
        this.lastMoveUpdate = 0;
        this.retreatLookUntil = 0;
        this.retreatLookTarget = null;
        this.sourceLookUntil = 0;
        this.sourceLookTarget = null;
        this.lockLookUntil = 0;
        this.lookOffset = null;
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
        this.moveLocked = false;
    }

    onExit() {
        console.log('[Dueling] Duel ended');
        this.ctx.mcSend('unsprint', {});
        this.fetchBusy = false;
        this._actionQueue = [];
        this._executing = false;
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

        // Watchdog: unstick fetchBusy if it has been held too long
        if (this.fetchBusy && this._fetchBusySince && now - this._fetchBusySince > MAX_BUSY_MS) {
            console.warn(`[Dueling] fetch stuck for ${MAX_BUSY_MS}ms — force-resetting`);
            this.fetchBusy = false;
            this._fetchBusySince = null;
            this.nextPromptAt = 0;
        }

        // Movement toward a target position
        if (!this.moveLocked && this.moveTarget && this.ctx.lilyPos && now >= this.forceMoveUntil && now - this.lastMoveUpdate >= 1000) {
            this.lastMoveUpdate = now;
            const dx = this.moveTarget.x - this.ctx.lilyPos.x;
            const dz = this.moveTarget.z - this.ctx.lilyPos.z;
            if (Math.hypot(dx, dz) < 1.0) {
                this.ctx.mcSend('move', { direction: 'stop' });
                this.moveTarget = null;
            } else {
                const dir = this._getMoveDirection(this.ctx.lilyPos, this.moveTarget, target);
                if (dir) this.ctx.mcSend('move', { direction: dir });
            }
        }

        // Periodic duel data request
        if (now - this.lastRequest >= DATA_REQUEST_INTERVAL) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        // AI prompt dispatch
        if (!this.fetchBusy && now >= this.nextPromptAt) {
            this._dispatchPrompt(targetName);
        }

        // Look logic (priority: source > retreat > locked > normal+offset)
        this._tickLook(target, now);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOOK
    // ─────────────────────────────────────────────────────────────────────────

    _tickLook(target, now) {
        // Expire look offset
        if (this.lookOffset && now >= this.lookOffset.until) this.lookOffset = null;

        if (this.sourceLookUntil && now < this.sourceLookUntil && this.sourceLookTarget) {
            this.ctx.mcSend('look_at', this.sourceLookTarget);
            return;
        }
        if (this.retreatLookUntil && now < this.retreatLookUntil && this.retreatLookTarget) {
            this.ctx.mcSend('look_at', this.retreatLookTarget);
            return;
        }
        if (this.lockLookUntil && now < this.lockLookUntil) {
            return; // locked — don't touch look
        }

        const baseY = target.y + 1.75;

        if (this.lookOffset) {
            const dx = target.x - (this.ctx.lilyPos?.x ?? target.x);
            const dz = target.z - (this.ctx.lilyPos?.z ?? target.z);
            const flatDist = Math.hypot(dx, dz) || 1;
            const rad = (this.lookOffset.degrees * Math.PI) / 180;
            const yShift = Math.tan(rad) * flatDist;
            const offsetY = this.lookOffset.direction === 'down' ? baseY - yShift : baseY + yShift;
            this.ctx.mcSend('look_at', { x: target.x, y: offsetY, z: target.z });
        } else {
            this.ctx.mcSend('look_at', { x: target.x, y: baseY, z: target.z });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PROMPT DISPATCH
    // ─────────────────────────────────────────────────────────────────────────

    _dispatchPrompt(targetName) {
        const prompt = buildDuelPrompt(this.ctx, targetName);
        if (!prompt || typeof prompt !== 'string'
            || prompt === 'Opponent not found.'
            || prompt === 'Lily position unknown.') {
            console.warn('[Dueling] Prompt not ready:', prompt);
            this._setNextPromptAt(MIN_PROMPT_DELAY);
            return;
        }

        this.fetchBusy = true;
        this._fetchBusySince = Date.now();
        this._setNextPromptAt(MIN_PROMPT_DELAY);

        this._fetchAction(prompt, targetName)
            .then(action => {
                if (action) {
                    this._actionQueue.push({ action, targetName });
                    this._drainQueue();
                }
            })
            .catch(err => console.error('[Dueling] AI fetch error:', err.message))
            .finally(() => {
                this.fetchBusy = false;
                this._fetchBusySince = null;
            });
    }

    async _fetchAction(prompt, targetName) {
        console.log('[Dueling] DUELING PROMPT', prompt);
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
                    { role: "system", content: "Return ONLY valid JSON. No reasoning. No extra text." },
                    { role: "user", content: prompt }
                ]
            })
        });

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        console.log('[Dueling] Lily decision:', text);
        if (!text) return null;

        try {
            return JSON.parse(text);
        } catch {
            console.error('[Dueling] AI response was not valid JSON:', text);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ACTION QUEUE
    // ─────────────────────────────────────────────────────────────────────────

    _drainQueue() {
        if (this._executing || this._actionQueue.length === 0) return;
        this._executing = true;

        const { action, targetName } = this._actionQueue.shift();

        this._executeAction(action, targetName)
            .catch(err => console.error('[Dueling] Execute error:', err.message))
            .finally(() => {
                this._executing = false;
                this._drainQueue();
            });
    }

    async _executeAction(action, targetName) {
        this.moveLocked = false;

        if (action.strategy) this.ctx.lastDuelStrategy = action.strategy;

        // Reposition: look away from opponent before retreating
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

        // Move toward a requested position
        const target = this.ctx.players[targetName];
        if (!this.moveLocked && action.move_to && this.ctx.lilyPos && target) {
            const dx = action.move_to.x - this.ctx.lilyPos.x;
            const dz = action.move_to.z - this.ctx.lilyPos.z;
            if (Math.hypot(dx, dz) <= 0.75) {
                this.ctx.mcSend('move', { direction: 'stop' });
                this.moveTarget = null;
            } else {
                this.ctx.mcSend('move_to', { x: action.move_to.x, z: action.move_to.z });
                this.moveTarget = action.move_to;
            }
        }

        // Execute each requested slot in order
        const slots = Array.isArray(action.slot)
            ? action.slot
            : action.slot != null ? [action.slot] : [];

        for (const slot of slots) {
            triggerCooldown(this.ctx, slot);
            await this._executeSlot(slot);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SLOT DISPATCH
    // ─────────────────────────────────────────────────────────────────────────

    /** Slots 10+ are virtual combo slots; 1-9 are hotbar ability slots. */
    async _executeSlot(slot) {
        if (slot >= 10) {
            await this._executeComboSlot(slot);
        } else {
            await this._executeAbilitySlot(slot);
        }
    }

    _getComboForSlot(slot) {
        const available = getCombos().filter(c =>
            isComboAvailable(c, this.ctx.bindings, cleanName)
        );
        return available[slot - 10] ?? null;
    }

    async _executeComboSlot(slot) {
        const combo = this._getComboForSlot(slot);
        if (!combo) {
            console.warn(`[Dueling] No combo for virtual slot ${slot}`);
            return;
        }

        this._setNextPromptAt(comboDuration(combo) + MIN_PROMPT_DELAY);
        await executeCombo(combo, this.ctx.bindings, cleanName, this.ctx.mcSend, this._comboHandlers());
    }

    async _executeAbilitySlot(slot) {
        const raw = this.ctx.bindings[slot];
        if (!raw) return;

        const abilityName = cleanName(raw);
        const stats = this.ctx.abilityStats[abilityName];
        if (!stats?.actions?.length) return;

        // Switch to the correct hotbar slot first
        this.ctx.mcSend('hotbar', { slot });

        // Treat the ability's action list as a one-off combo and reuse the same pipeline
        const combo = abilityAsCombo(abilityName, stats);
        await executeCombo(combo, this.ctx.bindings, cleanName, this.ctx.mcSend, this._comboHandlers());
    }

    /**
     * Returns the handler object wiring combo/ability step side-effects
     * into this DuelingState's look/move tracking fields.
     * Defined once here instead of duplicated in every execute method.
     */
    _comboHandlers() {
        return {
            onLockLook: (duration) => {
                this.sourceLookUntil = 0;
                this.sourceLookTarget = null;
                this.retreatLookUntil = 0;
                this.retreatLookTarget = null;
                this.lockLookUntil = Date.now() + duration;
            },
            onForceMove: (direction, duration) => {
                this._forceMove(direction, duration);
            },
            onSource: (blocks, distance, holdMs) => {
                this._acquireSource(blocks, distance, holdMs);
            },
            onStop: (lock = false) => {
                if (lock) this.moveLocked = true;
                this._stopMove();
            },
            onLookDir: (direction, degrees, duration) => {
                this.lookOffset = { direction, degrees, until: Date.now() + duration };
            },
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SOURCE ACQUISITION
    // ─────────────────────────────────────────────────────────────────────────

    onSourceBlock(event) {
        if (!this._sourceResolve) return;
        this._sourceResolve(event);
        this._sourceResolve = null;
    }

    /**
     * Sends get_source_block with an optional block filter list.
     * Always non-blocking from the caller's perspective.
     */
    _acquireSource(blocks, distance, holdMs) {
        return new Promise((resolve) => {
            this._sourceResolve = resolve;
            const msg = { get_source_block: true };
            if (blocks?.length > 0) msg.blocks = blocks;
            if (distance > 0) msg.distance = distance;
            this.ctx.mcSend('get_source_block', msg);

            // Timeout fallback so a missing source block doesn't hang indefinitely
            setTimeout(() => {
                if (this._sourceResolve) {
                    this._sourceResolve({ found: false });
                    this._sourceResolve = null;
                }
            }, 800);
        }).then(event => {
            if (!event.found) return false;
            this.sourceLookUntil = Date.now() + holdMs;
            this.sourceLookTarget = { x: event.x, y: event.y, z: event.z };
            this.ctx.mcSend('look_at', this.sourceLookTarget);
            return true;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MOVEMENT HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    _stopMove() {
        this.moveTarget = null;
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
        this.ctx.mcSend('move', { direction: 'stop' });
    }

    _forceMove(direction, durationMs) {
        if (this.moveLocked) return;
        this.forceMoveUntil = Date.now() + durationMs;
        this.forceMoveDirection = direction;
        this.ctx.mcSend('move', { direction });
        setTimeout(() => {
            if (this.forceMoveDirection === direction) {
                this.forceMoveDirection = null;
                if (!this.moveTarget) this.ctx.mcSend('move', { direction: 'stop' });
            }
        }, durationMs);
    }

    /**
     * Returns the dominant movement direction (relative to facing the target)
     * needed to reach moveTo from lilyPos.
     */
    _getMoveDirection(lilyPos, moveTo, targetPos) {
        const forwardX = targetPos.x - lilyPos.x;
        const forwardZ = targetPos.z - lilyPos.z;
        const forwardLen = Math.hypot(forwardX, forwardZ);
        const fx = forwardX / forwardLen;
        const fz = forwardZ / forwardLen;
        const rx = fz, rz = -fx;  // right = rotate forward 90° CW

        const dx = moveTo.x - lilyPos.x;
        const dz = moveTo.z - lilyPos.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return null;

        const mx = dx / len, mz = dz / len;
        const dotForward = mx * fx + mz * fz;
        const dotRight = mx * rx + mz * rz;

        if (Math.abs(dotForward) >= Math.abs(dotRight)) {
            return dotForward >= 0 ? 'forward' : 'back';
        } else {
            return dotRight >= 0 ? 'right' : 'left';
        }
    }

    _setNextPromptAt(delay) {
        const clamped = Math.min(Math.max(delay, 0), MAX_NEXT_PROMPT_DELAY);
        this.nextPromptAt = Date.now() + clamped;
    }
}

/**
 * DUELING STATE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1v1 bending combat against a specific player. Each tick dispatches an async
 * AI prompt (non-blocking) and drains queued responses one at a time.
 *
 * PROMPT / QUEUE MODEL:
 *   - _dispatchPrompt() fires an HTTP fetch immediately when fetchBusy=false
 *     and the prompt cooldown has elapsed. It does NOT wait for execution.
 *   - When the fetch resolves, the action is pushed onto _actionQueue.
 *   - _drainQueue() processes one action at a time (FIFO). While _executing,
 *     new responses queue up but don't interrupt the current action.
 *   - nextPromptAt is extended by combo/ability duration so prompts don't
 *     arrive faster than they can usefully be acted on.
 *
 * WATCHDOG:
 *   - fetchBusy is reset if stuck > MAX_BUSY_MS
 *   - _drainQueue is re-entered on every .finally() so nothing stalls
 *
 * COMBO vs ABILITY SLOTS:
 *   - Slots 1–9  → hotbar ability slots  (_executeAbilitySlot)
 *   - Slots 10+  → virtual combo slots   (_executeComboSlot)
 *   Both paths normalize to the same combo shape and execute through
 *   executeCombo() in comboExecutor.js.
 *
 * AI RESPONSE FORMAT:
 *   Single:  { "slot": 3, "move_to": { "x": 100, "z": 200 } }
 *   Multi:   { "slot": [3, 7], "move_to": { "x": 100, "z": 200 } }
 *
 * TRANSITIONS OUT:
 *   → IDLE when duelTarget is null or target player leaves
 */

/**
 * ACTION REFERENCE  (actionsTime entries consumed left-to-right per blocking step)
 * ─────────────────────────────────────────────────────────────────────────────
 * swap:slot:<Ability>          Switch hotbar to slot holding <Ability>. Blocking.
 * locklook                     Lock look for actionsTime[i] ms. NON-BLOCKING.
 * source:<blocks>:<dist>       Acquire nearest source block. NON-BLOCKING.
 * click:left|right[:N]         Left/right click N times. Blocking per click.
 * sneak:hold|tap[:N][:cont]    Hold/tap sneak. Blocking unless :continue.
 * jump[:N]                     Jump N times. Blocking per jump.
 * forward|back|left|right[:N]  Force movement for actionsTime[i] ms. Blocking.
 * wait                         Sleep for actionsTime[i] ms. Blocking.
 * look:<dir>:<deg>             Offset look tracking. NON-BLOCKING.
 * stop                         Stop movement and lock it. NON-BLOCKING.
 */