// ai/skills.js
//
// Skills are markdown playbooks in ai/skills/. The model only sees each skill's name and
// one-line description (inside the use_skill tool); calling use_skill returns the full steps.
// Drop a new .md file in the folder and it's picked up on the next turn, no restart.
//
//   ---
//   name: fill-form
//   description: one line saying WHEN to use it
//   ---
//   Steps, written as short instructions to the model...
import fs from 'node:fs'

const DIR = new URL('./skills/', import.meta.url)

function parse(raw, file) {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    const meta = Object.fromEntries(
        (m?.[1] ?? '').split(/\r?\n/).map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2].trim()]),
    )
    return { name: meta.name || file.replace(/\.md$/, ''), description: meta.description || '', body: (m?.[2] ?? raw).trim() }
}

export function listSkills() {
    let files
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.md')) } catch { return [] }
    return files.map(f => parse(fs.readFileSync(new URL(f, DIR), 'utf8'), f))
}

export const getSkill = name => listSkills().find(s => s.name === name) ?? null
