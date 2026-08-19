import fs from "fs"
import path from "path"
import { Logger } from '../../src/utils/Logger.js'

const OUTPUT_DIR = path.resolve("./data/flawless_turns")
const OUTPUT_FILE = path.join(OUTPUT_DIR, "pending_review.jsonl")

// Simple write queue so concurrent saves (e.g. Discord and Minecraft turns
// finishing around the same moment) can't interleave partial writes to
// the same file.
let writeQueue = Promise.resolve()

// ─── Role mapping ───────────────────────────────────────────────────────
// Matches the sharegpt-style {"conversations": [{"from": ..., "value": ...}]}
// format your existing dataset uses (system/human/gpt). tool-role messages
// map to a new "function_response" from-role, which is NOT in your sample
// dataset (that one had no tool calls). Verify this round-trips correctly
// through your training pipeline's dataset loader on a real tool-call
// sample before trusting it at scale — this mapping is a reasonable
// default, not a confirmed spec.
function toShareGptRole(role) {
    switch (role) {
        case "system": return "system"
        case "user": return "human"
        case "assistant": return "gpt"
        case "tool": return "tool"
        default: return role
    }
}

// Native tool_calls (OpenAI-style) get flattened into a readable
// function_call turn. If your inference-time chat template renders tool
// calls differently (e.g. the embedded <tool_call> tag path also present
// in runToolLoop), this should mirror THAT format instead — training
// format should match serving format, not necessarily the OpenAI native
// shape.
function messageToConversationEntries(msg) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
        return msg.tool_calls.map(tc => ({
            from: "tool",
            value: JSON.stringify({ name: tc.function.name, arguments: tc.function.arguments })
        }))
    }
    return [{
        from: toShareGptRole(msg.role),
        value: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "")
    }]
}

function toShareGptSample(messages) {
    const conversations = messages
        .filter(m => m.content !== undefined || m.tool_calls?.length)
        .flatMap(messageToConversationEntries)
        .filter(entry => entry.value !== "" && entry.value !== undefined)

    return { conversations }
}

/**
 * Saves one flawless turn to the pending-review queue. Never throws —
 * failures are logged and swallowed so a disk/write issue can't affect
 * the live chat turn that triggered the save.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {Array}  params.messages - full conversation for this turn, in
 *        OpenAI-message-array form (system/user/assistant/tool, with
 *        tool_calls where applicable), ending in the final assistant reply.
 */
export async function saveFlawlessTurn({ channelId, messages }) {
    let sample
    try {
        sample = toShareGptSample(messages)
    } catch (err) {
        Logger.error(err.message, "FLAWLESS SAVE")
        return
    }
    if (!sample.conversations.length) return

    const record = {
        ...sample,
        // _meta: {
        //     channelId,
        //     savedAt: new Date().toISOString(),
        // }
    }

    writeQueue = writeQueue.then(async () => {
        try {
            await fs.promises.mkdir(OUTPUT_DIR, { recursive: true })
            await fs.promises.appendFile(OUTPUT_FILE, JSON.stringify(record) + "\n", "utf8")
            Logger.info(`Saved flawless turn (${channelId})`, "FLAWLESS SAVE")
        } catch (err) {
            Logger.error(err.message, "FLAWLESS SAVE")
        }
    })

    return writeQueue
}