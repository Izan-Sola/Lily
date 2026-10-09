const KNOWN_FLAGS = ['discord', 'modded', 'mineflayer', 'bending', 'vtube', 'vrchat', 'coding', 'pidev', 'stts', 'browser', 'n8n'];

export function parseFlags(argv = process.argv.slice(2)) {
    return new Set(
        argv.map(f => f.toLowerCase()).filter(f => KNOWN_FLAGS.includes(f))
    )
}

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
        vrchat: flags.has('vrchat'),
        coding: flags.has('coding'),
        pidev: flags.has('pidev'),
        stts: flags.has('stts'),
        browser: flags.has('browser'),
        n8n: flags.has('n8n'),
    }
}


let runConfig = null

/** The parsed process flags, computed once. Throws on invalid flag combinations. */
export function getRunConfig() {
    return (runConfig ??= getConfigFromFlags(parseFlags()))
}

export function describeConfig(config) {
    let label = config.backend ?? 'discord-only'
    if (config.bending) label += '-bending'
    if (config.vtube) label += '-vtube'
    if (config.vrchat) label += '-vrchat'
    if (config.coding) label += '-coding'
    if (config.pidev) label += '-pidev'
    if (config.stts) label += '-stts'
    if (config.browser) label += '-browser'
    if (config.n8n) label += '-n8n' 
    return label
}


export function getToolConfig(runConfig = {}) {
    return {
        includeMinecraft: true,
        includeVtube: runConfig.vtube,
        includeBending: runConfig.bending,
        includeChat: false
    }
}