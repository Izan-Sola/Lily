import express from 'express'
import { stt, tts } from '../STTS/index.js'
import { SYSTEM_PROMPT } from '../ai/prompts.js'
import { getOwnerId } from '../ai/config.js'
import { VOICE_ASSISTANT_CHANNEL_ID } from '../ai/Lily.js'
import { Logger } from '../utils/Logger.js'
import { createTurnRouter } from '../ai/tools/stts/remoteDevices.js'
import { createApprovalRouter } from '../ai/tools/riskyActionsManagement/approvalRoutes.js'

const REMOTE_PORT = Number(process.env.STTS_REMOTE_PORT) || 8770

/**
 * Starts the voice assistant: local-mic wake handler plus the HTTP endpoint
 * remote devices use (/stts turns, approval routes). Nothing binds on import.
 *
 * @param {object} deps
 * @param {import('../ai/Lily.js').Lily} deps.ai
 * @param {() => import('discord.js').Client|null} deps.getDiscordClient  resolved lazily; Discord may log in later
 * @returns {{ stop(): Promise<void> }}
 */
export function startVoiceAssistant({ ai, getDiscordClient }) {
    // One turn: the same call for local mic and remote devices.
    const runTurn = text => ai.chat(VOICE_ASSISTANT_CHANNEL_ID, text, SYSTEM_PROMPT, {}, [])

    async function sendGif(result) {
        if (!result?.gifUrl) return
        const userId = getOwnerId()
        const client = getDiscordClient()
        if (!userId) return Logger.warning('No discordUserID configured – cannot send GIF DM', 'VOICE GIF')
        if (!client) return Logger.warning('Discord client not available – cannot send GIF DM', 'VOICE GIF')
        try {
            const user = await client.users.fetch(userId)
            await user.send({ content: `\n${result.gifUrl}` })
            Logger.info(`Sent voice‑assistant GIF to ${userId}`, 'VOICE GIF')
        } catch (err) {
            Logger.error(`Failed to send GIF DM: ${err.message}`, 'VOICE GIF')
        }
    }

    // Local mic on the minipc.
    const onWake = async wakeSentence => {
        try {
            const result = await runTurn(wakeSentence)
            if (result?.text) {
                await tts.speak(result.text)
                await sendGif(result)
            }
        } catch (err) {
            Logger.error(err.message, 'VOICE')
        }
    }
    stt.on('wake', onWake)

    // Remote devices speak the reply themselves, so just hand the text back.
    const app = express()
    app.use('/stts', createTurnRouter(async text => {
        const result = await runTurn(text)
        await sendGif(result)
        return result?.text ?? ''
    }))
    app.use(createApprovalRouter())

    const server = app.listen(REMOTE_PORT, '0.0.0.0', () =>
        Logger.info(`Remote STTS turns on :${REMOTE_PORT}/stts`, 'VOICE'))
    server.on('error', err => Logger.error(`Remote STTS server error: ${err.message}`, 'VOICE'))

    return {
        stop: () => new Promise(resolve => {
            stt.off('wake', onWake)
            server.close(() => resolve())
        }),
    }
}
