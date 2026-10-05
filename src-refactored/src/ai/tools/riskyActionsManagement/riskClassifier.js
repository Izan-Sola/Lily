// riskClassifier.js
//
// Classifies the REAL tool calls pi is about to make (bash command, write/edit
// target). Runs on the brain; the pi extension only forwards what it sees.
//
// Policy (riskConfig.json): destructive/disruptive things ask, harmless things
// run. Anything that can run arbitrary code (interpreters, shells, wrappers like
// env/xargs/sudo) asks. "unknownCommands": "allow" lets unlisted plain commands
// through; set it to "ask" for a strict allowlist. Config problems fail to "ask".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfig } from '../../../config/loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const riskConfig = createConfig(path.join(__dirname, 'riskConfig.json'), { name: 'riskConfig.json', strict: true })

let allowDepth = 0
export function riskAllowed() { return allowDepth > 0 }
export async function withRiskAllowed(fn) {
    allowDepth++
    try { return await fn() } finally { allowDepth-- }
}

const risky = (reason) => ({ risky: true, matched: reason })
const safe = () => ({ risky: false, matched: null })

const loadConfig = () => riskConfig.get()

// Things we can't reason about statically: backticks, $( ), ${ }, heredocs,
// process substitution, >| , newlines, lone & (background).
const UNPARSEABLE = /[`\n\r]|\$\(|\$\{|<<|<\(|>\(|>\||(?<!&)&(?!&)/
const SEPARATORS = /&&|\|\||;|\|/
// > file, >> file, 2> file (>&N handled before this runs)
const REDIRECT = /(?<![<>\\])\d*(>>?)\s*([^\s;&|<>]+)/g
const PLAIN_NAME = /^[A-Za-z0-9._+-]+$/
const DEV_OK = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

const tokenize = (seg) =>
    (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ''))

// Single-letter flags ("-f") also match inside clusters ("-rf", "-i.bak").
function argBlocked(token, blocked) {
    return blocked.some(b => {
        if (/^-[A-Za-z]$/.test(b)) return new RegExp(`^-[A-Za-z]*${b[1]}`).test(token) && !token.startsWith('--')
        return token === b || token.startsWith(b + '=') || (b.startsWith('--') && token.startsWith(b))
    })
}

function resolvePath(p, cwd) {
    const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
    return path.resolve(cwd || process.cwd(), expanded)
}

function resolveReal(p, cwd) {
    const abs = resolvePath(p, cwd)
    try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)) } catch { return abs }
}

function insideDir(target, dir) {
    const rel = path.relative(dir, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const inProtected = (abs, cfg) => (cfg.protectedDirs ?? []).some(d => insideDir(abs, d))

function checkRedirects(cleaned, cfg, cwd) {
    for (const m of cleaned.matchAll(REDIRECT)) {
        const op = m[1]
        const target = m[2].replace(/^["']|["']$/g, '')
        if (target.includes('$')) return risky('redirect to a variable path')
        const abs = resolveReal(target, cwd)
        if (DEV_OK.has(abs)) continue
        if (abs.startsWith('/dev/')) return risky(`redirect to device ${abs}`)
        if (inProtected(abs, cfg)) return risky(`redirect into protected path ${abs}`)
        if (op === '>' && fs.existsSync(abs)) return risky(`redirect would overwrite existing ${abs}`)
    }
    return null
}

export function classifyCommand(command, cfg = loadConfig(), cwd = process.cwd()) {
    if (typeof command !== 'string' || !command.trim()) return risky('empty command')

    for (const p of cfg.riskyPatterns ?? []) {
        const m = command.match(new RegExp(p, 'i'))
        if (m) return risky(`matches risky pattern "${m[0]}"`)
    }
    for (const p of cfg.sensitivePatterns ?? []) {
        const m = command.match(new RegExp(p, 'i'))
        if (m) return risky(`touches sensitive path/keyword "${m[0]}"`)
    }

    // Normalise harmless stderr plumbing, then reject what we can't parse.
    const cleaned = command.replace(/\d*>&\d+/g, ' ').replace(/&>(>?)/g, '>$1')
    if (UNPARSEABLE.test(cleaned)) return risky('uses substitution, heredoc, background or other unparseable syntax')

    const redirectProblem = checkRedirects(cleaned, cfg, cwd)
    if (redirectProblem) return redirectProblem

    const noRedirects = cleaned.replace(REDIRECT, ' ')

    const safeCmds = new Set(cfg.safeCommands ?? [])
    const askCmds = new Set(cfg.askCommands ?? [])
    const askPatterns = (cfg.askCommandPatterns ?? []).map(p => new RegExp(p))
    const safeSubs = cfg.safeSubcommands ?? {}
    const askSubs = cfg.askSubcommands ?? {}
    const blockedArgs = cfg.blockedArgs ?? {}
    const writeCmds = new Set(cfg.writeCommands ?? [])

    for (const seg of noRedirects.split(SEPARATORS)) {
        const tokens = tokenize(seg.trim())
        if (!tokens.length) continue
        const [cmd, ...rest] = tokens

        if (/^[A-Za-z_]\w*=/.test(cmd)) return risky('command starts with a variable assignment')
        // Quotes, backslashes, globs, $ etc. in the command NAME hide what really runs (r''m, \rm).
        if (!PLAIN_NAME.test(cmd)) return risky(`unusual command name "${cmd}"`)

        if (askCmds.has(cmd) || askPatterns.some(re => re.test(cmd))) {
            return risky(`"${cmd}" is destructive, disruptive, or can run arbitrary code`)
        }

        if (safeSubs[cmd] && !(rest[0] && safeSubs[cmd].includes(rest[0]))) {
            return risky(`"${cmd} ${rest[0] ?? ''}"`.trim() + ' is not a read-only subcommand')
        }
        if (askSubs[cmd]) {
            const hit = rest.find(t => askSubs[cmd].includes(t))
            if (hit) return risky(`"${cmd} ${hit}" is destructive or disruptive`)
        }

        if (blockedArgs[cmd]) {
            const hit = rest.find(t => argBlocked(t, blockedArgs[cmd]))
            if (hit) return risky(`"${cmd}" with "${hit}" can destroy or overwrite things`)
        }

        if (writeCmds.has(cmd)) {
            const bad = rest.find(t => !t.startsWith('-') && !t.includes('$') && inProtected(resolveReal(t, cwd), cfg))
            if (bad) return risky(`"${cmd}" targets protected path ${bad}`)
        }

        if (!safeCmds.has(cmd) && !safeSubs[cmd] && !askSubs[cmd] && cfg.unknownCommands !== 'allow') {
            return risky(`"${cmd}" is not on the allowlist`)
        }
    }
    return safe()
}

export function classifyToolCall({ tool, input = {}, cwd } = {}) {
    let cfg
    try { cfg = loadConfig() } catch (e) { return risky(`risk config unreadable (${e.message})`) }

    if (tool === 'bash') return classifyCommand(input.command, cfg, cwd)

    if (tool === 'write' || tool === 'edit') {
        const target = input.path ?? input.file_path
        if (!target) return risky(`${tool} with no path`)
        const abs = resolveReal(target, cwd)

        for (const p of cfg.sensitivePatterns ?? []) {
            const m = abs.match(new RegExp(p, 'i'))
            if (m) return risky(`${tool} touches sensitive path/keyword "${m[0]}"`)
        }
        if (inProtected(abs, cfg)) return risky(`${tool} targets protected path ${abs}`)
        if ((cfg.autoApproveTools ?? []).includes(tool)) return safe()
        if ((cfg.writeAutoApproveDirs ?? []).some(d => insideDir(abs, path.resolve(d)))) return safe()
        if (tool === 'write' && !fs.existsSync(abs)) return safe() // new file, nothing lost
        return risky(`${tool} would modify existing ${abs}`)
    }

    if ((cfg.autoApproveTools ?? []).includes(tool)) return safe()
    return risky(`unrecognized tool "${tool}"`)
}

// Legacy prompt/argument-level check, still used by Lily.js for tool calls handed
// off to external clients (Continue). Pattern-only: flags text that matches
// riskConfig.json "riskyPatterns". For pi's real commands use classifyToolCall.
export function classifyRisk(instruction) {
    let cfg
    try { cfg = loadConfig() } catch (e) { return { risky: true, matched: `risk config unreadable (${e.message})` } }
    for (const pattern of cfg.riskyPatterns ?? []) {
        const match = String(instruction).match(new RegExp(pattern, 'i'))
        if (match) return { risky: true, matched: match[0] }
    }
    return { risky: false, matched: null }
}