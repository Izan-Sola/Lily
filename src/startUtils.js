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

export function getModeFromEnv() {
    const mode = process.env.MODE || 'modded-bending'
    const vtube = process.env.VTS_ENABLED === 'true'

    if (vtube) {
        // Add -vtube suffix to the mode
        return `${mode}-vtube`
    }

    return mode
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