import { createBot, ai } from "./bot.js"
import { config } from "./utils/config.js"
import { startMinecraftBot } from "./minecraft/neoforgemod-way/lilybot.js"

const client = await createBot()

client.once("clientReady", () => {
    console.log(`Logged in as ${client.user.tag}`)

    // startMinecraftBot({
    //     host: process.env.MC_BRIDGE_HOST ?? "localhost",  
    //     port: parseInt(process.env.MC_BRIDGE_PORT ?? "8765"),
    //     ai
    // })
})

client.login(config.token)