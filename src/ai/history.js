import { log } from './utils.js'

/**
 * Clean conversation history — stores only actual exchanges,
 * filters out malformed tool nonsense.
 */
export class ConversationHistory {
    constructor(maxMessages = 20) {
        this.maxMessages = maxMessages
        this.messages = []
    }

    push(message) {
        // Skip empty or invalid messages
        if (!message || (!message.content && !message.tool_calls)) return

        // Don't store tool responses that are just system blocks
        if (message.role === "tool") {
            const content = message.content || ""
            if (content.includes("[System:") || content.includes("already called this tool")) return
        }

        this.messages.push(message)

        // Trim to max
        if (this.messages.length > this.maxMessages) {
            this.messages.splice(0, this.messages.length - this.maxMessages)
        }
    }

    get() {
        return [...this.messages]
    }

    clear() {
        this.messages = []
    }

    length() {
        return this.messages.length
    }

    // Get last N messages for context
    lastN(n) {
        return this.messages.slice(-n)
    }
}

/**
 * Raw chat buffer — keeps recent chat from all users.
 * Can be passively filled via push(), or replaced wholesale
 * via replace() when we have exact channel history (e.g. on a ping).
 */
export class RawBuffer {
    constructor(maxMessages = 20) {
        this.maxMessages = maxMessages
        this.messages = []
    }

    push(authorName, content) {
        this.messages.push(`${authorName}: ${content}`)
        if (this.messages.length > this.maxMessages) {
            this.messages.shift()
        }
    }

    /**
     * Replace the buffer's contents with a pre-fetched set of lines.
     * Pass an array of already-formatted "AuthorName: content" strings,
     * oldest first. Trims to maxMessages automatically.
     */
    replace(lines) {
        this.messages = lines.slice(-this.maxMessages)
    }

    get() {
        return [...this.messages]
    }

    clear() {
        this.messages = []
    }
}