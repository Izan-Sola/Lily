// duelPromptBuilder.js
function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim();
}

export function buildDuelPrompt(ctx, opponentName) {
    const opponent = ctx.players[opponentName]
    if (!opponent) return "Opponent not found."

    const now = Date.now()
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return "Lily position unknown."

    const dist = Math.hypot(lilyPos.x - opponent.x, lilyPos.z - opponent.z)
    const distInt = Math.floor(dist)

    let abilitiesText = ""
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (!raw) continue
        const ability = cleanName(raw)  // clean before lookup
        const stats = ctx.abilityStats[ability] || { range: 10, cooldown: 0 }
        // console.log(`[DEBUG] ${ability}:`, ctx.abilityStats[ability])
        const remaining = ctx.abilityCooldowns[ability] ? Math.max(0, ctx.abilityCooldowns[ability] - now) : 0
        const remainingSec = (remaining / 1000).toFixed(1)
        const cooldownStatus = remaining > 0 ? `${remainingSec}s` : "ready"
        abilitiesText += `Slot ${slot}: ${ability} - Range: ${stats.range}, Cooldown: ${cooldownStatus}\n`
    }

    const opponentHp = opponent.hp
    const oppX = opponent.x, oppY = opponent.y, oppZ = opponent.z
    const lilyHp = ctx.lilyHp

    return `
You are currently in a bending duel with ${opponentName}.

# AVAILABLE ABILITIES
${abilitiesText}

# DUEL STATUS

## Opponent Status
- Health: ${opponentHp}/20
- Distance: ${distInt} blocks
- Location: (${Math.floor(oppX)}, ${Math.floor(oppY)}, ${Math.floor(oppZ)})

## Your Status
- Health: ${lilyHp}/20
- Location: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# INSTRUCTIONS
- Based on the above information, decide your next action. You can choose to use an ability (if off cooldown).
- Reply ONLY with the specified JSON format:
  { "slot": slot_number, "move_to": { "x": new_x, "z": new_z } }
        - "slot" is the number of the ability slot you want to use (from 1 to 9).
        - "move_to" is the coordinate you want to move toward (or same as current to stay in place).
# STRATEGY TIPS
- Use long-range abilities when opponent is far, close-range when near.
- Dont use same slot over and over, use variety to keep opponent guessing.
- Move around your opponent to make it harder for them to hit you, I recommend circling to their left or right and mainting 5-10 blocks distance.
- If your health is low, consider retreating to a safer distance while waiting for cooldowns.
`
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