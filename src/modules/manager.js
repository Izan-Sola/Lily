// modules/manager.js — owns the lifecycle of every module: real start/stop, hot swapping.
import { Logger } from '../utils/Logger.js'

/**
 * Module definition:
 *   name, label
 *   flag?:      CLI flag that starts it at boot (kept for pm2 / convenience)
 *   needs?:     modules that must be running first (started automatically when toggled on by hand)
 *   conflicts?: modules that can't run alongside it (stopped automatically, so toggling swaps them)
 *   start(ctx): set everything up, return a handle (or nothing); throw on failure
 *   stop(handle, ctx): tear everything down
 * ctx = { ai, runConfig, handle(name) }
 * Stopping a module stops everything that needs it first. All operations run one at a time.
 */
export class ModuleManager {
    constructor(defs, { ai, runConfig }) {
        this.defs = new Map(defs.map(d => [d.name, d]))
        this.running = new Map()   // name -> handle, in start order
        this.ctx = { ai, runConfig, handle: name => this.running.get(name) }
        this._queue = Promise.resolve()
    }

    status() {
        return Object.fromEntries([...this.defs.values()].map(d => [d.name, {
            label: d.label,
            running: this.running.has(d.name),
            needs: d.needs ?? [],
        }]))
    }

    start(name) { return this._run(() => this._start(name, true)) }
    stop(name) { return this._run(() => this._stop(name)) }

    /** Boot: start every module whose flag was passed, skipping those whose needs aren't up. */
    startFlagged(flags) {
        return this._run(async () => {
            for (const def of this.defs.values()) {
                if (!def.flag || !flags.has(def.flag)) continue
                const missing = (def.needs ?? []).filter(n => !this.running.has(n))
                if (missing.length) {
                    Logger.warning(`${def.label} skipped — needs ${missing.join(', ')}`, "MODULES")
                    continue
                }
                try { await this._start(def.name, false) } catch { /* already logged */ }
            }
        })
    }

    stopAll() {
        return this._run(async () => {
            for (const name of [...this.running.keys()].reverse()) await this._stop(name)
        })
    }

    // Serialised, never rejects: returns { ok } or { ok: false, error }.
    _run(fn) {
        const result = this._queue.then(fn).then(() => ({ ok: true }), err => ({ ok: false, error: err.message }))
        this._queue = result
        return result
    }

    _def(name) {
        const def = this.defs.get(name)
        if (!def) throw new Error(`Unknown module "${name}"`)
        return def
    }

    async _start(name, withDeps) {
        const def = this._def(name)
        if (this.running.has(name)) return

        for (const other of def.conflicts ?? []) await this._stop(other)
        for (const need of def.needs ?? []) {
            if (this.running.has(need)) continue
            if (!withDeps) throw new Error(`${def.label} needs ${need}`)
            await this._start(need, true)
        }

        try {
            const handle = await def.start(this.ctx)
            this.running.set(name, handle ?? true)
            Logger.success(`${def.label} started`, "MODULES")
        } catch (err) {
            Logger.error(`${def.label} failed to start: ${err.stack ?? err.message}`, "MODULES")
            throw err
        }
    }

    async _stop(name) {
        const def = this._def(name)
        if (!this.running.has(name)) return

        for (const dep of this.defs.values()) {
            if (dep.needs?.includes(name)) await this._stop(dep.name)
        }
        const handle = this.running.get(name)
        this.running.delete(name)
        try {
            await def.stop?.(handle, this.ctx)
            Logger.success(`${def.label} stopped`, "MODULES")
        } catch (err) {
            Logger.error(`${def.label} failed to stop cleanly: ${err.message}`, "MODULES")
        }
    }
}
