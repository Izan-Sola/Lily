import { buildDuelPrompt } from './duelPromptBuilder.js';

export class DuelingState {
    constructor(ctx) {
        this.ctx = ctx;
        this.lastPromptTime = 0;
        this.promptInterval = 2000;   // generate prompt every 2 seconds
        this.lastRequest = 0;
    }

    onEnter() {
        console.log(`[Dueling] Facing ${this.ctx.duelTarget}`);
        this.ctx.sneak.setSneaking(false);
        this.ctx.move.stop();
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
        // Always look at opponent
        // this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1, z: target.z });

        // Request fresh duel data every 2 seconds
        const now = Date.now();
        if (now - this.lastRequest >= this.promptInterval) {
            this.lastRequest = now;
            this.ctx.mcSend('get_duel_data', { opponent: targetName });
        }

        // Generate prompt (uses latest data from ctx.players, ctx.lilyPos, etc.)
        if (now - this.lastPromptTime >= this.promptInterval) {
            this.lastPromptTime = now;
            const prompt = buildDuelPrompt(this.ctx, targetName);
            console.log('[DUEL PROMPT]\n', prompt);
            // TODO: send to AI
//             aiInstance.chat("duel", duelPrompt, DUEL_SYSTEM_PROMPT, { 
            //     skipHistory: true, 
            //     skipRawContext: true 
            // })
        }
    }

    onExit() {
        console.log('[Dueling] Duel ended');
    }
}