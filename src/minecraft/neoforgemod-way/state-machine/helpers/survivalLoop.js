import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js'

const ACTIONS_INTERVAL_MS = 20000
const MSG_MIN_MS = 2 * 60 * 1000
const MSG_MAX_MS = 6 * 60 * 1000

function randomMsgDelay() {
    return MSG_MIN_MS + Math.random() * (MSG_MAX_MS - MSG_MIN_MS)
}

export function startSurvivalLoop(stateController, mcSend, mcChat, ollamaUrl = "http://localhost:11435") {
    let nextMessageAt = Date.now() + randomMsgDelay()

    setInterval(async () => {
        if (!stateController) return

        const allowMessage = Date.now() >= nextMessageAt
        if (allowMessage) {
            nextMessageAt = Date.now() + randomMsgDelay()
        }

        const prompt = buildSurvivalPrompt(stateController, { allowMessage })
        console.log(`[SURVIVAL] Prompt (allowMessage=${allowMessage}):`, prompt)
        if (!prompt) return

        try {
            const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "Lily",
                    stream: false,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.4,
                    max_tokens: 512
                })
            })

            if (!response.ok) {
                const errBody = await response.text().catch(() => '')
                console.error('[SURVIVAL] HTTP', response.status, errBody)
                return
            }

            const data = await response.json()
            const rawText = data.choices?.[0]?.message?.content
            if (!rawText) {
                console.error('[SURVIVAL] No content in response:', JSON.stringify(data))
                return
            }

            const cleanText = rawText.replace(/```json|```/g, '').trim()

            let action
            try { action = JSON.parse(cleanText) } catch {
                console.error('[SURVIVAL] Invalid JSON:', rawText)
                return
            }
            console.log('[SURVIVAL] Lily response:', JSON.stringify(action, null, 2))

            // Only allow chat output on the ticks that actually offered it —
            // ignore a stray "msg" if the model hallucinates one anyway.
            if (allowMessage && action.msg) mcChat(action.msg)

            // Defensive cap: the prompt demands exactly one action, but if the
            // model ever returns more, only take the first rather than firing
            // several actions in the same tick.
            const actions = action.actions ?? []
            if (actions.length > 1) {
                console.warn(`[SURVIVAL] Model returned ${actions.length} actions, only using the first`)
            }
            if (actions[0]) handleSurvivalAction(actions[0], stateController, mcSend)
        } catch (err) {
            console.error('[SURVIVAL] AI error:', err.message)
        }
    }, ACTIONS_INTERVAL_MS)
}

function handleSurvivalAction(act, stateController, mcSend) {
    switch (act.type) {
        case 'attack': mcSend('attack', { mode: 'once' }); break
        case 'use': mcSend('use', { mode: 'once' }); break
        case 'eat': mcSend('use', { mode: 'once' }); break
        case 'swap_slot': mcSend('hotbar', { slot: act.slot }); break
        case 'drop': mcSend('drop', { slot: act.slot }); break
        case 'move_to': mcSend('move_to', { x: act.x, z: act.z }); break
        case 'follow':
            if (act.player) stateController.setFollowTarget(act.player)
            stateController.transitionTo('FOLLOWING')
            break
        case 'stop':
            stateController.transitionTo('IDLE')
            break
        default:
            console.warn(`[SURVIVAL] Unknown action type: ${act.type}`)
    }
}