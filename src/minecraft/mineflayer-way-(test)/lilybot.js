import mineflayer from "mineflayer"

import mineflayerPathfinder from "mineflayer-pathfinder"
const { pathfinder, Movements, goals } = mineflayerPathfinder

import { LilyStateMachine } from "./states.js"
import { Logger } from "../../utils/Logger.js"

let mcBot = null
let stateMachine = null
let aiInstance = null

export function startMinecraftBot({ host, port = 25565, username = "Lily", version, ai, relayChannelId = null }) {
    if (mcBot) {
        Logger.info("⛏️ [MC] Bot already running")
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
        Logger.info(`⛏️ [MC] ${username} spawned in ${host}`)

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

        Logger.info(`⛏️ [MC CHAT] ${sender}: ${message}`)
        aiInstance.pushRawMessage("minecraft", sender, message)

        const lower = message.toLowerCase()
        const addressed = lower.includes("lily") || lower.includes("hylily") || lower.startsWith("!")
        const randomButtin = Math.random() < 0.05

        // if (addressed || randomButtin) {
        //     if (StateController?.currentStateName === State.DUELING) {
        //         return {
        //             content: "Lily is currently in a duel, she can't reply right now!"
        //         }
        //     }
        //     try {
        //         const formattedMessage = addressed
        //             ? `[${sender}] says to you in Minecraft: ${message}`
        //             : `[${sender}] said in Minecraft nearby: ${message}`

        //         const reply = await aiInstance.chat("minecraft", formattedMessage)
        //         const text = typeof reply === "object" ? reply.text : reply
        //         if (text) splitMessage(text).forEach(chunk => mcBot.chat(chunk))
        //     } catch (err) {
        //         console.error("⛏️ [MC] Chat handler error:", err)
        //     }
        // }
    })
    mcBot.on("kicked", reason => {
        console.error("⛏️ [MC] Kicked:", JSON.stringify(reason, null, 2))
        stateMachine?.stop()
        mcBot = null
    })
    mcBot.on("death", () => {
        Logger.info("⛏️ [MC] Bot died, respawning...")
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
        Logger.info("⛏️ [MC] Disconnected:", reason)
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