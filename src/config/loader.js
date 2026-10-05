// Shared JSON config loader: one cached parse per file, live reload via
// fs.watch, and a deep-merge over in-code defaults. A bad edit on disk keeps
// the previous values instead of crashing.
import fs from 'node:fs'
import { Logger } from '../utils/Logger.js'

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

export function deepMerge(base, override) {
    if (!isObj(override)) return base
    const out = { ...base }
    for (const [k, v] of Object.entries(override)) {
        out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v
    }
    return out
}

/**
 * @param {string} file      absolute path to the JSON file
 * @param {object} [o]
 * @param {object} [o.defaults]  merged under the file contents
 * @param {boolean} [o.watch=true] reload when the file changes
 * @param {boolean} [o.strict=false] throw if the file can't be loaded and nothing is cached
 * @param {string} [o.name]  label for log lines
 * @returns {{ get(): object, section(name: string): object, reload(): object }}
 */
export function createConfig(file, { defaults = {}, watch = true, strict = false, name = file } = {}) {
    let cache = null
    let timer = null
    let lastError = null

    const read = () => {
        try {
            return deepMerge(defaults, JSON.parse(fs.readFileSync(file, 'utf8')))
        } catch (err) {
            lastError = err
            if (err.code !== 'ENOENT') Logger.error(`${name}: failed to read/parse, keeping previous values: ${err.message}`, 'CONFIG')
            return null
        }
    }

    const reload = () => {
        cache = read() ?? cache
        if (!cache) {
            if (strict) throw lastError
            cache = defaults
        }
        return cache
    }

    const arm = () => {
        try {
            const watcher = fs.watch(file, event => {
                clearTimeout(timer)
                timer = setTimeout(() => {
                    const next = read()
                    if (next) { cache = next; Logger.info(`${name} reloaded`, 'CONFIG') }
                }, 150)
                // Editors that save via temp-file + rename drop the watch; re-arm.
                if (event === 'rename') { watcher.close(); setTimeout(arm, 150) }
            })
            watcher.unref()
        } catch { /* file missing or unwatchable: cached value stays valid */ }
    }

    return {
        get() {
            if (!cache) { reload(); if (watch) arm() }
            return cache
        },
        section(key) { return this.get()[key] ?? {} },
        reload,
    }
}
