// startUtils.js
//
// Flag parsing + a single config object derived from them. No mode
// strings anywhere internally - every caller reads booleans/backend name
// directly off the object getConfigFromFlags() returns, instead of
// re-parsing a string with startsWith/endsWith/includes.
//
// NOTE: the old MODES enum, getModeFromFlags, isModdedMode,
// isMineflayerMode, hasVtubeSupport, and hasBending(modeString) have all
// been removed. Anything still importing those names will now fail to
// import - that's intentional, grep for them and update the call site to
// read the equivalent field off the config object instead of adding the
// old functions back.

// The only flags the parser recognizes. Anything else on the command line
// is ignored (so `node src/start.js modded discord` and `node src/start.js
// discord modded` are identical - order never matters, only presence).
const KNOWN_FLAGS = ['discord', 'modded', 'mineflayer', 'bending', 'vtube']

export function parseFlags(argv = process.argv.slice(2)) {
    return new Set(
        argv.map(f => f.toLowerCase()).filter(f => KNOWN_FLAGS.includes(f))
    )
}

// The single source of truth for "what is this process configured to do".
//
// backend is null when neither 'modded' nor 'mineflayer' is set - NOT the
// string 'discord'. The old code conflated "no Minecraft backend" with
// the *unrelated* `discord` flag (whether the Discord bot logs in at
// all) by reusing the string 'discord' for both. Those are independent:
// you can run modded MC with no Discord bot, or a Discord-only bot with
// no MC backend at all. Keeping backend===null for the latter case avoids
// that collision.
export function getConfigFromFlags(flags = parseFlags()) {
    const isModded = flags.has('modded')
    const isMineflayer = flags.has('mineflayer')

    if (isModded && isMineflayer) {
        throw new Error("Can't combine 'modded' and 'mineflayer' flags - they're alternate Minecraft backends, pick one")
    }

    return {
        backend: isMineflayer ? 'mineflayer' : isModded ? 'modded' : null,
        bending: isModded && flags.has('bending'),
        vtube: flags.has('vtube'),
        discord: flags.has('discord'),
    }
}

// Cosmetic only - for log lines where you want a single human-readable
// label. Never branch on this string; read the config object's fields
// directly instead, the way describeConfig itself does.
export function describeConfig(config) {
    let label = config.backend ?? 'discord-only'
    if (config.bending) label += '-bending'
    if (config.vtube) label += '-vtube'
    return label
}

export function isDiscordEnabled(flags = parseFlags()) {
    return flags.has('discord')
}

export function isVtubeEnabled(flags = parseFlags()) {
    return flags.has('vtube')
}
export function isMineflayerEnabled(flags = parseFlags()) {
    return flags.has('mineflayer')
}
export function isModdedEnabled(flags = parseFlags()) {
    return flags.has('modded')
}
// Tool-config derivation for the survival loop / AI layer - takes the
// same config object everything else now uses, not a mode string.
export function getToolConfig(runConfig) {
    return {
        includeMinecraft: true,
        includeVtube: runConfig.vtube,
        includeBending: runConfig.bending,
        includeChat: false // Survival loop doesn't need chat tools
    }
}