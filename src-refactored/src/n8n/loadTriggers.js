// src/n8n/loadTriggers.js
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { Logger } from '../utils/Logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRIGGERS_DIR = path.join(__dirname, 'triggers')

export async function loadAllTriggers() {
    const handles = []
    let files
    try {
        files = readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.js'))
    } catch (err) {
        Logger.warning(`No triggers directory found: ${err.message}`, "N8N TRIGGERS")
        return handles
    }

    for (const file of files) {
        try {
            const mod = await import(pathToFileURL(path.join(TRIGGERS_DIR, file)).href)
            const start = mod.default
            if (typeof start !== 'function') {
                Logger.warning(`${file} has no default export function, skipping`, "N8N TRIGGERS")
                continue
            }
            const handle = await start()
            handles.push({ file, handle })
            Logger.success(`Trigger loaded: ${file}`, "N8N TRIGGERS")
        } catch (err) {
            Logger.error(`Failed to load trigger ${file}: ${err.message}`, "N8N TRIGGERS")
        }
    }

    return handles
}