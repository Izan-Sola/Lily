// src/discord/notifyEndpoint.js
import express from 'express'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function startNotifyServer(client, yourUserId, port = 3300) {
    const app = express()
    app.use(express.json())

    app.post('/notify', async (req, res) => {
        const { message, filePath } = req.body
        if (!message) return res.status(400).json({ error: 'message is required' })

        try {
            const user = await client.users.fetch(yourUserId)
            const payload = {}

            if (message.length > 1900) {
                const dir = mkdtempSync(path.join(tmpdir(), 'lily-notify-'))
                const mdPath = path.join(dir, 'digest.md')
                writeFileSync(mdPath, message)
                payload.files = filePath ? [mdPath, filePath] : [mdPath]
                payload.content = 'Here you go~'
            } else {
                payload.content = message
                if (filePath) payload.files = [filePath]
            }

            await user.send(payload)
            res.json({ status: 'ok' })
        } catch (err) {
            console.error('Notify DM failed:', err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(port, () => console.log(`Notify server listening on ${port}`))
}