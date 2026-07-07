// This file sets up and starts the main Discord bot
// It imports necessary modules for creating the bot,
// handling configuration, and connecting to Minecraft.

import { createBot, ai } from "./bot.js"
import { config } from "./utils/config.js"
import { startMinecraftBot } from "./minecraft/neoforgemod-way/lilybot.js"

const client = await createBot()
let currentMode = process.env.MODE ?? 'bendcraft'
let survivalLoopStarted = false

export const getMode = () => currentMode

// When the bot is ready, log in and start the Minecraft connection
client.once("clientReady", () => {
    console.log(`Logged in as ${client.user.tag}`)
    startMinecraftBot({
        host: process.env.MC_BRIDGE_HOST ?? "localhost",
        port: parseInt("8765"),
        ai
    })
})

// Login to the Discord server with the provided token
client.login(config.token)