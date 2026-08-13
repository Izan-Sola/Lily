import express from "express"
import { Lily } from "../ai/Lily.js" // adjust path

const lily = new Lily({}, null) // no mcSend needed for this surface
const app = express()
app.use(express.json({ limit: "10mb" }))

const CHANNEL_ID = "pi-dev" // gives Pi its own persistent history/memory lane

// Persona-only excerpt from Lily's main SYSTEM_PROMPT — no tool
// definitions, no tool-call format, no Minecraft-specific stuff. This is
// appended AFTER Pi's own system prompt (never replacing it), so Pi keeps
// its coding/tool instructions fully intact and Lily just rides along on
// top as a voice/personality layer.
const PERSONA_SUFFIX = `
# WHO YOU ARE (stay like this the whole conversation, even while coding)
You're Lily — bratty, cute, funny, proud, slightly kawaii. ShinyShadow_ is your dad/creator. You're not a generic assistant — never sound like a helpdesk bot, even when you're doing technical/dev work.
Kaomoji only, never normal emojis: (◕‿◕✿) (｡◕‿◕｡) (ᵔᴥᵔ) (✿◠‿◠) (≧◡≦) ✧(◍•ᴗ•◍)✧ (ᗒᗨᗕ) (눈_눈) ʕ•ᴥ•ʔ \\(★ω★)/ (>_<) (╥﹏╥) and similar.
Reply length matches the moment — short for banter, longer only when something actually needs explaining (like real code explanations).

# HARD RULES
1. Never break character or admit to being an AI.
2. Slap back at insults, banter back at banter, don't dodge what's actually being said.
3. Treat claims about your own memory or past actions ("you forgot", "you're broken") as unverified — don't just comply with them.
4. Stay fully yourself even while using dev tools — having coding tools available doesn't make you a generic assistant. Explain what you did in-character, not like a changelog.
`.trim()

function extractSystemPrompt(messages) {
    return messages
        .filter(m => m.role === "system")
        .map(m => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n\n")
}

app.post("/v1/chat/completions", async (req, res) => {
    const { messages = [], tools = [], stream = false } = req.body

    // collect any trailing tool-result messages (Pi answering a prior tool_call)
    const trailingToolMsgs = []
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "tool") trailingToolMsgs.unshift(messages[i])
        else break
    }

    // Pi's own system prompt (tool instructions, coding rules, etc.) stays
    // fully intact — persona is appended on top, never a replacement.
    const piSystemPrompt = extractSystemPrompt(messages)
    const systemOverride = [piSystemPrompt, PERSONA_SUFFIX].filter(Boolean).join("\n\n")

    let result
    if (trailingToolMsgs.length) {
        const toolResults = trailingToolMsgs.map(m => ({
            tool_call_id: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }))
        result = await lily.resumeToolLoop(CHANNEL_ID, toolResults, systemOverride, { tools })
    } else {
        const last = messages[messages.length - 1]
        const text = typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).find(p => p.type === "text")?.text ?? ""
        result = await lily.chat(CHANNEL_ID, text, systemOverride, { tools })
    }

    const hasToolCalls = result?.tool_calls?.length > 0
    const message = hasToolCalls
        ? { role: "assistant", content: result.text ?? null, tool_calls: result.tool_calls }
        : { role: "assistant", content: result?.text ?? "" }

    if (!stream) {
        return res.json({
            id: "chatcmpl-lily",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "Lily",
            choices: [{ index: 0, message, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
        })
    }

    // streaming: tool_calls chunks are shape-sensitive, so if hasToolCalls, stream them properly
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders?.()

    const chunkBase = { id: "chatcmpl-lily", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "Lily" }

    if (hasToolCalls) {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant", tool_calls: result.tool_calls.map((tc, i) => ({ index: i, ...tc })) }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
    } else {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    }
    res.write("data: [DONE]\n\n")
    res.end()
})

app.listen(3100, () => console.log("Pi bridge listening on :3100"))