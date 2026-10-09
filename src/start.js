// start.js — composition root: builds Lily and the module manager, then boots the flagged modules.
// Flags (pm2 / convenience) only choose what starts at boot; the control panel can start/stop any module live.
import 'dotenv/config'
import { Logger } from './utils/Logger.js'
import { parseFlags, getRunConfig } from './startUtils.js'
import { Lily } from './ai/Lily.js'
import { ModuleManager } from './modules/manager.js'
import { MODULES } from './modules/index.js'
import { startControlPanel } from './controlPanel/server.js'

let runConfig
try {
    runConfig = getRunConfig()
} catch (err) {
    Logger.error(err.message, "STARTUP")
    process.exit(1)
}
const flags = parseFlags()
if (flags.has('bending') && runConfig.backend !== 'modded') {
    Logger.warning("'bending' flag has no effect without 'modded' - ignoring", "STARTUP")
}

const ai = new Lily()
const manager = new ModuleManager(MODULES, { ai, runConfig })

const CONTROL_PANEL_ENV = ['CP_USERNAME', 'CP_PASSWORD_HASH', 'CP_SESSION_SECRET']
const hasPanel = CONTROL_PANEL_ENV.every(k => process.env[k])

async function shutdown(signal) {
    Logger.info(`Shutting down (${signal})...`, "SHUTDOWN")
    await manager.stopAll()
    process.exit(0)
}

try {
    Logger.info(`Starting with flags: ${[...flags].join(', ') || '(none)'}`, "STARTUP")
    if (hasPanel) {
        startControlPanel(manager, {
            port: parseInt(process.env.CP_PORT ?? '4210'),
            username: process.env.CP_USERNAME,
            passwordHash: process.env.CP_PASSWORD_HASH,
            sessionSecret: process.env.CP_SESSION_SECRET,
            trustProxy: process.env.CP_HTTPS === 'true',
        })
    } else {
        Logger.warning(`Control panel not started — missing ${CONTROL_PANEL_ENV.join(' / ')} in .env`, "STARTUP")
    }

    await manager.startFlagged(flags)

    if (!manager.running.size && !hasPanel) {
        Logger.warning('No modules running and no control panel - there is nothing for this process to do', "STARTUP")
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    Logger.success('Bot started!', "MAIN")
} catch (err) {
    Logger.error(`Failed to start: ${err.message}`, "MAIN")
    process.exit(1)
}
