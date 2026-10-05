// start.js — composition root: builds Lily, then starts/stops every enabled service.
import 'dotenv/config'
import { createBot } from './discord/bot.js'
import { config } from './utils/config.js'
import { getOwnerId } from './ai/config.js'
import { Logger } from './utils/Logger.js'
import { parseFlags, getRunConfig, lilyOptionsFor } from './startUtils.js'
import * as stts from './STTS/index.js'
import { startVoiceAssistant } from './voiceAssistant/index.js'
import { Lily } from './ai/Lily.js'
import { startTriggerServer } from './n8n/loadTriggers.js'
import { startControlPanel } from './controlPanel/server.js'

let runConfig
try {
    runConfig = getRunConfig()
} catch (err) {
    Logger.error(err.message, "STARTUP")
    process.exit(1)
}
const { backend } = runConfig
const flags = parseFlags()
if (flags.has('bending') && backend !== 'modded') {
    Logger.warning("'bending' flag has no effect without 'modded' - ignoring", "STARTUP")
}

const ai = new Lily(lilyOptionsFor(runConfig))

// Shared state services read from. Discord connects asynchronously, so `discord` fills in later.
const ctx = { ai, runConfig, discord: null, vts: null, mc: null }

const closeServer = server => new Promise(resolve => server.close(resolve))
const importAndCall = (path, fn, ...args) => import(path).then(m => m[fn](...args))
const DUEL_REPLY = "Lily is currently in a duel, she can't reply right now!"
const CONTROL_PANEL_ENV = ['CP_USERNAME', 'CP_PASSWORD_HASH', 'CP_SESSION_SECRET']

/**
 * name:    log tag
 * label:   banner text (omit to keep a service out of the banner)
 * phase:   'early' starts before Discord logs in, 'ready' once it has (or right away without Discord)
 * enabled: (runConfig, ctx) => boolean
 * needs:   name of a service that must have started
 * start:   (ctx) => handle (null/undefined = nothing to track)
 * stop:    (handle, ctx) => void | Promise
 * Services stop in reverse start order.
 */
const SERVICES = [
    {
        name: 'CONTROL PANEL', phase: 'early',
        enabled: () => CONTROL_PANEL_ENV.every(k => process.env[k]),
        start: ({ ai }) => startControlPanel(ai, {
            port: parseInt(process.env.CP_PORT ?? '4210'),
            username: process.env.CP_USERNAME,
            passwordHash: process.env.CP_PASSWORD_HASH,
            sessionSecret: process.env.CP_SESSION_SECRET,
            trustProxy: process.env.CP_HTTPS === 'true',
        }) ?? true,
    },
    {
        name: 'STTS', label: 'Speech-to-Text (STT) + Voice Assistant', phase: 'early',
        enabled: rc => rc.stts,
        start: async () => { await stts.start(); return true },
        stop: () => stts.stop(),
    },
    {
        name: 'VOICE', phase: 'early', needs: 'STTS',
        enabled: rc => rc.stts,
        start: ({ ai }) => startVoiceAssistant({ ai, getDiscordClient: () => ctx.discord }),
        stop: voice => voice.stop(),
    },
    {
        name: 'VTUBE', label: 'VTube Studio', phase: 'ready',
        enabled: rc => rc.vtube,
        async start({ ai }) {
            const { VTSClient } = await import('./vtubing/VTSClient.js')
            const client = new VTSClient({
                host: process.env.VTS_HOST || 'localhost',
                port: parseInt(process.env.VTS_PORT || '8001'),
                pluginName: process.env.VTS_PLUGIN_NAME || 'LilyVTS',
                pluginDev: process.env.VTS_PLUGIN_DEV || 'Izan',
            })
            await client.connect()
            ai.setVtsClient(client)
            ctx.vts = client
            return client
        },
        stop: client => client.disconnect().catch(() => { }),
    },
    {
        name: 'YOUTUBE', phase: 'ready',
        enabled: rc => rc.vtube,
        async start({ ai }) {
            const { YouTubeLiveChatClient } = await import('./vtubing/youtube/liveClient.js')
            const { YouTubeChatBuffer } = await import('./vtubing/youtube/chatBuffer.js')
            const buffer = new YouTubeChatBuffer(ai)
            const client = new YouTubeLiveChatClient({ onMessage: (author, text) => buffer.push(author, text) })
            try {
                await client.start()
            } catch (err) {
                const data = err.response?.data
                Logger.error(
                    `YouTube chat failed: HTTP ${err.response?.status ?? 'unknown'} | ` +
                    `${data?.error?.errors?.[0]?.reason ?? 'unknown'} | ${data?.error?.message ?? err.message}`,
                    "YOUTUBE")
                return null
            }
            return { client, buffer }
        },
        stop: ({ client, buffer }) => { client.stop(); buffer.stop() },
    },
    {
        name: 'MINECRAFT', phase: 'ready',
        label: 'Minecraft', offText: 'None',
        detail: rc => rc.backend === 'mineflayer' ? 'Mineflayer' : 'Modded (NeoForge)',
        enabled: rc => !!rc.backend,
        async start({ ai, vts, runConfig }) {
            let mod, bot
            if (runConfig.backend === 'mineflayer') {
                mod = await import('./minecraft/mineflayer/index.js')
                bot = await mod.startMinecraftBot({
                    host: process.env.MC_SERVER_HOST ?? "localhost",
                    port: parseInt(process.env.MC_SERVER_PORT ?? "25565"),
                    username: process.env.MC_BOT_USERNAME ?? "SillyLily_",
                    followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
                    ai, vtsClient: vts, runConfig,
                })
            } else {
                mod = await import('./minecraft/neoforgemod-way/bot.js')
                bot = await mod.startMinecraftBot({
                    host: process.env.MC_BRIDGE_HOST ?? "localhost",
                    port: parseInt(process.env.MC_BRIDGE_PORT ?? "8766"),
                    ai, vtsClient: vts, runConfig,
                })
                // The duel state lives in the NeoForge bot; Lily only sees these hooks.
                ai.setStateController(mod.getStateController)
                ai.setReplyGate(() => mod.getStateController()?.currentStateName === 'DUELING' ? DUEL_REPLY : null)
            }
            if (bot?.mcSend) ai.setMcSend(bot.mcSend)
            ctx.mc = bot
            return bot
        },
    },
    {
        name: 'SURVIVAL', phase: 'ready', needs: 'MINECRAFT',
        enabled: rc => rc.backend === 'modded',
        async start({ mc }) {
            if (!mc?.stateController) return null
            const { startSurvivalLoop } = await import('./minecraft/neoforgemod-way/state-machine/helpers/survivalLoop.js')
            return startSurvivalLoop(
                mc.stateController, mc.mcSend, mc.mcChat,
                process.env.OLLAMA_URL ?? "http://localhost:11435", runConfig, ctx.vts)
        },
        stop: loop => loop.stop?.(),
    },
    {
        name: 'N8N TRIGGERS', phase: 'ready',
        enabled: rc => rc.n8n,
        start: () => startTriggerServer(),
        stop: closeServer,
    },
    {
        name: 'VRCHAT', label: 'VRChat', phase: 'ready',
        enabled: rc => rc.vrchat,
        start: ({ ai }) => importAndCall('./vrchatBot/index.js', 'startVrchatBot', { ai }),
        stop: bot => bot.stop?.(),
    },
    {
        name: 'CODING', label: 'Continue.dev coding bridge', phase: 'ready',
        enabled: rc => rc.coding,
        start: ({ ai }) => importAndCall('./coding/continue-bridge.js', 'startContinueBridge', ai),
        stop: closeServer,
    },
    {
        name: 'TAVILY', label: 'Tavily MCP server', phase: 'ready',
        enabled: rc => rc.coding,
        async start() {
            const { spawn } = await import('node:child_process')
            const child = spawn(process.execPath, ['./src/coding/tavily-mcp-server.js'], { stdio: 'pipe', env: process.env })
            child.on('exit', (code, signal) => Logger.warning(`Tavily MCP server exited (code ${code}, signal ${signal})`, "TAVILY"))
            child.on('error', err => Logger.error(`Tavily MCP server failed to spawn: ${err.message}`, "TAVILY"))
            child.stderr?.on('data', data => Logger.error(`Tavily MCP stderr: ${data}`, "TAVILY"))
            return child
        },
        stop: child => child.kill(),
    },
    {
        name: 'BROWSER', label: 'Browser control bridge', phase: 'ready',
        enabled: rc => rc.browser,
        async start({ ai }) {
            const handle = await importAndCall('./browser/bridge.js', 'startBrowserBridge')
            if (handle?.client) ai.setBrowserClient(handle.client)
            return handle
        },
        stop: ({ client, process: proc }) => { client?.close(); proc?.kill?.() },
    },
    {
        name: 'PIDEV', label: 'Pi-dev bridge', phase: 'ready',
        enabled: rc => rc.pidev,
        start: () => importAndCall('./pidev-bridge/pidev-bridge.js', 'startPidevBridge'),
        stop: closeServer,
    },
    {
        name: 'N8N', label: 'n8n bridge + notification hook', phase: 'ready',
        enabled: rc => rc.n8n,
        start: () => importAndCall('./n8n/n8n-bridge.js', 'startN8nBridge'),
        stop: closeServer,
    },
    {
        name: 'APPROVAL', phase: 'ready',
        enabled: (_rc, { discord }) => !!discord,
        start({ ai, discord }) {
            const post = async (channelId, text) => {
                const channel = await discord.channels.fetch(channelId)
                return channel.send(text)
            }
            ai.setApprovalCallbacks({
                onApprovalNeeded: ({ instruction, channelId, matched }) =>
                    post(channelId, `⚠️ Risky command flagged ("${matched}"): ${instruction}\nApprove/deny it from the control panel dashboard.`)
                        .catch(e => Logger.error(`Approval notify failed: ${e.message}`, "APPROVAL")),
                onApprovalResult: ({ channelId, instruction, approved, report, error, reason }) => {
                    const text = !approved ? `❌ Declined (${reason}): ${instruction.slice(0, 150)}`
                        : error ? `⚠️ Approved but it failed: ${error}`
                            : `✅ Done: ${report || 'no output'}`
                    return post(channelId, text).catch(e => Logger.error(`Approval result post failed: ${e.message}`, "APPROVAL"))
                },
            })
            return true
        },
    },
    {
        name: 'NOTIFY', phase: 'ready',
        enabled: (rc, { discord }) => rc.n8n && !!discord,
        start: ({ discord }) => importAndCall('./n8n/discordNotify.js', 'startNotifyServer', discord, getOwnerId(), 3300),
        stop: closeServer,
    },
]

const running = []   // { svc, handle }, in start order

function logBanner() {
    Logger.info(`Starting with flags: ${[...flags].join(', ') || '(none)'}`, "STARTUP")
    Logger.info(`  • Discord: ${flags.has('discord') ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
    for (const svc of SERVICES) {
        if (!svc.label) continue
        const on = svc.enabled(runConfig, ctx)
        const text = on ? (svc.detail?.(runConfig) ?? '✅ Enabled') : (svc.offText ?? '❌ Disabled')
        Logger.info(`  • ${svc.label}: ${text}`, "STARTUP")
    }
    if (!SERVICES.find(s => s.name === 'CONTROL PANEL').enabled()) {
        Logger.warning(`Control panel not started — missing ${CONTROL_PANEL_ENV.join(' / ')} in .env`, "CONTROL PANEL")
    }
    if (!runConfig.discord && !backend && !runConfig.vrchat && !runConfig.stts) {
        Logger.warning('No Discord, no Minecraft, no VRChat bridge, and no STTS active - there is nothing for this process to do', "STARTUP")
    }
}

async function startServices(phase) {
    for (const svc of SERVICES) {
        if (svc.phase !== phase || !svc.enabled(runConfig, ctx)) continue
        if (svc.needs && !running.some(r => r.svc.name === svc.needs)) continue
        try {
            const handle = await svc.start(ctx)
            if (handle == null) continue
            running.push({ svc, handle })
            Logger.success(`${svc.label ?? svc.name} started`, svc.name)
        } catch (err) {
            Logger.error(`${svc.label ?? svc.name} failed to start: ${err.stack ?? err.message}`, svc.name)
        }
    }
}

async function shutdown(signal) {
    Logger.info(`Shutting down (${signal})...`, "SHUTDOWN")
    for (const { svc, handle } of running.reverse()) {
        try { await svc.stop?.(handle, ctx) } catch (err) {
            Logger.error(`${svc.name} failed to stop: ${err.message}`, "SHUTDOWN")
        }
    }
    await ctx.discord?.destroy()
    process.exit(0)
}

async function main() {
    try {
        logBanner()
        await startServices('early')

        if (runConfig.discord) {
            const client = ctx.discord = await createBot({ ai })
            client.once("clientReady", async () => {
                Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")
                await startServices('ready')
            })
            await client.login(config.token)
        } else {
            Logger.info("'discord' flag not set - skipping Discord login", "STARTUP")
            await startServices('ready')
        }

        process.on('SIGINT', () => shutdown('SIGINT'))
        process.on('SIGTERM', () => shutdown('SIGTERM'))
        Logger.success('Bot started!', "MAIN")
    } catch (err) {
        Logger.error(`Failed to start: ${err.message}`, "MAIN")
        process.exit(1)
    }
}

main()