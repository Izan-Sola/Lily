// discord/tools/sttsTools.js
import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'
import { checkShrinkRatio, checkStubBodies } from '../../coding/codeEditShared.js'
import { approvalStore } from './riskyActionsManagement/approvalStore.js'
import { LOCAL_GATE_TOKEN } from './riskyActionsManagement/approvalRoutes.js'
import { fileURLToPath } from 'node:url'
import { getSection } from '../config.js'
import { createLocalDevice } from './deviceLocal.js'
import { getDevice, deviceContext } from './remoteDevices.js'

const SUBMODULES = ['screenshot', 'pidev', 'coding']

// Timeouts come from config.json "timeouts"; read on each access so edits apply live.
const T = new Proxy({}, { get: (_, key) => getSection('timeouts')[key] })

// ─── STTS Tool Executor ──────────────────────────────────────────────────
//
// Anything that touches "the user's machine" (screen, VS Code, popup, pi)
// goes through a device. context.deviceId picks it: unset → this machine
// (local voice, unchanged); "laptop" etc. → that remote web app.
// Edit generation, risk classification and approvals always stay on the brain.
class SttsToolExecutor {
    constructor(sttsEnabled = false, pidevEnabled = false, codingEnabled = false, editCallback = null) {
        this.sttsEnabled = !!sttsEnabled
        this.pidevEnabled = !!pidevEnabled
        this.codingEnabled = !!codingEnabled
        this._editCallback = editCallback
        this._local = createLocalDevice({
            timeouts: T,
            companionUrl: process.env.VSCODE_COMPANION_URL || 'http://localhost:8768',
            // pi on this machine calls back into the brain's /approval routes (see approvalRoutes.js).
            gate: {
                url: process.env.LILY_BRAIN_URL || `http://127.0.0.1:${process.env.PORT || 8770}`,
                token: LOCAL_GATE_TOKEN,
                deviceId: 'local',
                extensionPath: fileURLToPath(new URL('../pidev-bridge/lily-gate.ts', import.meta.url)),
            },
        })
        this._available = {
            screenshot: !!sttsEnabled,
            pidev: !!(sttsEnabled && pidevEnabled),
            coding: !!(sttsEnabled && codingEnabled),
        }
        this._enabled = { screenshot: true, pidev: true, coding: true }
        this._onCreated = null
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

    setApprovalCallbacks({ onApprovalNeeded } = {}) {
        // 'created' fires from the /approval/request route whenever pi asks for something risky.
        if (this._onCreated) approvalStore.off('created', this._onCreated)
        if (!onApprovalNeeded) return
        this._onCreated = (entry) => {
            try { onApprovalNeeded(entry) }
            catch (e) { Logger.error(`onApprovalNeeded callback threw: ${e.message}`, "APPROVAL") }
        }
        approvalStore.on('created', this._onCreated)
    }

    _active(key) {
        return this._available[key] && this._enabled[key]
    }

    // ─── screenshot ─────────────────────────────────────────────────────

    async getScreenshot(dev) {
        if (!this._active('screenshot')) return err("Screenshot tool isn't enabled.")
        try {
            const { buffer, via } = await dev.screenshot()
            this._pendingImages.push({ base64: buffer.toString('base64'), mediaType: 'image/png' })
            Logger.info(`Captured screenshot via ${via} (${(buffer.length / 1024).toFixed(0)} KB)`, "STTS")
            return ok("Screenshot captured, it'll be attached to the conversation for you to see.")
        } catch (e) {
            Logger.error(`Screenshot failed: ${e.message}`, "STTS")
            return err("Couldn't capture the screen.")
        }
    }

    // ─── run_system_command ─────────────────────────────────────────────
    //
    // Hands the request to pi as-is. Safety does NOT live here: pi runs with
    // --yolo plus the lily-gate extension, which asks the brain (/approval/request)
    // before every real bash/write/edit. Safe calls auto-approve, everything else
    // waits in the control panel and fails closed on deny/timeout.
    async runSystemCommand(args = {}, context = {}, dev) {
        if (!this._active('pidev')) return err("System command tool isn't enabled.")

        const { prompt } = args
        if (!prompt?.trim()) return err("prompt required.")

        Logger.info(`Delegating to pi: ${prompt.slice(0, 200)}`, "STTS")
        return this._executeViaPi(prompt, dev)
    }

    async _executeViaPi(prompt, dev) {
        try {
            const report = await dev.runPi(prompt)
            Logger.success(`pi finished: ${report.slice(0, 200)}`, "STTS")
            return ok(report || "Done, no output.")
        } catch (e) {
            Logger.error(`pi failed: ${e.message}`, "STTS")
            return err(e.message === 'timeout'
                ? "Pi took too long and was cut off."
                : "Pi ran into a problem executing that.")
        }
    }

    // ─── ask-the-user popup ─────────────────────────────────────────────

    async askUserForInput(args = {}, dev) {
        if (!this._active('pidev')) return err("Ask-user tool isn't enabled.")

        const { prompt } = args
        if (!prompt?.trim()) return err("prompt required.")

        Logger.info(`Asking user for exact input: ${prompt.slice(0, 200)}`, "STTS")
        try {
            const value = await dev.askUser(prompt)
            Logger.success(`User supplied: ${value.slice(0, 200)}`, "STTS")
            return ok(`The user typed exactly: ${value}`)
        } catch (e) {
            if (e.cancelled) {
                Logger.warning("User cancelled the popup", "STTS")
                return err("The user closed the popup without typing anything. Don't ask again this turn — carry on with what you have, or ask out loud.")
            }
            Logger.error(`Ask popup failed: ${e.message}`, "STTS")
            return err("Couldn't show the popup on this system.")
        }
    }

    // ─── VSCode editing ─────────────────────────────────────────────────

    async editActiveFile(args = {}, dev) {
        if (!this._active('coding')) return err("VSCode editing tool isn't enabled.")
        if (!this._editCallback) return err("Editing isn't wired up right now.")

        const { instruction } = args
        if (!instruction?.trim()) return err("instruction required.")

        let active
        try {
            active = await dev.activeFile()
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
            await dev.applyEdit(active.path, newContent)
        } catch (e) {
            Logger.error(`Apply failed: ${e.message}`, "STTS")
            return err("Generated the edit but couldn't apply it in VSCode.")
        }

        const fileName = active.path.split(/[\\/]/).pop()
        Logger.success(`Applied voice edit to ${fileName}`, "STTS")
        return ok(`Edited ${fileName}. It's applied in the editor as unsaved changes — check it over before saving.`)
    }

    async createFile(args = {}, dev) {
        if (!this._active('coding')) return err("VSCode file-creation tool isn't enabled.")

        const { path: filePath, content, overwrite } = args
        if (!filePath?.trim()) return err("path required.")

        Logger.info(`Creating file: ${filePath}${overwrite ? ' (overwrite allowed)' : ''}`, "STTS")

        let data
        try {
            data = await dev.createFile(filePath, content, overwrite)
        } catch (e) {
            if (e.status === 409) {
                return err(`A file already exists at ${filePath}. Ask the user if they want it overwritten, then retry with overwrite set to true.`)
            }
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        const fileName = filePath.split(/[\\/]/).pop()
        Logger.success(`Created ${fileName}${data.overwritten ? ' (overwritten)' : ''}`, "STTS")
        return ok(`Created ${fileName}${content ? ' with the given content' : ' (empty)'}. It's open in the editor now.`)
    }

    async readActiveFile(dev) {
        if (!this._active('coding')) return err("VSCode reading tool isn't enabled.")

        let active
        try {
            active = await dev.activeFile()
        } catch (e) {
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        if (!active?.path) return err("No file is currently open in VSCode.")

        Logger.info(`Read active file: ${active.path}`, "STTS")
        return ok(`File: ${active.path}\n\n${active.content}`)
    }

    async execute(name, args, context = {}) {
        // Set by the remote /turn route (AsyncLocalStorage); unset for local voice.
        const deviceId = context.deviceId ?? deviceContext.getStore()?.deviceId
        context = { ...context, deviceId }
        const dev = getDevice(deviceId, this._local)
        if (!dev) return err(`Unknown device "${deviceId}" — nothing was done.`)

        switch (name) {
            case "get_screenshot": return this.getScreenshot(dev)
            case "run_system_command": return this.runSystemCommand(args, context, dev)
            case "ask_user_for_input": return this.askUserForInput(args, dev)
            case "edit_active_vscode_file": return this.editActiveFile(args, dev)
            case "read_active_vscode_file": return this.readActiveFile(dev)
            case "create_vscode_file": return this.createFile(args, dev)
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
            "Delegate an operating-system task to Pi, your terminal-savvy assistant, when the user asks for something that requires actually touching the system (running a command or script, finding/editing a file, cleaning something up, checking system state, fixing a bug in a project on disk). Pass EXACTLY what the user said to Pi — Pi figures out the actual commands. Only use this for real system/file actions, not things you can already answer yourself. Note: individual commands Pi wants to run may be paused for the user's approval, or denied. That's expected, not a failure. If Pi reports something was denied or not allowed, don't retry it or rephrase it.",
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