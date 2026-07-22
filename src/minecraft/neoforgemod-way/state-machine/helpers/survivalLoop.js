import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js'
import { ToolExecutor, TOOLS } from '../../../../ai/tools.js'
const ACTIONS_INTERVAL_MS = 30000
const MSG_MIN_MS = 2 * 60 * 1000
const MSG_MAX_MS = 6 * 60 * 1000
const HISTORY_MAX_TURNS = 8 // keep last N exchanges threaded into the call

// Survival loop only ever needs the minecraft_action_* tools — no memory/web/meme tools here.
const SURVIVAL_TOOLS = TOOLS.filter(t => t.function.name.startsWith('minecraft_action_'))

function randomMsgDelay() {
    return MSG_MIN_MS + Math.random() * (MSG_MAX_MS - MSG_MIN_MS)
}

export function startSurvivalLoop(stateController, mcSend, mcChat, ollamaUrl = "http://localhost:11435") {
    let nextMessageAt = Date.now() + randomMsgDelay()
    const toolExecutor = new ToolExecutor({}, mcSend, () => stateController)

    // history lives on stateController so it survives across ticks
    if (!stateController.chatHistory) stateController.chatHistory = []
    async function runTick() {
        if (!stateController) return

        // Don't let the autonomous loop step on an action already in progress
        // (started either by LOOP 1 / a direct command, or by a previous survival tick).
        const busyStates = ['MINING', 'ATTACKING', 'RECOVERING']
        if (busyStates.includes(stateController.currentStateName)) {
            console.log(`[SURVIVAL] Skipping tick — busy in ${stateController.currentStateName}`)
            return
        }

        const allowMessage = Date.now() >= nextMessageAt
        if (allowMessage) {
            nextMessageAt = Date.now() + randomMsgDelay()
        }

        const prompt = buildSurvivalPrompt(stateController, { allowMessage })
  
        if (!prompt) return

        // thread history as real turns instead of collapsing into one string
        const messages = [
            ...stateController.chatHistory.slice(-HISTORY_MAX_TURNS),
            { role: "user", content: prompt }
        ]

        try {
            const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "Lily",
                    stream: false,
                    messages,
                    tools: SURVIVAL_TOOLS,
                    tool_choice: "auto",
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
            const message = data.choices?.[0]?.message
            if (!message) {
                console.error('[SURVIVAL] No message in response:', JSON.stringify(data))
                return
            }

            const chatText = message.content?.trim()
            if (allowMessage && chatText) mcChat(chatText)

            // record this turn in history
            stateController.chatHistory.push({ role: "user", content: prompt })
            stateController.chatHistory.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls })
            if (stateController.chatHistory.length > HISTORY_MAX_TURNS * 2) {
                stateController.chatHistory = stateController.chatHistory.slice(-HISTORY_MAX_TURNS * 2)
            }

            const toolCalls = message.tool_calls ?? []
            for (const call of toolCalls) {
                await handleSurvivalToolCall(call, toolExecutor)
            }
        } catch (err) {
            console.error('[SURVIVAL] AI error:', err.message)
        }
    }

    setInterval(runTick, ACTIONS_INTERVAL_MS)

    // expose so a new chat message can trigger an immediate tick,
    // instead of waiting up to 30s for the next scheduled one
    return { triggerTick: runTick }
}

async function handleSurvivalToolCall(call, toolExecutor) {
    const name = call.function?.name
    if (!name) {
        console.warn('[SURVIVAL] Tool call missing function name:', JSON.stringify(call))
        return
    }

    let args = {}
    try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    } catch (err) {
        console.error(`[SURVIVAL] Invalid tool call arguments for ${name}:`, call.function.arguments)
        return
    }

    const result = await toolExecutor.execute(name, args)
    console.log(`[SURVIVAL] ${name} →`, result)
}