import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js' 

export function startSurvivalLoop(stateController, mcSend, mcChat) {
    setInterval(async () => {
        if (!stateController) return
        const prompt = buildSurvivalPrompt(stateController)
        if (!prompt) return

        try {
            const response = await fetch("http://localhost:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "Lily",
                    stream: false,
                    messages: [{ role: "user", content: prompt }]
                })
            })
            const data = await response.json()
            const text = data.message?.content
            if (!text) return

            let action
            try { action = JSON.parse(text) } catch {
                console.error('[SURVIVAL] Invalid JSON:', text)
                return
            }
            console.log('[SURVIVAL] Lily response:', JSON.stringify(action, null, 2))
            if (action.msg) mcChat(action.msg)
        
            for (const act of action.actions ?? []) {
                handleSurvivalAction(act, mcSend)
            }
        } catch (err) {
            console.error('[SURVIVAL] AI error:', err.message)
        }
    }, 60000)
}

function handleSurvivalAction(act, mcSend) {
    switch (act.type) {
        case 'attack':    mcSend('attack', { mode: 'once' }); break
        case 'use':       mcSend('use', { mode: 'once' }); break
        case 'eat':       mcSend('use', { mode: 'once' }); break
        case 'swap_slot': mcSend('hotbar', { slot: act.slot }); break
        case 'drop':      mcSend('drop', { slot: act.slot }); break
        case 'move_to':   mcSend('move_to', { x: act.x, z: act.z }); break
    }
}