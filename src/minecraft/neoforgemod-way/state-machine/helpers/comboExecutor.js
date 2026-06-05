import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const SWAP_LOCK_TIME = 20
const DEFAULT_STEP_TIME = 200

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

/*
handlers:
onSource(ms)
onLockLook(ms)
onForceMove(dir, ms)
*/

export async function executeCombo(combo, bindings, cleanName, mcSend, handlers = {}) {
    const { onSource, onLockLook, onForceMove } = handlers

    const actions = combo.actions
    const times = combo.actionsTime ?? []
    let timeIdx = 0

    for (let i = 0; i < actions.length; i++) {
        const actionStr = actions[i]
        const parts = actionStr.split(':')
        const type = parts[0]

        // ------------------------
        // SWAP
        // ------------------------
        if (type === 'swap') {
            const ability = parts[2]
            const slot = findSlot(ability, bindings, cleanName)
            timeIdx++

            if (slot !== null) {
                mcSend('hotbar', { slot })
                await sleep(SWAP_LOCK_TIME)
            } else {
                console.warn(`[COMBOS] Cannot find slot for ability: ${ability}`)
            }
            continue
        }

        const count = parseInt(parts[2] ?? '1') || 1

        // ------------------------
        // CLICK
        // ------------------------
        if (type === 'click') {
            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
                if (parts[1] === 'left') mcSend('attack', { mode: 'once' })
                if (parts[1] === 'right') mcSend('use', { mode: 'once' })
                await sleep(stepTime)
            }
            continue
        }

        // ------------------------
        // SNEAK
        // ------------------------
        if (type === 'sneak') {
            const mode = parts[1]
            const isBlocking = parts[3] !== 'continue'

            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME

                if (mode === 'hold') {
                    mcSend('fire_pk_event', { event: 'sneak' })
                    setTimeout(() => mcSend('fire_pk_event', { event: 'unsneak' }), stepTime)
                    if (isBlocking) await sleep(stepTime)
                } else if (mode === 'tap') {
                    mcSend('fire_pk_event', { event: 'sneak' })
                    setTimeout(() => mcSend('fire_pk_event', { event: 'unsneak' }), 80)
                    if (isBlocking) await sleep(stepTime)
                }
            }
            continue
        }

        // ------------------------
        // JUMP
        // ------------------------
        if (type === 'jump') {
            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
                mcSend('fire_pk_event', { event: 'jump' })
                await sleep(stepTime)
            }
            continue
        }

        // ------------------------
        // MOVEMENT
        // ------------------------
        if (type === 'forward' || type === 'back' || type === 'left' || type === 'right') {
            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
                if (onForceMove) onForceMove(type, stepTime)
                await sleep(stepTime)
            }
            continue
        }

        // LOCK LOOK
        // ------------------------
        if (type === 'locklook') {
            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
                if (onLockLook) onLockLook(stepTime)
                // non-blocking: just set the lock and move on immediately
            }
            continue
        }

        // ------------------------
        // SOURCE
        // ------------------------
        if (type === 'source') {
            for (let c = 0; c < count; c++) {
                const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
                const isBlocking = parts[3] === 'block'  // source defaults non-blocking

                if (onSource) onSource(stepTime)
                if (isBlocking) await sleep(stepTime)
            }
            continue
        }

        // ------------------------
        // FALLBACK
        // ------------------------
        const stepTime = times[timeIdx++] ?? DEFAULT_STEP_TIME
        await sleep(stepTime)
    }
}