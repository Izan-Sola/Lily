import { Logger } from "../utils/Logger.js"

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

// ─── Embedded <tool_call> parsing (JSON body or <function=...> XML body) ──
export function parseEmbeddedToolCalls(content) {
    const calls = []
    for (const [, raw] of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
        const inner = raw.trim()

        if (inner.startsWith("{")) {
            try {
                const parsed = JSON.parse(inner)
                let args = parsed.arguments ?? parsed.args ?? {}
                if (typeof args === "string") try { args = JSON.parse(args) } catch { args = {} }
                calls.push({ name: parsed.name, args })
                continue
            } catch { /* fall through to XML form */ }
        }

        const fn = inner.match(/<function=([^>]+)>([\s\S]*?)<\/function>/)
        if (!fn) continue
        const args = {}
        for (const [, key, val] of fn[2].matchAll(/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
            let value = val.trim()
            try { value = JSON.parse(value) } catch { /* keep as string */ }
            args[key.trim()] = value
        }
        calls.push({ name: fn[1].trim(), args })
    }
    return calls
}
