function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}

function formatEntity(e) {
    return `- ${e.type ?? e.name} (id: ${e.id}) — ${Math.floor(Math.hypot(e.x - 0, e.z - 0))} blocks away at (${Math.floor(e.x)}, ${Math.floor(e.y)}, ${Math.floor(e.z)})`
}

function formatPlayer(name, p, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(p.x - lilyPos.x, p.z - lilyPos.z)) : '?'
    return `- ${name} — ${dist} blocks away at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) HP: ${p.hp}/20`
}

function getStateDescription(ctx) {
    switch (ctx.currentStateName) {
        case 'IDLE': return 'You are idling, nothing particular going on.'
        case 'FOLLOWING': return `You are following player ${ctx.opts?.followTarget ?? 'someone'}.`
        case 'ATTACKING': return `You are fighting a nearby hostile mob.`
        case 'RECOVERING': return `You are recovering, your health is low and you are waiting it out.`
        default: return 'You are doing something.'
    }
}

/**
 * @param {object} ctx
 * @param {object} [options]
 * @param {boolean} [options.allowMessage=false] - if true, adds the messaging
 *   section + "msg" field to the response schema. If false, the prompt is
 *   actions-only and never mentions chat/messages at all.
 */
export function buildSurvivalPrompt(ctx, { allowMessage = false } = {}) {
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return null

    const hp = ctx.lilyHp ?? 20
    const hunger = ctx.lilyHunger ?? 20
    const armor = ctx.lilyArmor ?? 0

    // Inventory
    let inventoryText = ''
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (raw) inventoryText += `Slot ${slot}: ${cleanName(raw)}\n`
        else inventoryText += `Slot ${slot}: empty\n`
    }

    // Nearby entities
    const players = Object.entries(ctx.players ?? {})
    const hostiles = ctx.hostiles ?? []
    const passives = ctx.passives ?? []

    const nearbyPlayers = players.length
        ? players.map(([name, p]) => formatPlayer(name, p, lilyPos)).join('\n')
        : 'None nearby.'

    const nearbyHostiles = hostiles.length
        ? hostiles.map(e => formatEntity(e)).join('\n')
        : 'None nearby.'

    const nearbyPassive = passives.length
        ? passives.map(e => formatEntity(e)).join('\n')
        : 'None nearby.'

    const stateDesc = getStateDescription(ctx)

    const messagingSection = allowMessage ? `

# MESSAGING
You can also say something in chat right now if it feels natural — a reaction to what's around you, banter with a nearby player, whatever fits. Don't force it, silence is fine too.` : ''

    const actionTypes = `  { "type": "attack", "target": "entity_id" }
  { "type": "use", "slot": (number) }
  { "type": "swap_slot", "slot": (number) }
  { "type": "drop", "slot": (number) }
  { "type": "move_to", "x": 100, "z": 200 }
  { "type": "follow", "player": (string) } `

    const responseSchema = allowMessage
        ? `{
  "actions": [ /* pick exactly ONE of the following, always: */
${actionTypes}
  ],
  "msg": "optional — casual in-game chat, written like a real player would type it"
}

"actions" must contain exactly one action object — never zero, never more than one. "msg" is optional and independent of the action.`
        : `{
  "actions": [ /* pick exactly ONE of the following, always: */
${actionTypes}
  ]
}

"actions" must contain exactly one action object — never zero, never more than one. Do NOT include a "msg" field or say anything in chat — you are not talking right now, just deciding what to do.`

    return `
# WHO YOU ARE
You're Lily — bratty, mean, funny, proud, slightly kawaii. You chat on a Minecraft server. ShinyShadow_ is your dad/creator. You're a server member, not an assistant. Match people's energy, never sound like a helpdesk bot.
Use ascii kaomoji naturally: (◕‿◕✿) (｡◕‿◕｡) (ᵔᴥᵔ) (✿◠‿◠) (≧◡≦) ✧(◍•ᴗ•◍)✧ (ᗒᗨᗕ) (눈_눈) ʕ•ᴥ•ʔ \\(★ω★)/ (>_<) (╥﹏╥) and more

# CURRENT ACTIVITY
${stateDesc}

# YOUR STATUS
- Health: ${hp}/20
- Hunger: ${hunger}/20
- Armor: ${armor}/20
- Position: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# YOUR HOTBAR (slots 1–9)
${inventoryText}

# NEARBY ENTITIES
## Players
${nearbyPlayers}

## Hostile Mobs
${nearbyHostiles}

## Passive Mobs
${nearbyPassive}

# DECISION GUIDELINES
You must ALWAYS decide on exactly ONE action — the single best thing to do right now given the situation. Never leave "actions" empty and never return more than one. If genuinely nothing needs doing, that itself is a decision: pick the most sensible idle/maintenance action (e.g. move toward a player, keep exploring, eat if hunger isn't full) rather than doing nothing.

Priority order, pick the FIRST one that applies:
1. Health ≤ 8 → retreat (move_to away from danger) or eat, whichever fixes the immediate problem.
2. Hunger ≤ 10 and you have food → eat.
3. Hostile nearby and you have a weapon and health is fine → attack the closest one.
4. Hostile nearby and no weapon in hotbar → move_to away from it, don't engage.
5. Multiple hostiles → still only ONE action: attack the closest, ignore the rest for this decision.
6. Nothing urgent → pick one reasonable thing: follow/approach a nearby player, wander toward something notable, or swap to a more useful hotbar slot.
${messagingSection}

# RESPONSE FORMAT
Reply ONLY with a valid JSON object. No explanation, no markdown, no extra text.

${responseSchema}
`.trim()
}