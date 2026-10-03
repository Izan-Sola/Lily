// discord/tools/sttsTools.js
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'
import { checkShrinkRatio, checkStubBodies } from '../../coding/codeEditShared.js'
import { approvalStore } from '../../ai/tools/riskyActionsManagement/approvalStore.js'
import { classifyRisk } from './riskyActionsManagement/riskClassifier.js'

const SUBMODULES = ['screenshot', 'pidev', 'coding']
const execFileAsync = promisify(execFile)

const PI_TIMEOUT_MS = 90_000
const SCREENSHOT_TIMEOUT_MS = 15_000
const FILE_APPEAR_TIMEOUT_MS = 3_000
const FILE_APPEAR_POLL_MS = 100
const COMPANION_REQUEST_TIMEOUT_MS = 5_000
const ASK_USER_TIMEOUT_MS = 120_000

// ─── Desktop/session detection ───────────────────────────────────────────

function detectDesktop() {
    const de = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase()
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase()
    return {
        isGnome: de.includes('gnome'),
        isKde: de.includes('kde') || de.includes('plasma'),
        isWayland: sessionType === 'wayland',
        de,
        sessionType,
    }
}

async function waitForFile(filePath, timeoutMs = FILE_APPEAR_TIMEOUT_MS, pollMs = FILE_APPEAR_POLL_MS) {
    const deadline = Date.now() + timeoutMs
    let lastSize = -1
    let stableCount = 0
    while (Date.now() < deadline) {
        try {
            const s = await stat(filePath)
            if (s.size > 0) {
                if (s.size === lastSize) {
                    stableCount++
                    if (stableCount >= 2) return true
                } else {
                    stableCount = 0
                    lastSize = s.size
                }
            }
        } catch { /* not there yet */ }
        await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return false
}

// ─── Screenshot capture strategies ───────────────────────────────────────

async function captureWindows(outPath) {
    const psPath = outPath.replace(/\\/g, '\\\\')
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
        '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
        '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
        `$bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        '$graphics.Dispose()',
        '$bmp.Dispose()',
    ].join('\n')

    await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: SCREENSHOT_TIMEOUT_MS },
    )
}

async function captureGnomeDbus(outPath) {
    const { stdout } = await execFileAsync('gdbus', [
        'call', '--session',
        '--dest', 'org.gnome.Shell.Screenshot',
        '--object-path', '/org/gnome/Shell/Screenshot',
        '--method', 'org.gnome.Shell.Screenshot.Screenshot',
        'false', 'false', outPath,
    ], { timeout: SCREENSHOT_TIMEOUT_MS })

    if (!/^\(true,/.test(stdout.trim())) {
        throw new Error(`gnome-shell reported failure: ${stdout.trim()}`)
    }
}

async function captureGnomeScreenshotCli(outPath) {
    await execFileAsync('gnome-screenshot', ['-f', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureSpectacle(outPath) {
    await execFileAsync('spectacle', ['-b', '-n', '-o', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureGrim(outPath) {
    await execFileAsync('grim', [outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureScrot(outPath) {
    await execFileAsync('scrot', ['-o', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureMaim(outPath) {
    await execFileAsync('maim', [outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureImportMagick(outPath) {
    await execFileAsync('import', ['-window', 'root', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

// ─── Ask-the-user popup strategies ───────────────────────────────────────

function cancelError() {
    return Object.assign(new Error('cancelled'), { cancelled: true })
}

async function askWindows(prompt) {
    const script = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$prompt = $env:LILY_ASK_PROMPT',
        '$result = [Microsoft.VisualBasic.Interaction]::InputBox($prompt, "Lily needs your input", "")',
        'Write-Output $result',
    ].join('\n')

    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
            timeout: ASK_USER_TIMEOUT_MS,
            env: { ...process.env, LILY_ASK_PROMPT: prompt },
        },
    )

    const value = stdout.replace(/\r?\n$/, '').trim()
    if (!value) throw cancelError()
    return value
}

async function askKdialog(prompt) {
    let stdout
    try {
        ({ stdout } = await execFileAsync(
            'kdialog',
            ['--title', 'Lily needs your input', '--inputbox', prompt],
            { timeout: ASK_USER_TIMEOUT_MS },
        ))
    } catch (e) {
        if (e.code === 1 && !e.killed) throw cancelError()
        throw e
    }
    const value = stdout.trim()
    if (!value) throw cancelError()
    return value
}

async function askZenity(prompt) {
    let stdout
    try {
        ({ stdout } = await execFileAsync(
            'zenity',
            ['--entry', '--title=Lily needs your input', `--text=${prompt}`],
            { timeout: ASK_USER_TIMEOUT_MS },
        ))
    } catch (e) {
        if (e.code === 1 && !e.killed) throw cancelError()
        throw e
    }
    const value = stdout.trim()
    if (!value) throw cancelError()
    return value
}

// ─── STTS Tool Executor ──────────────────────────────────────────────────
class SttsToolExecutor {
    constructor(sttsEnabled = false, pidevEnabled = false, codingEnabled = false, editCallback = null) {
        this.sttsEnabled = !!sttsEnabled
        this.pidevEnabled = !!pidevEnabled
        this.codingEnabled = !!codingEnabled
        this._editCallback = editCallback
        this._vscodeCompanionUrl = process.env.VSCODE_COMPANION_URL || 'http://localhost:8768'
        this._available = {
            screenshot: !!sttsEnabled,
            pidev: !!(sttsEnabled && pidevEnabled),
            coding: !!(sttsEnabled && codingEnabled),
        }
        this._enabled = { screenshot: true, pidev: true, coding: true }
        this._onApprovalNeeded = null
        this._pendingImages = []
    }

    setSubmoduleEnabled(key, enabled) {
        if (!SUBMODULES.includes(key)) {
            return { ok: false, reason: `"${key}" isn't a toggleable STTS submodule.` }
        }
        if (!this._available[key]) {
            return { ok: false, reason: `${key} wasn't started at boot (missing flag), so it can't be toggled. Restart with that flag to make it available.` }
        }
        this._enabled[key] = !!enabled
        Logger.info(`${key} tools ${enabled ? 'ENABLED' : 'DISABLED'}`, "MODULE TOGGLE")
        return { ok: true }
    }

    getSubmoduleStatus() {
        const status = {}
        for (const key of SUBMODULES) {
            status[key] = { available: this._available[key], enabled: this._available[key] && this._enabled[key] }
        }
        return status
    }

    get toolNames() {
        return this._activeToolDefs().map(t => t.function.name)
    }

    get tools() {
        return this._activeToolDefs()
    }

    _activeToolDefs() {
        const defs = []
        if (this._active('screenshot')) defs.push(SCREENSHOT_TOOL)
        if (this._active('pidev')) defs.push(RUN_COMMAND_TOOL, ASK_USER_TOOL)
        if (this._active('coding')) defs.push(EDIT_ACTIVE_FILE_TOOL, READ_ACTIVE_FILE_TOOL, CREATE_FILE_TOOL)
        return defs
    }

    takePendingImages() {
        const images = this._pendingImages
        this._pendingImages = []
        return images
    }

    async getScreenshot() {
        if (!this._active('screenshot')) return err("Screenshot tool isn't enabled.")

        let dir
        try {
            dir = await mkdtemp(path.join(tmpdir(), 'lily-shot-'))
            const file = path.join(dir, 'screenshot.png')

            const usedStrategy = await this._captureScreenshot(file)

            const buf = await readFile(file)
            this._pendingImages.push({ base64: buf.toString('base64'), mediaType: 'image/png' })

            Logger.info(`Captured screenshot via ${usedStrategy} (${(buf.length / 1024).toFixed(0)} KB)`, "STTS")
            return ok("Screenshot captured, it'll be attached to the conversation for you to see.")
        } catch (e) {
            Logger.error(`Screenshot failed: ${e.message}`, "STTS")
            return err("Couldn't capture the screen.")
        } finally {
            if (dir) await rm(dir, { recursive: true, force: true }).catch(() => { })
        }
    }

    setApprovalCallbacks({ onApprovalNeeded, onApprovalResult } = {}) {
        if (onApprovalNeeded) this._onApprovalNeeded = onApprovalNeeded
        // onApprovalResult is no longer used — the tool call itself now blocks
        // until the approval resolves, and its return value goes straight back
        // to the model. Kept in the signature for backward compatibility with
        // existing callers.
    }

    _screenshotStrategies() {
        if (process.platform === 'win32') {
            return [['windows', captureWindows]]
        }

        const { isGnome, isKde, isWayland } = detectDesktop()
        const strategies = []
        const seen = new Set()
        const add = (name, fn) => {
            if (seen.has(name)) return
            seen.add(name)
            strategies.push([name, fn])
        }

        if (isGnome) {
            add('gnome-dbus', captureGnomeDbus)
            add('gnome-screenshot', captureGnomeScreenshotCli)
        }
        if (isKde) {
            add('spectacle', captureSpectacle)
        }
        if (isWayland && !isGnome) {
            add('grim', captureGrim)
        }
        if (!isGnome) {
            add('gnome-dbus', captureGnomeDbus)
            add('gnome-screenshot', captureGnomeScreenshotCli)
        }
        if (!isKde) {
            add('spectacle', captureSpectacle)
        }
        if (isWayland) {
            add('grim', captureGrim)
        }
        add('scrot', captureScrot)
        add('maim', captureMaim)
        add('import', captureImportMagick)

        return strategies
    }

    async _captureScreenshot(outPath) {
        const strategies = this._screenshotStrategies()
        const failures = []

        for (const [name, run] of strategies) {
            try {
                await run(outPath)
            } catch (e) {
                failures.push(`${name}: ${e.message}`)
                continue
            }

            if (await waitForFile(outPath)) {
                return name
            }
            failures.push(`${name}: exited cleanly but no file appeared`)
        }

        throw new Error(
            failures.length
                ? `No screenshot tool available. Tried: ${failures.join(' | ')}`
                : 'No screenshot tool available'
        )
    }

    // ─── run_system_command ─────────────────────────────────────────────
    //
    // Flow (this is the whole point of this method):
    //   1. classifyRisk(prompt) against riskConfig.json.
    //   2. NOT risky  -> hand straight to pi. Return pi's output.
    //   3. Risky      -> create an entry in approvalStore, notify the control
    //      panel via _onApprovalNeeded, and BLOCK until the user clicks
    //      approve/deny (or the 10-min TTL auto-denies). Then:
    //        - denied  -> return an error to the model, nothing runs.
    //        - approved-> hand to pi, return pi's output.
    //
    // This makes approval work identically whether the request originated
    // from a Discord voice turn, a DM, or any other channel that routes
    // through this executor. The control panel is the single UI for
    // resolving approvals because approvalStore is a module singleton.
    async runSystemCommand(args = {}, context = {}) {
        if (!this._active('pidev')) {
            return err("System command tool isn't enabled.")
        }

        const { prompt } = args
        if (!prompt?.trim()) return err("prompt required.")

        const { risky, matched } = classifyRisk(prompt)

        if (!risky) {
            Logger.info(`Not risky, delegating to pi: ${prompt.slice(0, 200)}`, "STTS")
            return this._executeViaPi(prompt)
        }

        Logger.warning(`Risky command flagged (matched "${matched}"): ${prompt.slice(0, 200)}`, "APPROVAL")

        const approval = await this._requestApproval({
            instruction: prompt,
            channelId: context.channelId,
            matched,
        })

        if (!approval.approved) {
            Logger.warning(`Approval [${approval.id}] denied (${approval.reason ?? 'manual deny'})`, "APPROVAL")
            return err(`Risky command was denied (${approval.reason ?? 'manual deny'}). Nothing was executed.`)
        }

        Logger.info(`Approval [${approval.id}] granted, running via pi: ${prompt.slice(0, 200)}`, "APPROVAL")
        return this._executeViaPi(prompt)
    }

    // Creates the approval entry, pings the control panel, and returns a
    // promise that resolves with the {approved, reason} payload once the
    // user (or the TTL) resolves it. Filtered by id so concurrent approval
    // requests don't cross-resolve each other.
    _requestApproval({ instruction, channelId, matched }) {
        return new Promise((resolve) => {
            const id = approvalStore.create({ instruction, channelId, matched })

            try {
                this._onApprovalNeeded?.({ id, instruction, channelId, matched })
            } catch (e) {
                // If the push callback explodes, we still want the approval
                // visible in the control panel via its /api/approvals poll —
                // so log and continue rather than rejecting.
                Logger.error(`onApprovalNeeded callback threw: ${e.message}`, "APPROVAL")
            }

            const handler = (payload) => {
                if (payload.id !== id) return
                approvalStore.off('resolved', handler)
                resolve(payload)
            }
            approvalStore.on('resolved', handler)
        })
    }

    async _executeViaPi(prompt) {
        try {
            const report = await this._runPi(prompt)
            Logger.success(`pi finished: ${report.slice(0, 200)}`, "STTS")
            return ok(report || "Done, no output.")
        } catch (e) {
            Logger.error(`pi failed: ${e.message}`, "STTS")
            return err(e.message === 'timeout'
                ? "Pi took too long and was cut off."
                : "Pi ran into a problem executing that.")
        }
    }

    _runPi(prompt) {
        return new Promise((resolve, reject) => {
            const child = spawn('pi', ['-p', prompt], {
                stdio: ['ignore', 'pipe', 'pipe'],
            })

            let stdout = ''
            let stderr = ''
            child.stdout.on('data', d => { stdout += d })
            child.stderr.on('data', d => { stderr += d })

            const timer = setTimeout(() => {
                child.kill('SIGTERM')
                reject(new Error('timeout'))
            }, PI_TIMEOUT_MS)

            child.on('error', e => {
                clearTimeout(timer)
                reject(e)
            })

            child.on('close', (code) => {
                clearTimeout(timer)
                if (code === 0) resolve(stdout.trim() || stderr.trim())
                else reject(new Error(stderr.trim() || `pi exited with code ${code}`))
            })
        })
    }

    // ─── Ask-the-user popup ─────────────────────────────────────────────

    _askStrategies() {
        if (process.platform === 'win32') {
            return [['windows-inputbox', askWindows]]
        }

        const { isGnome, isKde } = detectDesktop()
        const strategies = []
        const seen = new Set()
        const add = (name, fn) => {
            if (seen.has(name)) return
            seen.add(name)
            strategies.push([name, fn])
        }

        if (isKde) {
            add('kdialog', askKdialog)
            add('zenity', askZenity)
        } else if (isGnome) {
            add('zenity', askZenity)
            add('kdialog', askKdialog)
        } else {
            add('zenity', askZenity)
            add('kdialog', askKdialog)
        }

        return strategies
    }

    async askUserForInput(args = {}) {
        if (!this._active('pidev')) {
            return err("Ask-user tool isn't enabled.")
        }

        const { prompt } = args
        if (!prompt?.trim()) return err("prompt required.")

        Logger.info(`Asking user for exact input: ${prompt.slice(0, 200)}`, "STTS")

        const strategies = this._askStrategies()
        const failures = []

        for (const [name, run] of strategies) {
            try {
                const value = await run(prompt)
                Logger.success(`User supplied via ${name}: ${value.slice(0, 200)}`, "STTS")
                return ok(`The user typed exactly: ${value}`)
            } catch (e) {
                if (e.cancelled) {
                    Logger.warning(`User cancelled the ${name} popup`, "STTS")
                    return err("The user closed the popup without typing anything. Don't ask again this turn — carry on with what you have, or ask out loud.")
                }
                failures.push(`${name}: ${e.message}`)
                continue
            }
        }

        Logger.error(`No input-popup tool available. Tried: ${failures.join(' | ')}`, "STTS")
        return err("Couldn't show the popup on this system.")
    }

    // ─── VSCode editing ─────────────────────────────────────────────────

    async editActiveFile(args = {}) {
        if (!this._active('coding')) {
            return err("VSCode editing tool isn't enabled.")
        }
        if (!this._editCallback) {
            return err("Editing isn't wired up right now.")
        }

        const { instruction } = args
        if (!instruction?.trim()) return err("instruction required.")

        let active
        try {
            const { data } = await axios.get(
                `${this._vscodeCompanionUrl}/active-file`,
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
            active = data
        } catch (e) {
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        if (!active?.path) return err("No file is currently open in VSCode.")

        Logger.info(`Editing ${active.path}: ${instruction.slice(0, 200)}`, "STTS")

        let newContent
        try {
            newContent = await this._editCallback(active.path, active.content, instruction)
        } catch (e) {
            Logger.error(`Edit generation failed: ${e.message}`, "STTS")
            return err("Couldn't come up with an edit for that.")
        }

        if (!newContent?.trim()) return err("Didn't get a usable edit back.")

        const blockReason =
            checkShrinkRatio(active.content, newContent, active.path) ??
            checkStubBodies(newContent, active.path)

        if (blockReason) {
            Logger.warning(`BLOCKED voice edit: ${blockReason}`, "STTS")
            return err("That edit looked like it would wipe out real code, so I didn't apply it. Try being more specific.")
        }

        try {
            await axios.post(
                `${this._vscodeCompanionUrl}/apply-edit`,
                { path: active.path, content: newContent },
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
        } catch (e) {
            Logger.error(`Apply failed: ${e.message}`, "STTS")
            return err("Generated the edit but couldn't apply it in VSCode.")
        }

        const fileName = active.path.split(/[\\/]/).pop()
        Logger.success(`Applied voice edit to ${fileName}`, "STTS")
        return ok(`Edited ${fileName}. It's applied in the editor as unsaved changes — check it over before saving.`)
    }

    async createFile(args = {}) {
        if (!this._active('coding')) {
            return err("VSCode file-creation tool isn't enabled.")
        }

        const { path: filePath, content, overwrite } = args
        if (!filePath?.trim()) return err("path required.")

        Logger.info(`Creating file: ${filePath}${overwrite ? ' (overwrite allowed)' : ''}`, "STTS")

        let data
        try {
            const { data: resData } = await axios.post(
                `${this._vscodeCompanionUrl}/create-file`,
                { path: filePath, content: content ?? '', overwrite: !!overwrite },
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
            data = resData
        } catch (e) {
            if (e.response?.status === 409) {
                return err(`A file already exists at ${filePath}. Ask the user if they want it overwritten, then retry with overwrite set to true.`)
            }
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        const fileName = filePath.split(/[\\/]/).pop()
        Logger.success(`Created ${fileName}${data.overwritten ? ' (overwritten)' : ''}`, "STTS")
        return ok(`Created ${fileName}${content ? ' with the given content' : ' (empty)'}. It's open in the editor now.`)
    }

    async readActiveFile() {
        if (!this._active('coding')) {
            return err("VSCode reading tool isn't enabled.")
        }

        let active
        try {
            const { data } = await axios.get(
                `${this._vscodeCompanionUrl}/active-file`,
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
            active = data
        } catch (e) {
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        if (!active?.path) return err("No file is currently open in VSCode.")

        Logger.info(`Read active file: ${active.path}`, "STTS")
        return ok(`File: ${active.path}\n\n${active.content}`)
    }

    _active(key) {
        return this._available[key] && this._enabled[key]
    }

    async execute(name, args, context = {}) {
        switch (name) {
            case "get_screenshot": return this.getScreenshot()
            case "run_system_command": return this.runSystemCommand(args, context)
            case "ask_user_for_input": return this.askUserForInput(args)
            case "edit_active_vscode_file": return this.editActiveFile(args)
            case "read_active_vscode_file": return this.readActiveFile()
            case "create_vscode_file": return this.createFile(args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

// ─── Tool Definitions ───────────────────────────────────────────────────

const SCREENSHOT_TOOL = {
    type: "function",
    function: {
        name: "get_screenshot",
        description:
            "Take a screenshot of the user's screen right now. Use this whenever they ask you to look at, check, or react to something visual on their screen ('check this out', 'see this', 'what's on my screen', 'look at this error') during a voice conversation. The image is attached automatically after you call this - just describe or react to what you see once it arrives.",
        parameters: { type: "object", properties: {} },
    },
}

const RUN_COMMAND_TOOL = {
    type: "function",
    function: {
        name: "run_system_command",
        description:
            "Delegate an operating-system task to Pi, your terminal-savvy assistant, when the user asks for something that requires actually touching the system (running a command or script, finding/editing a file, cleaning something up, checking system state, fixing a bug in a project on disk). Pass EXACTLY what the user said to Pi — Pi figures out the actual commands. Only use this for real system/file actions, not things you can already answer yourself. Note: if the request matches a risky pattern, it will be paused for the user's approval before Pi runs it — that's expected, not a failure. Don't retry it or rephrase it.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Exactly what the user asked for, e.g. 'Empty the trash and tell me how much space was freed'.",
                },
            },
            required: ["prompt"],
        },
    },
}

const ASK_USER_TOOL = {
    type: "function",
    function: {
        name: "ask_user_for_input",
        description:
            "Show the user a small popup on their screen where they can type an answer, and get the exact text back. Use this ONLY when you genuinely need information that has to be EXACT and can't be paraphrased or approximated — for example: a file path, a full filename, an exact variable/function/class name, a URL, an ID or token, an exact error string, a config key, a password, a version number, or the precise wording of something. Example: If a search for a file or app name fails, you can use this tool.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "What to show inside the popup. Ask a clear, specific question that makes it obvious what exact value you need, e.g. 'What's the full path to the log file you want me to check?' or 'Paste the exact function name you want renamed.'",
                },
            },
            required: ["prompt"],
        },
    },
}

const EDIT_ACTIVE_FILE_TOOL = {
    type: "function",
    function: {
        name: "edit_active_vscode_file",
        description:
            "Edit the file currently open/active in VSCode, based on a natural-language instruction (e.g. 'add error handling to this function', 'rename this variable to userId', 'fix the bug where it double-counts'). Use this when the user asks you to change, fix, or edit code in the editor during a voice conversation. Don't use this for questions about the code - only for actual edit requests. The edit is applied as unsaved changes in VSCode so the user can review and undo it.",
        parameters: {
            type: "object",
            properties: {
                instruction: {
                    type: "string",
                    description: "Clear natural-language description of the change to make to the currently open file.",
                },
            },
            required: ["instruction"],
        },
    },
}

const CREATE_FILE_TOOL = {
    type: "function",
    function: {
        name: "create_vscode_file",
        description:
            "Create a new file in the user's workspace, with or without initial content. Use this when the user asks you to make/create/add a new file ('make a new file called utils.js', 'create an empty README', 'create config.json with these settings'). Won't overwrite an existing file unless overwrite is explicitly true — if the file already exists and overwrite isn't set, this fails so nothing gets clobbered by accident; tell the user and confirm before retrying with overwrite. The new file opens in the editor once created.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Full absolute path for the new file, including filename and extension, e.g. '/home/user/project/src/utils.js'.",
                },
                content: {
                    type: "string",
                    description: "Initial file content. Omit or leave empty to create a blank file.",
                },
                overwrite: {
                    type: "boolean",
                    description: "Set true only if the user has explicitly confirmed they want to replace an existing file at that path. Defaults to false.",
                },
            },
            required: ["path"],
        },
    },
}

const READ_ACTIVE_FILE_TOOL = {
    type: "function",
    function: {
        name: "read_active_vscode_file",
        description:
            "Read the file currently open/active in VSCode without changing it. Use this when the user asks you to look at, explain, review, or answer questions about the code they're editing, or before making an edit if you need to see the current content first. Returns the file's path and full text content.",
        parameters: { type: "object", properties: {} },
    },
}

const STTS_TOOL_NAMES = new Set(
    [SCREENSHOT_TOOL, RUN_COMMAND_TOOL, ASK_USER_TOOL, EDIT_ACTIVE_FILE_TOOL, READ_ACTIVE_FILE_TOOL, CREATE_FILE_TOOL].map(t => t.function.name)
)

export { SttsToolExecutor, STTS_TOOL_NAMES }