import { SlashCommandBuilder } from "discord.js"
import { Lily } from "../ai/Lily.js"
import { config } from "../utils/config.js"

const ai = new Lily({ 
    model: config.model 
});  

export const data = new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Talk to Lily")
    .addStringOption(option =>
        option.setName("message")
              .setDescription("What you want to say")
              .setRequired(true)
    )

export async function execute(interaction) {
    const message  = interaction.options.getString("message")
    const username = interaction.member?.displayName || interaction.user.username

    await interaction.deferReply()

    const formattedMessage = `[${username}] says to you: ${message}`
    const reply = await ai.chat(interaction.channelId, formattedMessage)

    await interaction.editReply(
        username + ": " + message +
        "\n ------- \n" +
        reply.replace(/\/\w+.*$/s, "").trim()
    )
}