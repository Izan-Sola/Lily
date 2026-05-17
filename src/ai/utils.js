import axios from "axios"

// ─── Logger ─────────────────────────────────────────────────────────────
let logChannel = null

export async function initLogChannel(client) {
    for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.find(c => c.name === "hylily-livechat-logs" && c.isTextBased())
        if (ch) {
            logChannel = ch
            log(`📋 [LOGS] Log channel found: #${ch.name} in ${guild.name}`)
            break
        }
    }
    if (!logChannel) console.warn("⚠️ [LOGS] No hylily-livechat-logs channel found")
}

function sendToLogChannel(message) {
    const truncated = message.length > 1900 ? message.slice(0, 1900) + "..." : message
    logChannel?.send(`\`\`\`\n${truncated}\n\`\`\``).catch(() => { })
}

export function log(message) { console.log(message); sendToLogChannel(message) }
export function logError(message) { console.error(message); sendToLogChannel(`❌ ${message}`) }

// ─── Sanitize ───────────────────────────────────────────────────────────
export function sanitizeInput(raw) {
    if (!raw) return ""
    return raw
        .replace(/<@!?\d+>/g, '')
        .replace(/<@&\d+>/g, '')
        .replace(/<#\d+>/g, '')
        .replace(/<a?:\w+:\d+>/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?tool_call>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// ─── Tool Call Dedupe ───────────────────────────────────────────────────
export class ToolCallTracker {
    constructor(maxRepeats = 2) {
        this.maxRepeats = maxRepeats
        this.reset()
    }

    reset() {
        this.calls = new Map()
        this.results = new Map()
        return this
    }

    check(name, args, logFn) {
        const key = `${name}:${JSON.stringify(args)}`
        
        if (this.results.has(key)) {
            logFn(`📦 [CACHED] ${key}`)
            return this.results.get(key)
        }
        
        const count = (this.calls.get(key) || 0) + 1
        this.calls.set(key, count)
        
        if (count > this.maxRepeats) {
            logFn(`🚫 [BLOCKED] ${key} (x${count})`)
            return `[System: You already called ${name} with these arguments ${count - 1} times. Reply now without repeating.]`
        }
        
        return null
    }

    cacheResult(name, args, result, logFn) {
        const key = `${name}:${JSON.stringify(args)}`
        this.results.set(key, result)
        logFn(`💾 [CACHED] ${key}`)
        return result
    }
}