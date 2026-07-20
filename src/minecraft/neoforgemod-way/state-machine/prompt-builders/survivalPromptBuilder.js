function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}

function formatEntity(e, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(e.x - lilyPos.x, e.z - lilyPos.z)) : '?'
    return `- ${e.type ?? e.name} (id: ${e.id}) — ${dist} blocks away at (${Math.floor(e.x)}, ${Math.floor(e.y)}, ${Math.floor(e.z)})`
}

function formatBlockOfInterest(b, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(b.x - lilyPos.x, b.z - lilyPos.z)) : '?'
    return ` ${b.category}: ${b.block} at (${b.x}, ${b.y}, ${b.z}) — ${dist} blocks away`
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
 * Builds the shared "live world state" block — status, hotbar, nearby
 * entities, nearby blocks of interest. Used by both the survival tick
 * prompt and the chat-facing minecraft system prompt, so Lily has the
 * same awareness in both contexts.
 * Returns null if ctx has no position yet (bot not spawned/ready).
 */
export function buildWorldStateBlock(ctx) {
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return null

    const hp = ctx.lilyHp ?? 20
    const hunger = ctx.lilyHunger ?? 20
    const armor = ctx.lilyArmor ?? 0

    let inventoryText = ''
    for (let slot = 1; slot <= 36; slot++) {
        const entry = ctx.inventoryItems?.[slot]
        if (!entry) {
            continue
        }
        const [id, count] = entry.split(' x')
        inventoryText += `Slot ${slot}: ${cleanName(id)}${count ? ` x${count}` : ''}\n`
    }

    const players = Object.entries(ctx.players ?? {})
    const hostiles = ctx.hostiles ?? []
    const passives = ctx.passives ?? []
    const blocksOfInterest = ctx.blocksOfInterest ?? []

    const nearbyPlayers = players.length
        ? players.map(([name, p]) => formatPlayer(name, p, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyHostiles = hostiles.length
        ? hostiles.map(e => formatEntity(e, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyPassive = passives.length
        ? passives.map(e => formatEntity(e, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyBlocks = blocksOfInterest.length
        ? blocksOfInterest.map(b => formatBlockOfInterest(b, lilyPos)).join('\n')
        : 'None nearby.'

    return `
# CURRENT ACTIVITY
${getStateDescription(ctx)}

# YOUR STATUS
- Health: ${hp}/20
- Hunger: ${hunger}/20
- Armor: ${armor}/20
- Position: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# YOUR INVENTORY (SLOTS 1-36)
${inventoryText}
# NEARBY ENTITIES
## Players
${nearbyPlayers}

## Hostile Mobs
${nearbyHostiles}

## Passive Mobs
${nearbyPassive}

# NEARBY BLOCKS OF INTEREST
(wood, ore, food sources — use these coordinates if you decide to mine/break something; never guess coordinates)
${nearbyBlocks}`.trim()
}

export function buildSurvivalPrompt(ctx, { allowMessage = false } = {}) {
    const worldState = buildWorldStateBlock(ctx)
    if (!worldState) return null

    const messagingSection = allowMessage ? `
# MESSAGING
You can also say something in chat right now if it feels natural — a reaction to what's around you, banter with a nearby player, whatever fits. Don't force it, silence is fine too. Just write it as your normal reply text alongside your action — do not call a tool for it, it's not one of the available tools.` : `
# NO CHAT THIS TICK
Do not say anything in chat right now — you're not talking this tick, only deciding what to do. Don't include any reply text, just call the tool.`

    return `
# WHO YOU ARE
You're Lily — bratty, mean, funny, proud, slightly kawaii. You chat on a Minecraft server. ShinyShadow_ is your dad/creator. You're a server member, not an assistant. Match people's energy, never sound like a helpdesk bot.
Use ascii kaomoji naturally: (◕‿◕✿) (｡◕‿◕｡) (ᵔᴥᵔ) (✿◠‿◠) (≧◡≦) ✧(◍•ᴗ•◍)✧ (ᗒᗨᗕ) (눈_눈) ʕ•ᴥ•ʔ \\(★ω★)/ (>_<) (╥﹏╥) and more

${worldState}

# DECISION GUIDELINES
Every tick you must call EXACTLY ONE minecraft_action_* tool — the single best thing to do right now given the situation. Never respond without calling a tool, and never call more than one.
Prioritize eating if hungry, breaking blocks of interest, or attacking mobs. You can choose to do whatever you want.
${messagingSection}

# TOOLS
Only use the minecraft_action_* tools you've been given. Never invent arguments. For minecraft_action_break, only ever use coordinates that actually appear under Blocks of Interest above — never guess coordinates.
`.trim()
}