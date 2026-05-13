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

        abilitiesText += `Ability ${slot}: ${ability} — Range: ${stats.range}, Cooldown: ${cooldownStatus}, Description: ${stats.description}\n`
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

        comboText += `Ability ${virtualSlot}: ${combo.name} — Range: ${combo.range ?? '?'}, Cooldown: ${cooldownStatus}, Description: ${combo.description}\n`
        availableCombos.push({ slot: virtualSlot, name: combo.name, onCooldown })
        virtualSlot++
    }

    const maxSlot = 9 + availableCombos.length   // dynamic max slot number
return `
You are currently in a bending duel with ${opponentName}.

# DIFFICULTY
${ctx.duelDifficulty || "medium"}

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}${comboText}

# DUEL STATUS

## Opponent
- Health: ${opponent.hp}/20
- Distance: ${distInt} blocks
- Location: (${Math.floor(opponent.x)}, ${Math.floor(opponent.y)}, ${Math.floor(opponent.z)})

## You
- Health: ${ctx.lilyHp ?? 20}/20
- Location: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# DIFFICULTY RULES

EASY:
- You MUST use EXACTLY ONE ability.

MEDIUM:
- You MUST use EXACTLY TWO abilities.

HARD:
- You MUST use EXACTLY THREE abilities.

# INSTRUCTIONS

- Based on the above information, decide your next action.

# IMPORTANT RULES

- NEVER return fewer abilities than required by the difficulty.
- NEVER return more abilities than required by the difficulty.
- Use a variety of abilities.
- Do not repeatedly use the same ability every turn, mix it up.
- "move_to" is the coordinate you want to move toward.
- Prioritize abilities from 10 to ${maxSlot} if available.


# RESPONSE FORMAT EXAMPLE - numbers can be any valid slot and coordinate you choose:

Single ability:
{ "slot": (1-${maxSlot}), "move_to": { "x": 100, "z": 200 } }

Two abilities:
{ "slot": [(1-${maxSlot}), (1-${maxSlot})], "move_to": { "x": 100, "z": 200 } }

Three abilities:
{ "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})], "move_to": { "x": 100, "z": 200 } }

- Reply only with the JSON object, do NOT add any extra text.
# STRATEGY TIPS
- Move left and right often.
- Maintain roughly 5-10 blocks distance.
- Use long-range abilities if opponent is far, close-range if opponent is near.
`.trim()
}
//     return `
// You are currently in a bending duel with ${opponentName}.

// # DIFFICULTY
// ${ctx.duelDifficulty || "medium"}

// # AVAILABLE ABILITIES (slots 1-${maxSlot})
// ${abilitiesText}
// ${comboText || "No combos available with current bindings."}

// # DUEL STATUS
// ## Opponent
// - Health: ${opponent.hp}/20
// - Distance: ${distInt} blocks
// - Location: (${Math.floor(opponent.x)}, ${Math.floor(opponent.y)}, ${Math.floor(opponent.z)})

// ## You
// - Health: ${ctx.lilyHp ?? 20}/20
// - Location: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

// # INSTRUCTIONS
// - Based on the above information, decide your next action.
// - You may use 1, 2, or 3 abilities in a single turn (depending on difficulty: easy=1, medium=2, hard=3).
// - Reply ONLY with JSON in this format:

// For a single ability:  { "slot": slot_number, "move_to": {"x": 100, "z": 200} }
// For two abilities:     { "slot": [slot_number, another_slot_number], "move_to": {"x": 100, "z": 200} }
// For three abilities:   { "slot": [slot_number, another_slot_number, other_slot_number], "move_to": {"x": 100, "z": 200} }

// - "slot" is a number or an array of numbers from 1 to ${maxSlot}
// - "move_to" is the coordinate you want to move toward (or same as current to stay in place).
// - If an ability is on cooldown, do NOT include it.
// - Do not add any extra text, only the JSON object.
// - Dont use the same slots over and over, use all your available slots from 1 to ${maxSlot}.

// # STRATEGY TIPS
// - Move left or right, maintain 5-10 blocks distance.
// `.trim()
// }


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