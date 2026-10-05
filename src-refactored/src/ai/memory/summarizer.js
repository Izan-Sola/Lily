import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { SUMMARIZE_PROMPT } from '../prompts.js'
import { getSection } from '../config.js'

// Strips model artifacts and JSON-escaped angle brackets from text about to be
// stored as a memory, so "<think>" junk never reaches episodic memory.
export function cleanMemoryText(text) {
    if (typeof text !== 'string') return ''
    return text
        .replace(/\\u003C/gi, '<')
        .replace(/\\u003E/gi, '>')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<answer>[\s\S]*?<\/answer>/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<\/?think>/gi, '')
        .replace(/<\/?answer>/gi, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

// Periodic conversation summaries and batched "observe" summaries, both
// stored as episodic memories.
export class Summarizer {
    #counts = new Map()          // channelId -> messages handled
    #observed = new Map()        // channelId -> lines awaiting a batch
    #participants = new Map()    // channelId -> Set of speaker names

    /**
     * @param {() => object} getOpts   current merged config
     * @param {(channelId: string) => object} getHistory
     * @param {(memory: object) => Promise<unknown>} store  episodic memory writer
     */
    constructor(getOpts, getHistory, store) {
        this.getOpts = getOpts
        this.getHistory = getHistory
        this.store = store
    }

    async summarize(lines, { maxTokens = getSection('llm').summaryMaxTokens, source = 'conversation_batch', participants = [], emotions = [], importance = 0.5 } = {}) {
        if (lines.length < 2) return
        Logger.info(`Summarizing ${lines.length} entries...`, 'SUMMARIZE')
        const opts = this.getOpts()
        try {
            const { data } = await axios.post(`${opts.ollamaUrl}/v1/chat/completions`, {
                model: opts.model,
                messages: [{ role: 'system', content: SUMMARIZE_PROMPT }, { role: 'user', content: lines.join('\n') }],
                stream: false,
                temperature: getSection('llm').summaryTemperature,
                max_tokens: maxTokens,
            }, { timeout: opts.ollamaTimeout })

            const summary = cleanMemoryText(data.choices?.[0]?.message?.content ?? '')
            const raw = lines.map(cleanMemoryText).filter(Boolean).join('\n')
            if (!summary || !raw) return

            await this.store({ summary, raw, participants, emotions, importance, source })
        } catch (err) {
            Logger.error(err.message, 'SUMMARIZE')
        }
    }

    async summarizeConversation(channelId) {
        const lines = this.getHistory(channelId).lastN(this.getOpts().summarizeLastN)
            .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map(m => `${m.role === 'user' ? 'User' : 'Lily'}: ${m.content}`)
        return this.summarize(lines, { maxTokens: 150 })
    }

    /** Call once per handled message; summarizes every `summarizeEvery`-th. */
    async tick(channelId) {
        const count = (this.#counts.get(channelId) ?? 0) + 1
        this.#counts.set(channelId, count)
        const every = this.getOpts().summarizeEvery
        if (every > 0 && count % every === 0) await this.summarizeConversation(channelId)
    }

    /** Buffers an overheard line; flushes a batch summary every `observeEvery` lines. */
    observe(channelId, line, authorName = null) {
        const buffer = this.#observed.get(channelId) ?? []
        this.#observed.set(channelId, buffer)
        buffer.push(line)

        if (authorName && authorName.toLowerCase() !== 'lily') {
            const who = this.#participants.get(channelId) ?? new Set()
            this.#participants.set(channelId, who.add(authorName))
        }

        const every = this.getOpts().observeEvery
        if (every > 0 && buffer.length >= every) {
            const participants = [...(this.#participants.get(channelId) ?? [])]
            this.#participants.delete(channelId)
            this.summarize(buffer.splice(0, every), { maxTokens: 100, source: 'observe', importance: 0.3, participants })
        }
    }
}
