import mineflayer from "mineflayer"

import mineflayerPathfinder from "mineflayer-pathfinder"
const { pathfinder, Movements, goals } = mineflayerPathfinder

import { LilyStateMachine } from "./states.js"

let mcBot = null
let stateMachine = null
let aiInstance = null

export function startMinecraftBot({ host, port = 25565, username = "Lily", version, ai, relayChannelId = null }) {
    if (mcBot) {
        console.log("⛏️ [MC] Bot already running")
        return
    }

    aiInstance = ai

    mcBot = mineflayer.createBot({
        host,
        port,
        username,
        auth: "offline",
        version,
    })

    mcBot.loadPlugin(pathfinder)

    mcBot.once("spawn", () => {
        console.log(`⛏️ [MC] ${username} spawned in ${host}`)

        const defaultMove = new Movements(mcBot)
        mcBot.pathfinder.setMovements(defaultMove)

        // expose goals on pathfinder for state machine
        mcBot.pathfinder.goals = goals

        // start state machine
        const stateController = new StateController(mcSend, {
            followTarget: 'shinyshadow_',
            followDistance: 3,
            attackRange: 4,
            lowHpThreshold: 6,
            tickMs: 150
        })
        stateController.start()
    })

    mcBot.on("chat", async (sender, message) => {
        if (sender === mcBot.username) return
        if (!message.trim()) return

        console.log(`⛏️ [MC CHAT] ${sender}: ${message}`)
        aiInstance.pushRawMessage("minecraft", sender, message)

        const lower = message.toLowerCase()
        const addressed = lower.includes("lily") || lower.includes("hylily")
        const randomButtin = Math.random() < 0.05

        if (addressed || randomButtin) {
            try {
                const formattedMessage = addressed
                    ? `[${sender}] says to you in Minecraft: ${message}`
                    : `[${sender}] said in Minecraft nearby: ${message}`

                const reply = await aiInstance.chat("minecraft", formattedMessage)
                const text = typeof reply === "object" ? reply.text : reply
                if (text) splitMessage(text).forEach(chunk => mcBot.chat(chunk))
            } catch (err) {
                console.error("⛏️ [MC] Chat handler error:", err)
            }
        }
    })
    mcBot.on("kicked", reason => {
        console.error("⛏️ [MC] Kicked:", JSON.stringify(reason, null, 2))
        stateMachine?.stop()
        mcBot = null
    })
    mcBot.on("death", () => {
        console.log("⛏️ [MC] Bot died, respawning...")
        mcBot.respawn()
    })

    mcBot.on("kicked", reason => {
        console.error("⛏️ [MC] Kicked:", reason)
        stateMachine?.stop()
        mcBot = null
    })

    mcBot.on("error", err => {
        console.error("⛏️ [MC] Error:", err.message)
    })

    mcBot.on("end", reason => {
        console.log("⛏️ [MC] Disconnected:", reason)
        stateMachine?.stop()
        mcBot = null
    })

    return mcBot
}

export function stopMinecraftBot() {
    stateMachine?.stop()
    mcBot?.quit("Lily is going offline~")
    mcBot = null
}

export function getMinecraftBot() { return mcBot }
export function getStateMachine() { return stateMachine }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text, limit = 250) {
    const words = text.split(" ")
    const chunks = []
    let current = ""
    for (const word of words) {
        if ((current + " " + word).trim().length > limit) {
            if (current) chunks.push(current.trim())
            current = word
        } else {
            current = current ? current + " " + word : word
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}