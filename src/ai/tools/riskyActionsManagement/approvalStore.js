import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { getSection } from '../../config.js'

const DECIDED_KEEP_MS = 2 * 60_000 // lets pollers read the outcome after it resolves

// Pending human approvals. Events:
//   'created'  { id, instruction, tool, command, cwd, deviceId, matched, channelId, createdAt }
//   'resolved' { id, approved, reason, ...same fields }
class ApprovalStore extends EventEmitter {
    constructor() {
        super()
        this._pending = new Map()
        this._decided = new Map()
    }

    create({ instruction, channelId = null, matched = null, tool = null, command = null, cwd = null, deviceId = null }) {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => this.resolve(id, false, 'timeout'), getSection('timeouts').approvalTtlMs) // fail closed
        const entry = { instruction, channelId, matched, tool, command, cwd, deviceId, createdAt: Date.now() }
        this._pending.set(id, { ...entry, timer })
        this.emit('created', { id, ...entry })
        return id
    }

    list() {
        return [...this._pending.entries()].map(([id, { timer, ...v }]) => ({ id, ...v }))
    }

    // { status: 'pending' | 'approved' | 'denied', reason?, deviceId } or null if unknown/expired
    get(id) {
        const p = this._pending.get(id)
        if (p) return { status: 'pending', deviceId: p.deviceId }
        return this._decided.get(id) ?? null
    }

    resolve(id, approved, reason = null) {
        const entry = this._pending.get(id)
        if (!entry) return false
        clearTimeout(entry.timer)
        this._pending.delete(id)

        const { timer, ...rest } = entry
        this._decided.set(id, { status: approved ? 'approved' : 'denied', reason, deviceId: rest.deviceId })
        setTimeout(() => this._decided.delete(id), DECIDED_KEEP_MS).unref?.()

        this.emit('resolved', { id, approved, reason, ...rest })
        return true
    }

    cancel(id, reason = 'cancelled') {
        return this.resolve(id, false, reason)
    }
}

export const approvalStore = new ApprovalStore()