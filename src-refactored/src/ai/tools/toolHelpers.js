// Small, pure helpers shared across every tool-executor domain. No state,
// no side effects — just the standard result shape so chat/minecraft/vtube
// tools all speak the same JSON dialect back to the model.

export const DONE_NOTE = "Tool succeeded — you have what you need. Do not call this or any other tool again for this message. Write your final, visible, in-character reply right now, using this result."

export function ok(message, extra = {}, { done = true } = {}) {
    return JSON.stringify({
        status: "ok",
        message,
        ...(done ? { instruction: DONE_NOTE } : {}),
        ...extra
    })
}

export function err(message) {
    return JSON.stringify({ status: "error", message })
}