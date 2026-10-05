import { getSection } from './config.js'

// One in-flight turn per channel.
export class ChannelLocks {
    #held = new Set()

    isLocked(id) { return this.#held.has(id) }

    /** Waits for the lock, then runs fn. */
    async run(id, fn) {
        while (this.#held.has(id)) await new Promise(r => setTimeout(r, getSection('timeouts').channelLockPollMs))
        this.#held.add(id)
        try { return await fn() } finally { this.#held.delete(id) }
    }

    /** Runs fn only if the channel is free; otherwise { skipped: true }. */
    async tryRun(id, fn) {
        if (this.#held.has(id)) return { skipped: true }
        this.#held.add(id)
        try { return { skipped: false, result: await fn() } } finally { this.#held.delete(id) }
    }
}
