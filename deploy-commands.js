// This script deploys all Discord slash commands to the server
// It imports necessary modules for creating a REST API client,
// handling filesystem operations, and loading commands from files.

import pkg from "discord.js"
const { REST, Routes } = pkg
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { config } from "./src/utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default async () => {
    const commandsPath = path.join(__dirname, "src/commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"))
    const commands = []

    for (const file of commandFiles) {
        const command = await import(`./src/commands/${file}`)
        commands.push(command.data.toJSON())
        console.log(`📦 Loaded command: ${command.data.name}`)
    }

    // Create and configure the REST API client
    const rest = new REST({ version: "10" }).setToken(config.token)
    
    try {
        // Deploy commands to Discord server globally
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
