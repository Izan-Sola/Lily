// src/n8n/loadTriggers.js
//
// One HTTP server for every n8n trigger. Each file in ./triggers exports:
//
//   export const routes = [
//       { method: 'POST', path: '/run-something', handler: async ({ body, req }) => ({ ...json }) },
//   ]
//
// The handler returns a JSON-serialisable object (sent as 200). Throwing sends
// a 500 { error, stderr } (set err.status to override the code).
import http from 'node:http'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { Logger } from '../utils/Logger.js'
import { readJsonBody } from './triggerUtils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRIGGERS_DIR = path.join(__dirname, 'triggers')
const DEFAULT_PORT = parseInt(process.env.N8N_TRIGGER_PORT ?? '3400')

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
}

async function loadRoutes() {
    const routes = new Map()   // "METHOD /path" -> { handler, file }
    let files
    try {
        files = readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.js'))
    } catch (err) {
        Logger.warning(`No triggers directory found: ${err.message}`, "N8N TRIGGERS")
        return routes
    }

    for (const file of files) {
        try {
            const mod = await import(pathToFileURL(path.join(TRIGGERS_DIR, file)).href)
            if (!Array.isArray(mod.routes)) {
                Logger.warning(`${file} has no exported 'routes' array, skipping`, "N8N TRIGGERS")
                continue
            }
            for (const { method = 'POST', path: routePath, handler } of mod.routes) {
                const key = `${method.toUpperCase()} ${routePath}`
                if (typeof handler !== 'function' || !routePath) {
                    Logger.warning(`${file}: invalid route definition, skipping`, "N8N TRIGGERS")
                } else if (routes.has(key)) {
                    Logger.warning(`${file}: duplicate route ${key} (already from ${routes.get(key).file}), skipping`, "N8N TRIGGERS")
                } else {
                    routes.set(key, { handler, file })
                    Logger.success(`Route registered: ${key} (${file})`, "N8N TRIGGERS")
                }
            }
        } catch (err) {
            Logger.error(`Failed to load trigger ${file}: ${err.message}`, "N8N TRIGGERS")
        }
    }
    return routes
}

export async function startTriggerServer(port = DEFAULT_PORT) {
    const routes = await loadRoutes()
    if (!routes.size) Logger.warning('No trigger routes registered', "N8N TRIGGERS")

    const server = http.createServer(async (req, res) => {
        const { pathname } = new URL(req.url, 'http://localhost')
        const route = routes.get(`${req.method} ${pathname}`)
        if (!route) return sendJson(res, 404, { error: 'not found' })

        try {
            const body = await readJsonBody(req)
            const result = await route.handler({ body, req })
            sendJson(res, 200, result ?? {})
        } catch (err) {
            Logger.error(`${req.method} ${pathname} failed: ${err.message}`, "N8N TRIGGERS")
            if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message, stderr: err.stderr || '' })
        }
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, resolve)
    })
    Logger.success(`Trigger server listening on ${port}`, "N8N TRIGGERS")
    return server
}