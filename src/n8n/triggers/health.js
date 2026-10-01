// src/n8n/triggers/health.js
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SCRIPT_PATH = '/srv/n8n/system-health/bin/run-agent.sh'
const SSH_USER = process.env.HEALTH_SSH_USER || 'izansola'
const TIMEOUT_MS = 1000 * 60 * 10

function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = ''
        req.on('data', (c) => (data += c))
        req.on('end', () => {
            if (!data) return resolve({})
            try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
    })
}

async function runLocal() {
    return execFileAsync(SCRIPT_PATH, [], {
        maxBuffer: 1024 * 1024 * 20,
        timeout: TIMEOUT_MS,
    })
}

async function runRemote(ip) {
    return execFileAsync('ssh', [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        `${SSH_USER}@${ip}`,
        SCRIPT_PATH,
    ], {
        maxBuffer: 1024 * 1024 * 20,
        timeout: TIMEOUT_MS,
    })
}

export default function start(port = 3400) {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run-health-check') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
        }

        const payload = await readJsonBody(req)
        const { tailscaleIp } = payload
        const isLocal = !tailscaleIp || tailscaleIp === 'local'

        try {
            const { stdout, stderr } = isLocal
                ? await runLocal()
                : await runRemote(tailscaleIp)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                stdout,
                stderr,
                target: isLocal ? 'local' : tailscaleIp,
            }))
        } catch (err) {
            console.error('health check failed:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                error: err.message,
                stderr: err.stderr || '',
            }))
        }
    })

    server.listen(port, () => console.log(`Health trigger listening on ${port}`))
    return server
}