// src/ai/workingMemory.js
//
// A tiny per-channel scratchpad injected into every turn. Built for a room,
// not a 1:1 task chat — a Discord channel, a Minecraft server and a YouTube
// stream chat all have several people talking at once and no single "user".
//
//   {
//     topic, activity,
//     people:  { name -> { note, id, lastSeen } },   // presence tracked in CODE
//     threads: [ { text, who, ts } ]
//   }
//
// Split of responsibility, on purpose:
//   - WHO is around is deterministic. Every incoming message calls
//     noteSpeaker(); nobody is invented by a model, and nobody lingers in the
//     block forever after they stop talking.
//   - WHAT is going on comes from a cheap out-of-band pass that returns *ops*,
//     never a full rewrite. A bad generation can misplace one field instead of
//     wiping the object, and note_person / add_thread can only name someone
//     already present, so participants can't be hallucinated.
//
// Everything is capped, deduped and TTL'd so the block can't grow into a
// second system prompt.

import fs from 'fs'
import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { getConfig } from '../config.js'

const STORE_PATH = './working_memory.json'

const MAX_PEOPLE = 8
const MAX_THREADS = 6
const MAX_LEN = 140
const PRESENCE_TTL_MS = 45 * 60 * 1000      // stop listing someone who went quiet
const THREAD_TTL_MS = 6 * 60 * 60 * 1000

// Per-surface flavour for the update prompt. Keys match the channel ids used
// in Lily.js (minecraft / youtube / vrchat / voiceAssistant); anything else
// falls through to the Discord default.
const CHANNEL_KINDS = {
    minecraft: 'a Minecraft server — several players in chat, often building or fighting together',
    youtube: 'a live YouTube stream chat — many viewers, fast, mostly reactions and questions to Lily',
    vrchat: 'a VRChat instance — people drifting in and out of voice range',
    voiceAssistant: "a private voice session with Lily's owner",
    _default: 'a Discord channel — a handful of regulars talking to each other and to Lily',
}

const UPDATE_PROMPT = `You maintain a tiny shared scratchpad for a group chat. You are not talking to anyone.

Return ONLY a JSON object: {"ops": [...]} — no prose, no markdown, no reasoning.

Allowed ops:
{"op":"set_topic","value":"what the room is talking about"}
{"op":"set_activity","value":"what the group is doing right now"}
{"op":"clear_activity"}
{"op":"note_person","name":"<an exact name from People present>","value":"what that person is up to"}
{"op":"drop_person_note","name":"<an exact name from People present>"}
{"op":"add_thread","value":"one unresolved question or promise","who":"<optional exact name from People present>"}
{"op":"remove_thread","value":"the exact text of a thread that is now resolved"}

Rules:
- Several people are talking. Never assume one user. Topic and activity belong
  to the room; anything about one person goes in note_person.
- Only ever use names listed under "People present". Never invent a name and
  never guess who someone is.
- If nothing meaningful changed, return {"ops": []}.
- Never restate something already in the current state.
- Values: max 12 words, third person, no quotes.
- A thread is something genuinely left open — a question nobody answered, a
  task HyLily promised. Banter, greetings and reactions are never threads.
- Never note_person yourself (HyLily). You are not a participant, you are the room's memory.
  `

function emptyState() {
    return { topic: null, activity: null, people: {}, threads: [], updatedAt: 0 }
}

function clean(value) {
    if (typeof value !== 'string') return null
    const text = value
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!text) return null
    if (['null', 'none', 'unknown', 'n/a', 'someone', 'user', 'the user'].includes(text.toLowerCase())) return null
    return text.slice(0, MAX_LEN)
}

function sameText(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export class WorkingMemory {
    constructor({ storePath = STORE_PATH } = {}) {
        this.storePath = storePath
        this.states = new Map()
        this.inflight = new Set()
        this.counts = new Map()
        this._saveTimer = null
        this._load()
    }

    get opts() {
        return getConfig()
    }

    // ── State ────────────────────────────────────────────────────────────────

    get(channelId) {
        if (!this.states.has(channelId)) this.states.set(channelId, emptyState())
        return this.states.get(channelId)
    }

    clear(channelId) {
        this.states.set(channelId, emptyState())
        this._save()
    }

    /**
     * Deterministic presence. Call once per incoming message, before the turn
     * runs. No model involved — this is the only thing that creates a person.
     */
    noteSpeaker(channelId, { name, id = null } = {}) {
        const speaker = clean(name)
        if (!speaker) return null

        const state = this.get(channelId)
        const existing = state.people[speaker] ?? { note: null, id: null }
        state.people[speaker] = {
            note: existing.note,
            id: id ?? existing.id ?? null,
            lastSeen: Date.now(),
        }

        // Oldest-seen falls off first once the room gets busy.
        const names = Object.keys(state.people)
        if (names.length > MAX_PEOPLE) {
            names
                .sort((a, b) => state.people[a].lastSeen - state.people[b].lastSeen)
                .slice(0, names.length - MAX_PEOPLE)
                .forEach(n => delete state.people[n])
        }

        this._save()
        return speaker
    }

    /** Names seen recently enough to still count as "in the room". */
    presentNames(channelId) {
        const state = this.get(channelId)
        const cutoff = Date.now() - PRESENCE_TTL_MS
        return Object.entries(state.people)
            .filter(([, p]) => p.lastSeen >= cutoff)
            .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
            .map(([name]) => name)
    }

    /** Discord id for a name, when we've seen one — used for entity lookups. */
    idFor(channelId, name) {
        const key = clean(name)
        if (!key) return null
        const state = this.get(channelId)
        if (state.people[key]) return state.people[key].id ?? null
        const match = Object.entries(state.people).find(([n]) => sameText(n, key))
        return match ? (match[1].id ?? null) : null
    }

    _prune(state) {
        const now = Date.now()
        state.threads = state.threads
            .filter(t => t.ts >= now - THREAD_TTL_MS)
            .slice(-MAX_THREADS)
        for (const [name, person] of Object.entries(state.people)) {
            // Keep the person (their id is worth caching) but drop a stale note
            // so the block never describes what someone was doing yesterday.
            if (person.lastSeen < now - PRESENCE_TTL_MS) person.note = null
            if (person.lastSeen < now - THREAD_TTL_MS) delete state.people[name]
        }
    }

    // ── Injection ────────────────────────────────────────────────────────────

    renderBlock(channelId) {
        const state = this.get(channelId)
        this._prune(state)

        const lines = []
        if (state.activity) lines.push(`Going on: ${state.activity}`)
        if (state.topic) lines.push(`Topic: ${state.topic}`)

        const present = this.presentNames(channelId)
        if (present.length) {
            const described = present.map(name => {
                const note = state.people[name]?.note
                return note ? `${name} (${note})` : name
            })
            lines.push(`Here recently: ${described.join(', ')}`)
        }

        if (state.threads.length) {
            lines.push('Still open:')
            for (const t of state.threads) {
                lines.push(t.who ? `- ${t.who}: ${t.text}` : `- ${t.text}`)
            }
        }

        if (!lines.length) return null
        return `[Working memory]\n${lines.join('\n')}\n[End working memory]`
    }

    // ── Ops ──────────────────────────────────────────────────────────────────

    applyOps(channelId, ops) {
        if (!Array.isArray(ops) || !ops.length) return 0
        const state = this.get(channelId)
        const present = this.presentNames(channelId)
        const resolveName = (raw) => {
            const wanted = clean(raw)
            if (!wanted) return null
            return present.find(n => sameText(n, wanted)) ?? null
        }

        let applied = 0

        for (const raw of ops.slice(0, 8)) {
            const op = raw?.op
            const value = clean(raw?.value)

            switch (op) {
                case 'set_topic':
                    if (value && value !== state.topic) { state.topic = value; applied++ }
                    break

                case 'set_activity':
                    if (value && value !== state.activity) { state.activity = value; applied++ }
                    break

                case 'clear_activity':
                    if (state.activity) { state.activity = null; applied++ }
                    break

                case 'note_person': {
                    const name = resolveName(raw?.name)
                    if (!name) {
                        Logger.warning(`note_person for unknown name: ${JSON.stringify(raw?.name)}`, 'WORKING MEMORY')
                        break
                    }
                    if (!value || state.people[name].note === value) break
                    state.people[name].note = value
                    applied++
                    break
                }

                case 'drop_person_note': {
                    const name = resolveName(raw?.name)
                    if (name && state.people[name].note) { state.people[name].note = null; applied++ }
                    break
                }

                case 'add_thread': {
                    if (!value) break
                    if (state.threads.some(t => sameText(t.text, value))) break
                    state.threads.push({ text: value, who: resolveName(raw?.who), ts: Date.now() })
                    if (state.threads.length > MAX_THREADS) state.threads.shift()
                    applied++
                    break
                }

                case 'remove_thread': {
                    if (!value) break
                    const before = state.threads.length
                    state.threads = state.threads.filter(t => !sameText(t.text, value))
                    if (state.threads.length !== before) applied++
                    break
                }

                default:
                    Logger.warning(`Ignored unknown op: ${JSON.stringify(raw).slice(0, 120)}`, 'WORKING MEMORY')
            }
        }

        if (applied) {
            state.updatedAt = Date.now()
            this._save()
            Logger.info(`${applied} op(s) for ${channelId}: ${JSON.stringify({
                topic: state.topic,
                activity: state.activity,
                people: Object.fromEntries(Object.entries(state.people).map(([n, p]) => [n, p.note])),
                threads: state.threads.map(t => t.text),
            })}`, 'WORKING MEMORY')
        }
        return applied
    }

    // ── Update pass ──────────────────────────────────────────────────────────

    /**
     * Fire-and-forget. Never awaited on the reply path, never throws.
     * `lines` should be the recent multi-party chat ("Name: text"), not just
     * the one message that triggered the turn — in a busy channel that single
     * message is often not what the room is actually doing.
     *
     * @param {string} channelId
     * @param {object} exchange - { lines: string[], replyText: string }
     */
    update(channelId, { lines = [], replyText = '' } = {}) {
        if (!this.opts.workingMemoryEnabled) return
        if (!lines.length && !replyText.trim()) return

        const every = Math.max(1, this.opts.workingMemoryEvery ?? 1)
        const count = (this.counts.get(channelId) ?? 0) + 1
        this.counts.set(channelId, count)
        if (count % every !== 0) return

        if (this.inflight.has(channelId)) return
        this.inflight.add(channelId)

        this._runUpdate(channelId, { lines, replyText })
            .catch(err => Logger.error(err.message, 'WORKING MEMORY'))
            .finally(() => this.inflight.delete(channelId))
    }

    async _runUpdate(channelId, { lines, replyText }) {
        const state = this.get(channelId)
        const present = this.presentNames(channelId)

        const snapshot = {
            topic: state.topic,
            activity: state.activity,
            people: present.map(n => ({ name: n, note: state.people[n]?.note ?? null })),
            threads: state.threads.map(t => ({ text: t.text, who: t.who })),
        }

        const transcript = [
            ...lines.slice(-(this.opts.workingMemoryLines ?? 8)),
            replyText ? `Lily: ${replyText}` : '',
        ].filter(Boolean).join('\n')

        const setting = CHANNEL_KINDS[channelId] ?? CHANNEL_KINDS._default

        const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, {
            model: this.opts.workingMemoryModel || this.opts.model,
            messages: [
                { role: 'system', content: UPDATE_PROMPT },
                {
                    role: 'user',
                    content:
                        `Setting: ${setting}\n\n` +
                        `People present (use these names exactly, no others): ${present.length ? present.join(', ') : 'nobody yet'}\n\n` +
                        `Current state:\n${JSON.stringify(snapshot)}\n\n` +
                        `Recent chat:\n${transcript}`,
                },
            ],
            stream: false,
            temperature: 0.1,
            max_tokens: this.opts.workingMemoryMaxTokens ?? 250,
            think: false,
            reasoning_effort: 'none',
        }, { timeout: this.opts.ollamaTimeout })

        const ops = this._parseOps(data.choices?.[0]?.message?.content ?? '')
        this.applyOps(channelId, ops)
    }

    _parseOps(content) {
        const text = content
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```(?:json)?/gi, '')
            .trim()
        if (!text) return []

        const start = text.search(/[[{]/)
        if (start === -1) return []

        try {
            const parsed = JSON.parse(text.slice(start))
            if (Array.isArray(parsed)) return parsed
            if (Array.isArray(parsed?.ops)) return parsed.ops
        } catch {
            Logger.warning(`Unparseable ops payload: ${text.slice(0, 160)}`, 'WORKING MEMORY')
        }
        return []
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    _load() {
        try {
            if (!fs.existsSync(this.storePath)) return
            const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'))

            for (const [channelId, state] of Object.entries(parsed ?? {})) {
                const people = {}
                for (const [name, person] of Object.entries(state?.people ?? {})) {
                    const key = clean(name)
                    if (!key) continue
                    people[key] = {
                        note: clean(person?.note),
                        id: person?.id ?? null,
                        lastSeen: Number(person?.lastSeen) || 0,
                    }
                }
                this.states.set(channelId, {
                    topic: clean(state?.topic),
                    activity: clean(state?.activity),
                    people,
                    threads: Array.isArray(state?.threads)
                        ? state.threads
                            .map(t => ({ text: clean(t?.text), who: clean(t?.who), ts: Number(t?.ts) || Date.now() }))
                            .filter(t => t.text)
                            .slice(-MAX_THREADS)
                        : [],
                    updatedAt: Number(state?.updatedAt) || 0,
                })
            }
            Logger.info(`Loaded ${this.states.size} channel state(s)`, 'WORKING MEMORY')
        } catch (err) {
            Logger.error(`Load failed, starting empty: ${err.message}`, 'WORKING MEMORY')
        }
    }

    _save() {
        clearTimeout(this._saveTimer)
        this._saveTimer = setTimeout(() => {
            try {
                fs.writeFileSync(this.storePath, JSON.stringify(Object.fromEntries(this.states), null, 2))
            } catch (err) {
                Logger.error(`Save failed (non-fatal): ${err.message}`, 'WORKING MEMORY')
            }
        }, 1000)
        this._saveTimer.unref?.()
    }
}