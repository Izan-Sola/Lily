// approvalRoutes.js
//
// Brain-side endpoints the pi gate extension calls for every bash/write/edit.
//   POST /approval/request  -> classify; safe => {status:'approved',auto:true},
//                              otherwise create a control-panel approval => {status:'pending',id}
//   GET  /approval/:id      -> {status:'pending'|'approved'|'denied', reason?}
//
// The extension polls instead of holding one long request open, so slow
// humans don't hit HTTP header timeouts. Unknown/expired ids read as denied.
//
// Auth: Authorization: Bearer <token> + X-Lily-Device: <deviceId>.
//   deviceId "local" -> LOCAL_GATE_TOKEN (random per boot, only passed to the pi we spawn)
//   anything else    -> devices[deviceId].token from config.json (same as /turn)
import express from 'express'
import crypto from 'node:crypto'
import { Logger } from '../../../utils/Logger.js'
import { getSection } from '../../config.js'
import { approvalStore } from './approvalStore.js'
import { classifyToolCall } from './riskClassifier.js'

export const LOCAL_GATE_TOKEN = crypto.randomBytes(24).toString('hex')

const devices = () => { try { return getSection('devices') ?? {} } catch { return {} } }

function safeEq(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b))
    return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function authenticate(req) {
    const deviceId = String(req.headers['x-lily-device'] ?? '')
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const expected = deviceId === 'local' ? LOCAL_GATE_TOKEN : devices()[deviceId]?.token
    if (!deviceId || !expected || !safeEq(given, expected)) return null
    return deviceId
}

function describe({ tool, input, cwd, deviceId }) {
    const where = deviceId && deviceId !== 'local' ? `[on ${deviceId}] ` : ''
    const dir = cwd ? ` (cwd: ${cwd})` : ''
    if (tool === 'bash') return `${where}bash: ${input.command}${dir}`
    if (tool === 'write') return `${where}write ${input.path} (${input.bytes ?? '?'} bytes)${dir}`
    if (tool === 'edit') return `${where}edit ${input.path}${dir}`
    return `${where}${tool}: ${JSON.stringify(input).slice(0, 500)}${dir}`
}

export function createApprovalRouter() {
    const router = express.Router()

    router.post('/approval/request', express.json({ limit: '1mb' }), (req, res) => {
        const deviceId = authenticate(req)
        if (!deviceId) return res.status(401).json({ status: 'denied', reason: 'unauthorized' })

        const { tool, input = {}, cwd = null } = req.body ?? {}
        if (typeof tool !== 'string') return res.status(400).json({ status: 'denied', reason: 'bad request' })

        const verdict = classifyToolCall({ tool, input, cwd })
        const label = describe({ tool, input, cwd, deviceId })

        if (!verdict.risky) {
            Logger.info(`Auto-approved ${label.slice(0, 200)}`, 'APPROVAL')
            return res.json({ status: 'approved', auto: true })
        }

        const id = approvalStore.create({
            instruction: label,
            matched: verdict.matched,
            tool,
            command: tool === 'bash' ? input.command : null,
            cwd,
            deviceId,
        })
        Logger.warning(`Approval [${id}] needed (${verdict.matched}): ${label.slice(0, 200)}`, 'APPROVAL')
        res.json({ status: 'pending', id })
    })

    router.get('/approval/:id', (req, res) => {
        const deviceId = authenticate(req)
        if (!deviceId) return res.status(401).json({ status: 'denied', reason: 'unauthorized' })

        const state = approvalStore.get(req.params.id)
        if (!state || state.deviceId !== deviceId) return res.status(404).json({ status: 'denied', reason: 'unknown or expired' })
        res.json({ status: state.status, reason: state.reason ?? null })
    })

    return router
}