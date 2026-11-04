import axios from "axios"
import fs from "fs"
import path from "path"
import { Logger } from '../../utils/Logger.js'
import { tavily } from "@tavily/core"
import { getConfig, getSection } from '../config.js'
import { DONE_NOTE } from './toolHelpers.js'

// ─── Turn budget limits ─────────────────────────────────────────────────
// Only chat-context tools (memory, media, web search) spend against this.
// Minecraft and VTubing tools are intentionally exempt — see tools.js.
// Values come from config.json "toolLimits"; read on each access so edits apply live.
const LIMITS = new Proxy({}, {
    get: (_, key) => getSection('toolLimits')[key],
})

// Channels whose turns are private by nature (matches the id used in Lily.js).
const PRIVATE_CHANNELS = new Set(["voiceAssistant"])

// A fact written during a DM or voice turn is stored as 'private' in the vault
// so it never surfaces in a public channel.
const visibilityFor = (ctx = {}) =>
    (ctx.isDM || PRIVATE_CHANNELS.has(ctx.channelId)) ? "private" : "server"

// ─── Web search helpers (Tavily free tier) ──────────────────────────────
// Free tier = a small monthly credit pool, and a basic search costs 1 credit.
// So: results are cached, usage is counted on disk against a cap, and the
// expensive "advanced" depth is never used. Every knob below can be overridden
// with a flat key in config.json "search" (e.g. "tavilyMonthlyCap": 800).
const webCfg = () => {
    const s = getSection('search') ?? {}
    return {
        monthlyCap: s.tavilyMonthlyCap ?? 900,       // stay under the free pool; check your dashboard
        usagePath: s.tavilyUsagePath ?? "./data/tavily-usage.json",
        fetchResults: s.tavilyFetchResults ?? 8,     // asked for; the filter keeps the best few
        keep: s.tavilyKeep ?? 4,                     // sources actually shown to the model
        minScore: s.tavilyMinScore ?? 0.25,
        maxPerDomain: s.tavilyMaxPerDomain ?? 2,
        snippetChars: s.tavilySnippetChars ?? 450,
        answerChars: s.tavilyAnswerChars ?? 500,
        newsDays: s.tavilyNewsDays ?? 7,
        cacheTtlMs: s.tavilyCacheTtlMs ?? 15 * 60 * 1000,
        cacheMax: 50,
    }
}

const monthKey = () => new Date().toISOString().slice(0, 7)

function loadUsage(file) {
    try {
        const u = JSON.parse(fs.readFileSync(file, "utf8"))
        if (u?.month === monthKey() && Number.isFinite(u.credits)) return u
    } catch { /* first run or unreadable: start fresh */ }
    return { month: monthKey(), credits: 0 }
}

function saveUsage(file, usage) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(usage))
    } catch (err) {
        Logger.error(`Could not save usage (non-fatal): ${err.message}`, "WEB SEARCH")
    }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, "") } catch { return "unknown" } }

function trimText(text, max) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// Best-scoring first, junk dropped, at most N per domain. If nothing clears the
// score floor, keep the single best result but flag it as weak.
function pickResults(raw, c) {
    const sorted = [...(raw ?? [])]
        .filter(r => r?.content && r?.url)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const good = sorted.filter(r => (r.score ?? 1) >= c.minScore)
    const pool = good.length ? good : sorted.slice(0, 1)

    const perDomain = new Map()
    const picked = []
    for (const r of pool) {
        const host = hostOf(r.url)
        const n = perDomain.get(host) ?? 0
        if (n >= c.maxPerDomain) continue
        perDomain.set(host, n + 1)
        picked.push(r)
        if (picked.length >= c.keep) break
    }
    return { picked, weak: !good.length && picked.length > 0 }
}

// ─── Chat Tool Executor ──────────────────────────────────────────────────
//
// Turn-loop contract (unchanged from before the split — read before touching):
//   1. Call resetTurn() once at the START of handling each new incoming
//      user message.
//   2. After every tool execution, check shouldHardStop(). If true, force
//      a final generation with `tools` removed from the request.
//   3. When the model narrates a tool call in prose instead of emitting a
//      real one, call recordNarration() and check its return the same way.
//
// Flawless-turn tracking: turnFlawless starts true on resetTurn() and
// flips false the first time markFlawed() is called. lily.js checks
// this.tools.turnFlawless (via the router) before saving a turn to the
// training-data queue. markFlawed() is idempotent, only the first reason
// per turn sticks.
class ChatToolExecutor {
    constructor() {
        this.resetTurn()
        this._searchCache = new Map()
        this._usage = null
        this._tavilyClient = null
        this._entityNames = { at: 0, names: [] }
        this._missCache = new Map()   // NEW: lowercase name -> time of last empty lookup
    }

    get opts() {
        return getConfig()
    }

    get toolNames() {
        return CHAT_TOOL_NAMES
    }

    get tools() {
        return CHAT_TOOLS
    }

    resetTurn() {
        this.turnUsage = { memoryWrite: 0, media: 0, memoryQuery: 0, webSearch: 0, total: 0 }
        this.turnHardStop = false
        this.turnNarrationCount = 0
        this.turnBadArgs = 0
        this.turnFlawless = true
        this._flawReason = null
    }

    shouldHardStop() {
        return this.turnHardStop
    }

    markFlawed(reason) {
        if (this.turnFlawless) {
            this.turnFlawless = false
            this._flawReason = reason
            Logger.info(`Turn disqualified from flawless-save: ${reason}`, "FLAWLESS CHECK")
        }
    }

    recordNarration() {
        this.turnNarrationCount++
        this.markFlawed('narrated_tool')
        if (this.turnNarrationCount > LIMITS.narration) {
            this.turnHardStop = true
            return true
        }
        return false
    }

    // ─── Shared helpers ──────────────────────────────────────────────────
    _blocked(message) {
        this.turnHardStop = true
        this.markFlawed('blocked')
        return JSON.stringify({ status: "blocked", stop: true, message })
    }

    _err(message) {
        this.markFlawed('tool_error')
        return JSON.stringify({ status: "error", message })
    }

    _ok(message, extra = {}, { done = true } = {}) {
        return JSON.stringify({
            status: "ok",
            message,
            ...(done ? { instruction: DONE_NOTE } : {}),
            ...extra
        })
    }

    _checkLimit(key, limit, label) {
        if (this.turnUsage[key] >= limit) {
            return this._blocked(
                `STOP. You've already hit the limit for ${label} this turn (max ${limit}). Do not call it again for any reason. ` +
                `Write your visible, in-character reply now using only what you already have.`
            )
        }
        return null
    }

    _spendTotal() {
        if (this.turnUsage.total >= LIMITS.total) {
            return this._blocked(
                `STOP. You have already made ${this.turnUsage.total} tool calls this turn — that is the hard maximum for ANY tool, of any kind, combined. ` +
                `Do not call query_memory_database, addto/update/remove_memory_database, send_gif, send_meme, or web_search again — not this one, not a different one. ` +
                `Write your final, visible, in-character chat reply to the user right now, using only what you already have.`
            )
        }
        this.turnUsage.total++
        return null
    }

    _requireQuery(query, minWords, exampleHint) {
        const trimmed = (query ?? "").trim()
        if (!trimmed || trimmed.split(/\s+/).length < minWords) {
            this.turnBadArgs++
            this.markFlawed('bad_args')
            if (this.turnBadArgs > LIMITS.badArgs) {
                return this._blocked(
                    `STOP. You've now called a tool with a missing/empty/too-short argument ${this.turnBadArgs} time(s) this turn. ` +
                    `Do not call any more tools this turn, of any kind. Write your visible, in-character reply right now using only what you already have — ` +
                    `it's fine to skip whatever you were trying to do with that tool.`
                )
            }
            return this._err(
                `Missing or too-short query argument. You must pass an actual descriptive query string in the argument — ` +
                `not an empty value, not the raw user message. Example of a valid value: "${exampleHint}". ` +
                `If you don't actually have a real value to put there, don't call this tool again — drop it and reply in character instead.`
            )
        }
        return null
    }

    async wikiSearch(query) {
        Logger.info(`"${query}"`, "WIKI")
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout
            })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No relevant information found in the wiki."
            return text
        } catch (err) {
            Logger.error(err.message, "WIKI")
            return "No relevant information found in the wiki right now."
        }
    }

    async memoryQuery(query, { daysAgo = null, windowDays = 2, daysBack = null, includePrivate = false } = {}) {
        const limitErr = this._checkLimit('memoryQuery', LIMITS.memoryQuery, 'memory search (query_memory_database)')
        if (limitErr) return limitErr

        if (daysBack === null) {
            const argErr = this._requireQuery(query, 2, "shinyshadow_ favorite food")
            if (argErr) return argErr
        }

        this.turnUsage.memoryQuery++

        const finish = (resultsText) => JSON.stringify({
            status: "ok",
            results: resultsText,
            instruction: "Memory lookup complete. Use these results (or their absence) to write your visible, in-character reply now — don't search again unless this genuinely didn't answer what you needed."
        })

        if (daysBack !== null) {
            Logger.info(`Queried recent memories up to ${daysBack} days back`, "MEMORY QUERY")
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/recent`, {
                    limit: getSection('memory').recentLimit, days_back: daysBack, min_importance: getSection('memory').recentMinImportance
                }, { timeout: this.opts.dbTimeout })

                if (!data?.results?.length) return finish(`No memories found from the last ${daysBack} days.`)

                return finish(data.results.map(e => {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return e.type === "episodic" ? `[${date}] ${e.content}` : `[${date}] ${e.text}`
                }).join("\n"))
            } catch (err) {
                Logger.error(err.message, "MEMORY QUERY")
                return finish("No relevant information found in memory.")
            }
        }

        Logger.info(`Queried memory: "${query}" from ${daysAgo ?? "any"} days ago`, "MEMORY QUERY")
        try {
            const k = daysAgo !== null ? 25 : 10
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query, k, min_score: this.opts.memoryQueryMinScore, include_private: includePrivate,
                // One-hop expansion only for plain lookups: a dated search wants dated hits.
                include_related: daysAgo === null,
                related_limit: getSection('memory').searchRelatedLimit ?? 2,
            }, { timeout: this.opts.dbTimeout })

            const all = data?.results ?? []
            let results = all.filter(e => e.relation !== "linked")
            const related = all.filter(e => e.relation === "linked")

            if (!results.length) return finish("No relevant information found in memory.")

            if (daysAgo !== null) {
                const nowSecs = Date.now() / 1000
                const targetTs = nowSecs - daysAgo * 86400
                const windowSecs = Math.max(windowDays, 0) * 86400
                const lo = targetTs - windowSecs
                const hi = targetTs + windowSecs
                results = results.filter(e => e.timestamp >= lo && e.timestamp <= hi)
                if (!results.length) return finish(`No relevant information found from around ${daysAgo} days ago.`)
            }

            const lines = results.slice(0, 10).map(e => {
                if (e.type === "episodic") {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return `[${date}] ${e.content}`
                }
                return e.text
            })
            for (const r of related) lines.push(this._relatedLine(r))
            return finish(lines.join("\n"))
        } catch (err) {
            Logger.error(err.message, "MEMORY QUERY")
            return finish("No relevant information found in memory.")
        }
    }

    // Formats one get_entity row. Rows with relation "mentioned" come from OTHER
    // people's/topic files that link to this subject (Obsidian backlinks).
    _entityLine(name, hit) {
        switch (hit.relation) {
            case "mentioned":
                return `(about ${name}, from ${hit.from ?? "other"}'s notes) ${hit.text}`
            case "summary":
                return `(about ${name}, summary of what's known) ${hit.text}`
            case "conversation": {
                const date = hit.timestamp ? new Date(hit.timestamp * 1000).toLocaleDateString() : "earlier"
                return `(past conversation with ${name}, ${date}) ${hit.text}`
            }
            default:
                return `(about ${name}) ${hit.text}`
        }
    }

    _relatedLine(hit) {
        return `(related, about ${hit.from ?? "other"}) ${hit.text}`
    }
    // Every name/alias the vault has a note for. Cached; on failure keeps the last good list.
    async _vaultNames() {
        const ttl = this.opts.memoryAutoInjectNamesTtlMs ?? 60000
        const cached = this._entityNames
        if (cached.names.length && Date.now() - cached.at < Math.min(ttl, 60000)) return cached.names
        try {
            const { data } = await axios.get(`${this.opts.memoryDbUrl}/entities`, { timeout: this.opts.dbTimeout })
            const names = (data?.names ?? []).filter(n => typeof n === "string" && n.trim().length >= 3)
            Logger.info(`fetched ${names.length} name(s) from /entities`, "MEMORY AUTOINJECT NAMES")
            if (names.length) this._entityNames = { at: Date.now(), names }
            return names.length ? names : cached.names
        } catch (err) {
            Logger.error(`${this.opts.memoryDbUrl}/entities: ${err.message}`, "MEMORY AUTOINJECT NAMES")
            return cached.names   // keep last good list, retry next turn
        }
    }
    async _lookupMentioned(name, includePrivate) {
        const key = name.toLowerCase()
        if (Date.now() - (this._missCache.get(key) ?? 0) < 5 * 60 * 1000) return []
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/get_entity`, {
                person_name: name,
                limit: this.opts.memoryAutoInjectMentionedLimit ?? 4,
                include_private: includePrivate,
                include_related: true,
                related_limit: this.opts.memoryAutoInjectMentionedRelatedLimit ?? 2,
                summary_mode: "replace",
            }, { timeout: this.opts.dbTimeout })
            const hits = data?.results ?? []
            if (!hits.length) this._missCache.set(key, Date.now())
            Logger.info(`[mentioned] ${name}: ${hits.length} row(s)`, "MEMORY AUTOINJECT")
            return hits.map(h => this._entityLine(name, h))
        } catch (err) {
            Logger.error(`${name}: ${err.message}`, "MEMORY AUTOINJECT MENTIONED")
            return []
        }
    }
    // Names from `candidates` that appear in `text` as whole words, longest first.
    _namesIn(text, candidates) {
        const found = new Map()
        for (const name of candidates) {
            const trimmedName = (name ?? "").trim()
            if (trimmedName.length < 3) continue
            const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu")
            if (re.test(text) && !found.has(trimmedName.toLowerCase())) found.set(trimmedName.toLowerCase(), trimmedName)
        }
        return [...found.values()].sort((a, b) => b.length - a.length)
    }
    // Auto-injection (passive, not a tool call). Each turn pulls, in order:
    //   0. pinned server knowledge (Server/pinned.md)
    //   1. the speaker's own file (exact lookup) + a few facts others wrote about them
    //   1b. files of people named in the message (exact alias match, capped), same one-hop links
    //   2. topic facts (semantic)
    //   3. past conversations (semantic)
    // `known`: names currently in the room (working memory) — only these can
    // be matched as "mentioned", so a random word never becomes a lookup.
    // `includePrivate`: true on DM / voice turns so private facts are visible.
    _senderCandidates(authorName, text) {
        const handle = text.match(/^\[([^\]]+)\]/)?.[1]?.trim()
        const first = authorName?.split(/[^\p{L}\p{N}_.-]+/u)[0]
        return [...new Set([handle, authorName?.trim(), first].filter(n => n && n.length >= 2))]
    }


    async _lookupMentioned(name, includePrivate) {
        const key = name.toLowerCase()
        if (Date.now() - (this._missCache.get(key) ?? 0) < 60 * 1000) return []
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/get_entity`, {
                person_name: name,
                limit: this.opts.memoryAutoInjectMentionedLimit ?? 4,
                include_private: includePrivate,
                include_related: true,
                related_limit: this.opts.memoryAutoInjectMentionedRelatedLimit ?? 2,
                summary_mode: "replace",
            }, { timeout: this.opts.dbTimeout })
            const hits = data?.results ?? []
            if (!hits.length) this._missCache.set(key, Date.now())
            Logger.info(`[mentioned] ${name}: ${hits.length} row(s)`, "MEMORY AUTOINJECT")
            return hits.map(h => this._entityLine(name, h))
        } catch (err) {
            Logger.error(`${name}: ${err.message}`, "MEMORY AUTOINJECT MENTIONED")
            return []
        }
    }

    async autoInjectMemory(rawText, { authorName = null, authorId = null, known = [], includePrivate = true } = {}) {
        if (!this.opts.memoryAutoInjectEnabled) return null
        const raw = (rawText ?? "").trim()
        const senders = this._senderCandidates(authorName, raw)
        const trimmed = raw.replace(/^\[[^\]]+\]\s*says to you:\s*/i, "").trim()
        if (!trimmed && !senders.length && !authorId) return null

        const parts = []
        const seen = new Set()
        const push = (text) => {
            const key = (text ?? "").trim().toLowerCase()
            if (!key || seen.has(key)) return
            seen.add(key)
            parts.push(text)
        }
        const done = () => parts.length ? parts.join("\n") : null

        // 0. Pinned server knowledge.
        try {
            const { data } = await axios.get(`${this.opts.memoryDbUrl}/pinned`, { timeout: this.opts.dbTimeout })
            for (const text of data?.facts ?? []) push(`(server) ${text}`)
        } catch (err) {
            Logger.error(err.message, "MEMORY AUTOINJECT PINNED")
        }

        // 1. Sender: handle, then display name, then first token; stop at first hit.
        if (this.opts.memoryAutoInjectPersonEnabled && (senders.length || authorId)) {
            for (const name of senders.length ? senders : [null]) {
                try {
                    const { data } = await axios.post(`${this.opts.memoryDbUrl}/get_entity`, {
                        subject_id: authorId ?? null,
                        person_name: name,
                        limit: this.opts.memoryAutoInjectPersonLimit ?? 6,
                        include_private: includePrivate,
                        include_related: true,
                        related_limit: this.opts.memoryAutoInjectRelatedLimit ?? 3,
                        summary_mode: "replace",
                        conversation_limit: this.opts.memoryAutoInjectConversationLimit ?? 0,
                    }, { timeout: this.opts.dbTimeout })
                    const hits = data?.results ?? []
                    Logger.info(`[person] tried "${name}": ${hits.length} row(s)`, "MEMORY AUTOINJECT")
                    if (hits.length) {
                        for (const h of hits) push(this._entityLine(name ?? "them", h))
                        break
                    }
                } catch (err) {
                    Logger.error(err.message, "MEMORY AUTOINJECT PERSON")
                }
            }
        }

        if (!trimmed) return done()

        // 1b. Mentioned people: vault/room names plus every word in the message, exact lookup each.
        {
            const selfNames = new Set(senders.flatMap(s => [s.toLowerCase(), s.toLowerCase().replace(/^_+|_+$/g, "")]))
            const vault = [...(await this._vaultNames()), ...(known ?? [])]
            const names = this._namesIn(trimmed, vault)
                .filter(n => !selfNames.has(n.toLowerCase()))
                .slice(0, this.opts.memoryAutoInjectMentionedMax ?? 6)
            Logger.info(`${vault.length} vault name(s), mentioned: ${names.join(", ") || "(none)"}`, "MEMORY AUTOINJECT")
            const results = await Promise.all(names.map(n => this._lookupMentioned(n, includePrivate)))
            for (const lines of results) for (const l of lines) push(l)
        }
        // 2. Topic facts, one hop through links.
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query: trimmed,
                k: this.opts.memoryAutoInjectFactK,
                min_score: this.opts.memoryAutoInjectFactMinScore,
                types: ["fact"],
                include_private: includePrivate,
                include_related: true,
                related_limit: this.opts.memoryAutoInjectSearchRelatedLimit ?? 2,
                max_related: this.opts.memoryAutoInjectSearchRelatedMax ?? 4,
            }, { timeout: this.opts.dbTimeout })
            for (const h of data?.results ?? []) {
                Logger.info(`[${h.relation === "linked" ? `linked via "${h.via}"` : `fact, score ${h.score}`}] "${h.text}"`, "MEMORY AUTOINJECT")
                push(h.relation === "linked" ? this._relatedLine(h) : h.text)
            }
        } catch (err) {
            Logger.error(err.message, "MEMORY AUTOINJECT FACT")
        }

        // 3. Past conversations.
        if (this.opts.memoryAutoInjectEpisodicEnabled) {
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                    query: trimmed,
                    k: this.opts.memoryAutoInjectEpisodicK,
                    min_score: this.opts.memoryAutoInjectEpisodicMinScore,
                    types: ["episodic"],
                    include_private: includePrivate,
                }, { timeout: this.opts.dbTimeout })
                for (const h of data?.results ?? []) {
                    Logger.info(`[episodic, score ${h.score}] "${h.text}"`, "MEMORY AUTOINJECT")
                    push(`(past conversation) ${h.content}`)
                }
            } catch (err) {
                Logger.error(err.message, "MEMORY AUTOINJECT EPISODIC")
            }
        }

        if (!parts.length) Logger.info(`No hits for: "${trimmed}"`, "MEMORY AUTOINJECT")
        return done()
    }
    async memoryAdd(factText, source = "user", meta = {}) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        this._requireQuery(factText, 2, "ShinyShadow_ said their favorite color is teal")
        this.turnUsage.memoryWrite++

        Logger.info(` Added memory: "${factText}"`, "MEMORY ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`, {
                text: factText,
                source,
                category: meta.category ?? null,
                subject_id: meta.subject_id ?? null,
                person_name: meta.person_name ?? null,
                visibility: meta.visibility ?? "server",
            }, { timeout: this.opts.dbTimeout })

            const failed = data?.status === "error" || data?.ok === false
            if (failed) {
                Logger.error(`add_fact returned failure: ${JSON.stringify(data)}`, "MEMORY ADD")
                return this._err(data.message ?? "Failed to store information.")
            }
            if (data?.status !== "ok" && data?.status !== "skipped") {
                Logger.warning(`Unexpected add_fact response shape: ${JSON.stringify(data)}`, "MEMORY ADD")
            }
            return this._ok(data?.message ?? "Stored.")
        } catch (err) {
            Logger.error(err.message, "MEMORY ADD")
            return this._err("Failed to store information.")
        }
    }

    // Exact metadata lookup — "everything I know about this person" — instead of
    // hoping semantic similarity surfaces all of someone's facts.
    async entityLookup({ person_name = null, subject_id = null, category = null, includePrivate = false } = {}) {
        const limitErr = this._checkLimit('memoryQuery', LIMITS.memoryQuery, 'memory lookup (lookup_entity)')
        if (limitErr) return limitErr

        if (!person_name && !subject_id) {
            this.markFlawed('bad_args')
            return this._err(
                "lookup_entity needs person_name or subject_id. If all you have is a topic, " +
                "use query_memory_database with 2-6 keywords instead — don't call this one again."
            )
        }
        this.turnUsage.memoryQuery++

        Logger.info(`Entity lookup: ${person_name ?? subject_id}`, "MEMORY ENTITY")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/get_entity`, {
                person_name, subject_id, category,
                limit: getSection('memory').lookupEntityLimit,
                include_private: includePrivate,
                include_related: true,
                related_limit: getSection('memory').lookupEntityRelatedLimit ?? 5,
                summary_mode: "prepend",
                conversation_limit: getSection('memory').lookupEntityConversationLimit ?? 3,
            }, { timeout: this.opts.dbTimeout })

            const results = data?.results ?? []
            const line = (r) => {
                switch (r.relation) {
                    case "mentioned": return `[mentioned in ${r.from ?? "other"}'s notes] ${r.text}`
                    case "summary": return `[summary] ${r.text}`
                    case "conversation": {
                        const date = r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString() : "earlier"
                        return `[past conversation, ${date}] ${r.text}`
                    }
                    default: return `[${r.category}] ${r.text}`
                }
            }
            return JSON.stringify({
                status: "ok",
                results: results.length ? results.map(line).join("\n") : "Nothing is stored under that name yet.",
                instruction: "Lookup complete. Reply in character now — don't look the same person up again this turn.",
            })
        } catch (err) {
            Logger.error(err.message, "MEMORY ENTITY")
            return this._err("Entity lookup failed.")
        }
    }

    async addFactOutOfBand({ text, source = "explicit_user_request", category = null, subject_id = null, person_name = null, visibility = "server" }) {
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`,
                { text, source, category, subject_id, person_name, visibility },
                { timeout: this.opts.dbTimeout })
            return data
        } catch (err) {
            Logger.error(err.message, "MEMORY ADD OOB")
            return { status: "error", message: err.message }
        }
    }

    async removeFactOutOfBand(query) {
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/remove_by_query`, {
                query,
                k: this.opts.memoryRemoveK,
                min_score: this.opts.memoryRemoveMinScore,
                types: ["fact"],
            }, { timeout: this.opts.dbTimeout })
            return data
        } catch (err) {
            Logger.error(err.message, "MEMORY REMOVE OOB")
            return { status: "error", removed: [] }
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr

        const argErr = this._requireQuery(searchQuery, 2, "shinyshadow_ favorite color") || this._requireQuery(updatedText, 2, "ShinyShadow_'s favorite color is now teal")
        if (argErr) return argErr
        if (searchQuery.trim().toLowerCase() === updatedText.trim().toLowerCase()) {
            this.markFlawed('memory_update_noop')
            return JSON.stringify({
                status: "noop",
                message: "The old and new text are identical — there's nothing to update. If you don't actually know the current value, don't call this tool at all. Write your reply now."
            })
        }
        this.turnUsage.memoryWrite++

        Logger.info(`Updated memory: "${searchQuery}" → "${updatedText}"`, "MEMORY UPDATE")
        try {
            const { data } = await axios.put(`${this.opts.memoryDbUrl}/update_fact`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            if (data.status !== "ok") return this._err(data.message ?? "Failed to update entry.")
            return this._ok(data.message ?? "Updated.")
        } catch (err) {
            Logger.error(err.message, "MEMORY UPDATE")
            return this._err("Failed to update entry.")
        }
    }

    async memoryRemove(searchQuery) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(searchQuery, 2, "IsGone favorite color")
        if (argErr) return argErr
        this.turnUsage.memoryWrite++

        Logger.info(`Attempted to remove memory: "${searchQuery}"`, "MEMORY REMOVE")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/remove_by_query`, {
                query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore, types: ["fact"]
            }, { timeout: this.opts.dbTimeout })
            if (data?.status !== "ok" || !data?.removed?.length) {
                this.markFlawed('memory_remove_not_found')
                return JSON.stringify({
                    status: "not_found",
                    message: "No matching memories found.",
                    instruction: "Nothing matched — that's a final answer, not a failure to fix by retrying. Reply now, in character."
                })
            }
            return this._ok(`Removed: ${data.removed.join(", ")}`, { removed: data.removed })
        } catch (err) {
            Logger.error(err.message, "MEMORY REMOVE")
            return this._err("Failed to remove entries.")
        }
    }

    // Not part of the live chat-turn budget — called out-of-band by a
    // batch/summarizer process, not by the model mid-conversation.
    async addEpisodicMemory({ summary, raw, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation_batch" }) {
        Logger.info(`"${summary}"`, "EPISODIC BATCH ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_episodic`, {
                summary, raw, participants, emotions, importance, channel, source,
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            Logger.error(err.message, "EPISODIC BATCH ADD")
            return this._err("Failed to store episodic memory.")
        }
    }

    async searchGif(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "excited anime girl jumping")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "GIF")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: { q: query, per_page: getSection('search').klipyPerPage, page: 1, customer_id: getSection('search').klipyCustomerId },
                timeout: this.opts.dbTimeout
            })
            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('gif_not_found')
                return JSON.stringify({ status: "not_found", message: "No GIF found — don't retry with a near-identical query, just reply without a gif." })
            }
            const pick = results[Math.floor(Math.random() * Math.min(results.length, getSection('search').klipyPickPool))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('gif_no_url')
                return JSON.stringify({ status: "not_found", message: "No GIF URL — don't retry, just reply without a gif." })
            }
            Logger.success(`Gif found, URL: ${url}`, "GIF")
            return this._ok("Gif found and already queued to send — do NOT put the url in your text, just reply naturally to the user.", { url })
        } catch (err) {
            Logger.error(err.message, "GIF")
            return this._err("Gif not found, ignore this and reply naturally to the user. Do NOT attempt to send another gif this turn.")
        }
    }

    async searchMeme(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "drake approving")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "MEME")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/static-memes/search`, {
                params: { q: query, per_page: getSection('search').klipyPerPage, page: 1, customer_id: getSection('search').klipyCustomerId },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('meme_not_found')
                return JSON.stringify({ status: "not_found", message: "No meme found — don't retry with a near-identical query, just reply without a meme." })
            }

            const pick = results[Math.floor(Math.random() * Math.min(results.length, getSection('search').klipyPickPool))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('meme_no_url')
                return JSON.stringify({ status: "not_found", message: "No meme URL — don't retry, just reply without a meme." })
            }

            Logger.success(`Meme found, URL: ${url}`, "MEME")
            return this._ok("Meme found and already queued to send — do NOT put the url in your text, just reply to the user message naturally.", { url })
        } catch (err) {
            Logger.error(err.message, "MEME")
            if (err.response) Logger.error(JSON.stringify(err.response.data), "MEME RESPONSE")
            return this._err("Meme not found, ignore this and reply naturally to the user. Do NOT attempt to send another meme this turn.")
        }
    }

    _usageState(c) {
        if (!this._usage || this._usage.month !== monthKey()) this._usage = loadUsage(c.usagePath)
        return this._usage
    }

    // One basic-depth Tavily call (1 credit). Returns null when the monthly cap is hit.
    async _tavilySearch(q, recent, c) {
        const usage = this._usageState(c)
        if (usage.credits >= c.monthlyCap) return null

        this._tavilyClient ??= tavily({ apiKey: process.env.TAVILY_API_KEY })
        const options = {
            maxResults: c.fetchResults,
            includeAnswer: true,
            includeImages: false,
            searchDepth: "basic",       // "advanced" costs 2 credits; never used on the free tier
        }
        if (recent) { options.topic = "news"; options.days = c.newsDays }

        const response = await this._tavilyClient.search(q, options)
        usage.credits += 1
        saveUsage(c.usagePath, usage)
        return response
    }

    async webSearch(query, { recent = false } = {}) {
        const limitErr = this._checkLimit('webSearch', LIMITS.webSearch, 'web_search')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "current Minecraft version")
        if (argErr) return argErr
        this.turnUsage.webSearch++

        const c = webCfg()
        const q = query.replace(/["“”]/g, "").replace(/\s+/g, " ").trim()
        const cacheKey = `${recent ? "n" : "g"}:${q.toLowerCase()}`

        const hit = this._searchCache.get(cacheKey)
        if (hit && Date.now() - hit.at < c.cacheTtlMs) {
            Logger.info(`Cache hit (0 credits): "${q}"`, "WEB SEARCH")
            return hit.payload
        }

        const unavailable = () => this._err(
            "Web search isn't available right now. Don't retry — answer from what you already know, and say plainly that you couldn't check it."
        )

        Logger.info(`Tavily search${recent ? " (news)" : ""}: "${q}"`, "WEB SEARCH")
        try {
            let response = await this._tavilySearch(q, recent, c)
            if (!response) {
                Logger.warning(`Monthly cap (${c.monthlyCap}) reached, search disabled until next month`, "WEB SEARCH")
                return unavailable()
            }

            let { picked, weak } = pickResults(response.results, c)

            // News topic can come back empty for niche queries: one general retry.
            if (!picked.length && recent) {
                Logger.info(`News search empty, retrying as general`, "WEB SEARCH")
                response = await this._tavilySearch(q, false, c)
                if (!response) return unavailable()
                    ; ({ picked, weak } = pickResults(response.results, c))
            }

            if (!picked.length) {
                return JSON.stringify({
                    status: "ok",
                    results: "No results found.",
                    instruction: "Search came back empty — that's your answer, don't keep rephrasing. Reply now, in character, and say you couldn't find anything."
                })
            }

            const today = new Date().toISOString().slice(0, 10)
            const lines = [`Today's date: ${today}. Judge how old each source is against it.`]
            if (response.answer) {
                lines.push(`Search engine's quick summary (check it against the sources): ${trimText(response.answer, c.answerChars)}`)
            }
            picked.forEach((r, i) => {
                const when = r.publishedDate ? `, ${String(r.publishedDate).slice(0, 10)}` : ""
                lines.push(`${i + 1}. ${trimText(r.title, 90)} [${hostOf(r.url)}${when}]\n${trimText(r.content, c.snippetChars)}`)
            })
            if (weak) lines.push("Note: nothing here matched the question strongly. Say you're not sure instead of guessing.")

            const payload = JSON.stringify({
                status: "ok",
                results: lines.join("\n\n"),
                instruction: "Search complete. Answer in your own words in your visible, in-character reply now. Prefer facts that several sources agree on, mention if sources look old or disagree, and never paste URLs or raw excerpts. Don't search again unless this truly didn't cover it."
            })

            this._searchCache.set(cacheKey, { at: Date.now(), payload })
            if (this._searchCache.size > c.cacheMax) this._searchCache.delete(this._searchCache.keys().next().value)
            return payload
        } catch (err) {
            const status = err.response?.status
            Logger.error(`${err.message}${status ? ` (HTTP ${status})` : ""}`, "WEB SEARCH")
            if (status === 401) Logger.error("Check TAVILY_API_KEY", "WEB SEARCH")
            // 429/432/433: rate or plan limit hit on Tavily's side
            return [429, 432, 433].includes(status) ? unavailable() : this._err("Web search failed.")
        }
    }

    // `ctx` is { channelId, isDM, userId } as passed by Lily._runCalls. If your
    // ToolRouter.execute doesn't forward its third argument to this method yet,
    // add it there — without it everything defaults to 'server' visibility.
    async execute(name, args, ctx = {}) {
        const totalBlock = this._spendTotal()
        if (totalBlock) return totalBlock

        const visibility = visibilityFor(ctx)
        const includePrivate = visibility === "private"

        switch (name) {
            case "web_search": return this.webSearch(args?.query ?? "", {
                recent: args?.recent === true || args?.recent === "true",
            })
            case "query_memory_database": return this.memoryQuery(args?.query ?? "", {
                daysAgo: args?.days_ago ?? null,
                windowDays: args?.window_days ?? 2,
                daysBack: args?.days_back ?? null,
                includePrivate,
            })
            case "lookup_entity": return this.entityLookup({
                person_name: args?.person_name ?? null,
                subject_id: args?.subject_id ?? null,
                category: args?.category ?? null,
                includePrivate,
            })
            case "addto_memory_database": return this.memoryAdd(args?.text ?? "", args?.source ?? "user", {
                category: args?.category ?? null,
                subject_id: args?.subject_id ?? null,
                person_name: args?.person_name ?? null,
                visibility,
            })
            case "update_memory_database": return this.memoryUpdate(args?.query ?? "", args?.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args?.query ?? "")
            case "send_meme": return this.searchMeme(args?.query ?? "")
            case "send_gif": return this.searchGif(args?.query ?? "")
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                this.markFlawed('unknown_tool')
                return `Unknown tool: ${name}`
        }
    }
}

const CHAT_TOOLS = [
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: `Search stored facts and past conversations by topic or time.
USE WHEN: someone asks about a past event, what was said or done earlier, "remember when...", "what happened lately", or any stored fact that isn't about one specific named person.
DO NOT USE WHEN: the question is "what do you know about <person>" or "who is <person>" (use lookup_entity), or for real-world facts (use web_search).
Modes, pick ONE: (1) topic: query only. (2) specific past event: query + days_ago. (3) recent stretch with no topic: days_back only.
query is required (2-6 keywords) in modes 1 and 2.`,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "2-6 keywords only. No sentences, no politeness. Example: 'shinyshadow favorite color'.",
                        maxLength: 60
                    },
                    days_ago: { type: "number", minimum: 0, description: "Rough days back for a specific past event. Omit otherwise." },
                    window_days: { type: "number", minimum: 0, maximum: 30, description: "Only with days_ago. Default 2." },
                    days_back: { type: "number", minimum: 1, description: "Open-ended recap window, no topic needed." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: `Save a lasting fact about a specific person to long-term memory. Call this whenever the conversation reveals new information about someone: what they like or dislike, what they do, own, plan or did, their relationships, opinions, habits or history. This includes facts people tell you about THEMSELVES ("I main support", "I'm moving to Madrid") and facts about OTHER people, however phrased: direct statements ("he's a dev"), asides ("did you know Sam hates mornings?"), "btw..." remarks, corrections, or facts slipped in while talking about something else. The trigger is the information, not the sentence shape. If unsure whether something counts, call the tool. person_name is always required: use the speaker's name for "I/me/my", and resolve "he/she/they/my friend" from the conversation. Do NOT call for questions, jokes, temporary states ("is hungry right now").`,
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "One standalone factual sentence that names the person, e.g. 'Sam hates mornings'. 3-20 words. Drop framing like 'did you know'. Never empty.", maxLength: 150 },
                    person_name: { type: "string", description: "Name of the person the fact is about, exactly as written in chat. Resolve pronouns from context. Never empty.", maxLength: 60 },
                    category: {
                        type: "string",
                        enum: ["person", "project", "place", "object", "preference", "goal", "decision", "event", "bot", "general"],
                        description: "What kind of thing the fact is about. Default 'general'."
                    },
                    subject_id: { type: "string", description: "Only if you were actually given that person's Discord user id. Never invent one.", maxLength: 40 }
                },
                required: ["text", "person_name", "category"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: `Correct one existing stored fact.

                        HARD REQUIREMENT: you must have called query_memory_database earlier in THIS turn and gotten back the exact fact you are now correcting. If you have not done that in this turn, call query_memory_database instead — do NOT call update_memory_database.

                        "query" must be the same keywords that found the original fact, not new keywords. "text" must be a correction of that SAME fact (same subject), not a different unrelated fact.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Same keywords used in the query_memory_database call that found this fact this turn.", maxLength: 60 },
                    text: { type: "string", description: "The corrected version of that exact fact, same subject. 3-20 words.", maxLength: 150 }
                },
                required: ["query", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove one specific stored fact someone has pointed to as wrong, named by its content. Never use for vague/joking instructions like 'forget everything' — treat those as banter, not a tool call.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-6 keywords naming the specific fact to remove. Never a vague phrase like 'everything'.", maxLength: 60 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send ONE reaction GIF. At most one gif OR meme per message total.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-4 words describing the reaction/vibe, e.g. 'excited anime girl jumping'. Never the user's raw message, never a single generic word.", maxLength: 40 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send ONE meme. At most one gif OR meme per message total.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-4 words evoking a meme format, e.g. 'drake approving'. Never the user's raw message, never a single generic word.", maxLength: 40 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: `Search the web for real-world facts.
USE WHEN: news, current events, latest versions, prices, scores, release dates, or any real-world fact you aren't certain of. If you would be guessing, search instead.
DO NOT USE WHEN: chit-chat, opinions, facts about people in this chat (use memory tools), or things you already know for sure.
One call is normally enough.`,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "A short search-engine query, 3-8 words, like a real Google search. No questions, no politeness. Good: 'Minecraft latest version 2026'.",
                        maxLength: 60
                    },
                    recent: {
                        type: "boolean",
                        description: "true ONLY for news, current events, latest versions, prices or scores. Otherwise false."
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "lookup_entity",
            description: `Everything stored about ONE named person or topic note (exact lookup, not a similarity search).
USE WHEN: "what do you know about X", "who is X", "look X up", "check your memory for X", "do you know X", or before saying anything about a specific person you aren't sure of. Call it even if the autoinjected memory already shows something, because that block is partial.
DO NOT USE WHEN: the question is about an event, a time period, or a fuzzy topic (use query_memory_database).
Returns all their facts plus facts other people's notes link to them.`,
            parameters: {
                type: "object",
                properties: {
                    person_name: { type: "string", description: "The name exactly as the user typed it. Copy it letter by letter, never correct, shorten or respell it. Example: 'IsGone'.", maxLength: 60 },
                    subject_id: { type: "string", description: "Their Discord user id, only if you were actually given one. Never guess.", maxLength: 40 },
                    category: { type: "string", description: "Optional narrowing, e.g. 'preference'.", maxLength: 30 }
                },
                required: ["person_name"]
            }
        }
    },
]

const CHAT_TOOL_NAMES = new Set(CHAT_TOOLS.map(t => t.function.name))

export { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES }