import express from 'express';
import { stt, tts } from '../STTS/index.js';
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { ai } from '../start.js'         // Lily instance
import { client } from '../discord/bot.js';      // Discord client (must be exported)
import { getConfig } from '../ai/config.js';     // for discordUserID
import { VOICE_ASSISTANT_CHANNEL_ID } from '../ai/Lily.js';
import { Logger } from '../../src/utils/Logger.js'; // optional, but consistent
import { createTurnRouter } from '../ai/tools/remoteDevices.js'; // adjust path to where you put it
import { createApprovalRouter } from '../ai/tools/riskyActionsManagement/approvalRoutes.js';
const ASSISTANT_ENABLED = true;
const REMOTE_PORT = Number(process.env.STTS_REMOTE_PORT) || 8770;
let started = false;

// One turn: the same call for local mic and remote devices.
const runTurn = (text) => ai.chat(VOICE_ASSISTANT_CHANNEL_ID, text, SYSTEM_PROMPT, {}, []);
const remote = express();
remote.use('/stts', createTurnRouter(async (text) => {
    const result = await runTurn(text);
    await sendGif(result);
    return result?.text ?? '';
}));
remote.use(createApprovalRouter());   // <- new, no path prefix
remote.listen(REMOTE_PORT, '0.0.0.0', () => Logger.info(`Remote STTS turns on :${REMOTE_PORT}/stts`, 'VOICE'));
// --- Handle GIF if present ---
async function sendGif(result) {
    if (!result?.gifUrl) return;
    const userId = getConfig().discord.discordUserID;

    if (!userId) {
        Logger.warning('No discordUserID configured – cannot send GIF DM', 'VOICE GIF');
    } else if (!client) {
        Logger.warning('Discord client not available – cannot send GIF DM', 'VOICE GIF');
    } else {
        try {
            const user = await client.users.fetch(userId);
            await user.send({ content: `\n${result.gifUrl}` });
            Logger.info(`Sent voice‑assistant GIF to ${userId}`, 'VOICE GIF');
        } catch (err) {
            Logger.error(`Failed to send GIF DM: ${err.message}`, 'VOICE GIF');
        }
    }
}

export function startVoiceAssistant() {
    if (!ASSISTANT_ENABLED || started) return;
    started = true;

    // Local mic on the minipc (unchanged behaviour).
    stt.on('wake', async (wakeSentence, fullText) => {
        try {
            const result = await runTurn(wakeSentence);
            if (result?.text) {
                await tts.speak(result.text);
                await sendGif(result);
            }
        } catch (err) {
            console.error('[voiceAssistant] error:', err.message);
        }
    });

    // Remote devices (laptop web app). The device speaks the reply itself,
    // so no tts.speak() here — just hand the text back.
    const remote = express();
    remote.use('/stts', createTurnRouter(async (text) => {
        const result = await runTurn(text);
        await sendGif(result);
        return result?.text ?? '';
    }));
    remote.listen(REMOTE_PORT, '0.0.0.0', () => Logger.info(`Remote STTS turns on :${REMOTE_PORT}/stts`, 'VOICE'));
}

export function stopVoiceAssistant() {
    started = false;
    console.log('[voiceAssistant] stopped');
}