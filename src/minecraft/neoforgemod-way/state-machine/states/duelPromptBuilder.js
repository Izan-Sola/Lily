import { getCombos, isComboAvailable } from './comboExecutor.js'

function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}

export function buildDuelPrompt(ctx, opponentName) {
    const opponent = ctx.players[opponentName]
    if (!opponent) return "Opponent not found."

    const now = Date.now()
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return "Lily position unknown."

    const dist = Math.hypot(lilyPos.x - opponent.x, lilyPos.z - opponent.z)
    const distInt = Math.floor(dist)

    // ── Normal abilities (slots 1-9) ──────────────────────────────────────────
    let abilitiesText = ""
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (!raw) continue

        const ability = cleanName(raw)
        const stats = ctx.abilityStats[ability] || { range: 10, cooldown: 0, description: "No description." }

        const remaining = ctx.abilityCooldowns[ability] ? Math.max(0, ctx.abilityCooldowns[ability] - now) : 0
        const cooldownStatus = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "ready"

        abilitiesText += `Slot ${slot}: ${ability} — Range: ${stats.range}, Cooldown: ${cooldownStatus}, Description: ${stats.description}\n`
    }

    // ── Combos (virtual slots 10+) ────────────────────────────────────────────
    let comboText = ""
    const availableCombos = []
    let virtualSlot = 10

    for (const combo of getCombos()) {
        if (!isComboAvailable(combo, ctx.bindings, cleanName)) continue

        const onCooldown = combo.bindsRequired.some(req => {
            const exp = ctx.abilityCooldowns[req]
            return exp && exp > now
        })

        const totalTime = combo.actionsTime.reduce((a, b) => a + b, 0)
        const remaining = combo.bindsRequired.some(req => ctx.abilityCooldowns[req] && ctx.abilityCooldowns[req] > now)
            ? Math.max(...combo.bindsRequired.map(req => (ctx.abilityCooldowns[req] ?? 0) - now))
            : 0
        const cooldownStatus = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "ready"

        comboText += `Slot ${virtualSlot}: ${combo.name} — Range: ${combo.range ?? '?'}, Cooldown: ${cooldownStatus}, Description: ${combo.description}\n`
        availableCombos.push({ slot: virtualSlot, name: combo.name, onCooldown })
        virtualSlot++
    }

    const maxSlot = 9 + availableCombos.length   // dynamic max slot number

    return `
You are currently in a bending duel with ${opponentName}.

# DIFFICULTY
${ctx.duelDifficulty || "medium"}

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
${comboText || "No combos available with current bindings."}

# DUEL STATUS
## Opponent
- Health: ${opponent.hp}/20
- Distance: ${distInt} blocks
- Location: (${Math.floor(opponent.x)}, ${Math.floor(opponent.y)}, ${Math.floor(opponent.z)})

## You
- Health: ${ctx.lilyHp ?? 20}/20
- Location: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# INSTRUCTIONS
- Based on the above information, decide your next action.
- You may use 1, 2, or 3 abilities in a single turn (depending on difficulty: easy=1, medium=2, hard=3).
- Reply ONLY with JSON in this format:

For a single ability:  { "slot": slot_number, "move_to": {"x": 100, "z": 200} }
For two abilities:     { "slot": [slot_number, another_slot_number], "move_to": {"x": 100, "z": 200} }
For three abilities:   { "slot": [slot_number, another_slot_number, other_slot_number], "move_to": {"x": 100, "z": 200} }

- "slot" is a number or an array of numbers from 1 to ${maxSlot}
- "move_to" is the coordinate you want to move toward (or same as current to stay in place).
- If an ability is on cooldown, do NOT include it.
- Do not add any extra text, only the JSON object.
- Dont use the same slots over and over, use all your available slots from 1 to ${maxSlot}.

# STRATEGY TIPS
- Move left or right, maintain 5-10 blocks distance.
`.trim()
}

// You are currently in a bending duel with ${opponentName}.

// # AVAILABLE ABILITIES
// ${abilitiesText}

// # DUEL STATUS

// ## Opponent Status
// - Health: ${opponentHp}/20
// - Distance: ${distInt} blocks
// - Location: (${Math.floor(oppX)}, ${Math.floor(oppY)}, ${Math.floor(oppZ)})

// ## Your Status
// - Health: ${lilyHp}/20
// - Location: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

// # INSTRUCTIONS
// - Based on the above information, decide your next action. You can choose to use an ability (if off cooldown).
// - Reply ONLY with the specified JSON format:
//   { "slot": slot_number, "move_to": { "x": new_x, "z": new_z }, "look_at": { "x": new_x, "y": new_y, "z": new_z } }
//         - "slot" is the number of the ability slot you want to use (from 1 to 9).
//         - "movetoward" is the coordinate you want to move toward (or same as current to stay in place).
//         - "lookat" is the coordinate you want to look at. Most of the time this will be the opponent's position unless you are low hp and want to flee.

// # STRATEGY TIPS
// - Use long-range abilities when opponent is far, close-range when near.
// - Dont spam the same slot over and over, use variety to keep opponent guessing.
// - Maintain optimal distance based on your abilities.
// - If your health is low, consider retreating to a safer distance while waiting for cooldowns.
// `

/**
 * DUEL PROMPT BUILDER
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds the text prompt sent to the AI model during a bending duel.
 * Called by DuelingState._sendPrompt() every decision cycle.
 * The AI receives this and must reply with ONLY a JSON action object.
 *
 * INPUT (from ctx — StateController):
 *   ctx.players[opponentName]    → { x, y, z, hp } opponent position and health
 *   ctx.lilyPos                  → { x, y, z } Lily's current position
 *   ctx.lilyHp                   → Lily's current HP 0–20
 *   ctx.bindings                 → { slot: rawAbilityName }
 *                                  e.g. { 1: "§cFireBall", 2: "FireShots" }
 *   ctx.abilityStats             → { abilityName: { range, cooldown, description } }
 *   ctx.abilityCooldowns         → { abilityName: expiryTimestamp }
 *                                  remaining = abilityCooldowns[name] - Date.now()
 *   ctx.duelDifficulty           → "easy" | "medium" | "hard"
 *
 * PROMPT CONTENTS:
 *   - Difficulty level
 *   - All 9 ability slots with: name, range, cooldown status (ready / Xs), description
 *   - Opponent HP, distance in blocks, XYZ position
 *   - Lily HP, XYZ position
 *   - Instructions: pick 1/2/3 slots based on difficulty, reply JSON only
 *   - Strategy tips
 *
 * EXPECTED AI RESPONSE FORMAT:
 *   { "slot": 3, "move_to": { "x": 100, "z": 200 } }
 *   { "slot": [3, 7], "move_to": { "x": 100, "z": 200 } }
 *
 * HELPER:
 *   cleanName(raw) → strips Minecraft color codes (§c etc) and leading >
 *                    e.g. "§cFireBall" → "FireBall"
 */