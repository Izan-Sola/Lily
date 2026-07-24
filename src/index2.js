import { startMinecraftBot } from "./minecraft/neoforgemod-way/lilybot.js"
import { createBot, ai } from "./bot.js"
import "./utils/Logger.js";
startMinecraftBot({
    port: parseInt("8766"),
    ai
})