import { Client, Collection, GatewayIntentBits } from "discord.js"
import {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
    getVoiceConnection,
} from "@discordjs/voice"
import fs from "fs"
import { randomUUID } from "crypto"
import { tmpdir } from "os"
import { join } from "path"
import path from "path"
import { fileURLToPath } from "url"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import prism from "prism-media"
import { HytaleAIChat, initLogChannel } from "./ai/index.js"
import { config } from "./utils/config.js"
import { getPrefs } from "./utils/userPreferences.js"
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const execAsync  = promisify(exec)
export const ai         = new HytaleAIChat({ 
    model: config.modelName 

}) // export the AI instance for use in other modules like the Minecraft bot
// ─── Voice helpers ────────────────────────────────────────────────────────────

const PYTHON_BIN   = process.env.PYTHON_BIN   || "python3"
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || "edge-tts"

const guildPlayers = new Map()  // guildId → { player, isProcessing }

export async function transcribe(audioPath) {
    return new Promise((resolve, reject) => {
        const script = `
from faster_whisper import WhisperModel
model = WhisperModel('small', device='cuda', compute_type='int8')
segments, _ = model.transcribe(r'${audioPath}')
print(' '.join(s.text for s in segments).strip())
`
        const py = spawn(PYTHON_BIN, ["-c", script])
        let out = "", err = ""
        py.stdout.on("data", d => out += d)
        py.stderr.on("data", d => err += d)
        py.on("close", code => {
            if (code !== 0) return reject(new Error(`Whisper failed: ${err.trim()}`))
            resolve(out.trim())
        })
    })
}
export async function speak(text) {
    const outPath = join(tmpdir(), `lily_${randomUUID()}.wav`)
    return new Promise((resolve, reject) => {
        const py = spawn(PYTHON_BIN, [
            process.env.STYLETTS2_SCRIPT,
            "--text", text,
            "--ref",  process.env.VOICE_SAMPLE_PATH,
            "--out",  outPath,
            "--model_dir", process.env.STYLETTS2_MODEL_DIR ?? "./models",
        ])
        let err = ""
        py.stderr.on("data", d => err += d)
        py.on("close", code => {
            if (code !== 0) return reject(new Error(`StyleTTS2 failed: ${err.trim()}`))
            resolve(outPath)
        })
    })
}
function sanitizeInput(text) {
    return text
        .replace(/[:;=8][\-o\*\']?[\)\]\(\[dDpP\/\:\}\{@\|\\]/gi, "")
        .replace(/[\)\]\(\[dDpP\/\:\}\{@\|\\][\-o\*\']?[:;=8]/gi, "")
        .replace(/[(\[{╰╯][\s\S]{0,20}?[)\]}]/g, "")
        .replace(/[✿♡♥❤★☆♪♫•·°~∿≈]/g, "")
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
        .replace(/[\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\u{FE00}-\u{FEFF}]/gu, "")
        .replace(/[~\^*]{2,}/g, "")
        .replace(/\s+/g, " ")
        .replace(/\\/g, "")
        .replace(/'/g, " ")
        .trim()
}

// export async function speak(text) {
//     const clean   = sanitizeInput(text)
//     const escaped = clean.replace(/'/g, "\\'").replace(/"/g, '\\"')
//     const wavPath = "/tmp/lily_response.wav"
//     const oggPath = "/tmp/lily_response.ogg"
//     await execAsync(`${EDGE_TTS_BIN} --text "${escaped}" --voice en-US-AnaNeural --write-media ${wavPath}`)
//     await execAsync(`ffmpeg -y -i ${wavPath} -c:a libopus ${oggPath}`)
//     fs.unlink(wavPath, () => { })
//     return oggPath
// }

export async function playInGuild(guildId, text) {
    const state = guildPlayers.get(guildId)
    if (!state) return
    if (state.isProcessing) {
        console.log("🔇 [VOICE] Skipping — already processing audio")
        return
    }
    state.isProcessing = true
    const audioPath = await speak(text)
    const resource  = createAudioResource(audioPath)
    state.player.play(resource)
    state.player.once(AudioPlayerStatus.Idle, () => {
        state.isProcessing = false
        fs.unlink(audioPath, () => { })
    })
}

// ─── Shared reply helpers ─────────────────────────────────────────────────────

// normalizes reply to { text, gifUrl } whether ollama returned a string or object
function parseReply(reply) {
    if (typeof reply === "object" && reply !== null) return reply
    return { text: reply ?? "", gifUrl: null }
}

async function sendReply(message, reply) {
    const { text, gifUrl } = parseReply(reply)
    const clean = text.replace(/\/\w+.*$/s, "").trim()
    await message.reply({
        content: clean || undefined,
        files:   gifUrl ? [{ attachment: gifUrl, name: "lily.gif" }] : []
    })
    if (guildPlayers.has(message.guild.id) && clean) {
        await playInGuild(message.guild.id, clean)
    }
}

async function sendNoReply(message, reply) {
    const { text, gifUrl } = parseReply(reply)
    const clean = text.replace(/\/\w+.*$/s, "").trim()
    await message.channel.send({
        content: clean || undefined,
        files:   gifUrl ? [{ attachment: gifUrl, name: "lily.gif" }] : []
    })
    if (guildPlayers.has(message.guild.id) && clean) {
        await playInGuild(message.guild.id, clean)
    }
}

// ─── Voice listening ──────────────────────────────────────────────────────────

function listenAndTranscribe(connection, userId) {
    return new Promise((resolve, reject) => {
        const receiver    = connection.receiver
        const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        })

        const sessionId  = `${userId}_${Date.now()}`
        const pcmPath    = `/tmp/lily_input_${sessionId}.pcm`
        const wavPath    = `/tmp/lily_input_${sessionId}.wav`

        const decoder    = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
        const fileStream = fs.createWriteStream(pcmPath)

        decoder.on("error",     err => console.warn(`[VOICE] Opus decode error for ${userId}:`, err.message))
        audioStream.on("error", err => console.warn(`[VOICE] Audio stream error for ${userId}:`, err.message))

        audioStream.pipe(decoder).pipe(fileStream)

        audioStream.once("end", async () => {
            fileStream.end()
            try {
                await execAsync(`ffmpeg -y -f s16le -ar 48000 -ac 1 -i ${pcmPath} -af "adelay=400|400" ${wavPath}`)
                fs.unlink(pcmPath, () => { })
                resolve(wavPath)
            } catch (err) {
                fs.unlink(pcmPath, () => { })
                reject(err)
            }
        })
    })
}

// ─── Voice session ────────────────────────────────────────────────────────────

export function startVoiceSession(connection, guild, channelId) {
    const player = createAudioPlayer()
    connection.subscribe(player)
    guildPlayers.set(guild.id, { player, isProcessing: false })
    console.log("🔊 [VOICE] Audio player subscribed")

    const processingUsers = new Set()
    const speakingTimers  = new Map()

    connection.receiver.speaking.on("start", async (userId) => {
        const member = guild.members.cache.get(userId)
        if (!member || member.user.bot) return
        if (processingUsers.has(userId)) return

        if (speakingTimers.has(userId)) clearTimeout(speakingTimers.get(userId))

        const timer = setTimeout(async () => {
            speakingTimers.delete(userId)
            if (processingUsers.has(userId)) return
            processingUsers.add(userId)

            const memberName = member.displayName
            console.log(`🎙️ [VOICE] Processing audio from ${memberName}...`)

            try {
                const prefs = getPrefs(userId)
                if (!prefs.voiceProcess) return

                const wavPath    = await listenAndTranscribe(connection, userId)
                const transcript = await transcribe(wavPath)
                fs.unlink(wavPath, () => { })

                if (!transcript || transcript.length < 2) return

                const normalized = transcript.toLowerCase().replace(/[^a-z\s]/g, "").trim()
                console.log(`📝 [STT] ${memberName} said: "${normalized}"`)

                const words       = normalized.split(" ")
                const hasWakeWord = words.some(w =>
                    w === "lily" || w === "lili" || w === "really" || w === "lillie" || w === "lele"
                )

                if (!hasWakeWord) {
                    if (prefs.wakeWordRequired) return
                    if (Math.random() > 0.15) return
                }

                const formattedMessage = hasWakeWord
                    ? `[${memberName}] says to you: ${transcript}`
                    : `[${memberName}] said nearby: ${transcript}`

                const reply = await ai.chat(channelId, formattedMessage)
                // voice can't send files, just play the text
                const { text } = parseReply(reply)
                const clean = text.replace(/\/\w+.*$/s, "").trim()
                await playInGuild(guild.id, clean || text)
            } catch (err) {
                console.error("Voice pipeline error:", err)
            } finally {
                processingUsers.delete(userId)
            }
        }, 150)

        speakingTimers.set(userId, timer)
    })

    connection.on("stateChange", (_, newState) => {
        if (newState.status === "destroyed") {
            guildPlayers.delete(guild.id)
            speakingTimers.forEach(t => clearTimeout(t))
            speakingTimers.clear()
        }
    })

    return player
}

// ─── Bot setup ────────────────────────────────────────────────────────────────

export async function createBot() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
        ],
    })

    client.once("clientReady", async () => {
        await initLogChannel(client)
    })

    client.commands = new Collection()

    const commandsPath = path.join(__dirname, "commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"))
    for (const file of commandFiles) {
        const command = await import(`./commands/${file}`)
        client.commands.set(command.data.name, command)
    }

    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand()) return
        const command = client.commands.get(interaction.commandName)
        if (!command) return
        try {
            await command.execute(interaction)
        } catch (error) {
            console.error(error)
            await interaction.reply({ content: "Error executing command", ephemeral: true })
        }
    })

    client.on("messageCreate", async message => {
        let authorName = ""

        if (message.author.bot) {
            if (message.author.displayName === "Coolade") {
                if (message.content.includes("pikarohan")) return
                const match = message.content.match(/](.*)»/m)
                if (match?.[1]) authorName = sanitizeInput(match[1].trim())
            } else return
        } else {
            authorName = sanitizeInput(message.member.displayName)
        }

        if (!authorName || authorName === "pikarohan") return

        const channelId    = message.channel.id
        const isMentioned  = message.mentions.has(client.user) || message.content.includes("<@&1473317878785773684>")
        const isReplyToBot = message.reference?.messageId
            ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id
            : false

        const userInput = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`, "")
            .trim()

        // ── Always push to raw buffer first ──
        if (userInput) ai.pushRawMessage(channelId, authorName, userInput)

        // ─── Spontaneous butt-in ──────────────────────────────────────────────
        if (!isMentioned && !isReplyToBot) {
            ai.observe(`${authorName} said ${userInput}`)

            if (Math.random() < 0.03) {
                const prefs = getPrefs(message.author.id)
                if (prefs.spontaneousReplies) {
                    try {
                        await message.channel.sendTyping()
                        const reply = await ai.buttIn(channelId, `${authorName} said: ${userInput}`)
                        if (reply) {
                            if (prefs.pingOnSpontaneous) {
                                await sendReply(message, reply)
                            } else {
                                await sendNoReply(message, reply)
                            }
                        }
                    } catch (err) {
                        console.error("Butt in handler error:", err)
                    }
                }
            }
            return
        }

        // ─── Voice message handler ────────────────────────────────────────────
        if (isReplyToBot) {
            const audioAttachment = message.attachments.find(a =>
                a.contentType?.startsWith("audio/") ||
                a.name?.endsWith(".ogg") ||
                a.name?.endsWith(".mp3") ||
                a.name?.endsWith(".wav")
            )

            if (audioAttachment) {
                await message.channel.sendTyping()
                try {
                    const res        = await fetch(audioAttachment.url)
                    const tmpInPath  = `/tmp/lily_voicemsg_${message.id}.ogg`
                    const tmpWavPath = `/tmp/lily_voicemsg_${message.id}.wav`
                    fs.writeFileSync(tmpInPath, Buffer.from(await res.arrayBuffer()))

                    await execAsync(`ffmpeg -y -i ${tmpInPath} ${tmpWavPath}`).catch(() => { })
                    fs.unlink(tmpInPath, () => { })

                    const transcript = await transcribe(tmpWavPath)
                    fs.unlink(tmpWavPath, () => { })

                    if (!transcript || transcript.length < 2) {
                        await message.reply("I couldn't make out what you said! 🍓")
                        return
                    }

                    console.log(`📝 [VOICE MSG] ${authorName} said: "${transcript}"`)
                    const reply      = await ai.chat(channelId, `[${authorName}] says to you in a voice message: ${transcript}`)
                    const { text }   = parseReply(reply)
                    const cleanReply = text.replace(/\/\w+.*$/s, "").trim()

                    const oggPath = await speak(cleanReply)
                    await message.reply({
                        content: `💬 *"${cleanReply}"*`,
                        files:   [{ attachment: oggPath, name: "lily_response.ogg" }]
                    })
                    fs.unlink(oggPath, () => { })

                    if (guildPlayers.has(message.guild.id)) {
                        await playInGuild(message.guild.id, cleanReply)
                    }
                } catch (err) {
                    console.error("Voice message handler error:", err)
                    await message.reply("Something went wrong processing your voice message, sowwy! 🍓")
                }
                return
            }
        }

        // ─── Direct mention handler ───────────────────────────────────────────
        if (!userInput) {
            await message.reply("Yes? 🍓")
            return
        }

        let formattedMessage = ""

        if (message.reference?.messageId) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId)
                if (referenced) {
                    if (referenced.author.id === client.user.id) {
                        formattedMessage = `[${authorName}] says to you: ${userInput}`
                    } else {
                        const repliedUser = referenced.member?.displayName || referenced.author.username
                        const quoted      = referenced.content?.replace(/\n/g, " ").slice(0, 120)
                        formattedMessage  = `[${authorName}] says to you, replying to ${repliedUser} who said "${quoted}": ${userInput}`
                    }
                }
            } catch { }
        }

        if (!formattedMessage && message.mentions.users.size > 1) {
            const mentionedUsers = message.mentions.users
                .filter(u => u.id !== client.user.id)
                .map(u => message.guild.members.cache.get(u.id)?.displayName || u.username)
            if (mentionedUsers.length > 0) {
                formattedMessage = `[${authorName}] mentioned ${mentionedUsers.join(", ")}, ${authorName} says to you: ${userInput}`
            }
        }

        if (!formattedMessage) {
            formattedMessage = `[${authorName}] says to you: ${userInput}`
        }

        await message.channel.sendTyping()
        try {
            const reply = await ai.chat(channelId, formattedMessage)
            await sendReply(message, reply)
        } catch (err) {
            console.error("Ping handler error:", err)
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}