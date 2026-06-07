import { buildDuelPrompt } from '../prompt-builders/duelPromptBuilder.js';
import { getCombos, isComboAvailable, executeCombo, comboDuration } from '../helpers/comboExecutor.js'

const MAX_BUSY_MS = 6000;
const MAX_NEXT_PROMPT_DELAY = 8000;
const MIN_PROMPT_DELAY = 1500;
const DATA_REQUEST_INTERVAL = 500;

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
        this._sourceResolve = null;
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
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
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

        if (this.fetchBusy && this._fetchBusySince && now - this._fetchBusySince > MAX_BUSY_MS) {
            console.warn(`[Dueling] fetch stuck for ${MAX_BUSY_MS}ms — force-resetting`);
            this.fetchBusy = false;
            this._fetchBusySince = null;
            this.nextPromptAt = 0;
        }

        if (this.moveTarget && this.ctx.lilyPos && now >= this.forceMoveUntil && now - this.lastMoveUpdate >= 1000) {
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

        if (now - this.lastRequest >= DATA_REQUEST_INTERVAL) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        if (!this.fetchBusy && now >= this.nextPromptAt) {
            this._dispatchPrompt(targetName);
        }

        if (this.sourceLookUntil && now < this.sourceLookUntil && this.sourceLookTarget) {
            this.ctx.mcSend('look_at', this.sourceLookTarget);
        } else if (this.retreatLookUntil && now < this.retreatLookUntil && this.retreatLookTarget) {
            this.ctx.mcSend('look_at', this.retreatLookTarget);
        } else if (this.lockLookUntil && now < this.lockLookUntil) {
            // locked
        } else {
            this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1.75, z: target.z });
        }
    }

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
            .catch(err => {
                console.error('[Dueling] AI fetch error:', err.message);
            })
            .finally(() => {
                this.fetchBusy = false;
                this._fetchBusySince = null;
            });
    }

    async _fetchAction(prompt, targetName) {
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
        if (action.strategy) this.ctx.lastDuelStrategy = action.strategy;

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
            if (Math.hypot(dx, dz) <= 0.75) {
                this.ctx.mcSend('move', { direction: 'stop' });
                this.moveTarget = null;
            } else {
                this.ctx.mcSend('move_to', { x: action.move_to.x, z: action.move_to.z });
                this.moveTarget = action.move_to;
            }
        }

        const slots = Array.isArray(action.slot)
            ? action.slot
            : action.slot != null ? [action.slot] : [];

        for (const slot of slots) {
            triggerCooldown(this.ctx, slot);
            await this._executeSlot(slot);
        }
    }

    async _executeSlot(slot) {
        if (this._isComboSlot(slot)) {
            await this._executeComboSlot(slot);
        } else {
            await this._executeAbilitySlot(slot);
        }
    }

    _isComboSlot(slot) {
        return slot >= 10;
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

        const totalTime = comboDuration(combo);
        this._setNextPromptAt(totalTime + MIN_PROMPT_DELAY);

        await executeCombo(
            combo,
            this.ctx.bindings,
            cleanName,
            this.ctx.mcSend,
            {
                onLockLook: (duration) => {
                    this.lockLookUntil = Date.now() + duration;
                },
                onForceMove: (direction, duration) => {
                    this._forceMove(direction, duration);
                },
                // blocks: string[], holdMs: number — fire and forget (non-blocking)
                onSource: (blocks, holdMs) => this._acquireSource(blocks, holdMs),
                onStop: () => this._stopMove(),
                onLookDir: (direction, degrees, duration) => {
                    // Clear lower-priority locks so tick doesn't stomp
                    this.sourceLookUntil = 0;
                    this.sourceLookTarget = null;
                    this.retreatLookUntil = 0;
                    this.retreatLookTarget = null;
                    // Extend lock for the duration so tick stays hands-off
                    this.lockLookUntil = Date.now() + duration;
                    // Fire the rotated look once — lock prevents tick from overriding
                    this.ctx.mcSend('look_dir', { direction, degrees });
                },
            }
        );
    }

    async _executeAbilitySlot(slot) {
        const raw = this.ctx.bindings[slot];
        if (!raw) return;

        const abilityName = cleanName(raw);
        const stats = this.ctx.abilityStats[abilityName];
        if (!stats?.actions?.length) return;

        this.ctx.mcSend('hotbar', { slot });

        const steps = [];
        const actionTimes = stats.actionTimes ?? [];
        let timeIdx = 0;

        for (const actionStr of stats.actions) {
            const parts = actionStr.split(':');
            const type = parts[0];
            const mode = parts[1] ?? '*';
            const count = parseInt(parts[2] ?? '1') || 1;
            const extra = parts[3];

            for (let i = 0; i < count; i++) {
                const duration = actionTimes[timeIdx++] ?? 200;
                steps.push({ type, mode, extra, duration });
            }
        }

        for (const step of steps) {
            await this._fireStep(step);
        }
    }

    async _fireStep(step) {
        const { type, mode, extra, duration } = step;

        switch (type) {
            case 'source': {
                // mode is the comma-separated block list for single-ability steps
                const blocks = (mode && mode !== '*')
                    ? mode.split(',').map(b => b.trim().toLowerCase()).filter(Boolean)
                    : [];
                // non-blocking — fire and forget
                this._acquireSource(blocks, duration);
                break;
            }
            case 'click': {
                if (mode === 'right') this.ctx.mcSend('use', { mode: 'once' });
                else this.ctx.mcSend('attack', { mode: 'once' });
                await new Promise(r => setTimeout(r, duration));
                await new Promise(r => setTimeout(r, 100));
                break;
            }
            case 'sneak': {
                this.ctx.mcSend('fire_pk_event', { event: 'sneak' });
                const releaseAfter = mode === 'tap' ? 50 : duration;
                setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), releaseAfter);
                const blocking = extra !== 'continue';
                if (blocking) await new Promise(r => setTimeout(r, duration));
                break;
            }
            case 'jump': {
                this.ctx.mcSend('jump', { mode: 'once' });
                await new Promise(r => setTimeout(r, duration));
                break;
            }
            case 'forward':
            case 'back':
            case 'left':
            case 'right': {
                this._forceMove(type, duration);
                await new Promise(r => setTimeout(r, duration));
                break;
            }
            case 'locklook': {
                this.lockLookUntil = Date.now() + duration;
                break;
            }
            default:
                console.warn(`[Dueling] Unknown action type "${type}" — ignored`);
        }
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
     * Always non-blocking from the caller's perspective — returns a Promise
     * but the combo executor does NOT await it.
     */
    _acquireSource(blocks, holdMs) {
        return new Promise((resolve) => {
            this._sourceResolve = resolve;
            const msg = { get_source_block: true };
            if (blocks && blocks.length > 0) msg.blocks = blocks;
            this.ctx.mcSend('get_source_block', msg);

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

    _stopMove() {
        this.moveTarget = null;
        this.forceMoveUntil = 0;
        this.forceMoveDirection = null;
        this.ctx.mcSend('stop', {});
    }
    // ─────────────────────────────────────────────────────────────────────────

    _getMoveDirection(lilyPos, moveTo, targetPos) {
        const forwardX = targetPos.x - lilyPos.x;
        const forwardZ = targetPos.z - lilyPos.z;
        const forwardLen = Math.hypot(forwardX, forwardZ);
        const fx = forwardX / forwardLen;
        const fz = forwardZ / forwardLen;
        const rx = fz, rz = -fx;

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

    _setNextPromptAt(delay) {
        const clamped = Math.min(Math.max(delay, 0), MAX_NEXT_PROMPT_DELAY);
        this.nextPromptAt = Date.now() + clamped;
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
 *     arrive faster than they can usefully be acted on, but overlap is OK
 *     for light abilities.
 *
 * WATCHDOG:
 *   - fetchBusy is reset if stuck > MAX_BUSY_MS (fetch timeout / crash guard)
 *   - _drainQueue is re-entered on every .finally() so nothing stalls
 *
 * COMBO EXECUTION:
 *   - comboDuration() sums only blocking steps — the true wall-clock time
 *   - parseComboSteps() resolves all timeIdx bookkeeping up-front so the
 *     JSON you write maps 1:1 to what executes
 *
 * AI RESPONSE FORMAT:
 *   Single:  { "slot": 3, "move_to": { "x": 100, "z": 200 } }
 *   Multi:   { "slot": [3, 7], "move_to": { "x": 100, "z": 200 } }
 *
 * TRANSITIONS OUT:
 *   → IDLE when duelTarget is null or target player leaves
 */
/**
 * ACTION REFERENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * Format: "type:mode:count:extra"  — trailing fields can be omitted if unused.
 * Each blocking step consumes one entry from actionsTime (ms).
 *
 * swap:slot:<Ability>          Switch hotbar to the slot holding <Ability>.
 *                              Uses fixed SWAP_LOCK_TIME (20ms), no time entry consumed.
 *
 * locklook                     Lock look direction for actionsTime[i] ms.
 *                              NON-BLOCKING — next step starts immediately.
 *                              Consumes one time entry.
 *
 * source:*:N[:block]           Acquire nearest source block, lock look at it.
 *                              NON-BLOCKING by default. Add :block to await the hold.
 *
 * click:left:N                 Left-click (attack) N times, waiting actionsTime[i] between each.
 * click:right:N                Right-click (use)   N times, waiting actionsTime[i] between each.
 *
 * sneak:hold:N[:continue]      Hold sneak for actionsTime[i] ms, release via setTimeout.
 *                              BLOCKING unless :continue is appended.
 * sneak:tap:N[:continue]       Tap sneak (release after 80ms).
 *                              BLOCKING unless :continue is appended.
 *
 * jump:*:N                     Jump N times, waiting actionsTime[i] between each.
 *
 * forward:*:N                  Force-walk forward for actionsTime[i] ms. BLOCKING.
 * back:*:N                     Force-walk backward.
 * left:*:N                     Force-strafe left.
 * right:*:N                    Force-strafe right.
 * 
 * todo: look:direction (also can be look:random to randomize direction. non blocking.)
 * todo: source action needs specific block or tags like "waterbendable, earhtbendable..."
 * 
 */