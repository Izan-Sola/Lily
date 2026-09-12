import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, 'riskConfig.json')

export function classifyRisk(instruction) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    for (const pattern of raw.riskyPatterns) {
        const match = instruction.match(new RegExp(pattern, 'i'))
        if (match) return { risky: true, matched: match[0] }
    }
    return { risky: false, matched: null }
}