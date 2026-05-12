import { buildDuelPrompt } from './duelPromptBuilder.js';

export class DuelingState {
    constructor(ctx) {
        this.ctx = ctx;
        this.nextPromptAt = 0;
        this.lastRequest = 0;
        this.requestInterval = 2000;
        this.busy = false;
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

        // Keep duel data fresh
        if (now - this.lastRequest >= this.requestInterval) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        // Don't send a new prompt while waiting for ability to finish or AI to respond
        if (this.busy || now < this.nextPromptAt / 1.25) return;

        this.busy = true;
        this._sendPrompt(targetName).finally(() => {
            this.busy = false;
        });
    }

    async _sendPrompt(targetName) {
        const prompt = buildDuelPrompt(this.ctx, targetName);
        // console.log('[DUEL PROMPT]\n', prompt);

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
                    this.ctx.mcSend('move', { direction: 'stop' });
                } else {
                    const dir = this._getMoveDirection(this.ctx.lilyPos, action.move_to, target);
                    if (dir) {
                        this.ctx.mcSend('move', { direction: dir });
                    }
                }
            }

            // Use ability slot
            const slot = action.slot;
            if (slot) {
                triggerCooldown(this.ctx, slot);
                this._executeAbility(slot);
                this.nextPromptAt = Date.now() + this._getAbilityDuration(slot);
            } else {
               this.nextPromptAt = Date.now() + this._getAbilityDuration(slot);
            }

        } catch (err) {
            console.error('[Dueling] AI error:', err.message);
            this.nextPromptAt = Date.now();
        }
    }

    _executeAbility(slot) {
        //    console.log(`[Dueling] _executeAbility called with slot ${slot}`);
        const raw = this.ctx.bindings[slot];
        //    console.log(`[Dueling] raw binding: ${raw}`);
        if (!raw) return;
        const abilityName = cleanName(raw);
        //    console.log(`[Dueling] abilityName: ${abilityName}`);
        const stats = this.ctx.abilityStats[abilityName];
        //    console.log(`[Dueling] stats:`, stats);
        if (!stats?.actions?.length) return;

        //   console.log(`[Dueling] Executing slot ${slot}: ${abilityName}`);

        this.ctx.mcSend('hotbar', { slot });

        const steps = [];
        for (const actionStr of stats.actions) {
            const [type, mode, countStr] = actionStr.split(':');
            const count = parseInt(countStr ?? '1');
            for (let i = 0; i < count; i++) {
                steps.push({ type, mode });
            }
        }

        let timeOffset = 0;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const delay = timeOffset;
            setTimeout(() => this._fireAction(step), delay);

            if (step.type === 'sneak' && step.mode === 'hold') {
                setTimeout(() => this.ctx.mcSend('fire_pk_event', { event: 'unsneak' }), delay + (stats.actionTimes[i] ?? 200));
            }

            timeOffset += stats.actionTimes[i] ?? 200;
        }

        // timeOffset is now the total duration — use it directly instead of _getAbilityDuration
        this.nextPromptAt = Date.now();
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
        }
    }

    onExit() {
        console.log('[Dueling] Duel ended');
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