// src/ai/memory/factExtractor.js
// Second, narrow LLM call that pulls lasting facts about people out of a BATCH of chat
// lines (many speakers) and stores them out-of-band. Runs after the summarizer, so the
// chat model never has to decide to save anything.
import axios from 'axios'
import { chatCompletion } from '../llmClient.js'
import { Logger } from '../../utils/Logger.js'

const CATEGORIES = new Set(['person', 'project', 'place', 'object', 'preference', 'goal', 'decision', 'event', 'general'])
const NOT_A_NAME = new Set(['i', 'me', 'my', 'he', 'she', 'they', 'him', 'her', 'them', 'we', 'you', 'someone', 'somebody',
    'user', 'speaker', 'unknown', 'n/a', 'none', 'null', 'lily'])

const CHUNK_SIZE = 20            // chat lines per model call
const CONTEXT_LINES = 3          // earlier lines shown as context only
const MAX_FACTS_PER_CHUNK = 12
const MIN_LETTERS = 6            // a chunk with no real text from a human is skipped
const MAX_STORED_PEOPLE = 8      // people whose stored facts are shown to the model per chunk

const EXTRACT_PROMPT = `/no_think
You extract lasting facts about people from a chat log. Output JSON only. No prose, no code fences.

You are shown:
Known people: names currently in the room (may be missing)
ALREADY STORED: facts already saved about people in the log (may be missing)
EARLIER CONTEXT: lines before the log, only for working out who "he/she/they" means (may be missing)
CHAT LOG: lines in the form "Name: message"

Format: {"facts":[{"person":"","text":"","category":""}]}
If there is nothing to save: {"facts":[]}

Rules:
- Facts come ONLY from lines written by people. Lines written by "Lily" are the bot: use them to understand what people are answering, but NEVER save something that only Lily said, and never save facts about Lily.
- The log can contain SEVERAL people and SEVERAL facts. Return one entry per separate fact, about whichever person it concerns. Split lists and compound sentences ("X likes A and B" is two facts). Never merge different facts into one entry.
- Output ONLY facts that are NEW. Skip anything already in ALREADY STORED, even if worded differently, and skip a fact that is just a part of, or a combination of, stored facts.
- "I / me / my" means the person who wrote that line. "person" must be a real name, never a pronoun. Resolve "he/she/they" from nearby lines. If you cannot tell who it is, skip it.
- "person" must be the name exactly as written in the CHAT LOG or Known people. Never use a variant, nickname or typo of it from the stored facts.
- "text" is one short standalone sentence containing the person's name, 3-20 words. Drop framing like "did you know", "btw", "also". Fill in missing detail from the previous line when an answer depends on it.
- A lasting fact is: likes/dislikes, job, skills, possessions, plans, history, relationships, opinions, habits, identity.
- Skip: questions, commands, greetings, jokes with no real fact, temporary states (hungry, tired, brb), general world facts not about a person.
- Never invent anything that was not said. At most ${MAX_FACTS_PER_CHUNK} facts.
- "category" is one of: person, project, place, object, preference, goal, decision, event, general.

Examples:
Known people: Kai, Shiny, Mia
CHAT LOG:
Kai: did you know Sam hates mornings?
Lily: sam is a menace, don't wake him (눈_눈)
Shiny: isgone also likes furrys
Lily: of course he does (◕‿◕✿)
Mia: I main support and I live in Madrid
{"facts":[{"person":"Sam","text":"Sam hates mornings","category":"preference"},{"person":"isgone","text":"isgone likes furries","category":"preference"},{"person":"Mia","text":"Mia mains support","category":"preference"},{"person":"Mia","text":"Mia lives in Madrid","category":"place"}]}

Known people: Kai, Mia
CHAT LOG:
Lily: did mia ever hear back about the job?
Kai: yeah she got it, and she's starting next week
Lily: good for her (≧◡≦)
{"facts":[{"person":"Mia","text":"Mia got the job she applied for","category":"event"},{"person":"Mia","text":"Mia starts her new job next week","category":"event"}]}

Known people: Kai, Mia
ALREADY STORED:
- Mia: Mia lives in Madrid
CHAT LOG:
Mia: I live in Madrid and I work as a nurse
{"facts":[{"person":"Mia","text":"Mia works as a nurse","category":"person"}]}

Known people: Kai
CHAT LOG:
Lily: i love pizza, it's the best
Kai: lol ok
Kai: lily what's the capital of france?
Lily: paris, duh (눈_눈)
{"facts":[]}`

function parseFacts(raw) {
    const match = (raw ?? '').match(/\{[\s\S]*\}/)
    if (!match) return []
    try {
        const obj = JSON.parse(match[0])
        return Array.isArray(obj.facts) ? obj.facts : []
    } catch {
        return []
    }
}

const isLily = name => String(name ?? '').toLowerCase() === 'lily'
const render = arr => arr.map(l => `${l.name}: ${l.text}`).join('\n')

function hasHumanText(chunk) {
    return chunk.some(l => !isLily(l.name) && l.text.replace(/[^\p{L}]/gu, '').length >= MIN_LETTERS)
}

// Facts already stored for a person (resolved by the memory server through aliases).
// Private facts are only fetched on private turns, so a server turn never sees them.
async function existingFacts(opts, name, includePrivate) {
    try {
        const { data } = await axios.post(`${opts.memoryDbUrl}/get_entity`, {
            person_name: name,
            limit: 30,
            include_private: includePrivate,
            include_related: false,
            summary_mode: 'off',
        }, { timeout: opts.dbTimeout })
        return (data?.results ?? []).filter(r => r.relation === 'own').map(r => `${name}: ${r.text}`)
    } catch {
        return []
    }
}

function buildUserContent({ chunk, context, known, stored }) {
    const parts = []
    if (known.length) parts.push(`Known people: ${known.join(', ')}`)
    if (stored.length) parts.push(`ALREADY STORED:\n${stored.map(s => `- ${s}`).join('\n')}`)
    if (context.length) parts.push(`EARLIER CONTEXT:\n${render(context)}`)
    parts.push(`CHAT LOG:\n${render(chunk)}`)
    return parts.join('\n')
}

/**
 * Extracts facts from a batch of named chat lines and stores them. Never throws.
 * @param {object} p
 * @param {{name:string,text:string}[]} p.lines    chat lines in order, speaker name per line
 * @param {{name:string,text:string}[]} [p.context] lines before `lines`, context only
 * @param {string[]} [p.known]                      names currently in the room
 * @param {object} p.tools                          ToolRouter (needs addFactOutOfBand)
 * @param {object} p.opts                           merged config
 * @param {(name:string)=>string|null} [p.idLookup] name -> Discord id
 * @param {'server'|'private'} [p.visibility]
 * @returns {Promise<number>} facts sent to the store
 */
export async function extractAndStoreFacts({
    lines, context = [], known = [], tools, opts, idLookup = () => null, visibility = 'server',
}) {
    try {
        if (!lines?.length) return 0

        const llmOpts = {
            ...opts,
            think: false,
            model: opts.factExtractionModel ?? opts.model,
        }
        const includePrivate = visibility === 'private'

        const seen = new Set()
        let stored = 0

        for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
            const chunk = lines.slice(i, i + CHUNK_SIZE)
            if (!hasHumanText(chunk)) continue
            const ctx = i === 0 ? context.slice(-CONTEXT_LINES) : lines.slice(Math.max(0, i - CONTEXT_LINES), i)

            const speakers = [...new Set([...ctx, ...chunk].map(l => l.name).filter(n => n && !isLily(n)))]
            const people = [...new Set([...known, ...speakers])]
            const canonical = new Map(people.map(n => [n.toLowerCase(), n]))
            const haystack = [...ctx, ...chunk].map(l => `${l.name} ${l.text}`).join('\n').toLowerCase()

            // Facts already on file for everyone this chunk is about, so the model skips repeats.
            const mentioned = people.filter(n => haystack.includes(n.toLowerCase())).slice(0, MAX_STORED_PEOPLE)
            const storedFacts = (await Promise.all(mentioned.map(n => existingFacts(opts, n, includePrivate)))).flat()
            const storedSet = new Set(storedFacts.map(s => s.toLowerCase()))

            const msg = await chatCompletion(
                llmOpts,
                [
                    { role: 'system', content: EXTRACT_PROMPT },
                    { role: 'user', content: buildUserContent({ chunk, context: ctx, known: people, stored: storedFacts }) },
                ],
                { overrides: { temperature: 0, max_tokens: 900, presence_penalty: 0, repeat_penalty: 1 } },
            )
            const facts = parseFacts(msg?.content)

            for (const f of facts.slice(0, MAX_FACTS_PER_CHUNK)) {
                const rawPerson = String(f?.person ?? '').trim()
                const text = String(f?.text ?? '').trim()
                if (!rawPerson || NOT_A_NAME.has(rawPerson.toLowerCase())) continue

                const wordCount = text.split(/\s+/).filter(Boolean).length
                if (wordCount < 3 || text.length > 150) continue

                const person = canonical.get(rawPerson.toLowerCase()) ?? rawPerson
                if (!text.toLowerCase().includes(person.toLowerCase())) {
                    Logger.warning(`Dropped, text lacks the name "${person}": "${text}"`, 'FACT EXTRACT')
                    continue
                }
                // Guard against invented names: the person must actually appear in the log.
                if (!haystack.includes(person.toLowerCase())) {
                    Logger.warning(`Dropped, "${person}" never appears in the log: "${text}"`, 'FACT EXTRACT')
                    continue
                }

                const key = `${person.toLowerCase()}|${text.toLowerCase()}`
                if (seen.has(key)) continue
                seen.add(key)

                // Exact repeat of something already stored: skip without a server round trip.
                if (storedSet.has(`${person}: ${text}`.toLowerCase())) {
                    Logger.info(`${person}: "${text}" -> already stored`, 'FACT EXTRACT')
                    continue
                }

                const category = CATEGORIES.has(f?.category) ? f.category : 'general'
                // Sequential on purpose: keeps the backend's dedupe/similarity check from racing itself.
                const res = await tools.addFactOutOfBand({
                    text,
                    source: 'auto_extract',
                    category,
                    subject_id: idLookup(person) ?? null,
                    person_name: person,
                    visibility,
                })
                Logger.info(`${person}: "${text}" -> ${res?.status ?? 'unknown'}`, 'FACT EXTRACT')
                if (res?.status !== 'error') stored++
            }
        }
        if (stored) Logger.success(`${stored} fact(s) stored from ${lines.length} line(s)`, 'FACT EXTRACT')
        return stored
    } catch (err) {
        Logger.error(err.message, 'FACT EXTRACT')
        return 0
    }
}