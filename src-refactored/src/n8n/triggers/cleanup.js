// src/n8n/triggers/cleanup.js
//
// Cleanup trigger server. Mirrors health.js:
//  - Local host (tailscaleIp === 'local') → runs systemCleanup.sh directly.
//  - Remote host → pipes the bash script over SSH as a Python shim.
//
// Why the Python shim? The remote's sshd_config locks the `healthssh`
// user to `ForceCommand /usr/bin/python3 -`. We want to run a bash
// script but must arrive as Python. So we base64-encode the bash, embed
// it in a tiny Python wrapper, and ship that. The wrapper decodes and
// pipes the bash into `bash -s`. No file lands on the remote disk.
//
// The remote still needs passwordless sudo for the script's system-wide
// steps (apt/pacman/journal/docker/etc.). Without it, those steps skip
// gracefully and the run still completes.

import http from 'node:http'
import { execFile, spawn, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const LOCAL_SCRIPT = '/srv/n8n/system-cleanup/bin/systemCleanup.sh'
const REMOTE_SCRIPT = LOCAL_SCRIPT               // same file — piped to remote
const REPORTS_DIR = '/srv/n8n/system-cleanup/reports'
const SSH_KEY = process.env.HEALTH_SSH_KEY || `${process.env.HOME}/.ssh/health_ed25519`
const DEFAULT_SSH_USER = process.env.HEALTH_SSH_USER || 'healthssh'
const TIMEOUT_MS = 1000 * 60 * 20                // 20 min — cleanup can be slow

// ── Resolve pi once ─────────────────────────────────────────
function resolveBinary(bin) {
    try {
        const out = execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim()
        return out || null
    } catch {
        return null
    }
}
const PI_BIN = process.env.PI_BIN || resolveBinary('pi') || 'pi'
console.log(`[cleanup trigger] using pi: ${PI_BIN}`)

// ── Process-group isolation (same rationale as health.js) ───
function killGroup(pid, signal = 'SIGKILL') {
    if (!pid) return
    try { process.kill(-pid, signal) }
    catch { /* group may already be gone */ }
}

const PROMPT = `
You are a Linux system maintenance analyst.

You are reviewing the OUTPUT of a non-interactive cleanup script
(systemCleanup.sh) that ran on a Zorin OS workstation.

The script performs the safe subset of:
 - APT/pacman/dnf/zypper cache cleanup
 - systemd journal vacuum
 - Rotated log & crash-report cleanup
 - User cache + thumbnail cleanup (browser caches, pip, etc.)
 - Developer caches (pip, npm, yarn, pnpm)
 - Docker / Podman dangling-image prune
 - Snap / Flatpak cleanup
 - Steam browser-cache cleanup
 - Orphaned dpkg configs

Rules:
- Do not invent numbers. If a size isn't in the output, say so.
- Never recommend destructive actions.
- Point out anything that failed, was skipped, or looks suspicious.
- Distinguish "skipped because no sudo" from "failed".

Start with a one-paragraph executive summary.

Then include:

# What Was Cleaned
# Errors & Warnings
# Skipped Steps
# Recommendations
# Things Worth Watching

End with:

## Priority Queue

A short numbered list (max 5) of anything worth a follow-up.

Finally state:

"No automatic changes were made beyond the cleanup script itself."

Here is the cleanup output:
`

function readCleanupScript() {
    return fs.readFileSync(REMOTE_SCRIPT, 'utf8')
}

function wrapBashAsPython(bashScript) {
    const b64 = Buffer.from(bashScript, 'utf8').toString('base64')
    return `import base64, subprocess, sys
SCRIPT = base64.b64decode("${b64}").decode()
r = subprocess.run(['bash', '-s'], input=SCRIPT, capture_output=True, text=True)
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
`
}

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

// Run pi with the raw cleanup output piped to stdin.
function runPiWithText(text) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PI_BIN, ['--no-tools', '--no-session', '-p', PROMPT], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        })
        let out = '', err = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.on('error', reject)

        const t = setTimeout(() => {
            killGroup(proc.pid, 'SIGKILL')
            reject(new Error('pi timed out'))
        }, TIMEOUT_MS)

        proc.on('close', (code) => {
            clearTimeout(t)
            if (code === 0) resolve({ stdout: out, stderr: err })
            else reject(new Error(`pi exited ${code}: ${err.slice(0, 500)}`))
        })

        proc.stdin.write(text)
        proc.stdin.end()
    })
}

async function runLocal() {
    console.log(`[cleanup trigger] local run → ${LOCAL_SCRIPT}`)
    const { stdout, stderr } = await execFileAsync(LOCAL_SCRIPT, [], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
        detached: true,
    })
    return { stdout, stderr }
}

async function runRemoteStdin(ip, sshUser) {
    const user = sshUser || DEFAULT_SSH_USER
    console.log(`[cleanup trigger] remote ssh (stdin, python-wrapped) → ${user}@${ip}`)

    const py = wrapBashAsPython(readCleanupScript())

    return new Promise((resolve, reject) => {
        const proc = spawn('ssh', [
            '-i', SSH_KEY,
            '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=15',
            `${user}@${ip}`,
            // NO command — sshd's ForceCommand runs `python3 -`
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        })

        let out = '', err = ''
        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.on('error', reject)

        const t = setTimeout(() => {
            killGroup(proc.pid, 'SIGKILL')
            reject(new Error('remote cleanup timed out'))
        }, TIMEOUT_MS)

        proc.on('close', (code) => {
            clearTimeout(t)
            if (code === 0) resolve({ stdout: out, stderr: err })
            else reject(new Error(`remote cleanup exited ${code}: ${err.slice(0, 500)}`))
        })

        proc.stdin.write(py)
        proc.stdin.end()
    })
}

async function runCleanup({ tailscaleIp, sshUser }) {
    const isLocal = !tailscaleIp || tailscaleIp === 'local'
    const { stdout, stderr } = isLocal
        ? await runLocal()
        : await runRemoteStdin(tailscaleIp, sshUser)

    // Save raw output for debugging.
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        const tag = isLocal ? 'local' : tailscaleIp.replace(/[^0-9a-z.-]/gi, '_')
        fs.writeFileSync(
            path.join(REPORTS_DIR, `last-cleanup-${tag}.log`),
            `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}\n`
        )
    } catch { /* non-fatal */ }

    // Hand it to pi for a reviewed, Markdown report.
    const reviewInput =
        `Target: ${isLocal ? 'local (minipc)' : tailscaleIp}\n\n` +
        `--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}\n`

    const { stdout: report } = await runPiWithText(reviewInput)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(REPORTS_DIR, `${stamp}-cleanup.md`)
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        fs.writeFileSync(outPath, report)
    } catch (e) {
        console.error(`[cleanup trigger] failed to write ${outPath}: ${e.message}`)
    }

    const finalStdout = report + '\nReport saved to:\n' + outPath + '\n'
    return { stdout: finalStdout, stderr, target: isLocal ? 'local' : tailscaleIp }
}

export default function start(port = 3402) {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/run-cleanup') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
        }

        const payload = await readJsonBody(req)
        const { tailscaleIp, sshUser } = payload
        const isLocal = !tailscaleIp || tailscaleIp === 'local'

        console.log(`[cleanup trigger] payload=${JSON.stringify(payload)} → ${isLocal ? 'LOCAL' : 'REMOTE ' + tailscaleIp}`)

        try {
            const result = await runCleanup({ tailscaleIp, sshUser })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
        } catch (err) {
            console.error('cleanup failed:', err.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message, stderr: err.stderr || '' }))
        }
    })

    server.listen(port, () => console.log(`Cleanup trigger listening on ${port}`))
    return server
}