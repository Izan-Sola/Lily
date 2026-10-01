import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LOCAL_AGENT = '/srv/n8n/system-health/bin/run-agent.sh'
const REMOTE_COLLECT = '/srv/n8n/system-health/bin/collect.py'
const SSH_USER = process.env.HEALTH_SSH_USER || 'laptopssh'
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

function runAgentWithStdin(json) {
    return new Promise((resolve, reject) => {
        const proc = spawn(LOCAL_AGENT, [], { stdio: ['pipe', 'pipe', 'pipe'] })
        let out = '', err = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.on('close', (code) => {
            if (code === 0) resolve({ stdout: out, stderr: err })
            else reject(new Error(`run-agent.sh exited ${code}: ${err.slice(0, 500)}`))
        })
        proc.on('error', reject)
        const t = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { }
            reject(new Error('run-agent.sh timed out'))
        }, TIMEOUT_MS)
        proc.on('close', () => clearTimeout(t))
        proc.stdin.write(json)
        proc.stdin.end()
    })
}

async function runLocal() {
    return execFileAsync(LOCAL_AGENT, [], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
    })
}

const SSH_KEY = process.env.HEALTH_SSH_KEY || `${process.env.HOME}/.ssh/health_ed25519`

async function runRemote(ip) {
    const { stdout: json } = await execFileAsync('ssh', [
        '-i', SSH_KEY,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        `${SSH_USER}@${ip}`,
        REMOTE_COLLECT,
    ], { maxBuffer: 1024 * 1024 * 50, timeout: TIMEOUT_MS })
    return runAgentWithStdin(json)
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
            res.end(JSON.stringify({ stdout, stderr, target: isLocal ? 'local' : tailscaleIp }))
        } catch (err) {
            console.error('health check failed:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, stderr: err.stderr || '' }))
        }
    })

    server.listen(port, () => console.log(`Health trigger listening on ${port}`))
    return server
}