import { getCombos, isComboAvailable } from '../helpers/comboExecutor.js'

// ── Abilities to NEVER inject in the prompt ───────────────────────────────────
const EXCLUDED_ABILITIES = new Set([
    "shockwave", "raiseearth", "lavadisc", "catapult", "earthsmash", "lavathrow"
])

// ── Element system prompts (full prompt per element) ──────────────────────────
const ELEMENT_PROMPTS = {
    fire: (opponentName, abilitiesText, maxSlot, status) => `
You are currently in a 1v1 bending duel against ${opponentName} using fire.

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}

# DUEL STATUS
${status}

# STRATEGIES
- defensive: keep distance, use ranged abilities, avoid trading hits.
- reposition: MUST use when enemy is very close or closing in fast. MUST include a [MOVEMENT] slot.
- chase: go all in, pursue and close the gap. MUST include a [MOVEMENT] slot.

# IMPORTANT RULES
- Return three slot numbers from 1 to ${maxSlot} to use.
- Prioritize slots 10+ if off cooldown and at range.
- "move_to" is where you want to move this turn.
- If strategy is reposition or chase, you MUST pick a [MOVEMENT] as one of your slots.
- DO NOT use slots on cooldown.

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})],
  "move_to": { "x": 100, "z": 200 },
  "strategy": "strategy_name",
}
- Reply ONLY with the JSON object, no extra text.
`.trim(),

    water: (opponentName, abilitiesText, maxSlot, status) => `
You are currently in a 1v1 bending duel against ${opponentName}.

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
# DUEL STATUS
${status}

# STRATEGIES
- defensive: keep distance, use ranged abilities, avoid trading hits.
- reposition: MUST use when enemy is very close or closing in fast. MUST include a [MOVEMENT] slot.
- chase: go all in, pursue and close the gap. MUST include a [MOVEMENT] slot.

# IMPORTANT RULES
- Return three slot numbers from 1 to ${maxSlot} to use.
- Prioritize slots 10+ if off cooldown and at range.
- "move_to" is where you want to move this turn.
- If strategy is reposition or chase, you MUST pick a [MOVEMENT] as one of your slots.
- DO NOT use slots on cooldown.

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})],
  "move_to": { "x": 100, "z": 200 },
  "strategy": "strategy_name",
}
- Reply ONLY with the JSON object, no extra text.
`.trim(),

    earth: (opponentName, abilitiesText, maxSlot, status) => `
You are currently in a 1v1 bending duel against ${opponentName} using earth.

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
# DUEL STATUS
${status}

# STRATEGIES
- defensive: keep distance, use ranged abilities, avoid trading hits.
- chase: go all in, pursue and close the gap..

# IMPORTANT RULES
- Return three slot numbers from 1 to ${maxSlot} to use.
- Prioritize slots 10+ if off cooldown and at range.
- "move_to" is where you want to move this turn.
- DO NOT use slots on cooldown.
- DO NOT spam the same ability, use variety.

# RANGE REFERENCE:
- close: 0-5 blocks
- medium: 5-10 blocks
- long: +10

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})],
  "move_to": { "x": 100, "z": 200 },
  "strategy": "strategy_name",
}
- Reply ONLY with the JSON object, no extra text.
`.trim(),

    air: (opponentName, abilitiesText, maxSlot, status) => `
You are currently in a 1v1 bending duel against ${opponentName}.

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
# DUEL STATUS
${status}

# STRATEGIES
- defensive: keep distance, use ranged abilities, avoid trading hits.
- reposition: MUST use when enemy is very close or closing in fast. MUST include a [MOVEMENT] slot.
- chase: go all in, pursue and close the gap. MUST include a [MOVEMENT] slot.

# IMPORTANT RULES
- Return three slot numbers from 1 to ${maxSlot} to use.
- Prioritize slots 10+ if off cooldown and at range.
- "move_to" is where you want to move this turn.
- If strategy is reposition or chase, you MUST pick a [MOVEMENT] as one of your slots.
- DO NOT use slots on cooldown.

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})],
  "move_to": { "x": 100, "z": 200 },
  "strategy": "strategy_name",
}
- Reply ONLY with the JSON object, no extra text.
`.trim(),

    chi: (opponentName, abilitiesText, maxSlot, status) => `
You are currently in a 1v1 bending duel against ${opponentName}.

# AVAILABLE ABILITIES (slots 1-${maxSlot})
${abilitiesText}
# DUEL STATUS
${status}

# STRATEGIES
- defensive: keep distance, use ranged abilities, avoid trading hits.
- reposition: MUST use when enemy is very close or closing in fast. MUST include a [MOVEMENT] slot.
- chase: go all in, pursue and close the gap. MUST include a [MOVEMENT] slot.

# IMPORTANT RULES
- Return three slot numbers from 1 to ${maxSlot} to use.
- Prioritize slots 10+ if off cooldown and at range.
- "move_to" is where you want to move this turn.
- If strategy is reposition or chase, you MUST pick a [MOVEMENT] as one of your slots.
- DO NOT use slots on cooldown.

# RESPONSE FORMAT EXAMPLE
{ 
  "slot": [(1-${maxSlot}), (1-${maxSlot}), (1-${maxSlot})],
  "move_to": { "x": 100, "z": 200 },
  "strategy": "strategy_name",
}
- Reply ONLY with the JSON object, no extra text.
`.trim(),
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function buildDuelPrompt(ctx, opponentName) {
    const opponent = ctx.players[opponentName]
    if (!opponent) return "Opponent not found."

    const now = Date.now()
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return "Lily position unknown."

    const element = ctx.currentElement ?? 'fire'

    const prevPos = ctx.lilyPrevPos
    const prevOpp = ctx.opponentPrevPos?.[opponentName]

    // ── Distances ─────────────────────────────────────────────────────────────
    const dist = Math.hypot(lilyPos.x - opponent.x, lilyPos.z - opponent.z)
    const distInt = Math.floor(dist)
    const prevDist = prevPos && prevOpp
        ? Math.floor(Math.hypot(prevPos.x - prevOpp.x, prevPos.z - prevOpp.z))
        : null

    // ── Height ────────────────────────────────────────────────────────────────
    const yDiff = Math.floor(lilyPos.y - opponent.y)

    // ── Lily movement ─────────────────────────────────────────────────────────
    const lilyMoved = prevPos
        ? Math.hypot(lilyPos.x - prevPos.x, lilyPos.z - prevPos.z)
        : null
    const lilyDy = prevPos ? Math.floor(lilyPos.y - prevPos.y) : 0

    const lilyMovementDesc = lilyMoved === null ? 'No data yet.'
        : lilyDy < -3 ? `You fell ${Math.abs(lilyDy)} blocks — you may be in a hole.`
            : lilyDy > 3 ? `You were launched ${lilyDy} blocks upward.`
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

    const oppVelocity = oppMoved === null ? '' : oppMoved > 4 ? ' Fast.' : oppMoved > 1.75 ? ' Moderate speed.' : ' Slow.'

    // ── Situation summary ─────────────────────────────────────────────────────
    const situations = []
    if (yDiff > 2) situations.push('You have high ground advantage.')
    if (yDiff < -2) situations.push('Opponent has high ground — consider repositioning.')
    if (ctx.lilyHp <= 6) situations.push('Your health is critical — consider retreating.')
    if (opponent.hp <= 4) situations.push('Opponent is nearly dead — finish them.')
    if (lilyMoved !== null && lilyMoved < 0.5) situations.push('You are not moving — you may be stuck.')
    if (distInt > 15) situations.push('Opponent is very far — use long-range abilities or chase.')
    if (distInt < 4) situations.push('Opponent is very close — use close-range abilities.')
    const situationText = situations.length ? situations.map(s => `- ${s}`).join('\n') : '- No special situation.'

    // ── Abilities (slots 1-9, excluding blacklisted) ──────────────────────────
    let abilitiesText = ''
    let maxSlot = 9
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (!raw) continue
        const ability = cleanName(raw)
        if (EXCLUDED_ABILITIES.has(ability.toLowerCase())) continue
        const stats = ctx.abilityStats[ability] || { range: 10, cooldown: 0, description: 'No description.' }
        const remaining = ctx.abilityCooldowns[ability] ? Math.max(0, ctx.abilityCooldowns[ability] - now) : 0
        const cdStatus = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s cooldown` : 'ready'
        abilitiesText += `Slot ${slot}: ${ability} — Range: ${stats.range}, ${cdStatus}, ${stats.description}\n`
    }

    // ── Combos (slots 10+) ────────────────────────────────────────────────────
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

    // ── Status block ──────────────────────────────────────────────────────────
    const status = `
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
${situationText}`.trim()

    // ── Build final prompt ────────────────────────────────────────────────────
    const promptFn = ELEMENT_PROMPTS[element] ?? ELEMENT_PROMPTS['fire']
    return promptFn(opponentName, abilitiesText, maxSlot, status)
}

function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}