// Cleanup trigger. Mirrors health.js:
//  - Local host (tailscaleIp 'local' / empty) → runs systemCleanup.sh directly.
//  - Remote host → pipes the bash script over SSH wrapped in a tiny Python shim.
//
// Why the shim? The remote's sshd_config locks the `healthssh` user to
// `ForceCommand /usr/bin/python3 -`, so we must arrive as Python. The script is
// base64-embedded in a wrapper that pipes it into `bash -s`. Nothing lands on
// the remote disk. Steps needing sudo skip gracefully without passwordless sudo.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { runPi, runSshStdin } from '../triggerUtils.js'

const execFileAsync = promisify(execFile)

const LOCAL_SCRIPT = '/srv/n8n/system-cleanup/bin/systemCleanup.sh'
const REPORTS_DIR = '/srv/n8n/system-cleanup/reports'
const TIMEOUT_MS = 1000 * 60 * 20                // cleanup can be slow

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

function runLocal() {
    console.log(`[cleanup trigger] local run → ${LOCAL_SCRIPT}`)
    return execFileAsync(LOCAL_SCRIPT, [], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
        detached: true,
    })
}

function runRemote(ip, sshUser) {
    console.log(`[cleanup trigger] remote ssh (stdin, python-wrapped) → ${ip}`)
    return runSshStdin({
        ip, sshUser,
        input: wrapBashAsPython(fs.readFileSync(LOCAL_SCRIPT, 'utf8')),
        timeoutMs: TIMEOUT_MS,
        label: 'remote cleanup',
    })
}

async function runCleanup({ tailscaleIp, sshUser }) {
    const isLocal = !tailscaleIp || tailscaleIp === 'local'
    const { stdout, stderr } = isLocal ? await runLocal() : await runRemote(tailscaleIp, sshUser)

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

    const { stdout: report } = await runPi(PROMPT, reviewInput, TIMEOUT_MS)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(REPORTS_DIR, `${stamp}-cleanup.md`)
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        fs.writeFileSync(outPath, report)
    } catch (e) {
        console.error(`[cleanup trigger] failed to write ${outPath}: ${e.message}`)
    }

    return { stdout: report + '\nReport saved to:\n' + outPath + '\n', stderr, target: isLocal ? 'local' : tailscaleIp }
}

export const routes = [
    {
        method: 'POST',
        path: '/run-cleanup',
        handler({ body }) {
            const isLocal = !body.tailscaleIp || body.tailscaleIp === 'local'
            console.log(`[cleanup trigger] payload=${JSON.stringify(body)} → ${isLocal ? 'LOCAL' : 'REMOTE ' + body.tailscaleIp}`)
            return runCleanup(body)
        },
    },
]