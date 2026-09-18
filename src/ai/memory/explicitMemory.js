// src/ai/explicitMemory.js
//
// When someone *explicitly* says "remember that X" / "forget X", write it
// straight through with the primitives that already exist (add_fact /
// remove_by_query) instead of hoping the model decides to call
// addto_memory_database.
//
// Multi-party aware:
//   - In a server, people address her by name ("Lily, remember that ..."),
//     and mentions arrive as <@123>. Both get stripped before matching.
//   - First person ("remember that I hate mushrooms") is attributed to the
//     SPEAKER — name, and their Discord id as subject_id.
//   - Third person ("remember that Alex hates mushrooms") is attributed to
//     that person when they're someone we've actually seen in the channel;
//     otherwise it's stored as a plain fact with no subject.
//
// Deliberately narrow: patterns are anchored to the start of the message, so
// "I should remember that for later" doesn't trigger a write. This runs
// out-of-band — it does not spend the turn's tool budget — and returns a note
// injected into the same turn so the model doesn't store a duplicate itself.

import { Logger } from '../../utils/Logger.js'

const ADDRESS = String.raw`(?:<@!?\d+>|lily|@lily)[,\s]+`

const REMEMBER_PATTERNS = [
    new RegExp(String.raw`^(?:hey\s+)?(?:${ADDRESS})?(?:please\s+)?(?:remember|memorize|note)\s*(?:that|this)?\s*[:,-]?\s*(.+)$`, 'i'),
    new RegExp(String.raw`^(?:hey\s+)?(?:${ADDRESS})?(?:don'?t|do not)\s+forget\s+(?:that\s+)?(.+)$`, 'i'),
    new RegExp(String.raw`^(?:hey\s+)?(?:${ADDRESS})?keep in mind\s+(?:that\s+)?(.+)$`, 'i'),
]

const FORGET_PATTERNS = [
    new RegExp(String.raw`^(?:hey\s+)?(?:${ADDRESS})?(?:please\s+)?forget\s+(?:that\s+|about\s+|what i said about\s+)?(.+)$`, 'i'),
    new RegExp(String.raw`^(?:hey\s+)?(?:${ADDRESS})?(?:delete|remove)\s+(?:the\s+)?(?:memory|fact)\s+(?:about\s+)?(.+)$`, 'i'),
]

// Anything here is banter or a nuke request, not a pointer to one fact.
const VAGUE = new Set([
    'everything', 'it', 'that', 'this', 'all', 'all of it', 'me', 'us', 'him', 'her', 'them',
    'everything about me', 'everything i said', 'all of that', 'my memory', 'everything about us',
])

const FIRST_PERSON = /\b(i|i'm|im|i've|my|me|mine|myself)\b/i
const MIN_WORDS = 2
const MAX_LEN = 150

function normalize(raw) {
    return (raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?,;]+$/, '')
}

function isUsable(payload) {
    if (!payload) return false
    if (VAGUE.has(payload.toLowerCase())) return false
    if (payload.split(/\s+/).length < MIN_WORDS) return false
    if (payload.length > MAX_LEN) return false
    return true
}

/**
 * Pure detector — no side effects, safe to unit test.
 * @returns {{intent: 'remember'|'forget', payload: string} | null}
 */
export function detectExplicitMemory(text) {
    const message = normalize(text)
    if (!message || message.length > 400) return null

    for (const pattern of FORGET_PATTERNS) {
        const match = message.match(pattern)
        if (match) {
            const payload = normalize(match[1])
            return isUsable(payload) ? { intent: 'forget', payload } : null
        }
    }

    for (const pattern of REMEMBER_PATTERNS) {
        const match = message.match(pattern)
        if (match) {
            const payload = normalize(match[1])
            return isUsable(payload) ? { intent: 'remember', payload } : null
        }
    }

    return null
}

/**
 * Who is this fact about? Returns { personName, subjectId, firstPerson }.
 * `known` is the list of names actually seen in this channel (working memory)
 * so a random capitalised word never becomes a "person".
 */
export function attributeFact(payload, { authorName = null, authorId = null, known = [], idLookup = null } = {}) {
    if (FIRST_PERSON.test(payload)) {
        return { personName: authorName, subjectId: authorId, firstPerson: true }
    }

    const lower = payload.toLowerCase()
    const mentioned = known
        .filter(name => name && lower.includes(name.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0]

    if (mentioned) {
        return {
            personName: mentioned,
            subjectId: idLookup ? idLookup(mentioned) : null,
            firstPerson: false,
        }
    }

    return { personName: null, subjectId: null, firstPerson: false }
}

/**
 * Detect + write. Returns a short note to inject into this turn's context,
 * or null when nothing fired. Never throws.
 *
 * @param {string} text  the raw user message
 * @param {object} ctx   { tools, authorName, authorId, known, idLookup }
 */
export async function handleExplicitMemory(text, {
    tools,
    authorName = null,
    authorId = null,
    known = [],
    idLookup = null,
} = {}) {
    const hit = detectExplicitMemory(text)
    if (!hit || !tools) return null

    const who = authorName ?? 'someone'

    try {
        if (hit.intent === 'forget') {
            const result = await tools.removeFactOutOfBand(hit.payload)
            if (!result?.removed?.length) {
                Logger.info(`No match to remove for: "${hit.payload}"`, 'EXPLICIT MEMORY')
                return `[Note: ${who} asked you to forget "${hit.payload}", but nothing matching was stored. Say so plainly — don't call a memory tool for it.]`
            }
            Logger.success(`Removed for ${who}: ${result.removed.join(', ')}`, 'EXPLICIT MEMORY')
            return `[Note: "${result.removed.join('", "')}" has already been deleted from memory. Confirm it in character — do not call remove_memory_database.]`
        }

        const { personName, subjectId, firstPerson } = attributeFact(hit.payload, {
            authorName, authorId, known, idLookup,
        })

        // Rewrite "I hate mushrooms" as "ShinyShadow_: I hate mushrooms" so the
        // fact still means something when it comes back out of the DB months
        // later with no speaker attached.
        const factText = firstPerson && authorName
            ? `${authorName}: ${hit.payload}`
            : hit.payload

        const result = await tools.addFactOutOfBand({
            text: factText,
            source: `explicit:${who}`,
            // Metadata from step 1 — never touches the embedding, only get_entity().
            category: personName ? 'person' : 'general',
            subject_id: subjectId ?? null,
            person_name: personName ?? null,
        })

        if (result?.status === 'skipped') {
            Logger.info(`Already stored: "${factText}"`, 'EXPLICIT MEMORY')
            return `[Note: you already know that — "${factText}" is in memory. Don't call addto_memory_database for it.]`
        }
        if (result?.status !== 'ok') {
            Logger.warning(`Write failed: ${JSON.stringify(result)}`, 'EXPLICIT MEMORY')
            return null
        }

        Logger.success(`Stored from ${who}: "${factText}"${personName ? ` [person: ${personName}]` : ''}`, 'EXPLICIT MEMORY')
        return `[Note: "${factText}" has already been saved to memory. Acknowledge it in character — do not call addto_memory_database for it.]`
    } catch (err) {
        Logger.error(err.message, 'EXPLICIT MEMORY')
        return null
    }
}