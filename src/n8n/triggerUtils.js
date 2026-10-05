// src/n8n/triggerUtils.js — helpers shared by every trigger in ./triggers
import { spawn, execFileSync } from 'node:child_process'

// ── Binary resolution (lazy + memoized) ─────────────────────
export function resolveBinary(bin) {
    try {
        const out = execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim()
        return out || null
    } catch {
        return null
    }
}

let piBin
export function getPiBin() {
    if (!piBin) {
        piBin = process.env.PI_BIN || resolveBinary('pi') || 'pi'
        console.log(`[triggers] using pi: ${piBin}`)
    }
    return piBin
}

// ── HTTP ────────────────────────────────────────────────────
export function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = ''
        req.on('data', (c) => (data += c))
        req.on('end', () => {
            if (!data) return resolve({})
            try { resolve(JSON.parse(data)) } catch { resolve({}) }
        })
    })
}

// ── Process-group isolation ─────────────────────────────────
// Every external process (pi, ssh, ...) runs `detached` in its OWN process
// group. Otherwise a child that signals its group on cleanup (kill(0, SIGINT))
// would signal LilyBrain too. killGroup() kills the whole group, so orphans
// (llama-server, shell wrappers...) die on timeout as well.
export function killGroup(pid, signal = 'SIGKILL') {
    if (!pid) return
    try { process.kill(-pid, signal) }
    catch { /* group may already be gone */ }
}

/** Spawn a detached process, optionally feed it stdin, collect stdout/stderr. */
export function runProcess(cmd, args, { input, timeoutMs, label = cmd } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        let out = '', err = ''

        const t = timeoutMs && setTimeout(() => {
            killGroup(proc.pid, 'SIGKILL')
            reject(Object.assign(new Error(`${label} timed out`), { stderr: err }))
        }, timeoutMs)

        proc.stdout.on('data', (d) => (out += d))
        proc.stderr.on('data', (d) => (err += d))
        proc.stdin.on('error', () => { /* child exited before reading all input */ })
        proc.on('error', (e) => { clearTimeout(t); reject(e) })
        proc.on('close', (code) => {
            clearTimeout(t)
            if (code === 0) resolve({ stdout: out, stderr: err })
            else reject(Object.assign(new Error(`${label} exited ${code}: ${err.slice(0, 500)}`), { stderr: err }))
        })

        if (input != null) proc.stdin.write(input)
        proc.stdin.end()
    })
}

/** Run pi (no tools, no session) with `prompt` as the instruction and `input` on stdin. */
export function runPi(prompt, input, timeoutMs) {
    return runProcess(getPiBin(), ['--no-tools', '--no-session', '-p', prompt], { input, timeoutMs, label: 'pi' })
}

// ── SSH ─────────────────────────────────────────────────────
export const SSH_KEY = process.env.HEALTH_SSH_KEY || `${process.env.HOME}/.ssh/health_ed25519`
export const DEFAULT_SSH_USER = process.env.HEALTH_SSH_USER || 'healthssh'

export function sshBaseArgs(ip, sshUser) {
    return [
        '-i', SSH_KEY,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        `${sshUser || DEFAULT_SSH_USER}@${ip}`,
    ]
}

/**
 * Pipe `input` to the remote over SSH with NO command argument: the remote
 * sshd's `ForceCommand /usr/bin/python3 -` executes it (so `input` must be Python).
 */
export function runSshStdin({ ip, sshUser, input, timeoutMs, label = 'remote ssh' }) {
    return runProcess('ssh', sshBaseArgs(ip, sshUser), { input, timeoutMs, label })
}