import { buildDuelPrompt } from './duelPromptBuilder.js';
import { getComboByName, getCombos, isComboAvailable, executeCombo } from './comboExecutor.js'

export class DuelingState {
    constructor(ctx) {
        this.ctx = ctx;
        this.nextPromptAt = 0;
        this.lastRequest = 0;
        this.requestInterval = 2000;
        this.busy = false;
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

    onEnter() {
        console.log(`[Dueling] Facing ${this.ctx.duelTarget}`);
        this.ctx.sneak.setSneaking(false);
        this.ctx.move.stop();
        this.nextPromptAt = 0;
        this.busy = false;
        this.moveTarget = null;
        this.lastMoveUpdate = 0;
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

        // Always look at opponent
        this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1.5, z: target.z });

        // Continuously update movement direction toward moveTarget every second
        if (this.moveTarget && this.ctx.lilyPos && now - this.lastMoveUpdate >= 1000) {
            this.lastMoveUpdate = now;
            const dx = this.moveTarget.x - this.ctx.lilyPos.x;
            const dz = this.moveTarget.z - this.ctx.lilyPos.z;
            const distToTarget = Math.hypot(dx, dz);

            if (distToTarget < 1.0) {
                // Reached destination, stop moving
                this.ctx.mcSend('move', { direction: 'stop' });
                this.moveTarget = null;
            } else {
                const dir = this._getMoveDirection(this.ctx.lilyPos, this.moveTarget, target);
                if (dir) this.ctx.mcSend('move', { direction: dir });
            }
        }

        // Keep duel data fresh
        const requestInterval = this.lastAbilityDuration ? this.lastAbilityDuration / 2 : 1000;
        if (now - this.lastRequest >= requestInterval) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        if (this.busy || now < this.nextPromptAt) return;

        this.busy = true;
        this._sendPrompt(targetName).finally(() => {
            this.busy = false;
        });
    }

    async _sendPrompt(targetName) {
        const prompt = buildDuelPrompt(this.ctx, targetName);
        //   console.log('[DUEL PROMPT]\n', prompt);

        try {
            const response = await fetch("http://localhost:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "Lily",
                    stream: false,
                    messages: [{ role: "user", content: prompt }]
                })
            });
            const data = await response.json();
            const text = data.message?.content;

            console.log('[Dueling] Lily decision:', text);
            if (!text) return;

            let action;
            try {
                action = JSON.parse(text);
            } catch {
                console.error('[Dueling] AI response was not valid JSON:', text);
                this.nextPromptAt = Date.now() + 2000;
                return;
            }

            const target = this.ctx.players[targetName];

            // Look at target (always handled in onTick now)
            // if (action.look_at) {
            //     this.ctx.mcSend('look_at', action.look_at);
            // } else if (target) {
            //     this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1, z: target.z });
            // }

            // Move in the correct direction based on desired position
            // Move in the correct direction based on desired position, stop when close enough
            if (action.move_to && this.ctx.lilyPos && target) {
                const dx = action.move_to.x - this.ctx.lilyPos.x;
                const dz = action.move_to.z - this.ctx.lilyPos.z;
                const distToGoal = Math.hypot(dx, dz);

                if (distToGoal <= 0.75) {
                    // Already close enough – stop moving
                    this.ctx.mcSend('move', { direction: 'stop' });
                    this.moveTarget = null;
                } else {
                    // Send target coordinates – Java will continuously adjust
                    this.ctx.mcSend('move_to', { x: action.move_to.x, z: action.move_to.z });
                    this.moveTarget = action.move_to;   // store for local use (optional)
                }
            }

            // Use ability slot
            // const slot = action.slot;
            // if (slot) {
            //     triggerCooldown(this.ctx, slot);
            //     this._executeAbility(slot);
            //     this.nextPromptAt = Date.now() + this._getAbilityDuration(slot);
            // } else {
            //     this.nextPromptAt = Date.now() + this._getAbilityDuration(slot);
            // }
            const slots = Array.isArray(action.slot)
                ? action.slot
                : action.slot
                    ? [action.slot]
                    : []

            if (slots.length > 0) {
                let maxDuration = 0
                let accumulatedDelay = 0;

                for (const slot of slots) {
                    const duration =
                        this._getAbilityDuration(slot);
                    setTimeout(() => {
                        triggerCooldown(this.ctx, slot);
                        this._executeAbility(slot);

                    }, accumulatedDelay);
                    accumulatedDelay += duration + 650;
                    if (accumulatedDelay > maxDuration) {
                        maxDuration = accumulatedDelay;
                    }
                }
                this.nextPromptAt =
                    Date.now() + maxDuration
            } else {
                this.nextPromptAt =
                    Date.now() + 1000
            }

        } catch (err) {
            console.error('[Dueling] AI error:', err.message);
            this.nextPromptAt = Date.now();
        }
    }

_executeAbility(slot) {
    // ── Combo slot ──
    if (this._isComboSlot(slot)) {
        const combo = this._getComboForSlot(slot)
        if (!combo) {
            console.warn(`[Dueling] No combo found for virtual slot ${slot}`)
            return
        }
        const duration = executeCombo(combo, this.ctx.bindings, cleanName, this.ctx.mcSend)
        this.nextPromptAt = Date.now() + duration + 500
        return
    }

    // ── Normal ability slot ──
    const raw = this.ctx.bindings[slot]
    if (!raw) return
    const abilityName = cleanName(raw)
    const stats = this.ctx.abilityStats[abilityName]
    if (!stats?.actions?.length) return

    this.ctx.mcSend('hotbar', { slot })

    const steps = []
    for (const actionStr of stats.actions) {
        const [type, mode, countStr] = actionStr.split(':')
        const count = parseInt(countStr ?? '1')
        for (let i = 0; i < count; i++) steps.push({ type, mode })
    }

    let timeOffset = 0
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        const delay = timeOffset
        setTimeout(() => this._fireAction(step), delay)
        if (step.type === 'sneak' && step.mode === 'hold') {
            setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), delay + (stats.actionTimes[i] ?? 200))
        }
        timeOffset += stats.actionTimes[i] ?? 200
    }

    this.nextPromptAt = Date.now()
}
    _fireAction(step) {
        console.log(`[FireAction] type: ${step.type} mode: ${step.mode}`);
        const { type, mode } = step;

        if (type === 'sneak') {
            if (mode === 'hold') {
                this.ctx.mcSend('fire_pk_event', { event: 'sneak' });
            } else {
                // tap
                this.ctx.mcSend('fire_pk_event', { event: 'sneak' });
                setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), 50);
            }
        } else if (type === 'click') {
            if (mode === 'right') {
                this.ctx.mcSend('use', { mode: 'once' });
            } else {
                // left
                this.ctx.mcSend('attack', { mode: 'once' });
            }
        } else if (type === 'jump') {
                 this.ctx.mcSend('jump', { mode: 'once' });
        }
    }

    onExit() {
        console.log('[Dueling] Duel ended');
        this.ctx.mcSend('unsprint', {});
        this.busy = false;
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
    console.log(`[Cooldown] ${ability} on cooldown for ${stats.cooldown}ms`);
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
 *   this.lastRequest             → timestamp of last get_duel_data request
 *   this.requestInterval         → how often duel data is refreshed, default 2000ms
 *   this.moveTarget              → { x, z } destination Lily is moving toward, or null
 *   this.lastMoveUpdate          → timestamp of last movement direction update
 *
 * AI RESPONSE FORMAT:
 *   Single slot:  { "slot": 3, "move_to": { "x": 100, "z": 200 } }
 *   Multi slot:   { "slot": [3, 7], "move_to": { "x": 100, "z": 200 } }
 *
 * ACTION EXECUTION:
 *   Each ability's actions array e.g. ["click:left:1", "sneak:hold:1"]
 *   is expanded into steps and fired with timeOffset delays using _fireAction()
 *   click:left  → mcSend("attack", { mode: "once" })
 *   click:right → mcSend("use",    { mode: "once" })
 *   sneak:hold  → mcSend fire_pk_event sneak, then unsneak after actionTime
 *   sneak:tap   → fire_pk_event sneak + unsneak 50ms later
 *
 * TRANSITIONS OUT:
 *   → IDLE  when duelTarget is null or player leaves
 */