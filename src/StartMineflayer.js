// This file sets up and starts the main Discord bot
// It imports necessary modules for creating the bot,
// handling configuration, and connecting to Minecraft.
//
// Difference from the neoforgemod-way version: Minecraft is no longer a
// WebSocket bridge waiting on a Java mod to connect — it's a mineflayer
// bot that connects straight out to a server, so there's no "port the mod
// listens on", just the target server's host/port.

import { createBot, ai } from "./bot.js"
import { config } from "./utils/config.js"
import { startMinecraftBot } from "./minecraft/lily-mineflayer/index.js"
import { Logger } from "./utils/Logger.js";
const client = await createBot()

export const getMode = () => 'survival' // mineflayer-way only supports survival mode — no ProjectKorra bending on a cracked plugin server

// When the bot is ready, log in and start the Minecraft connection

startMinecraftBot({
    host: process.env.MC_SERVER_HOST ?? "", // TODO: point at the real cracked server
    port: parseInt(process.env.MC_SERVER_PORT ?? "25565"),
    username: process.env.MC_BOT_USERNAME ?? "Lily",
    followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
    ai
})
