// modules/index.js — every toggleable module. Add a new one by adding an entry here.
// Tool-bearing modules attach their executor to ai.tools in start() and detach it in stop(),
// so a stopped module has no tools, no connections and no ports — not just hidden tools.
import { spawn } from 'node:child_process'
import { Logger } from '../utils/Logger.js'
import { getOwnerId } from '../ai/config.js'
import { VOICE_ASSISTANT_CHANNEL } from '../ai/tools/toolRouter.js'
import { approvalStore } from '../ai/tools/riskyActionsManagement/approvalStore.js'
import { MinecraftToolExecutor } from '../ai/tools/minecraftTools.js'
import { VtubeToolExecutor } from '../ai/tools/vtubeTools.js'
import { VrchatToolExecutor } from '../ai/tools/vrchatTools.js'
import { BrowserToolExecutor } from '../ai/tools/browserTools.js'

const closeServer = server => new Promise(resolve => server.close(resolve))
const call = (path, fn, ...args) => import(path).then(m => m[fn](...args))
const discordClient = ctx => ctx.handle('discord')?.client ?? null
const DUEL_REPLY = "Lily is currently in a duel, she can't reply right now!"

// A tool group of the shared STTS executor (screenshot / input / pidev / coding).
const sttsGroup = (name, label, flag) => ({
    name, label, flag,
    start: ({ ai }) => ai.tools.sttsSet(name, true),
    stop: (_, { ai }) => ai.tools.sttsSet(name, false),
})

function minecraft(name, label, flag, other, load) {
    return {
        name, label, flag, conflicts: [other],
        async start(ctx) {
            const { ai, runConfig } = ctx
            const mod = await load(ctx, { ...runConfig, backend: name === 'minecraft-modded' ? 'modded' : 'mineflayer' })
            ai.tools.attach('minecraft', new MinecraftToolExecutor(null, mod.getStateController), { channels: ['minecraft'] })
            return mod
        },
        stop(mod, { ai }) {
            ai.tools.detach('minecraft')
            ai.setStateController(null)
            ai.setReplyGate(null)
            mod.stopMinecraftBot()
        },
    }
}

let discordBot = null // createBot() registers its event handlers once; later starts only log in again

export const MODULES = [
    {
        name: 'discord', label: 'Discord', flag: 'discord',
        async start({ ai }) {
            const { config } = await import('../utils/config.js')
            discordBot ??= await import('../discord/bot.js').then(m => m.createBot({ ai }))
            const client = discordBot
            await new Promise((resolve, reject) => {
                client.once('clientReady', resolve)
                client.login(config.token).catch(reject)
            })
            Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")

            // Risky-command approvals are announced in the channel that triggered them.
            const onCreated = ({ instruction, channelId, matched }) =>
                client.channels.fetch(channelId)
                    .then(ch => ch.send(`⚠️ Risky command flagged ("${matched}"): ${instruction}\nApprove/deny it from the control panel dashboard.`))
                    .catch(e => Logger.error(`Approval notify failed: ${e.message}`, "APPROVAL"))
            approvalStore.on('created', onCreated)
            return { client, off: () => approvalStore.off('created', onCreated) }
        },
        async stop({ client, off }) {
            off()
            await client.destroy()
        },
    },
    {
        name: 'stts', label: 'Speech-to-Text + Voice Assistant', flag: 'stts',
        async start(ctx) {
            const stts = await import('../STTS/index.js')
            await stts.start()
            const { startVoiceAssistant } = await import('../voiceAssistant/index.js')
            return { stts, voice: startVoiceAssistant({ ai: ctx.ai, getDiscordClient: () => discordClient(ctx) }) }
        },
        async stop({ stts, voice }) {
            await voice.stop()
            await stts.stop()
        },
    },
    sttsGroup('screenshot', 'Screenshot tool', 'stts'),
    sttsGroup('input', 'Typing, keys & clipboard tools', 'stts'),
    {
        ...sttsGroup('pidev', 'Pi-dev / system commands', 'pidev'),
        async start({ ai }) {
            const server = await call('../pidev-bridge/pidev-bridge.js', 'startPidevBridge')
            ai.tools.sttsSet('pidev', true)
            return server
        },
        async stop(server, { ai }) {
            ai.tools.sttsSet('pidev', false)
            await closeServer(server)
        },
    },
    {
        ...sttsGroup('coding', 'VSCode editing + coding bridge', 'coding'),
        async start({ ai }) {
            const bridge = await call('../coding/continue-bridge.js', 'startContinueBridge', ai)
            const tavily = spawn(process.execPath, ['./src/coding/tavily-mcp-server.js'], { stdio: 'pipe', env: process.env })
            tavily.on('exit', (code, signal) => Logger.warning(`Tavily MCP server exited (code ${code}, signal ${signal})`, "TAVILY"))
            tavily.on('error', err => Logger.error(`Tavily MCP server failed to spawn: ${err.message}`, "TAVILY"))
            tavily.stderr?.on('data', data => Logger.error(`Tavily MCP stderr: ${data}`, "TAVILY"))
            ai.tools.sttsSet('coding', true)
            return { bridge, tavily }
        },
        async stop({ bridge, tavily }, { ai }) {
            ai.tools.sttsSet('coding', false)
            tavily.kill()
            await closeServer(bridge)
        },
    },
    {
        name: 'browser', label: 'Browser control', flag: 'browser',
        async start({ ai }) {
            const handle = await call('../browser/bridge.js', 'startBrowserBridge')
            ai.tools.attach('browser', new BrowserToolExecutor(handle.client), { channels: [VOICE_ASSISTANT_CHANNEL], voiceOnly: true })
            return handle
        },
        stop({ client, process: proc }, { ai }) {
            ai.tools.detach('browser')
            client?.close()
            proc?.kill?.()
        },
    },
    {
        name: 'vtube', label: 'VTube Studio', flag: 'vtube',
        async start({ ai }) {
            const { VTSClient } = await import('../vtubing/VTSClient.js')
            const client = new VTSClient({
                host: process.env.VTS_HOST || 'localhost',
                port: parseInt(process.env.VTS_PORT || '8001'),
                pluginName: process.env.VTS_PLUGIN_NAME || 'LilyVTS',
                pluginDev: process.env.VTS_PLUGIN_DEV || 'Izan',
            })
            await client.connect()
            const exec = new VtubeToolExecutor(client)
            ai.tools.attach('vtube', exec)
            // Pick up hotkeys added/renamed in VTS; drop the client if VTS closes so tools fail cleanly.
            const refresh = setInterval(() => exec.refreshExpressions(), 60_000)
            client.ws?.once('close', () => exec.setVtsClient(null))
            return { client, refresh }
        },
        stop({ client, refresh }, { ai }) {
            clearInterval(refresh)
            ai.tools.detach('vtube')
            return client.disconnect().catch(() => { })
        },
    },
    {
        name: 'youtube', label: 'YouTube live chat', flag: 'vtube',
        async start({ ai }) {
            const { YouTubeLiveChatClient } = await import('../vtubing/youtube/liveClient.js')
            const { YouTubeChatBuffer } = await import('../vtubing/youtube/chatBuffer.js')
            const buffer = new YouTubeChatBuffer(ai)
            const client = new YouTubeLiveChatClient({ onMessage: (author, text) => buffer.push(author, text) })
            try {
                await client.start()
            } catch (err) {
                const data = err.response?.data
                throw new Error(`HTTP ${err.response?.status ?? 'unknown'} | ${data?.error?.errors?.[0]?.reason ?? 'unknown'} | ${data?.error?.message ?? err.message}`)
            }
            return { client, buffer }
        },
        stop: ({ client, buffer }) => { client.stop(); buffer.stop() },
    },
    minecraft('minecraft-modded', 'Minecraft (NeoForge mod)', 'modded', 'minecraft-mineflayer', async ({ ai, handle }, runConfig) => {
        const mod = await import('../minecraft/neoforgemod-way/bot.js')
        mod.startMinecraftBot({
            port: parseInt(process.env.MC_BRIDGE_PORT ?? '8766'),
            ai, runConfig, vtsClient: handle('vtube')?.client ?? null,
        })
        // The duel state lives in the NeoForge bot; Lily only sees these hooks.
        ai.setStateController(mod.getStateController)
        ai.setReplyGate(() => mod.getStateController()?.currentStateName === 'DUELING' ? DUEL_REPLY : null)
        return mod
    }),
    minecraft('minecraft-mineflayer', 'Minecraft (Mineflayer)', 'mineflayer', 'minecraft-modded', async ({ ai, handle }, runConfig) => {
        const mod = await import('../minecraft/mineflayer/index.js')
        mod.startMinecraftBot({
            host: process.env.MC_SERVER_HOST ?? 'localhost',
            port: parseInt(process.env.MC_SERVER_PORT ?? '25565'),
            username: process.env.MC_BOT_USERNAME ?? 'SillyLily_',
            followTarget: process.env.MC_FOLLOW_TARGET ?? 'shinyshadow_',
            ai, runConfig, vtsClient: handle('vtube')?.client ?? null,
        })
        return mod
    }),
    {
        name: 'vrchat', label: 'VRChat', flag: 'vrchat',
        async start({ ai }) {
            const bot = await call('../vrchatBot/index.js', 'startVrchatBot', { ai })
            ai.tools.attach('vrchat', new VrchatToolExecutor(), { channels: ['vrchat'] })
            return bot
        },
        stop(bot, { ai }) {
            ai.tools.detach('vrchat')
            return bot.stop?.()
        },
    },
    {
        name: 'n8n', label: 'n8n bridge + triggers', flag: 'n8n',
        async start() {
            const triggers = await call('../n8n/loadTriggers.js', 'startTriggerServer')
            const bridge = await call('../n8n/n8n-bridge.js', 'startN8nBridge')
            return { triggers, bridge }
        },
        stop: ({ triggers, bridge }) => Promise.all([closeServer(triggers), closeServer(bridge)]),
    },
    {
        name: 'notify', label: 'n8n Discord notifications', flag: 'n8n', needs: ['n8n', 'discord'],
        start: ctx => call('../n8n/discordNotify.js', 'startNotifyServer', discordClient(ctx), getOwnerId(), 3300),
        stop: closeServer,
    },
]
