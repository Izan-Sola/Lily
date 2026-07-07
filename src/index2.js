import { startMinecraftBot } from "./minecraft/neoforgemod-way/lilybot.js"
import { createBot, ai } from "./bot.js"
startMinecraftBot({
    port: parseInt("8766"),
    ai
})