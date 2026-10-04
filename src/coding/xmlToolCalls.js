// src/coding/xmlToolCalls.js
//
// Qwen 3.5 emits tool calls in its native XML format:
//
//   <tool_call>
//   <function=edit_existing_file>
//   <parameter=filepath>
//   /path/to/file.js
//   </parameter>
//   </function>
//   </tool_call>
//
// llama-server (--jinja) normally converts these into structured OpenAI
// `tool_calls`. When it doesn't (older build, truncated parse, Ollama quirk),
// this module recovers them from the text and converts them into the shape
// Continue expects. It also understands the older JSON-in-tags variant:
//   <tool_call>{"name": "...", "arguments": {...}}</tool_call>

// Only COMPLETE calls match. A call cut off by max_tokens is deliberately
// ignored: executing a half-written file edit would corrupt the user's file.
const XML_CALL_RE = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g

// A parameter ends at a </parameter> that is followed by another parameter or
// the end of the function body, so file contents containing a literal
// "</parameter>" don't terminate it early.
const PARAM_RE = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>\s*(?=<parameter=|$)/g

const JSON_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

// Qwen's template strips exactly one leading and one trailing newline from a
// value. Don't .trim(): leading indentation in file content is significant.
function stripOneNewline(value) {
    return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
}

// XML parameters are always strings; convert them using the tool's schema so
// `recursive: true` arrives as a boolean and not the string "true".
function coerce(value, schema) {
    if (!schema) return value
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
    try {
        if (type === "boolean") return /^(true|1|yes)$/i.test(value.trim())
        if (type === "integer" || type === "number") {
            const n = Number(value)
            return Number.isFinite(n) ? n : value
        }
        if (type === "array" || type === "object") return JSON.parse(value)
    } catch { /* fall through to raw string */ }
    return value
}

function schemaFor(tools, name) {
    const tool = (tools ?? []).find(t => t.function?.name === name)
    return tool?.function?.parameters?.properties ?? {}
}

function makeCall(name, args) {
    return {
        id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
    }
}

/**
 * @param {string} text   raw model output
 * @param {Array} tools   the `tools` array Continue sent (used for type coercion)
 * @returns {{ calls: Array, text: string }} calls found and the text with them removed
 */
export function parseToolCalls(text, tools = []) {
    if (!text || !text.includes("<tool_call>")) return { calls: [], text: text ?? "" }

    const calls = []
    let remaining = text

    for (const m of text.matchAll(XML_CALL_RE)) {
        const name = m[1]
        const props = schemaFor(tools, name)
        const args = {}
        for (const p of m[2].matchAll(PARAM_RE)) {
            args[p[1]] = coerce(stripOneNewline(p[2]), props[p[1]])
        }
        calls.push(makeCall(name, args))
    }
    remaining = remaining.replace(XML_CALL_RE, "")

    if (!calls.length) {
        for (const m of text.matchAll(JSON_CALL_RE)) {
            try {
                const obj = JSON.parse(m[1])
                const name = obj.name ?? obj.function?.name
                let args = obj.arguments ?? obj.parameters ?? {}
                if (typeof args === "string") args = JSON.parse(args)
                if (name) calls.push(makeCall(name, args))
            } catch { /* malformed JSON: skip */ }
        }
        if (calls.length) remaining = remaining.replace(JSON_CALL_RE, "")
    }

    return { calls, text: remaining.trim() }
}