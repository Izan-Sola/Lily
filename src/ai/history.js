import { log } from './utils.js'

/**
 * Clean conversation history — stores only real exchanges.
 */
export class ConversationHistory {
    constructor(maxMessages = 10) {
        this.maxMessages = maxMessages
        this.messages = []
    }

    push(message) {
        if (!message || (!message.content && !message.tool_calls)) return

        if (message.role === "tool") {
            const content = message.content || ""
            if (content.includes("[System:") || content.includes("already called this tool")) return
        }

        this.messages.push(message)

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

    lastN(n) {
        return this.messages.slice(-n)
    }
}

/**
 * Raw chat buffer — recent channel chat from all users.
 * Filled passively via push(), or replaced wholesale via replace()
 * when exact channel history is available (e.g. on a ping).
 */
export class RawBuffer {
    constructor(maxMessages = 12) {
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
     * Replace buffer with pre-fetched lines (oldest first, "Author: content").
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