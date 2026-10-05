// src/discord/notifyEndpoint.js
import express from 'express'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const TYPORA_BIN = process.env.TYPORA_BIN || 'typora'
const DOWNLOADS_DIR = path.join(homedir(), 'Downloads')

// Resolve once at startup.
function resolveBinary(bin) {
    try {
        const out = execFileSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim()
        return out || null
    } catch {
        return null
    }
}

const TYPORA_PATH = resolveBinary(TYPORA_BIN)
if (TYPORA_PATH) {
    console.log(`[notify] Typora preview enabled: ${TYPORA_PATH}`)
} else {
    console.warn(`[notify] Typora not found (${TYPORA_BIN}); .md will be saved but not opened`)
}

function openInTypora(mdPath) {
    if (!TYPORA_PATH) return
    let proc
    try {
        proc = spawn(TYPORA_PATH, [mdPath], { detached: true, stdio: 'ignore' })
    } catch (err) {
        console.warn(`[notify] Typora spawn failed: ${err.message}`)
        return
    }
    // THE FIX: without this, ENOENT kills the whole Node process.
    proc.on('error', (err) => {
        console.warn(`[notify] Typora error (${err.code || err.message}); skipping preview`)
    })
    proc.unref()
}

function makeMdPath(type) {
    mkdirSync(DOWNLOADS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const label = (type || 'notify').replace(/[^a-z0-9-]/gi, '-')
    return path.join(DOWNLOADS_DIR, `${label}-${stamp}.md`)
}

export function startNotifyServer(client, defaultUserId, port = 3300) {
    const app = express()
    app.use(express.json())

    app.post('/notify', async (req, res) => {
        const { message, summary, filePath, type, discordId } = req.body
        if (!message) return res.status(400).json({ error: 'message is required' })

        const mdPath = filePath || makeMdPath(type)
        writeFileSync(mdPath, message, 'utf8')

        try {
            const targetId = discordId || defaultUserId
            if (!targetId) {
                return res.status(400).json({ error: 'no discordId provided and no default set' })
            }

            const user = await client.users.fetch(targetId)
            const source = summary || message
            const preview = source.length > 1900 ? source.slice(0, 1900) + '…' : source

            await user.send({ content: preview, files: [mdPath] })
            openInTypora(mdPath)

            res.json({ status: 'ok', filePath: mdPath, discordId: targetId, typora: !!TYPORA_PATH })
        } catch (err) {
            console.error('Notify DM failed:', err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(port, () => console.log(`Notify server listening on ${port}`))
}