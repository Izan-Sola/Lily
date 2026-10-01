import http from 'node:http'
import { execFile, spawn, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const LOCAL_AGENT = '/srv/n8n/system-health/bin/run-agent.sh'
const REMOTE_COLLECT = '/srv/n8n/system-health/bin/collect.py'  // also the local source when piping
const REPORTS_DIR = '/srv/n8n/system-health/reports'
const SSH_KEY = process.env.HEALTH_SSH_KEY || `${process.env.HOME}/.ssh/health_ed25519`
const DEFAULT_SSH_USER = process.env.HEALTH_SSH_USER || 'healthssh'
const TIMEOUT_MS = 1000 * 60 * 10

// Resolve pi's absolute path once at startup, using a login shell so PATH is correct.
function resolveBinary(bin) {
    try {
        const out = execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim()
        return out || null
    } catch {
        return null
    }
}
const PI_BIN = process.env.PI_BIN || resolveBinary('pi') || 'pi'
console.log(`[health trigger] using pi: ${PI_BIN}`)

// Cache collect.py content for stdin-piping. Reloaded per-run so edits on minipc
// take effect immediately without restarting the panel.
function readCollectScript() {
    return fs.readFileSync(REMOTE_COLLECT, 'utf8')
}

const PROMPT = `
You are a Linux system reliability analyst.

You are reviewing a READ-ONLY diagnostic report from a Zorin OS workstation.

IMPORTANT:
- Do not execute commands.
- Do not suggest that you already changed anything.
- Do not assume a problem is serious without evidence.
- Distinguish facts from hypotheses.
- Do not recommend destructive actions casually.
- Never recommend deleting files merely because they are large.
- Never recommend disabling security features merely to make an error disappear.
- If information is unavailable, say so.
- Treat one-off anomalies differently from persistent trends.
- Compare the current report with the previous report whenever possible.
- Prioritize things that genuinely save the owner time.

Analyze the report deeply.

Look for:
1. Hardware/storage health problems.
2. Filesystem capacity and growth trends.
3. SMART/NVMe concerns.
4. Memory pressure, swap pressure, CPU/load anomalies.
5. Thermal concerns.
6. Failed systemd services.
7. Kernel/journal error patterns.
8. Repeated crashes or service failures.
9. Docker containers restarting or consuming abnormal resources.
10. Docker storage growth.
11. Package/update/reboot state.
12. Network/listening-service anomalies.
13. Suspicious or unusual resource consumers.
14. Git repositories that appear neglected or potentially problematic.
15. Changes since the previous report.
16. Anything that deserves human investigation but cannot be concluded from this data.

Do NOT merely repeat the raw measurements.

For each meaningful finding:
- explain what was observed
- explain why it matters
- estimate severity
- give a safe next investigation step

Use these severity levels:

CRITICAL = immediate risk of data loss, hardware failure, security issue, or major service outage.
HIGH = significant issue that should be investigated soon.
MEDIUM = useful maintenance/investigation item.
LOW = minor issue or optimization.
INFO = useful context with no action needed.

The report should be detailed but practical.

Start with an executive summary.

Then include:

# System Health
# Storage & Hardware
# CPU, Memory & Thermals
# Services & Logs
# Docker
# Packages & Updates
# Network
# Development / Git
# Changes Since Previous Scan
# Findings & Recommendations
# Things Worth Watching

At the end provide:

## Priority Queue

A numbered list of the most worthwhile things to investigate, maximum 10.

## Safe Next Steps

Only investigation commands or actions that do not modify the system.

Finally state:

"No automatic changes were made."

Here is the diagnostic JSON:
`

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

function runPiWithJson(json) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PI_BIN, ['--no-tools', '--no-session', '-p', PROMPT], {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = '', err = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.on('error', reject)

        const t = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { }
            reject(new Error('pi timed out'))
        }, TIMEOUT_MS)

        proc.on('close', (code) => {
            clearTimeout(t)
            if (code === 0) resolve({ stdout: out, stderr: err })
            else reject(new Error(`pi exited ${code}: ${err.slice(0, 500)}`))
        })

        proc.stdin.write(json)
        proc.stdin.end()
    })
}

function runLocal() {
    return execFileAsync(LOCAL_AGENT, [], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
    })
}

// ---- REMOTE MODE: file ---------------------------------------------------
// Old behavior. SSH the target, run collect.py from disk, get JSON back.
async function runRemoteFile(ip, sshUser) {
    const user = sshUser || DEFAULT_SSH_USER
    console.log(`[health trigger] remote ssh (file mode) → ${user}@${ip}`)

    const { stdout: json } = await execFileAsync('ssh', [
        '-i', SSH_KEY,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        `${user}@${ip}`,
        'python3', REMOTE_COLLECT,
    ], { maxBuffer: 1024 * 1024 * 50, timeout: TIMEOUT_MS })

    return json
}

// ---- REMOTE MODE: stdin --------------------------------------------------
// New behavior. Pipe collect.py into `python3 -` on the remote.
// Requires on the remote's sshd_config:
//     Match User healthssh
//         ForceCommand /usr/bin/python3 -
//         PermitTTY no
//         X11Forwarding no
//         AllowTcpForwarding no
//         AllowAgentForwarding no
//
// The remote needs NOTHING on disk. No collect.py, no exec bit, no shebang.
async function runRemoteStdin(ip, sshUser) {
    const user = sshUser || DEFAULT_SSH_USER
    console.log(`[health trigger] remote ssh (stdin mode) → ${user}@${ip}`)

    const script = readCollectScript()

    return new Promise((resolve, reject) => {
        const proc = spawn('ssh', [
            '-i', SSH_KEY,
            '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=15',
            `${user}@${ip}`,
            // NO command argument — sshd's ForceCommand runs `python3 -`
        ], { stdio: ['pipe', 'pipe', 'pipe'] })

        let out = '', err = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.on('error', reject)

        const t = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { }
            reject(new Error('remote ssh (stdin) timed out'))
        }, TIMEOUT_MS)

        proc.on('close', (code) => {
            clearTimeout(t)
            if (code === 0) resolve(out)
            else reject(new Error(`remote exited ${code}: ${err.slice(0, 500)}`))
        })

        proc.stdin.write(script)
        proc.stdin.end()
    })
}

// ---- REMOTE dispatch -----------------------------------------------------
async function runRemote(ip, sshUser, scriptMode) {
    const mode = (scriptMode || 'stdin').toLowerCase()
    let json

    if (mode === 'file') {
        json = await runRemoteFile(ip, sshUser)
    } else {
        json = await runRemoteStdin(ip, sshUser)
    }

    console.log(`[health trigger] got ${json.length} bytes from ${ip}, first 80: ${json.slice(0, 80).replace(/\n/g, ' ')}`)

    if (!json || json.length < 50) {
        throw new Error(`Empty or tiny response from ${ip}: ${JSON.stringify(json.slice(0, 200))}`)
    }
    if (!json.trimStart().startsWith('{')) {
        throw new Error(`Non-JSON output from ${ip}: ${json.slice(0, 200)}`)
    }

    // Save raw JSON for debugging (overwritten each run).
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        fs.writeFileSync(path.join(REPORTS_DIR, 'last-remote-raw.json'), json)
    } catch { }

    const { stdout, stderr } = await runPiWithJson(json)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(REPORTS_DIR, `${stamp}.md`)
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        fs.writeFileSync(outPath, stdout)
    } catch (e) {
        console.error(`[health trigger] failed to write ${outPath}: ${e.message}`)
    }

    const finalStdout = stdout + '\nReport saved to:\n' + outPath + '\n'
    return { stdout: finalStdout, stderr }
}

export default function start(port = 3400) {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run-health-check') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
        }

        const payload = await readJsonBody(req)
        const { tailscaleIp, sshUser, scriptMode } = payload
        const isLocal = !tailscaleIp || tailscaleIp === 'local'

        console.log(`[health trigger] payload=${JSON.stringify(payload)} → ${isLocal ? 'LOCAL' : 'REMOTE ' + tailscaleIp}`)

        try {
            const { stdout, stderr } = isLocal
                ? await runLocal()
                : await runRemote(tailscaleIp, sshUser, scriptMode)

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