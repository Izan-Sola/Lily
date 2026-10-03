import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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

let cached = null

function deepMerge(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) return base
    const out = { ...base }
    for (const [key, value] of Object.entries(override)) {
        const baseVal = base[key]
        if (
            baseVal && value &&
            typeof baseVal === 'object' && !Array.isArray(baseVal) &&
            typeof value === 'object' && !Array.isArray(value)
        ) {
            out[key] = deepMerge(baseVal, value)
        } else {
            out[key] = value
        }
    }
    return out
}

/**
 * Loads the runtime config from disk (config.json at project root by default)
 * and merges it over the built-in defaults. Env var APP_CONFIG_PATH overrides
 * the file location. Safe to call multiple times.
 */
export function loadAppConfig(configPath = null) {
    const resolved = configPath
        ?? process.env.APP_CONFIG_PATH
        ?? path.join(__dirname, '.', 'config.json')

    let fileConfig = {}
    try {
        fileConfig = JSON.parse(fs.readFileSync(resolved, 'utf8'))
    } catch {
        // No config file on disk — fall back to defaults silently.
    }

    cached = deepMerge(DEFAULTS, fileConfig)
    return cached
}

export function getAppConfig() {
    if (!cached) loadAppConfig()
    return cached
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