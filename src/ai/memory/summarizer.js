import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { SUMMARIZE_PROMPT } from '../prompts.js'
import { getSection } from '../config.js'

const NAMED_CAP = 120       // max named lines kept per channel while waiting for extraction
const TAIL_LINES = 3        // last lines of the previous batch, handed over as context

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
// stored as episodic memories. After each summarization, the chat lines collected
// since the last one (with speaker names) are handed to `onExtract` for fact extraction.
export class Summarizer {
    #counts = new Map()          // channelId -> messages handled
    #observed = new Map()        // channelId -> lines awaiting a batch
    #participants = new Map()    // channelId -> Set of speaker names
    #named = new Map()           // channelId -> [{ name, text, isPrivate }] awaiting extraction
    #tail = new Map()            // channelId -> last lines of the previous extracted batch
    #pending = new Set()         // channels whose extraction is deferred until after the reply

    /**
     * @param {() => object} getOpts   current merged config
     * @param {(channelId: string) => object} getHistory
     * @param {(memory: object) => Promise<unknown>} store  episodic memory writer
     * @param {(batch: {channelId:string, lines:object[], context:object[], isPrivate:boolean}) => Promise<unknown>} [onExtract]
     */
    constructor(getOpts, getHistory, store, onExtract = null) {
        this.getOpts = getOpts
        this.getHistory = getHistory
        this.store = store
        this.onExtract = onExtract
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

    // ---------- named lines for fact extraction ----------
    /** Records one chat line with its speaker. Skips a line already recorded a moment ago (observe + handleMessage overlap). */
    record(channelId, name, text, { isPrivate = false } = {}) {
        const clean = cleanMemoryText(String(text ?? '')).replace(/\s+/g, ' ').trim()
        if (!clean) return
        const entry = { name: name || 'User', text: clean.slice(0, 400), isPrivate }
        const buffer = this.#named.get(channelId) ?? []
        this.#named.set(channelId, buffer)
        if (buffer.slice(-5).some(e => e.name === entry.name && e.text === entry.text)) return
        buffer.push(entry)
        if (buffer.length > NAMED_CAP) buffer.splice(0, buffer.length - NAMED_CAP)
    }

    async #extract(channelId) {
        if (!this.onExtract) return
        const buffer = this.#named.get(channelId)
        if (!buffer?.length) return

        const lines = buffer.splice(0, buffer.length)
        const context = this.#tail.get(channelId) ?? []
        this.#tail.set(channelId, lines.slice(-TAIL_LINES))
        const isPrivate = lines.some(l => l.isPrivate)
        try {
            await this.onExtract({ channelId, lines, context, isPrivate })
        } catch (err) {
            Logger.error(err.message, 'FACT EXTRACT')
        }
    }

    /** Runs a deferred extraction, if a summary just ran for this channel. Call after the reply has been sent. */
    async runPendingExtraction(channelId) {
        if (!this.#pending.delete(channelId)) return
        await this.#extract(channelId)
    }

    /**
     * Call once per handled message; summarizes every `summarizeEvery`-th.
     * Extraction is deferred (see runPendingExtraction) so it never competes with the reply for the model.
     */
    async tick(channelId) {
        const count = (this.#counts.get(channelId) ?? 0) + 1
        this.#counts.set(channelId, count)
        const every = this.getOpts().summarizeEvery
        if (every > 0 && count % every === 0) {
            await this.summarizeConversation(channelId)
            this.#pending.add(channelId)
        }
    }

    /** Buffers an overheard line; flushes a batch summary every `observeEvery` lines, then extracts facts. */
    observe(channelId, line, authorName = null) {
        const buffer = this.#observed.get(channelId) ?? []
        this.#observed.set(channelId, buffer)
        buffer.push(line)
        this.record(channelId, authorName ?? 'User', line)

        if (authorName && authorName.toLowerCase() !== 'lily') {
            const who = this.#participants.get(channelId) ?? new Set()
            this.#participants.set(channelId, who.add(authorName))
        }

        const every = this.getOpts().observeEvery
        if (every > 0 && buffer.length >= every) {
            const participants = [...(this.#participants.get(channelId) ?? [])]
            this.#participants.delete(channelId)
            this.summarize(buffer.splice(0, every), { maxTokens: 100, source: 'observe', importance: 0.3, participants })
                .finally(() => this.#extract(channelId))
        }
    }
}