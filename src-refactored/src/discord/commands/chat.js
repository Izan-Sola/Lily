import { SlashCommandBuilder } from "discord.js"
import { Lily } from "../../ai/Lily.js"
import { config } from "../../utils/config.js"

const ai = new Lily({ overrides: { model: config.model } });

export const data = new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Talk to Lily")
    .addStringOption(option =>
        option.setName("message")
            .setDescription("What you want to say")
            .setRequired(true)
    )

export async function execute(interaction) {
    const message = interaction.options.getString("message")
    const username = interaction.member?.displayName || interaction.user.username
    const authorName = interaction.member?.displayName || interaction.user.username
    const bannedUsers = config.bannedUsers
    if (!authorName || bannedUsers.includes(authorName) || bannedUsers.includes(interaction.user.username)) return

    await interaction.deferReply()

    const formattedMessage = `[${username}] says to you: ${message}`
    const result = await ai.chat(
        interaction.channelId,
        formattedMessage,
        null,
        { authorName: username, userId: interaction.user.id }
    )

    // handleMessage returns { text, ... } from runToolLoop, or null when
    // the input was empty or Lily is still busy replying in this channel.
    const replyText = typeof result === "string" ? result : result?.text

    if (!replyText) {
        await interaction.editReply(
            username + ": " + message +
            "\n ------- \n" +
            "*(Lily is busy or had nothing to say, try again in a moment)*"
        )
        return
    }

    // Strip trailing slash-commands, only when they start a line.
    const cleaned = replyText.replace(/(^|\n)\/\w+.*$/s, "").trim()

    const output = username + ": " + message + "\n ------- \n" + cleaned
    await interaction.editReply(output.slice(0, 2000))
}