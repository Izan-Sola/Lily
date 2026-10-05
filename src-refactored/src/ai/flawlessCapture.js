import { Logger } from '../utils/Logger.js'
import { saveFlawlessTurn } from './saveFlawlessTurns.js'
import { SYSTEM_PROMPT } from './prompts.js'

// Collects turns that finished without any tool misuse and writes them out as
// training data once `trainingTurnWindow` of them have accumulated per channel.
export class FlawlessCapture {
    #windows = new Map()   // channelId -> turns[]

    /**
     * @param {TurnContext} ctx
     * @param {boolean} flawless  did the whole turn avoid markFlawed()?
     * @param {number} windowSize
     * @param {string} finalText  the reply that ended the turn
     * @param {Array} scratch     in-turn messages leading to the reply
     */
    record(ctx, { flawless, windowSize, finalText, scratch }) {
        const { channelId } = ctx
        if (!flawless || !finalText || finalText.toLowerCase() === 'none') {
            this.#windows.delete(channelId)
            return
        }
        if (!ctx.userMessage) return

        const turns = this.#windows.get(channelId) ?? []
        turns.push([ctx.userMessage, ...scratch, { role: 'assistant', content: finalText }])

        if (turns.length < Math.max(1, windowSize)) {
            this.#windows.set(channelId, turns)
            return
        }

        const messages = [{ role: 'system', content: ctx.systemPrompt ?? SYSTEM_PROMPT }, ...turns.flat()]
        saveFlawlessTurn({ channelId, messages }).catch(err => Logger.error(err.message, 'FLAWLESS SAVE'))
        this.#windows.delete(channelId)
    }
}
