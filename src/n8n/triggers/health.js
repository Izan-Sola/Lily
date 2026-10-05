import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { runPi, runSshStdin, sshBaseArgs } from '../triggerUtils.js'

const execFileAsync = promisify(execFile)

const LOCAL_AGENT = '/srv/n8n/system-health/bin/run-agent.sh'
const REMOTE_COLLECT = '/srv/n8n/system-health/bin/collect.py'  // also the local source when piping
const REPORTS_DIR = '/srv/n8n/system-health/reports'
const TIMEOUT_MS = 1000 * 60 * 10

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

// ---- REMOTE MODE: file ---------------------------------------------------
// SSH the target, run collect.py from its disk, get JSON back.
async function runRemoteFile(ip, sshUser) {
    console.log(`[health trigger] remote ssh (file mode) → ${ip}`)
    const { stdout } = await execFileAsync('ssh', [...sshBaseArgs(ip, sshUser), 'python3', REMOTE_COLLECT], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
        detached: true,
    })
    return stdout
}

// ---- REMOTE MODE: stdin --------------------------------------------------
// Pipe collect.py into `python3 -` on the remote. Requires on the remote's sshd_config:
//     Match User healthssh
//         ForceCommand /usr/bin/python3 -
//         PermitTTY no
//         X11Forwarding no
//         AllowTcpForwarding no
//         AllowAgentForwarding no
// The remote needs NOTHING on disk. Script is re-read per run so edits apply immediately.
async function runRemoteStdin(ip, sshUser) {
    console.log(`[health trigger] remote ssh (stdin mode) → ${ip}`)
    const { stdout } = await runSshStdin({
        ip, sshUser,
        input: fs.readFileSync(REMOTE_COLLECT, 'utf8'),
        timeoutMs: TIMEOUT_MS,
        label: 'remote ssh (stdin)',
    })
    return stdout
}

async function runRemote(ip, sshUser, scriptMode) {
    const mode = (scriptMode || 'stdin').toLowerCase()
    const json = mode === 'file' ? await runRemoteFile(ip, sshUser) : await runRemoteStdin(ip, sshUser)

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

    const { stdout, stderr } = await runPi(PROMPT, json, TIMEOUT_MS)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(REPORTS_DIR, `${stamp}.md`)
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true })
        fs.writeFileSync(outPath, stdout)
    } catch (e) {
        console.error(`[health trigger] failed to write ${outPath}: ${e.message}`)
    }

    return { stdout: stdout + '\nReport saved to:\n' + outPath + '\n', stderr }
}

// run-agent.sh calls collect.py and pi itself. Detached so it can't signal LilyBrain.
function runLocal() {
    return execFileAsync(LOCAL_AGENT, [], {
        maxBuffer: 1024 * 1024 * 50,
        timeout: TIMEOUT_MS,
        detached: true,
    })
}

export const routes = [
    {
        method: 'POST',
        path: '/run-health-check',
        async handler({ body }) {
            const { tailscaleIp, sshUser, scriptMode } = body
            const isLocal = !tailscaleIp || tailscaleIp === 'local'
            console.log(`[health trigger] payload=${JSON.stringify(body)} → ${isLocal ? 'LOCAL' : 'REMOTE ' + tailscaleIp}`)

            const { stdout, stderr } = isLocal
                ? await runLocal()
                : await runRemote(tailscaleIp, sshUser, scriptMode)
            return { stdout, stderr, target: isLocal ? 'local' : tailscaleIp }
        },
    },
]