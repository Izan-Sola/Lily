import { SlashCommandBuilder } from "discord.js"
import { speak } from "../bot.js"
import { Lily } from "../ai/Lily.js"
import { config } from "../utils/config.js"
import fs from "fs"

const ai = new Lily(config.modelName)

export const data = new SlashCommandBuilder()
    .setName("audiolily")
    .setDescription("Ask Lily something and she'll respond with her voice!")
    .addStringOption(option =>
        option
            .setName("message")
            .setDescription("What do you want to say to Lily?")
            .setRequired(true)
    )

export async function execute(interaction) {
    await interaction.deferReply()

    const userMessage = interaction.options.getString("message")
    const authorName  = interaction.member?.displayName || interaction.user.username  // ← fixed

    try {
        const formattedMessage = `[${authorName}] says to you: ${userMessage}`
        const reply = await ai.chat(interaction.channelId, formattedMessage)
        const cleanReply = typeof reply === "object" ? reply.text : reply
        const clean = cleanReply.replace(/\/\w+.*$/s, "").trim()

        const oggPath = await speak(clean)

        await interaction.editReply({
            content: `💬 *"${clean}"*`,
            files: [{ attachment: oggPath, name: "lily_response.ogg" }]
        })

        fs.unlink(oggPath, () => {})

    } catch (err) {
        console.error("[/audiolily] Error:", err)
        // ← only reply if not already replied
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "Sowwy, something went wrong! 🍓", ephemeral: true })
        } else {
            await interaction.editReply({ content: "Sowwy, something went wrong! 🍓" })
        }
    }
}