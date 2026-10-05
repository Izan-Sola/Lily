// src/coding/codeEditShared.js
//
// Shared between continue-bridge.js (Continue's apply role) and the voice
// "edit the current file" path in discord/tools/sttsTools.js + Lily's
// generateFileEdit(). Both take a file's original content plus a described
// change and produce the complete new file, so the prompt and the safety
// checks against a hallucinated/shrunk rewrite live here once.

export const CODE_SYSTEM_PROMPT = `You are a code-merging engine. You will be given a file's original content and a set of proposed changes. Output ONLY the complete final file content with the changes correctly applied. No explanations, no commentary, no markdown code fences, no "Here's the updated file" preamble. Every line of code not part of the change must be preserved exactly as-is. Never use placeholders such as "// ... existing code", "// rest of file unchanged" or "{ ... }": write out every line in full.`

export const OVERWRITE_GUARD = {
    minOriginalLines: 40,   // only size-guard files bigger than this
    maxShrinkRatio: 0.35,   // new/old char ratio below this is treated as a bad rewrite
    minStubHits: 1,         // new placeholder markers (beyond the original's) needed to block
}

// Placeholder patterns models use instead of writing real code:
//  1. `) { ... }` as a function body
//  2. `// ... existing code`, `# ... rest`, `/* ... unchanged`
//  3. `// rest of the code unchanged`, `# existing implementation here`
// Exported with the g flag for backwards compatibility; the checks below build
// a fresh RegExp so lastIndex state can never leak between calls.
export const STUB_BODY_PATTERN =
    /(\)\s*\{\s*\.\.\.\s*\})|((?:\/\/|#|--|\/\*)\s*(?:\.\.\.|\u2026)\s*(?:existing|rest|remaining|unchanged|previous|other)\b)|((?:\/\/|#|--|\/\*)\s*(?:rest of|remaining|existing|previous)\s+(?:the\s+)?(?:code|file|implementation|function|methods?)\b[^\n]*\b(?:unchanged|same|here|omitted))/gi

function countStubs(text) {
    if (!text) return 0
    return (text.match(new RegExp(STUB_BODY_PATTERN.source, "gi")) ?? []).length
}

/**
 * Returns a block reason if newContent looks like a hallucinated or
 * "simplified" rewrite of a real file, or null if it's fine.
 */
export function checkShrinkRatio(originalContent, newContent, label = "the file") {
    if (typeof originalContent !== "string" || typeof newContent !== "string") return null
    const originalLines = originalContent.split("\n").length
    if (originalLines < OVERWRITE_GUARD.minOriginalLines) return null

    if (newContent.trim() === "") {
        return `BLOCKED: this would replace ${label} (${originalLines} lines) with empty content.`
    }

    const shrinkRatio = newContent.length / Math.max(originalContent.length, 1)
    if (shrinkRatio < OVERWRITE_GUARD.maxShrinkRatio) {
        return (
            `BLOCKED: this would replace ${label} (${originalLines} lines, ` +
            `${originalContent.length} chars) with only ${newContent.length} chars, ` +
            `a ${Math.round((1 - shrinkRatio) * 100)}% reduction. That looks like ` +
            `a hallucinated/simplified rewrite rather than a real edit.`
        )
    }
    return null
}

/**
 * Returns a block reason if text contains NEW placeholder stand-ins for real
 * code, or null if it's fine. Pass originalText so placeholders that already
 * exist in the file (e.g. this very file's regex) don't cause false positives.
 */
export function checkStubBodies(text, label = "the file", originalText = "") {
    const hits = countStubs(text) - countStubs(originalText)
    if (hits >= OVERWRITE_GUARD.minStubHits) {
        return (
            `BLOCKED: ${label} contains ${hits} placeholder(s) such as "{ ... }" or ` +
            `"// ... existing code" instead of real code. That would delete the actual implementation.`
        )
    }
    return null
}

/**
 * Removes a single wrapping markdown fence from the whole text. Handles CRLF,
 * language tags and longer fences (````), and leaves text alone when the fence
 * is only part of the content (e.g. a README that contains code blocks).
 */
export function stripCodeFence(text) {
    if (!text) return text
    const trimmed = text.trim()
    const match = trimmed.match(/^(`{3,})[^\n]*\r?\n([\s\S]*?)\r?\n?\1\s*$/)
    return match ? match[2] : trimmed
}

/**
 * Removes Qwen <think> reasoning from output. Qwen 3.5's template opens the
 * think block inside the prompt, so output may contain only a closing tag.
 */
export function stripThinking(text) {
    if (!text) return text
    let out = text.replace(/<think>[\s\S]*?<\/think>/g, "")
    const idx = out.lastIndexOf("</think>")
    if (idx !== -1) out = out.slice(idx + "</think>".length)
    return out === text ? text : out.replace(/^\s+/, "")
}