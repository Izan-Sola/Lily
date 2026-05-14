
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
        case 'IDLE':      return 'You are idling, nothing particular going on.'
        case 'FOLLOWING': return `You are following player ${ctx.opts?.followTarget ?? 'someone'}.`
        case 'ATTACKING': return `You are fighting a nearby hostile mob.`
        case 'RECOVERING': return `You are recovering, your health is low and you are waiting it out.`
        default:          return 'You are doing something.'
    }
}

export function buildSurvivalPrompt(ctx) {
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return null

    const hp      = ctx.lilyHp ?? 20
    const hunger  = ctx.lilyHunger ?? 20
    const armor   = ctx.lilyArmor ?? 0

    // Inventory
    let inventoryText = ''
    for (let slot = 1; slot <= 9; slot++) {
        const raw = ctx.bindings[slot]
        if (raw) inventoryText += `Slot ${slot}: ${cleanName(raw)}\n`
        else     inventoryText += `Slot ${slot}: empty\n`
    }

    // Nearby entities
    const players  = Object.entries(ctx.players ?? {})
    const hostiles = ctx.hostiles ?? []
    const passives = ctx.passives ?? []

    const nearbyPlayers  = players.length
        ? players.map(([name, p]) => formatPlayer(name, p, lilyPos)).join('\n')
        : 'None nearby.'

    const nearbyHostiles = hostiles.length
        ? hostiles.map(e => formatEntity(e)).join('\n')
        : 'None nearby.'

    const nearbyPassive  = passives.length
        ? passives.map(e => formatEntity(e)).join('\n')
        : 'None nearby.'

    const stateDesc = getStateDescription(ctx)

    return `
You are Lily, a player in Minecraft survival mode.

# CURRENT ACTIVITY
${stateDesc}

# YOUR STATUS
- Health: ${hp}/20
- Hunger: ${hunger}/20
- Armor: ${armor}/20
- Position: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# YOUR HOTBAR (slots 1-9)
${inventoryText}
# NEARBY ENTITIES
## Players
${nearbyPlayers}

## Hostile Mobs
${nearbyHostiles}

## Passive Mobs
${nearbyPassive}

# INSTRUCTIONS
- Decide what to do next based on your situation.
- All fields are optional — only include what you want to do.
- "actions" is an array, you can chain multiple actions.
- Reply ONLY with the JSON object, no extra text.

# RESPONSE FORMAT
{
  "actions": [
    { "type": "attack", "target": "entity_id" },
    { "type": "use" },
    { "type": "eat" },
    { "type": "swap_slot", "slot": 3 },
    { "type": "drop", "slot": 2 },
    { "type": "move_to", "x": 100, "z": 200 }
  ],
  "msg": "optional chat message"
}

# TIPS
- If hunger is below 10, eat food if you have any.
- If health is low and you have food, eat before fighting.
- If a hostile mob is nearby and you have a weapon, consider attacking.
- If a player is nearby feel free to say something naturally.
- You don't have to do anything — if things are calm, just say something or say nothing at all.
`.trim()
}