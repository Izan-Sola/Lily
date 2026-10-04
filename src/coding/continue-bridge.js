// src/coding/continue-bridge.js
//
// Stateless OpenAI-compatible bridge between Continue.dev and the local
// llama-server running Qwen 3.5 9B.
//
// Why this works for remote use: Continue executes tools (read_file,
// edit_existing_file, create_new_file, run_terminal_command, ...) on the
// machine where VS Code runs, and re-sends the full conversation on every
// request. So the bridge only has to (1) forward messages + tool schemas to
// the model, and (2) hand structured tool_calls back. No server-side session
// state, no channel history, and the minipc never touches the client's files.
//
// Env:
//   BRAIN_PORT        listen port                      (default 8767)
//   BRAIN_HOST        listen address                   (default 0.0.0.0)
//   BRIDGE_API_KEY    OPTIONAL bearer token; leave unset for no auth (like before)
//   UPSTREAM_URL      llama-server OpenAI base URL     (default http://127.0.0.1:8080/v1)
//   UPSTREAM_MODEL    model name sent upstream         (default qwen3.5-9b; ignored by llama-server)
//   UPSTREAM_API_KEY  key for upstream, if any
//   BRIDGE_THINKING   "on" to let Qwen think           (default off: faster, cleaner tool calls)
//   BRIDGE_GUARD      "off" to disable apply placeholder check
//
// start.js can keep calling startContinueBridge(ai); the argument is ignored.
import express from "express"
import crypto from "node:crypto"
import { Readable } from "node:stream"
import { Logger } from "../utils/Logger.js"
import { CODE_SYSTEM_PROMPT, stripCodeFence, stripThinking, checkStubBodies } from "./codeEditShared.js"
import { parseToolCalls } from "./xmlToolCalls.js"

const warn = (...a) => (Logger.warn ?? Logger.info).call(Logger, ...a)

function loadConfig(overrides = {}) {
    return {
        port: Number(process.env.BRAIN_PORT) || 8767,
        host: process.env.BRAIN_HOST || "0.0.0.0",
        apiKey: process.env.BRIDGE_API_KEY || "",
        upstream: (process.env.UPSTREAM_URL || "http://127.0.0.1:11435/v1").replace(/\/+$/, ""),
        upstreamKey: process.env.UPSTREAM_API_KEY || "",
        upstreamModel: process.env.UPSTREAM_MODEL || "qwen3.5-9b",
        thinking: process.env.BRIDGE_THINKING === "on",
        guard: process.env.BRIDGE_GUARD !== "off",
        keepaliveMs: 10_000,
        ...overrides,
    }
}

// ---------- message normalisation ----------

function flattenContent(content) {
    if (typeof content === "string") return content
    if (content == null) return ""
    if (Array.isArray(content)) {
        // Text-only part arrays become plain strings (safest for the chat template).
        // Anything with images is left as-is for the multimodal path.
        if (content.every(p => p?.type === "text" || typeof p === "string")) {
            return content.map(p => (typeof p === "string" ? p : p.text ?? "")).join("\n")
        }
        return content
    }
    return JSON.stringify(content)
}

// Qwen's template rejects system messages that aren't first, so merge them all.
function normalizeMessages(messages, extraSystem = []) {
    const systems = [...extraSystem]
    const rest = []
    for (const m of messages ?? []) {
        if (m.role === "system" || m.role === "developer") {
            const c = flattenContent(m.content)
            if (c) systems.push(typeof c === "string" ? c : JSON.stringify(c))
            continue
        }
        const out = { ...m, content: flattenContent(m.content) }
        if (m.role === "tool" && typeof out.content !== "string") out.content = JSON.stringify(out.content)
        rest.push(out)
    }
    const merged = systems.filter(Boolean).join("\n\n")
    return merged ? [{ role: "system", content: merged }, ...rest] : rest
}

// ---------- upstream ----------

function buildUpstreamBody(reqBody, cfg, { isApply, stream, messages }) {
    const body = { ...reqBody, model: cfg.upstreamModel, messages, stream }
    if (!Array.isArray(body.tools) || !body.tools.length) {
        delete body.tools
        delete body.tool_choice
    }
    if (!stream) delete body.stream_options
    body.max_tokens ??= 8192
    if (isApply) body.temperature = 0
    // Qwen 3.5 template switch. Unknown fields are ignored by servers that don't support it.
    body.chat_template_kwargs = { enable_thinking: cfg.thinking, ...(reqBody.chat_template_kwargs ?? {}) }
    return body
}

async function callUpstream(cfg, body, signal) {
    const headers = { "Content-Type": "application/json" }
    if (cfg.upstreamKey) headers.Authorization = `Bearer ${cfg.upstreamKey}`
    const r = await fetch(`${cfg.upstream}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal,
    })
    if (!r.ok) {
        const detail = await r.text().catch(() => "")
        const err = new Error(`upstream ${r.status}: ${detail.slice(0, 500)}`)
        err.status = r.status
        throw err
    }
    return r
}

// ---------- response shaping ----------

function normalizeToolCalls(calls) {
    if (!calls?.length) return null
    return calls.map(tc => ({
        id: tc.id || `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
        type: "function",
        function: {
            name: tc.function?.name,
            arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
        },
    }))
}

function extractResult(data, tools, isApply) {
    const choice = data.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    let text = stripThinking(typeof msg.content === "string" ? msg.content : "") ?? ""
    let toolCalls = normalizeToolCalls(msg.tool_calls)

    if (!toolCalls && text.includes("<tool_call>")) {
        const parsed = parseToolCalls(text, tools)
        if (parsed.calls.length) {
            Logger.info("[BRIDGE] recovered tool calls from text:", parsed.calls.map(c => c.function.name))
            toolCalls = parsed.calls
            text = parsed.text
        } else {
            warn("[BRIDGE] <tool_call> in output but nothing parsed (truncated?). finish_reason:", choice.finish_reason)
        }
    }
    if (isApply && !toolCalls) text = stripCodeFence(text)

    const finish = toolCalls ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop"
    return { text, toolCalls, finish, usage: data.usage }
}

function sseChunk(res, model, delta, finish_reason = null, extra = {}) {
    res.write(`data: ${JSON.stringify({
        id: "chatcmpl-lily", object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason }], ...extra,
    })}\n\n`)
}

function sendBuffered(res, model, stream, { text, toolCalls, finish, usage }) {
    if (!stream) {
        return res.json({
            id: "chatcmpl-lily", object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
            usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
    }
    // Headers were already sent by beginSse(); just write the events.
    sseChunk(res, model, { role: "assistant", content: text ?? "" })
    if (toolCalls) {
        sseChunk(res, model, { tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) })
    }
    sseChunk(res, model, {}, finish)
    res.write("data: [DONE]\n\n")
    res.end()
}

function beginSse(res, cfg) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    })
    res.flushHeaders?.()
    // A 9B model can take a while to produce a whole file edit; comments keep
    // proxies and Continue's HTTP client from timing out the idle connection.
    const timer = setInterval(() => res.write(": keepalive\n\n"), cfg.keepaliveMs)
    res.on("close", () => clearInterval(timer))
    return () => clearInterval(timer)
}

// ---------- auth ----------

function authMiddleware(cfg) {
    const expected = Buffer.from(cfg.apiKey)
    return (req, res, next) => {
        if (!cfg.apiKey) return next()
        const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))
        if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next()
        res.status(401).json({ error: { message: "invalid api key", type: "auth_error" } })
    }
}

// ---------- server ----------

export function startContinueBridge(_ai, overrides = {}) {
    const cfg = loadConfig(overrides)
    const app = express()
    app.use(express.json({ limit: "50mb" }))

    app.get("/health", (_req, res) => res.json({ ok: true, upstream: cfg.upstream, thinking: cfg.thinking }))

    app.use("/v1", authMiddleware(cfg))

    app.get("/v1/models", (_req, res) => {
        const now = Math.floor(Date.now() / 1000)
        res.json({
            object: "list",
            data: ["lily-agent", "lily-apply"].map(id => ({ id, object: "model", created: now, owned_by: "lily" })),
        })
    })

    app.post("/v1/chat/completions", async (req, res) => {
        const { messages, model, tools } = req.body ?? {}
        const stream = req.body?.stream === true
        const isApply = /apply|code/i.test(model ?? "")
        const hasTools = Array.isArray(tools) && tools.length > 0
        // Anything that needs post-processing (tool recovery, think stripping,
        // fence stripping, placeholder checks) is buffered. Plain chat streams
        // straight through token by token.
        const mustBuffer = hasTools || isApply || cfg.thinking

        Logger.info(`[BRIDGE] model=${model} stream=${stream} msgs=${messages?.length ?? 0} tools=${hasTools ? tools.map(t => t.function?.name).join(",") : "none"} mode=${isApply ? "apply" : hasTools ? "agent" : "chat"}`)

        const abort = new AbortController()
        res.on("close", () => { if (!res.writableEnded) abort.abort() })
        let stopKeepalive = () => { }

        try {
            if (!Array.isArray(messages) || !messages.length) {
                return res.status(400).json({ error: { message: "messages required" } })
            }
            const normalized = normalizeMessages(messages, isApply ? [CODE_SYSTEM_PROMPT] : [])

            // ----- plain chat: pipe SSE straight through -----
            if (stream && !mustBuffer) {
                const up = await callUpstream(cfg, buildUpstreamBody(req.body, cfg, { isApply, stream: true, messages: normalized }), abort.signal)
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                })
                Readable.fromWeb(up.body).pipe(res)
                return
            }

            if (stream) stopKeepalive = beginSse(res, cfg)

            // ----- buffered path (agent / apply / thinking) -----
            let msgs = normalized
            let result
            const maxAttempts = isApply && cfg.guard ? 2 : 1
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const up = await callUpstream(cfg, buildUpstreamBody(req.body, cfg, { isApply, stream: false, messages: msgs }), abort.signal)
                result = extractResult(await up.json(), tools, isApply)

                if (!isApply || !cfg.guard) break
                const problem = checkStubBodies(result.text, "the apply output")
                if (!problem) break
                warn(`[BRIDGE] apply attempt ${attempt}: ${problem}`)
                if (attempt < maxAttempts) {
                    msgs = [...normalized,
                    { role: "assistant", content: result.text },
                    { role: "user", content: "Your output contained placeholders instead of real code. Output the COMPLETE file again with every line written out in full, and nothing else." }]
                } else {
                    // Refuse instead of letting Continue write a gutted file.
                    const err = new Error(problem)
                    err.status = 422
                    throw err
                }
            }

            Logger.info("[BRIDGE] reply:", JSON.stringify((result.text ?? "").slice(0, 160)), "| tool_calls:", result.toolCalls?.map(t => t.function.name) ?? "none", "| finish:", result.finish)
            stopKeepalive()
            sendBuffered(res, model, stream, result)
        } catch (err) {
            stopKeepalive()
            if (abort.signal.aborted) return
            Logger.error("[BRIDGE] error:", err.message)
            if (res.headersSent) {
                // Mid-SSE: surface the failure as visible text, then close cleanly.
                sseChunk(res, model, { content: `\n\n[bridge error: ${err.message}]` }, "stop")
                res.write("data: [DONE]\n\n")
                res.end()
            } else {
                res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502)
                    .json({ error: { message: err.message, type: "bridge_error" } })
            }
        }
    })

    const server = app.listen(cfg.port, cfg.host, () =>
        Logger.info(`🧠 Lily bridge on http://${cfg.host}:${cfg.port}/v1 -> ${cfg.upstream}`))
    server.requestTimeout = 0       // long generations must not be cut off
    server.headersTimeout = 60_000
    return server
}