// src/discord/notifyEndpoint.js
import express from 'express'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'

const TYPORA_BIN = process.env.TYPORA_BIN || 'typora'
const DOWNLOADS_DIR = path.join(homedir(), 'Downloads')

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
            spawn(TYPORA_BIN, [mdPath], { detached: true, stdio: 'ignore' }).unref()

            res.json({ status: 'ok', filePath: mdPath, discordId: targetId })
        } catch (err) {
            console.error('Notify DM failed:', err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(port, () => console.log(`Notify server listening on ${port}`))
}