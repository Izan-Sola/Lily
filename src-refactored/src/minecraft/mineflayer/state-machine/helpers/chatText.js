/**
 * Turns whatever a mineflayer 'message' event hands us into readable text,
 * no matter what shape it is. jsonMsg is normally a prismarine-chat
 * ChatMessage with a working .toString(), but not every plugin server sends
 * fully well-formed chat JSON, and a malformed/edge-case component can make
 * .toString() silently fall back to the default Object.prototype one
 * (producing "[object Object]") instead of throwing.
 *
 * Tries several extraction paths in order and only gives up — with the raw
 * JSON, not "[object Object]" — if none of them produce anything.
 */
export function extractChatText(jsonMsg) {
    if (typeof jsonMsg === 'string') return jsonMsg

    if (jsonMsg && typeof jsonMsg.toString === 'function') {
        const viaToString = jsonMsg.toString()
        if (viaToString && viaToString !== '[object Object]') return viaToString
    }

    if (jsonMsg?.json) {
        const flat = flattenChatComponent(jsonMsg.json)
        if (flat) return flat
    }
    const flat = flattenChatComponent(jsonMsg)
    if (flat) return flat

    try {
        return JSON.stringify(jsonMsg)
    } catch {
        return String(jsonMsg)
    }
}

/** Manually walks a Minecraft chat-component tree ({text, extra, translate, with}) into plain text. */
function flattenChatComponent(node) {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(flattenChatComponent).join('')

    let out = ''
    if (typeof node.text === 'string') out += node.text
    if (typeof node.translate === 'string') {
        out += node.with ? node.with.map(flattenChatComponent).join(' ') : node.translate
    }
    if (Array.isArray(node.extra)) out += node.extra.map(flattenChatComponent).join('')
    return out
}