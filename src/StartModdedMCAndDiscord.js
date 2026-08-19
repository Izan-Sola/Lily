// This file sets up and starts the main Discord bot
// It imports necessary modules for creating the bot,
// handling configuration, and connecting to Minecraft.

import { createBot, ai } from "./bot.js"
import { config } from "./utils/config.js"
import { startMinecraftBot } from "./minecraft/neoforgemod-way/lilybot.js"
import { Logger } from "./utils/Logger.js";
const client = await createBot()
let currentMode = process.env.MODE ?? 'bendcraft'
let survivalLoopStarted = false

export const getMode = () => currentMode

// When the bot is ready, log in and start the Minecraft connection
client.once("clientReady", async () => {
    Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")

    // for (const guild of client.guilds.cache.values()) {
    //     try {
    //         await guild.leave()
    //         Logger.info(`Left ${guild.name}`, "CLEANUP")
    //     } catch (err) {
    //         Logger.error(`Failed to leave ${guild.name}: ${err}`, "CLEANUP")
    //     }
    // }

    startMinecraftBot({
        host: process.env.MC_BRIDGE_HOST ?? "localhost",
        port: parseInt("8766"),
        ai
    })
})
// Login to the Discord server with the provided token
client.login(config.token)