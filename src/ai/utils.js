import axios from "axios"

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

// ─── Trim a tool/memory result string to roughly maxTokens (≈4 chars/token) ──
export function trimToTokens(text, maxTokens = 400) {
    if (!text) return text
    const maxChars = maxTokens * 4
    if (text.length <= maxChars) return text
    return text.slice(0, maxChars) + "\n...(truncated)"
}

// ─── Tool Call Tracker (repeat counter only, no cache) ───────────────────
export class ToolCallTracker {
    constructor(maxRepeats = 1) {
        this.maxRepeats = maxRepeats
        this.calls = new Map()
    }

    check(name, args) {
        const key = `${name}:${JSON.stringify(args)}`
        const count = (this.calls.get(key) || 0) + 1
        this.calls.set(key, count)

        if (count > this.maxRepeats) {
            Logger.warning(`${key} (x${count})`, "BLOCKED")
            return `[System: You already called ${name} with these exact arguments ${count - 1} time(s). Stop calling it and reply now.]`
        }
        return null
    }
}