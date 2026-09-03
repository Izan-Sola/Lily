#!/usr/bin/env node

import { createBot, ai } from "./bot.js"
import { config } from "./utils/config.js"
import { Logger } from "./utils/Logger.js"
import { parseFlags, getModeFromFlags, isModdedMode, isMineflayerMode, hasVtubeSupport } from "./startUtils.js"

const flags = parseFlags()

let mode
try {
    mode = getModeFromFlags(flags)
} catch (err) {
    Logger.error(err.message, "STARTUP")
    process.exit(1)
}

const hasVtube = hasVtubeSupport(mode)
const isModded = isModdedMode(mode)
const isMineflayer = isMineflayerMode(mode)
const isDiscordEnabled = flags.has('discord')

if (flags.has('bending') && !isModded) {
    Logger.warning("'bending' flag has no effect without 'modded' - ignoring", "STARTUP")
}

Logger.info(`Starting with flags: ${[...flags].join(', ') || '(none)'}`, "STARTUP")
Logger.info(`  • Discord: ${isDiscordEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • VTube Studio: ${hasVtube ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Minecraft: ${isMineflayer ? 'Mineflayer' : isModded ? 'Modded (NeoForge)' : 'None'}`, "STARTUP")

if (!isDiscordEnabled && !isModded && !isMineflayer) {
    Logger.warning('No Discord and no Minecraft backend active - there is nothing for this process to do', "STARTUP")
}

let vtsClient = null
let survivalLoopHandle = null

async function initializeVTS() {
    if (!hasVtube) return null

    try {
        const { VTSClient } = await import('./vtuber/VTSClient.js')
        const client = new VTSClient({
            host: process.env.VTS_HOST || 'localhost',
            port: parseInt(process.env.VTS_PORT || '8001'),
            pluginName: process.env.VTS_PLUGIN_NAME || 'LilyVTS',
            pluginDev: process.env.VTS_PLUGIN_DEV || 'Izan'
        })

        await client.connect()
        Logger.success('VTube Studio connected', "VTUBE")
        return client
    } catch (err) {
        Logger.error(`VTube Studio failed: ${err.message}`, "VTUBE")
        return null
    }
}

async function startMinecraft() {
    if (isMineflayer) {
        const { startMinecraftBot } = await import('./minecraft/lily-mineflayer/index.js')
        return startMinecraftBot({
            host: process.env.MC_SERVER_HOST ?? "infection.fun",
            port: parseInt(process.env.MC_SERVER_PORT ?? "25565"),
            username: process.env.MC_BOT_USERNAME ?? "SillyLily_",
            followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
            ai,
            vtsClient,
            mode
        })
    } else if (isModded) {
        const { startMinecraftBot } = await import('./minecraft/neoforgemod-way/lilybot.js')
        return startMinecraftBot({
            host: process.env.MC_BRIDGE_HOST ?? "localhost",
            port: parseInt(process.env.MC_BRIDGE_PORT ?? "8766"),
            ai,
            vtsClient,
            mode
        })
    }
    return null
}

async function startSurvivalLoop(mcSend, mcChat, stateController) {
    const { startSurvivalLoop } = await import('./ai/survivalLoop.js')
    return startSurvivalLoop(
        stateController,
        mcSend,
        mcChat,
        process.env.OLLAMA_URL ?? "http://localhost:11435",
        mode,
        vtsClient
    )
}

async function initializeFeatures() {
    vtsClient = await initializeVTS()

    const mcBot = await startMinecraft()

    if (mcBot) {
        const { stateController, mcSend, mcChat } = mcBot
        const survivalLoop = await startSurvivalLoop(mcSend, mcChat, stateController)

        if (survivalLoop) {
            survivalLoopHandle = survivalLoop
            Logger.success('Survival loop started', "SURVIVAL")
        }
    }
}

async function setupDiscordBot() {
    if (!isDiscordEnabled) {
        Logger.info("'discord' flag not set - skipping Discord login", "STARTUP")
        await initializeFeatures()
        return null
    }

    const client = await createBot()

    client.once("clientReady", async () => {
        Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")
        await initializeFeatures()
    })

    await client.login(config.token)
    return client
}

async function main() {
    try {
        const client = await setupDiscordBot()

        const shutdown = async (signal) => {
            Logger.info(`Shutting down (${signal})...`, "SHUTDOWN")

            if (vtsClient) {
                await vtsClient.disconnect().catch(() => { })
            }

            if (survivalLoopHandle?._interval) {
                clearInterval(survivalLoopHandle._interval)
            }

            if (survivalLoopHandle?.stop) {
                survivalLoopHandle.stop()
            }

            if (client) {
                await client.destroy()
            }
            process.exit(0)
        }

        process.on('SIGINT', () => shutdown('SIGINT'))
        process.on('SIGTERM', () => shutdown('SIGTERM'))

        Logger.success('Bot started!', "MAIN")
    } catch (err) {
        Logger.error(`Failed to start: ${err.message}`, "MAIN")
        process.exit(1)
    }
}

main()