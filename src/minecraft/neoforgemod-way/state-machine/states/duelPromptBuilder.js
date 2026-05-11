// duelPromptBuilder.js
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
        const ability = ctx.bindings[slot]
        if (!ability) continue
        const stats = ctx.abilityStats[ability] || { range: 10, cooldown: 0 }
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
- Reply only in the specified JSON format:
  { "slot": slot_number, "move_to": { "x": new_x, "z": new_z }, "look_at": { "x": new_x, "y": new_y, "z": new_z } }
        - "slot" is the number of the ability slot you want to use (or null to skip using an ability).
        - "movetoward" is the coordinate you want to move toward (or same as current to stay in place).
        - "lookat" is the coordinate you want to look at. Most of the time this will be the opponent's position, but you can choose to look elsewhere if you intend to flee with a movement ability.
- You choose the ability and the coordinates to move toward. If you want to stay in place, set movetoward to your current coordinates.

# STRATEGY TIPS
- Use long-range abilities when opponent is far, close-range when near.
- Respect cooldowns; don't spam.
- Maintain optimal distance based on your abilities.
- If your health is low, consider retreating to a safer distance while waiting for cooldowns.
`
}