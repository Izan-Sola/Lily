// src/discord/notifyEndpoint.js
import express from 'express'

export function startNotifyServer(client, yourUserId, port = 3300) {
    const app = express()
    app.use(express.json())

    app.post('/notify', async (req, res) => {
        const { message, filePath } = req.body
        if (!message) return res.status(400).json({ error: 'message is required' })

        try {
            const user = await client.users.fetch(yourUserId)
            const payload = { content: message }
            if (filePath) payload.files = [filePath]
            await user.send(payload)
            res.json({ status: 'ok' })
        } catch (err) {
            console.error('Notify DM failed:', err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(port, () => console.log(`Notify server listening on ${port}`))
}