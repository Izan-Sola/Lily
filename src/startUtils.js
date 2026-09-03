// Mode definitions - what we actually support
export const MODES = {
    // Modded Minecraft with ProjectKorra bending
    MODDED_BENDING: 'modded-bending',
    MODDED_BENDING_VTUBE: 'modded-bending-vtube',

    // Modded Minecraft without bending
    MODDED_NOBENDING: 'modded-nobending',
    MODDED_NOBENDING_VTUBE: 'modded-nobending-vtube',

    // Mineflayer (cracked server) 
    MINEFLAYER: 'mineflayer',
    MINEFLAYER_VTUBE: 'mineflayer-vtube'
}

// The only flags the parser recognizes. Anything else on the command line
// is ignored (so `node src/start.js modded discord` and `node src/start.js
// discord modded` are identical - order never matters, only presence).
const KNOWN_FLAGS = ['discord', 'modded', 'mineflayer', 'bending', 'vtube']

export function parseFlags(argv = process.argv.slice(2)) {
    return new Set(
        argv.map(f => f.toLowerCase()).filter(f => KNOWN_FLAGS.includes(f))
    )
}

// Turns the flag set into the same internal mode string the rest of the
// codebase already understands (isModdedMode / hasBending / etc. all just
// look for substrings, so nothing downstream needs to change).
export function getModeFromFlags(flags = parseFlags()) {
    const isModded = flags.has('modded')
    const isMineflayer = flags.has('mineflayer')

    if (isModded && isMineflayer) {
        throw new Error("Can't combine 'modded' and 'mineflayer' flags - they're alternate Minecraft backends, pick one")
    }

    let mode = isMineflayer ? 'mineflayer' : isModded ? 'modded' : 'discord'

    if (isModded) {
        mode += flags.has('bending') ? '-bending' : '-nobending'
    }

    if (flags.has('vtube')) {
        mode += '-vtube'
    }

    return mode
}

export function isDiscordEnabled(flags = parseFlags()) {
    return flags.has('discord')
}

export function isModdedMode(mode) {
    return mode.startsWith('modded')
}

export function isMineflayerMode(mode) {
    return mode.startsWith('mineflayer')
}

export function hasVtubeSupport(mode) {
    return mode.endsWith('-vtube')
}

export function hasBending(mode) {
    return mode.includes('bending') && !mode.includes('nobending')
}

export function getToolConfig(mode) {
    return {
        includeMinecraft: true,
        includeVtube: hasVtubeSupport(mode),
        includeBending: hasBending(mode),
        includeChat: false // Survival loop doesn't need chat tools
    }
}