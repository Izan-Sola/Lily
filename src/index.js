import { createBot } from "./bot.js"
import { config } from "./utils/config.js"

const client = await createBot()

client.once("clientReady", () => {
    console.log(`Logged in as ${client.user.tag}`)
})

client.login(config.token)
