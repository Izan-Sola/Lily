import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js'
import { Logger } from '../../../../utils/Logger.js'

const ACTIONS_INTERVAL_MS = 30000
const MSG_MIN_MS = 2 * 60 * 1000
const MSG_MAX_MS = 6 * 60 * 1000
const HISTORY_MAX_TURNS = 8

function randomMsgDelay() {
    return MSG_MIN_MS + Math.random() * (MSG_MAX_MS - MSG_MIN_MS)
}

/**
 * @param stateController  the StateController instance
 * @param toolExecutor      object with .execute(name, args) -> Promise<string>,
 *                           same interface as the original ToolExecutor from ai/tools.js.
 *                           Wire your existing minecraft_action_* tools through
 *                           stateController.dispatchAction(action, args) — the
 *                           action/arg names match the mod version 1:1 (follow,
 *                           break, attack, retreat, stop, move_to, use, drop, chat).
 * @param survivalTools      the filtered tool list (minecraft_action_* only), same as before
 * @param ollamaUrl
 */
export function startSurvivalLoop(stateController, toolExecutor, survivalTools, ollamaUrl = "http://localhost:11435") {
    let nextMessageAt = Date.now() + randomMsgDelay()

    if (!stateController.chatHistory) stateController.chatHistory = []

    async function runTick() {
        if (!stateController) return

        const busyStates = ['MINING', 'ATTACKING', 'RECOVERING']
        if (busyStates.includes(stateController.currentStateName)) {
            Logger.info(`Skipping tick — busy in ${stateController.currentStateName}`, "SURVIVAL")
            return
        }

        const allowMessage = Date.now() >= nextMessageAt
        if (allowMessage) {
            nextMessageAt = Date.now() + randomMsgDelay()
        }

        const prompt = buildSurvivalPrompt(stateController, { allowMessage })
        if (!prompt) return

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
                    tools: survivalTools,
                    tool_choice: "auto",
                    temperature: 0.4,
                    max_tokens: 512
                })
            })

            if (!response.ok) {
                const errBody = await response.text().catch(() => '')
                Logger.error('HTTP ' + response.status + errBody, "SURVIVAL")
                return
            }

            const data = await response.json()
            const message = data.choices?.[0]?.message
            if (!message) {
                Logger.error('No message in response: ' + JSON.stringify(data), "SURVIVAL")
                return
            }

            const chatText = message.content?.trim()
            if (allowMessage && chatText) {
                // Reply on whichever channel the triggering message came in on —
                // this is the /msg feature: if the last thing said to Lily was
                // a private whisper, she whispers back instead of replying in
                // public chat where it'd be visible (and annoying) to everyone else.
                const last = stateController.lastUserMessage
                if (last?.channel === 'whisper') {
                    stateController.mcWhisper(last.player, chatText)
                } else {
                    stateController.mcChat(chatText)
                }
            }

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
            Logger.error('[SURVIVAL] AI error: ' + err.message, "SURVIVAL")
        }
    }

    setInterval(runTick, ACTIONS_INTERVAL_MS)

    return { triggerTick: runTick }
}

async function handleSurvivalToolCall(call, toolExecutor) {
    const name = call.function?.name
    if (!name) {
        Logger.warning('Tool call missing function name: ' + JSON.stringify(call), "SURVIVAL")
        return
    }

    let args = {}
    try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    } catch (err) {
        Logger.error(`Invalid tool call arguments for ${name}: ` + call.function.arguments, "SURVIVAL")
        return
    }

    const result = await toolExecutor.execute(name, args)
    Logger.info(`${name} → ` + result, "SURVIVAL")
}
