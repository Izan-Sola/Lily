import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const SWAP_LOCK_TIME = 100
const DEFAULT_STEP_TIME = 200
const POST_ACTION_GAP = 100

let combosData = {}

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────

export function loadCombos() {
    try {
        const raw = fs.readFileSync(path.join(__dirname, '../states/data/PKCombosData.json'), 'utf8')
        combosData = JSON.parse(raw)
        console.log(`[COMBOS] Loaded ${combosData.combos?.length ?? 0} combos`)
    } catch (err) {
        console.error('[COMBOS] Failed to load PKCombosData.json:', err.message)
        combosData = { combos: [] }
    }
    return combosData
}

export function enrichCombosData(abilityStats) {
    for (const combo of getCombos()) {
        const stats = abilityStats[combo.name]
        if (stats) {
            combo.range = stats.range
            combo.cooldown = stats.cooldown
        }
    }
}

export function getCombos() {
    return combosData.combos ?? []
}

export function getComboByName(name) {
    return getCombos().find(c => c.name === name) ?? null
}

export function isComboAvailable(combo, bindings, cleanName) {
    const normalize = (s) => s.toLowerCase().trim().replace(/\s+/g, '')
    const availableAbilities = Object.values(bindings)
        .filter(Boolean)
        .map(raw => normalize(cleanName(raw)))

    return combo.bindsRequired.every(required =>
        availableAbilities.includes(normalize(required))
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// ABILITY → COMBO NORMALIZATION
//
// Converts an ability's abilityStats entry into the same shape as a combo
// object, so _everything_ can be routed through parseComboSteps + executeCombo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a single ability's stats into a minimal combo-shaped object.
 * The returned object is ephemeral — it is never stored in combosData.
 *
 * @param {string} abilityName
 * @param {object} stats  — the entry from ctx.abilityStats[abilityName]
 * @returns {{ name, actions, actionsTime, bindsRequired }}
 */
export function abilityAsCombo(abilityName, stats) {
    return {
        name: abilityName,
        actions: stats.actions ?? [],
        actionsTime: stats.actionTimes ?? [],
        bindsRequired: [abilityName],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP PARSING
// ─────────────────────────────────────────────────────────────────────────────

function findSlot(abilityName, bindings, cleanName) {
    for (const [slot, raw] of Object.entries(bindings)) {
        if (cleanName(raw) === abilityName) return parseInt(slot)
    }
    return null
}

/**
 * Parses a combo's actions array into a flat list of resolved steps,
 * each paired with its duration from actionsTime.
 *
 * Step shape:
 *   { type, mode?, direction?, ability?, blocking, duration, blocks?, distance?, degrees? }
 */
export function parseComboSteps(combo) {
    const actions = combo.actions ?? []
    const times = combo.actionsTime ?? []
    let timeIdx = 0
    const steps = []

    for (const actionStr of actions) {
        const parts = actionStr.split(':')
        const type = parts[0]

        switch (type) {

            // swap:slot:<AbilityName>
            case 'swap': {
                const duration = times[timeIdx++] ?? SWAP_LOCK_TIME
                steps.push({ type: 'swap', ability: parts[2], blocking: true, duration })
                break
            }

            // locklook  (non-blocking)
            case 'locklook': {
                const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
                steps.push({ type: 'locklook', blocking: false, duration })
                break
            }

            // source:<block1,block2,...>:<distance>  (non-blocking)
            case 'source': {
                const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
                const blocks = (parts[1] ?? '')
                    .split(',')
                    .map(b => b.trim().toLowerCase())
                    .filter(Boolean)
                const distance = parseInt(parts[2] ?? '0') || 0
                steps.push({ type: 'source', blocks, distance, blocking: false, duration })
                break
            }

            // stop  (non-blocking)
            case 'stop': {
                const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
                steps.push({ type: 'stop', blocking: false, duration })
                break
            }

            // wait  (blocking sleep)
            case 'wait': {
                const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
                steps.push({ type: 'wait', blocking: true, duration })
                break
            }

            // look:<direction>:<degrees>  (non-blocking)
            case 'look': {
                const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
                steps.push({
                    type: 'look',
                    direction: parts[1] ?? 'forward',
                    degrees: parseInt(parts[2] ?? '90') || 90,
                    blocking: false,
                    duration,
                })
                break
            }

            // Everything else: type:mode:count[:extra]
            default: {
                const mode = parts[1] ?? '*'
                const count = parseInt(parts[2] ?? '1') || 1
                const extra = parts[3]

                for (let c = 0; c < count; c++) {
                    const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME

                    switch (type) {
                        case 'click':
                            steps.push({ type: 'click', mode, blocking: true, duration })
                            break
                        case 'sneak':
                            steps.push({ type: 'sneak', mode, blocking: extra !== 'continue', duration })
                            break
                        case 'jump':
                            steps.push({ type: 'jump', blocking: true, duration })
                            break
                        case 'forward':
                        case 'back':
                        case 'left':
                        case 'right':
                            steps.push({ type: 'move', direction: type, blocking: true, duration })
                            break
                        default:
                            console.warn(`[COMBOS] Unknown action type "${type}" in combo "${combo.name}" — skipped`)
                            break
                    }
                }
                break
            }
        }
    }

    return steps
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a pre-parsed steps array sequentially.
 *
 * handlers:
 *   onSource(blocks, dist, ms)    — non-blocking; fire and forget
 *   onLockLook(ms)                — sync; sets look lock
 *   onForceMove(dir, ms)          — sync; starts forced movement
 *   onStop(lockMove)              — sync; stops movement
 *   onLookDir(dir, deg, ms)       — sync; offsets look tracking
 */
export async function executeCombo(combo, bindings, cleanName, mcSend, handlers = {}) {
    const { onSource, onLockLook, onForceMove, onStop, onLookDir } = handlers
    const steps = parseComboSteps(combo)

    for (const step of steps) {
        await executeStep(step, { bindings, cleanName, mcSend, onSource, onLockLook, onForceMove, onStop, onLookDir })
    }
}

/**
 * Executes a single parsed step.
 * Extracted so duelingState can route ability steps through the same logic.
 */
export async function executeStep(step, { bindings, cleanName, mcSend, onSource, onLockLook, onForceMove, onStop, onLookDir }) {
    switch (step.type) {

        case 'swap': {
            const slot = findSlot(step.ability, bindings, cleanName)
            if (slot !== null) {
                mcSend('hotbar', { slot })
                await sleep(step.duration)
            } else {
                console.warn(`[COMBOS] Cannot find slot for ability: ${step.ability}`)
            }
            await sleep(POST_ACTION_GAP)
            break
        }

        case 'click': {
            if (step.mode === 'left') mcSend('attack', { mode: 'once' })
            else if (step.mode === 'right') mcSend('use', { mode: 'once' })
            await sleep(step.duration)
            await sleep(POST_ACTION_GAP)
            break
        }

        case 'sneak': {
            mcSend('fire_pk_event', { event: 'sneak' })
            const releaseAfter = step.mode === 'tap' ? 80 : step.duration
            setTimeout(() => mcSend('fire_pk_event', { event: 'unsneak' }), releaseAfter)
            if (step.blocking) {
                await sleep(step.duration)
                await sleep(POST_ACTION_GAP)
            }
            break
        }

        case 'jump': {
            mcSend('fire_pk_event', { event: 'jump' })
            await sleep(step.duration)
            await sleep(POST_ACTION_GAP)
            break
        }

        case 'move': {
            if (onForceMove) onForceMove(step.direction, step.duration)
            await sleep(step.duration)
            break
        }

        case 'locklook': {
            if (onLockLook) onLockLook(step.duration)
            break // non-blocking
        }

        case 'source': {
            if (onSource) onSource(step.blocks, step.distance, step.duration)
            break // non-blocking
        }

        case 'stop': {
            if (onStop) onStop(true)
            break
        }

        case 'look': {
            if (onLookDir) onLookDir(step.direction, step.degrees, step.duration)
            break
        }

        case 'wait': {
            await sleep(step.duration)
            break
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total wall-clock duration of a combo in ms (sum of all blocking steps).
 */
export function comboDuration(combo) {
    return parseComboSteps(combo)
        .filter(s => s.blocking)
        .reduce((acc, s) => acc + s.duration, 0)
}