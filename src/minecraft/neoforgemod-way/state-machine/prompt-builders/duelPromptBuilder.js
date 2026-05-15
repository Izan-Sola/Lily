import { getCombos, isComboAvailable } from '../helpers/comboExecutor.js'
export function buildDuelPrompt(ctx, opponentName) {
    const opponent = ctx.players[opponentName]
    if (!opponent) return "Opponent not found."

    const now     = Date.now()
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return "Lily position unknown."

    const prevPos     = ctx.lilyPrevPos
    const prevOpp     = ctx.opponentPrevPos?.[opponentName]
  //  const lastStrategy = ctx.lastDuelStrategy ?? 'none'

    // ── Distances ─────────────────────────────────────────────────────────────
    const dist     = Math.hypot(lilyPos.x - opponent.x, lilyPos.z - opponent.z)
    const distInt  = Math.floor(dist)
    const prevDist = prevPos && prevOpp
        ? Math.floor(Math.hypot(prevPos.x - prevOpp.x, prevPos.z - prevOpp.z))
        : null

    // ── Height ────────────────────────────────────────────────────────────────
    const yDiff = Math.floor(lilyPos.y - opponent.y)
    const heightDesc = yDiff > 2  ? `You are ${yDiff} blocks above opponent — projectiles arc further.`
                     : yDiff < -2 ? `Opponent is ${Math.abs(yDiff)} blocks above you — you are at a disadvantage.`
                     : 'Same elevation.'

    // ── Lily movement ─────────────────────────────────────────────────────────
    const lilyMoved = prevPos
        ? Math.hypot(lilyPos.x - prevPos.x, lilyPos.z - prevPos.z)
        : null
    const lilyDy = prevPos ? Math.floor(lilyPos.y - prevPos.y) : 0

    const lilyMovementDesc = lilyMoved === null ? 'No data yet.'
        : lilyDy < -3  ? `You fell ${Math.abs(lilyDy)} blocks — you may be in a hole.`
        : lilyDy > 3   ? `You were launched ${lilyDy} blocks upward.`
        : lilyMoved < 0.5 ? 'You have not moved — you may be stuck or cornered.'
        : `You moved ${Math.floor(lilyMoved)} blocks.`

    // ── Opponent movement ─────────────────────────────────────────────────────
    const oppMoved = prevOpp
        ? Math.hypot(opponent.x - prevOpp.x, opponent.z - prevOpp.z)
        : null

    const oppMovementDesc = oppMoved === null ? 'No data yet.'
        : oppMoved < 0.3 ? 'Opponent is standing still.'
        : distInt > (prevDist ?? distInt) ? `Opponent is retreating (moved ${Math.floor(oppMoved)} blocks away).`
        : distInt < (prevDist ?? distInt) ? `Opponent is closing in (moved ${Math.floor(oppMoved)} blocks closer).`
        : `Opponent is moving laterally (moved ${Math.floor(oppMoved)} blocks).`

    const oppVelocity = oppMoved === null ? '' : oppMoved > 4 ? ' Fast.' : oppMoved > 1.5 ? ' Moderate speed.' : ' Slow.'

    // ── Situation summary ─────────────────────────────────────────────────────
    const situations = []
    if (yDiff > 2)  situations.push('You have high ground advantage.')
    if (yDiff < -2) situations.push('Opponent has high ground — consider repositioning.')
    if (ctx.lilyHp <= 6)  situations.push('Your health is critical — consider retreating.')
    if (opponent.hp <= 4) situations.push('Opponent is nearly dead — finish them.')
    if (lilyMoved !== null && lilyMoved < 0.5) situations.push('You are not moving — you may be stuck.')
    if (distInt > 15) situations.push('Opponent is very far — use long-range abilities or chase.')
    if (distInt < 4)  situations.push('Opponent is very close — use close-range abilities.')
    const situationText = situations.length ? situations.map(s => `- ${s}`).join('\n') : '- No special situation.'

    // ── Abilities (slots 1-9) ─────────────────────────────────────────────────
    let abilitiesText = ''
    let maxSlot = 9
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (!raw) continue
        const ability  = cleanName(raw)
        const stats    = ctx.abilityStats[ability] || { range: 10, cooldown: 0, description: 'No description.' }
        const remaining = ctx.abilityCooldowns[ability] ? Math.max(0, ctx.abilityCooldowns[ability] - now) : 0
        const cdStatus  = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s cooldown` : 'ready'
        abilitiesText += `Slot ${slot}: ${ability} — Range: ${stats.range}, ${cdStatus}, ${stats.description}\n`
    }

    // ── Combos (slots 10+) ────────────────────────────────────────────────────
    let comboText = ''
    let virtualSlot = 10
    for (const combo of getCombos()) {
        if (!isComboAvailable(combo, ctx.bindings, cleanName)) continue
        const onCooldown = combo.bindsRequired.some(req => {
            const exp = ctx.abilityCooldowns[req]
            return exp && exp > now
        })
        const remaining = onCooldown
            ? Math.max(...combo.bindsRequired.map(req => Math.max(0, (ctx.abilityCooldowns[req] ?? 0) - now)))
            : 0
        const cdStatus = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s cooldown` : 'ready'
        abilitiesText += `Slot ${virtualSlot}: ${combo.name} — Range: ${combo.range ?? '?'}, ${cdStatus}, ${combo.description}\n`
        maxSlot = virtualSlot
        virtualSlot++
    }

    return `
You are currently in a 1v1 bending duel against ${opponentName}.

# DIFFICULTY
${ctx.duelDifficulty || "medium"}

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
# DUEL STATUS

## You
- Health: ${ctx.lilyHp ?? 20}/20
- Position now: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})
- Position last turn: ${prevPos ? `(${Math.floor(prevPos.x)}, ${Math.floor(prevPos.y)}, ${Math.floor(prevPos.z)})` : 'unknown'}
- Movement: ${lilyMovementDesc}

## Opponent
- Health: ${opponent.hp}/20
- Distance now: ${distInt} blocks
- Distance last turn: ${prevDist ?? 'unknown'} blocks
- Height difference: ${yDiff > 0 ? `+${yDiff} (you are higher)` : yDiff < 0 ? `${yDiff} (opponent is higher)` : '0 (same level)'}
- Position now: (${Math.floor(opponent.x)}, ${Math.floor(opponent.y)}, ${Math.floor(opponent.z)})
- Position last turn: ${prevOpp ? `(${Math.floor(prevOpp.x)}, ${Math.floor(prevOpp.y)}, ${Math.floor(prevOpp.z)})` : 'unknown'}
- Opponent movement: ${oppMovementDesc}${oppVelocity}

## Situation
${situationText}

# STRATEGIES
- aggressive: close distance, pressure hard, sprint in, use combos
- defensive: keep distance, use ranged abilities, avoid trading hits
- retreat: flee and survive, use movement abilities to escape
- chase: opponent is running, pursue and close the gap
- circle: strafe around opponent laterally, avoid direct trades
- reposition: move to better ground, higher elevation or open space

# DIFFICULTY RULES
EASY: use EXACTLY ONE ability.
MEDIUM: use EXACTLY TWO abilities.
HARD: use EXACTLY THREE abilities.
IMPOSSIBLE: You are free to use any number of abilities.

# IMPORTANT RULES
- NEVER return fewer or more abilities than required by difficulty.
- Use a variety of abilities, do not repeat the same every turn.
- Prioritize slots 10+ if available and at range.
- "move_to" is where you want to move this turn.
- "look_toward" is what you want to aim at — usually the opponent, but can be a retreat point or predicted position.
- "look_pitch" is vertical aim in degrees: negative aims down, positive aims up. Use -10 to -25 for arcing projectiles at range.

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [1, 3],
  "move_to": { "x": 100, "z": 200 },
  "look_toward": { "x": 106, "y": 62, "z": 204 },
  "look_pitch": -15,
  "strategy": "aggressive",F
}
- Reply ONLY with the JSON object, no extra text.
`.trim()
}

function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}
