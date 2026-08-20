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
// format: system/human/gpt, plus "tool" for actual tool RESULTS. A model
// tool CALL is not its own from-role — it's rendered as a "gpt" turn whose
// value contains an embedded <tool_call>{...}</tool_call> block, same as
// what the model actually emits at inference time in the embedded-tool-call
// path. See messageToConversationEntries below for where that happens.
function toShareGptRole(role) {
    switch (role) {
        case "system": return "system"
        case "user": return "human"
        case "assistant": return "gpt"
        case "tool": return "tool"
        default: return role
    }
}

// Native tool_calls (OpenAI-style, msg.tool_calls array with JSON-string
// arguments) get flattened into a "gpt" turn containing a plain-text
// <tool_call>{"name":..., "arguments": {...}}</tool_call> block — this is
// what your chat template actually renders for the model to produce, so
// training format matches serving format. arguments is parsed back into a
// real object (not left as a JSON string) so it prints the same shape as
// the embedded-tool-call path already used elsewhere in the pipeline.
//
// The embedded-<tool_call> path (non-native — scratch already pushes
// { role: "assistant", content } where content is the raw text containing
// the tag) needs no special-casing here: it falls through to the default
// branch below and comes out as a normal "gpt" turn, tag and all, which is
// already the desired shape.
function messageToConversationEntries(msg) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
        return msg.tool_calls.map(tc => {
            let args
            try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { args = tc.function.arguments }
            return {
                from: "gpt",
                value: `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`
            }
        })
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
 * @param {Array}  params.messages - the messages for THIS TURN ONLY, in
 *        OpenAI-message-array form: system, the single user message that
 *        started the turn, any tool-call/tool-result scratch messages from
 *        this turn's loop (assistant with tool_calls, or role:"tool"/
 *        embedded <tool_call> pairs), ending in the final assistant reply.
 *        Callers must NOT pass the full accumulated conversation history —
 *        see maybeSaveFlawlessTurn in lily.js, which is the only caller.
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