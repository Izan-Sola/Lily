// discord/tools/remoteDevices.js
//
// Brain side of "STTS on other devices".
//
//   getDevice(id, local)      → object with the same interface as deviceLocal's
//                               device, but every call is forwarded to the
//                               remote web app. No id / "local" → the minipc.
//   deviceContext             → AsyncLocalStorage carrying { deviceId } through a turn,
//                               so ai.chat() needs no changes.
//   createTurnRouter(handle)  → Express router: remote web apps POST their
//                               transcript here and get the reply text back.
//
// config.json (brain):
//   "devices": { "laptop": { "url": "http://<laptop-ip>:3131", "token": "<secret>" } }
import express from 'express'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getSection } from '../config.js'

export const deviceContext = new AsyncLocalStorage()
const devices = () => { try { return getSection('devices') ?? {} } catch { return {} } }
const T = new Proxy({}, { get: (_, k) => getSection('timeouts')[k] })
const SLACK_MS = 5000 // device enforces its own op timeout; ours must outlast it

function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b))
    return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export function getDevice(id, local) {
    if (!id || id === 'local') return local
    const d = devices()[id]
    if (!d?.url || !d?.token) return null // unknown device: never fall back to the minipc

    const call = async (op, body, ms) => {
        const res = await fetch(`${d.url}/device/${op}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(ms + SLACK_MS),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw Object.assign(new Error(data.error || `device ${id}: HTTP ${res.status}`), { status: res.status })
        return data
    }

    return {
        async screenshot() {
            const { base64, via } = await call('screenshot', {}, T.screenshotMs * 4)
            return { buffer: Buffer.from(base64, 'base64'), via: `${id}/${via}` }
        },
        async askUser(prompt) {
            const data = await call('ask', { prompt }, T.askUserMs)
            if (data.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true })
            return data.value
        },
        activeFile: () => call('active-file', {}, T.companionRequestMs),
        applyEdit: (path, content) => call('apply-edit', { path, content }, T.companionRequestMs),
        createFile: (path, content, overwrite) => call('create-file', { path, content, overwrite }, T.companionRequestMs),
        runPi: async (prompt) => (await call('pi', { prompt }, T.piMs)).output,
    }
}

// handleTurn(text) → Promise<string reply>. Runs inside deviceContext, so every
// tool call made during the turn targets the calling device.
// Remote turns run one at a time: the executors keep per-turn state
// (e.g. pending screenshots), so overlapping turns would mix it up.
export function createTurnRouter(handleTurn) {
    const router = express.Router()
    let queue = Promise.resolve()

    router.post('/turn', express.json({ limit: '1mb' }), async (req, res) => {
        const { text, deviceId } = req.body ?? {}
        const d = devices()[deviceId]
        const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (!d?.token || !safeEq(given, d.token)) return res.status(401).json({ error: 'unauthorized' })
        if (!text?.trim()) return res.status(400).json({ error: 'no text' })

        const turn = queue.then(() => deviceContext.run({ deviceId }, () => handleTurn(text.trim())))
        queue = turn.catch(() => { })
        try {
            res.json({ reply: (await turn) ?? '' })
        } catch (e) {
            res.status(500).json({ error: e.message })
        }
    })
    return router
}