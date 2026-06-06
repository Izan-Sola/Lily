import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const SWAP_LOCK_TIME = 100
const DEFAULT_STEP_TIME = 200
const POST_ACTION_GAP = 250  // hard gap after every blocking step before the next fires

let combosData = {}

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
 * This separation of parsing from execution makes the behaviour 100%
 * predictable: you can inspect steps[] before running anything.
 *
 * Step shape:
 *   { type, mode?, ability?, blocking, duration }
 */
export function parseComboSteps(combo) {
    const actions = combo.actions ?? []
    const times = combo.actionsTime ?? []
    let timeIdx = 0
    const steps = []

    for (const actionStr of actions) {
        const parts = actionStr.split(':')
        const type = parts[0]

        // ── SWAP ──────────────────────────────────────────────────
        // format: swap:slot:<AbilityName>
        // consumes one time entry — use it as the post-swap settling delay
        if (type === 'swap') {
            const duration = times[timeIdx++] ?? SWAP_LOCK_TIME
            steps.push({
                type: 'swap',
                ability: parts[2],
                blocking: true,
                duration,
            })
            continue
        }

        // ── LOCKLOOK ─────────────────────────────────────────────
        // format: locklook  (no count, no mode — always 1 step, 1 time entry)
        if (type === 'locklook') {
            const duration = times[timeIdx++] ?? DEFAULT_STEP_TIME
            steps.push({ type: 'locklook', blocking: false, duration })
            continue
        }

        // Everything else: [type, mode, count, extra]
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
                    // blocking unless extra === 'continue'
                    steps.push({ type: 'sneak', mode, blocking: extra !== 'continue', duration })
                    break
                case 'jump':
                    steps.push({ type: 'jump', blocking: true, duration })
                    break
                case 'source':
                    // blocking only when extra === 'block'
                    steps.push({ type: 'source', blocking: extra === 'block', duration })
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
    }

    return steps
}

/**
 * Executes a pre-parsed steps array sequentially.
 *
 * handlers:
 *   onSource(ms)           — async, must resolve when source is acquired
 *   onLockLook(ms)         — sync, sets look lock
 *   onForceMove(dir, ms)   — sync, starts forced movement
 */
export async function executeCombo(combo, bindings, cleanName, mcSend, handlers = {}) {
    const { onSource, onLockLook, onForceMove } = handlers
    const steps = parseComboSteps(combo)

    for (const step of steps) {
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
                    await sleep(POST_ACTION_GAP)  // ensure unsneak is processed before next action
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
                await sleep(POST_ACTION_GAP)
                break
            }

            case 'locklook': {
                if (onLockLook) onLockLook(step.duration)
                // non-blocking — continue immediately
                break
            }

            case 'source': {
                if (onSource) await onSource(step.duration)
                if (step.blocking) await sleep(step.duration)
                break
            }
        }
    }
}

/**
 * Returns total wall-clock duration of a combo in ms
 * (sum of all blocking step durations).
 */
export function comboDuration(combo) {
    return parseComboSteps(combo)
        .filter(s => s.blocking)
        .reduce((acc, s) => acc + s.duration, 0)
}