import axios from 'axios'
import { Logger } from '../utils/Logger.js'

// Model sometimes lands its text in the reasoning field and wraps output in tags.
function normalize(msg) {
    if (!msg) return null
    if (!msg.content?.trim() && (msg.reasoning_content || msg.reasoning)) {
        Logger.warning('content empty, model text landed in reasoning field — using it as fallback', 'OLLAMA FALLBACK')
        msg.content = msg.reasoning_content ?? msg.reasoning
    }
    if (msg.content) {
        msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?answer>/g, '').trim()
    }
    return msg
}

/**
 * One chat completion against the OpenAI-compatible endpoint.
 * @param {object} opts   merged config (ollamaUrl, model, sampling params, think...)
 * @param {Array} messages
 * @param {{ tools?: Array|null, overrides?: object }} [o]  tools: schemas to offer, null/empty = none
 * @returns {Promise<object|null>} the assistant message, or null on failure
 */
export async function chatCompletion(opts, messages, { tools = null, overrides = {} } = {}) {
    const payload = {
        model: opts.model,
        stream: false,
        temperature: overrides.temperature ?? opts.temperature,
        top_p: opts.top_p,
        top_k: opts.top_k,
        presence_penalty: overrides.presence_penalty ?? opts.presence_penalty,
        min_p: opts.min_p,
        repeat_penalty: overrides.repeat_penalty ?? opts.repeat_penalty,
        repeat_last_n: overrides.repeat_last_n ?? opts.repeat_last_n,
        max_tokens: overrides.max_tokens ?? opts.max_tokens,
        stop: overrides.stop ?? ['</answer>', '<|user|>', '<|endoftext|>'],
        reasoning_effort: opts.think === false ? 'none' : (opts.think ?? 'none'),
        think: opts.think ?? false,
        messages,
    }
    if (tools?.length) payload.tools = tools

    try {
        const { data } = await axios.post(`${opts.ollamaUrl}/v1/chat/completions`, payload, { timeout: opts.ollamaTimeout })
        return normalize(data.choices?.[0]?.message ?? null)
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : ''
        Logger.error(`${err.message} ${detail}`, 'OLLAMA')
        return null
    }
}
