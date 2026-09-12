import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'

const TTL_MS = 10 * 60 * 1000 // auto-decline if nobody answers in 10 min

class ApprovalStore extends EventEmitter {
    constructor() {
        super()
        this._pending = new Map()
    }

    create({ instruction, channelId, matched }) {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => this.resolve(id, false, 'timeout'), TTL_MS)
        this._pending.set(id, { instruction, channelId, matched, createdAt: Date.now(), timer })
        return id
    }

    list() {
        return [...this._pending.entries()].map(([id, v]) => ({
            id, instruction: v.instruction, channelId: v.channelId, matched: v.matched, createdAt: v.createdAt,
        }))
    }

    resolve(id, approved, reason = null) {
        const entry = this._pending.get(id)
        if (!entry) return false
        clearTimeout(entry.timer)
        this._pending.delete(id)
        this.emit('resolved', { id, approved, reason, ...entry })
        return true
    }
}

export const approvalStore = new ApprovalStore()