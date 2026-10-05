import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'
import { getActionNames, triggerAvatarAction } from '../../vrchatBot/bot/avatarActions.js'

// ─── VRChat Tool Executor ────────────────────────────────────────────────
//
// Runs in the VRChat-avatar context. Talks straight to avatarActions.js
// (OSC VRCEmote triggers) — no async connection to wait on like
// mcSend/vtsClient, since the OSC port is a synchronous UDP socket
// already opened by initOsc() before the vrchat channel can receive any
// message, so unlike Minecraft/VTube this executor needs no injected
// handle and no setter. Importing this module (via toolRouter.js, always
// loaded regardless of which flags this process was started with) has no
// side effects — it just defines functions, same precedent as Lily.js's
// always-on minecraft getStateController import.
class VrchatToolExecutor {
    get toolNames() {
        return VRCHAT_TOOL_NAMES
    }

    get tools() {
        return VRCHAT_TOOLS
    }

    async triggerAction(args = {}) {
        const { action } = args
        if (!action) return err("action required.")

        let result
        try {
            result = triggerAvatarAction(action)
        } catch (e) {
            Logger.error(e.message, "VRCHAT")
            return err("Failed to trigger avatar action.")
        }

        // triggerAvatarAction returns a plain description string either way
        // (no separate ok/err shape) — success text always starts with
        // "Triggered", the invalid-action message is the only failure case.
        const failed = result.toLowerCase().includes("isn't a valid action")
        Logger.info(result, "VRCHAT")
        return failed ? err(result) : ok(result)
    }

    async execute(name, args) {
        switch (name) {
            case "trigger_avatar_action": return this.triggerAction(args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

// ─── Tool Definitions ───────────────────────────────────────────────────

const VRCHAT_TOOLS = [
    {
        type: "function",
        function: {
            name: "trigger_avatar_action",
            description:
                "Play one of your avatar's built-in physical actions in VRChat (waving, dancing, etc). Use it only when it actually fits the moment -- don't force it into every reply. Looping actions (like dancing) stop themselves automatically after a few seconds, no need to stop them yourself. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: getActionNames(),
                        description: "Which action to play.",
                    },
                },
                required: ["action"],
            },
        },
    },
]

const VRCHAT_TOOL_NAMES = new Set(VRCHAT_TOOLS.map(t => t.function.name))

export { VrchatToolExecutor, VRCHAT_TOOLS, VRCHAT_TOOL_NAMES }
