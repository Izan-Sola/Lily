import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js'
import { ToolExecutor, TOOLS } from '../../../../ai/tools.js'
const ACTIONS_INTERVAL_MS = 60000
const MSG_MIN_MS = 2 * 60 * 1000
const MSG_MAX_MS = 6 * 60 * 1000

// Survival loop only ever needs the minecraft_action_* tools — no memory/web/meme tools here.
const SURVIVAL_TOOLS = TOOLS.filter(t => t.function.name.startsWith('minecraft_action_'))

function randomMsgDelay() {
    return MSG_MIN_MS + Math.random() * (MSG_MAX_MS - MSG_MIN_MS)
}

export function startSurvivalLoop(stateController, mcSend, mcChat, ollamaUrl = "http://localhost:11435") {
    let nextMessageAt = Date.now() + randomMsgDelay()

    // Single shared executor — always reads the *current* stateController via the getter.
    const toolExecutor = new ToolExecutor({}, mcSend, () => stateController)

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

            console.log('[SURVIVAL] Lily response:', JSON.stringify(message, null, 2))

            // Only allow chat output on the ticks that actually offered it —
            // ignore stray content if the model produces text anyway.
            const chatText = message.content?.trim()
            if (allowMessage && chatText) mcChat(chatText)

            // Defensive cap: the prompt demands at most one action, but if the
            // model ever returns more tool calls, only take the first rather
            // than firing several actions in the same tick.
            const toolCalls = message.tool_calls ?? []
            if (toolCalls.length > 1) {
                console.warn(`[SURVIVAL] Model returned ${toolCalls.length} tool calls, only using the first`)
            }

            const call = toolCalls[0]
            if (call) await handleSurvivalToolCall(call, toolExecutor)
        } catch (err) {
            console.error('[SURVIVAL] AI error:', err.message)
        }
    }, ACTIONS_INTERVAL_MS)
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