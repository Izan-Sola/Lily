import path from 'path'
import { fileURLToPath } from 'url'
import { createConfig } from '../config/loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
    survival: {
        mineflayer: { actionsIntervalMs: 20000, historyMaxTurns: 8 },
        modded: { actionsIntervalMs: 10000, historyMaxTurns: 4 },
        msgMinMs: 120000,
        msgMaxMs: 360000
    },
    combat: {
        attackRange: 2.5,
        moddedAttackCooldownMs: 625,
        mineflayerAttackIntervalMs: 650,
        tickMs: 150
    },
    duel: {
        maxBusyMs: 6000,
        maxNextPromptDelayMs: 8000,
        minPromptDelayMs: 2500,
        dataRequestIntervalMs: 500
    },
    combo: { swapLockMs: 100, defaultStepMs: 200, postActionGapMs: 100 },
    blockScanIntervalMs: 4000,
    messageSplitLength: 250
}

let source = null

function sourceFor(configPath) {
    const resolved = configPath ?? process.env.APP_CONFIG_PATH ?? path.join(__dirname, 'config.json')
    if (!source || source.file !== resolved) {
        source = Object.assign(createConfig(resolved, { defaults: DEFAULTS, name: 'minecraft/config.json' }), { file: resolved })
    }
    return source
}

/** Re-reads the runtime config (APP_CONFIG_PATH or ./config.json) over the defaults. */
export function loadAppConfig(configPath = null) {
    return sourceFor(configPath).reload()
}

export function getAppConfig() {
    return sourceFor(null).get()
}

/**
 * Resolves the survival-loop settings for a given backend.
 * Defaults to the "modded" backend unless MC_BACKEND is set.
 */
export function resolveSurvivalConfig(backend = null) {
    const cfg = getAppConfig()
    const s = cfg.survival ?? {}
    const resolved = backend
        ?? process.env.MC_BACKEND
        ?? 'modded'
    const backendCfg = s[resolved] ?? s.modded ?? DEFAULTS.survival.modded
    return {
        backend: resolved,
        actionsIntervalMs: backendCfg.actionsIntervalMs,
        historyMaxTurns: backendCfg.historyMaxTurns,
        msgMinMs: s.msgMinMs,
        msgMaxMs: s.msgMaxMs
    }
}