import { SlashCommandBuilder } from "discord.js"
import { getPrefs, setPrefs } from "../utils/userPreferences.js"

export const data = new SlashCommandBuilder()
    .setName("lilyprefs")
    .setDescription("Manage your personal Lily preferences")
    .addSubcommand(sub =>
        sub.setName("spontaneous")
           .setDescription("Control whether Lily can randomly reply to your messages")
           .addStringOption(opt =>
               opt.setName("value")
                  .setDescription("Allow or disable spontaneous replies")
                  .setRequired(true)
                  .addChoices(
                      { name: "Enabled", value: "true" },
                      { name: "Disabled", value: "false" }
                  )
           )
    )
    .addSubcommand(sub =>
        sub.setName("ping")
           .setDescription("Control whether Lily pings you on spontaneous replies")
           .addStringOption(opt =>
               opt.setName("value")
                  .setDescription("Ping or no ping")
                  .setRequired(true)
                  .addChoices(
                      { name: "Always ping", value: "true" },
                      { name: "No ping", value: "false" }
                  )
           )
    )
    .addSubcommand(sub =>
        sub.setName("voiceprocess")
           .setDescription("Control whether Lily listens to you in voice chat")
           .addStringOption(opt =>
               opt.setName("value")
                  .setDescription("Allow or disable voice processing")
                  .setRequired(true)
                  .addChoices(
                      { name: "Yes", value: "true" },
                      { name: "No", value: "false" }
                  )
           )
    )
    .addSubcommand(sub =>
        sub.setName("wakeword")
           .setDescription("Control whether Lily requires her name before responding in voice")
           .addStringOption(opt =>
               opt.setName("value")
                  .setDescription("Require wake word or not")
                  .setRequired(true)
                  .addChoices(
                      { name: "Required", value: "true" },
                      { name: "Not required", value: "false" }
                  )
           )
    )
    .addSubcommand(sub =>
        sub.setName("view")
           .setDescription("View your current preferences")
    )

export async function execute(interaction) {
    const sub = interaction.options.getSubcommand()
    const userId = interaction.user.id

    if (sub === "view") {
        const prefs = getPrefs(userId)
        return interaction.reply({
            content: [
                "**Your Lily preferences:**",
                `> Spontaneous replies: **${prefs.spontaneousReplies ? "Enabled" : "Disabled"}**`,
                `> Ping on spontaneous: **${prefs.pingOnSpontaneous ? "Yes" : "No"}**`,
                `> Voice processing: **${prefs.voiceProcess ? "Yes" : "No"}**`,
                `> Wake word required: **${prefs.wakeWordRequired ? "Yes" : "No"}**`,
            ].join("\n"),
            flags: 64
        })
    }

    const value = interaction.options.getString("value") === "true"
    const keyMap = {
        spontaneous: "spontaneousReplies",
        ping:        "pingOnSpontaneous",
        voiceprocess: "voiceProcess",
        wakeword:    "wakeWordRequired",
    }

    setPrefs(userId, { [keyMap[sub]]: value })
    return interaction.reply({
        content: `✅ Updated **${sub}** to **${value ? "enabled" : "disabled"}**`,
        flags: 64
    })
}