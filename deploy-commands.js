import pkg from "discord.js"
const { REST, Routes } = pkg
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { config } from "./src/utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const deploy = async () => {
    const commandsPath = path.join(__dirname, "src/commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"))
    const commands = []

    for (const file of commandFiles) {
        const command = await import(`./src/commands/${file}`)
        commands.push(command.data.toJSON())
        console.log(`📦 Loaded command: ${command.data.name}`)
    }

    const rest = new REST({ version: "10" }).setToken(config.token)

    try {
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: commands }
        )
        console.log("✅ Slash commands deployed successfully!")
    } catch (error) {
        console.error("❌ Error deploying slash commands:", error.message)
        throw error
    }
}

export default deploy


if (import.meta.url === `file://${process.argv[1]}`) {
    deploy()
}