import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
            combo.range    = stats.range
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

// Check if all required abilities are bound in current bindings
// bindings: { slot: rawAbilityName }
// cleanName: fn to strip color codes
export function isComboAvailable(combo, bindings, cleanName) {
    const normalize = (s) => s.toLowerCase().trim().replace(/\s+/g, '');
    
    const availableAbilities = Object.values(bindings)
        .filter(Boolean)
        .map(raw => normalize(cleanName(raw)));

   // console.log(`[COMBOS] Checking ${combo.name} — needs: ${combo.bindsRequired} — have: ${availableAbilities}`);

    return combo.bindsRequired.every(required =>
        availableAbilities.includes(normalize(required))
    );
}

// Find the hotbar slot for a given ability name
function findSlot(abilityName, bindings, cleanName) {
    for (const [slot, raw] of Object.entries(bindings)) {
        if (cleanName(raw) === abilityName) return parseInt(slot)
    }
    return null
}

// Execute a combo given current bindings and mcSend
// Returns total duration in ms so caller knows when it's done
export function executeCombo(combo, bindings, cleanName, mcSend) {
   // console.log(`[COMBOS] Executing: ${combo.name}`)

    // Expand actions into steps, one per actual input
    const steps = []
    for (const actionStr of combo.actions) {
        const parts = actionStr.split(':')
        const type = parts[0]

        if (type === 'swap') {
            steps.push({ type, target: parts[2] })
        } else {
            const mode = parts[1]
            const count = parseInt(parts[2] ?? '1')
            for (let j = 0; j < count; j++) {
                steps.push({ type, mode })
            }
        }
    }

    // Now steps.length === actionsTime.length
    let timeOffset = 0
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        const delay = timeOffset
        const stepTime = combo.actionsTime[i] ?? 200

        if (step.type === 'swap') {
            const slot = findSlot(step.target, bindings, cleanName)
            if (slot !== null) setTimeout(() => mcSend('hotbar', { slot }), delay)
            else console.warn(`[COMBOS] Cannot find slot for ability: ${step.target}`)
        } else if (step.type === 'click') {
            if (step.mode === 'left') setTimeout(() => mcSend('attack', { mode: 'once' }), delay)
            else if (step.mode === 'right') setTimeout(() => mcSend('use', { mode: 'once' }), delay)
} else if (step.type === 'sneak') {
            if (step.mode === 'hold') {
                setTimeout(() => mcSend('fire_pk_event', { event: 'sneak' }), delay)
                // unsneak scheduled after ALL remaining steps finish
                const remainingTime = combo.actionsTime.slice(i).reduce((a, b) => a + b, 0)
                setTimeout(() => mcSend('fire_pk_event', { event: 'unsneak' }), delay + remainingTime)
                // do NOT add stepTime to timeOffset — next action fires immediately
                continue
            } else if (step.mode === 'tap') {
                setTimeout(() => mcSend('fire_pk_event', { event: 'sneak' }), delay)
                setTimeout(() => mcSend('fire_pk_event', { event: 'unsneak' }), delay + 80)
            }
        } else if (step.type === 'jump') {
            setTimeout(() => mcSend('fire_pk_event', { event: 'jump' }), delay)
        }

        timeOffset += stepTime
    }

   //console.log(`[COMBOS] ${combo.name} will finish in ~${timeOffset}ms`)
    return timeOffset
}