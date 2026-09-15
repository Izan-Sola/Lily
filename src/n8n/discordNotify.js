// src/discord/notifyEndpoint.js
import express from 'express'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'

const TYPORA_BIN = process.env.TYPORA_BIN || 'typora'
const DOWNLOADS_DIR = path.join(homedir(), 'Downloads')

export function startNotifyServer(client, yourUserId, port = 3300) {
    const app = express()
    app.use(express.json())

    app.post('/notify', async (req, res) => {
        const { message, filePath } = req.body
        if (!message) return res.status(400).json({ error: 'message is required' })

        try {
            const user = await client.users.fetch(yourUserId)

            const payload = {
                content: message,
                files: filePath ? [filePath] : []
            }

            await user.send(payload)

            if (filePath) {
                spawn(TYPORA_BIN, [filePath], { detached: true, stdio: 'ignore' }).unref()
            }

            res.json({ status: 'ok' })
        } catch (err) {
            console.error('Notify DM failed:', err.message)
            res.status(500).json({ error: err.message })
        }
    })
    return app.listen(port, () => console.log(`Notify server listening on ${port}`))
}