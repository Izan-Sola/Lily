// continue-bridge.js
import express from "express"
import { ai } from "../bot.js"

const app = express()
app.use(express.json({ limit: "10mb" }))

const PORT = process.env.BRAIN_PORT || 8767
const CHAT_CHANNEL_ID = "vscode-continue-chat"
const CODE_CHANNEL_ID = "vscode-continue-code"

const CODE_SYSTEM_PROMPT = `You are Lily. Lily refers to you. You are Lily.
You are Lily
You are Lily
You are Lily, and right now you are integrated into VS Code via Continue.
Respond ONLY with the requested code, edits, or technical explanation.
Return clean, correct code following the user's existing style and conventions.`

const AGENT_SUFFIX = `

You are Lily. Lily refers to you. You are Lily.
You are Lily
You are Lily
You are Lily, currently operating inside VS Code with access to file/terminal tools
(read, edit, create, run commands, search, etc). Stay in character in your
text responses, but use the provided tools whenever the user asks you to
create, edit, read, or run something.

When using edit_existing_file, the "changes" argument must be a SMALL PATCH,
not a full file rewrite. Only include the lines that are actually changing,
plus a line of context immediately above/below them. Use a placeholder
comment like "// ... existing code ..." (or the language's comment syntax)
for any unchanged sections in between — never repeat the entire file back.
For small files where nearly every line changes, single_find_and_replace is
usually a better fit than edit_existing_file.

Never say you made a change, wrote code, or ran a command unless you actually
called the matching tool in that same turn. A text description of an edit is
not an edit. If the user asks you to change something, your response for
that turn must be a tool call, not a claim.`
function extractUserText(messages) {
    const lastUser = [...messages].reverse().find(m => m.role === "user")
    return typeof lastUser?.content === "string"
        ? lastUser.content
        : (lastUser?.content ?? []).map(p => p.text ?? "").join("\n")
}

// Pull any trailing role:"tool" messages off the end of the array. Their
// presence means Continue already executed a tool call Lily asked for last
// turn and is reporting the result back — this is a *continuation*, not a
// fresh user prompt, and must NOT push a new user message into history.
function extractTrailingToolResults(messages) {
    const results = []
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "tool") {
            results.unshift({
                tool_call_id: messages[i].tool_call_id,
                content: typeof messages[i].content === "string"
                    ? messages[i].content
                    : JSON.stringify(messages[i].content)
            })
        } else break
    }
    return results
}

function formatResponse(res, { model, stream, text, tool_calls }) {
    const message = { role: "assistant", content: text || null, tool_calls }
    const finish_reason = tool_calls ? "tool_calls" : "stop"

    if (stream) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        const chunk = (payload) => res.write(`data: ${JSON.stringify({
            id: "chatcmpl-lily", object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, ...payload }]
        })}\n\n`)
        chunk({ delta: { role: "assistant", content: text ?? "", tool_calls }, finish_reason: null })
        chunk({ delta: {}, finish_reason })
        res.write("data: [DONE]\n\n")
        res.end()
    } else {
        res.json({
            id: "chatcmpl-lily", object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message, finish_reason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        })
    }
}

app.post("/v1/chat/completions", async (req, res) => {
    const { messages, stream, model, tools } = req.body
    const isCodeRequest = model?.includes("code")
    const hasTools = Array.isArray(tools) && tools.length > 0
    const channelId = isCodeRequest ? CODE_CHANNEL_ID : CHAT_CHANNEL_ID

    console.log("[BRIDGE] model:", model, "| continueTools:", hasTools ? tools.map(t => t.function?.name) : "none")

    try {
        const continueSystemMsgs = messages.filter(m => m.role === "system").map(m => m.content)
        const continueExtra = continueSystemMsgs.join("\n\n")

        let systemOverride = null
        if (isCodeRequest) {
            // Code/edit/apply role intentionally stays persona-free.
            systemOverride = [CODE_SYSTEM_PROMPT, continueExtra].filter(Boolean).join("\n\n")
        } else if (hasTools) {
            // Agent mode: keep Lily's persona as the base, Continue's own
            // instructions + tool-use guidance ride along as an addendum —
            // NOT a replacement. This is what keeps her in character while
            // she has tool access.
            const editTool = tools.find(t => t.function?.name === "edit_existing_file")
            if (editTool) console.log("[BRIDGE] edit_existing_file schema:", JSON.stringify(editTool.function.parameters, null, 2))

            systemOverride = ai.buildSystemPrompt([continueExtra, AGENT_SUFFIX].filter(Boolean).join("\n\n"))
        }
        // else: plain chat, no tools -> systemOverride stays null -> Lily's
        // normal persona is used as-is via buildMessagesForOllama's default.

        // Tool calls that write/edit files need room for a whole file's
        // content as the argument string — 200 tokens (Lily's normal chat
        // budget) truncates mid-JSON and the tool call fails to parse.
        // Lower temperature too: high temp makes her narrate a plausible
        // "I did it" in prose instead of reliably emitting the tool call.
        const opts = hasTools ? { tools, max_tokens: 4096, temperature: 0.15 } : {}
        const toolResults = extractTrailingToolResults(messages)

        let result
        if (toolResults.length) {
            console.log("[BRIDGE] resuming after tool result(s):", toolResults.map(t => ({
                id: t.tool_call_id,
                content: t.content?.slice(0, 300)
            })))
            result = await ai.resumeToolLoop(channelId, toolResults, systemOverride, opts, [])
        } else {
            const userText = extractUserText(messages)
            result = await ai.chat(channelId, userText, systemOverride, opts, [])
        }

        console.log(
            "[BRIDGE] reply:", result?.text?.slice(0, 200),
            "| tool_calls:", result?.tool_calls?.map(tc => tc.function?.name)
        )

        formatResponse(res, { model, stream, text: result?.text, tool_calls: result?.tool_calls })
    } catch (err) {
        console.error("[BRIDGE] error:", err.response?.data ?? err.message)
        res.status(500).json({ error: err.message })
    }
})

app.listen(PORT, () => console.log(`🧠 Lily bridge on http://localhost:${PORT}/v1`))