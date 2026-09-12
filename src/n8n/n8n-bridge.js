// src/n8n/n8n-bridge.js
import express from 'express'
import axios from 'axios'
import { SYSTEM_PROMPT } from '../ai/prompts.js'
import { getConfig } from '../ai/config.js'

function createThinkStripper() {
    let buffer = ''
    let done = false
    return function (chunk) {
        if (done) return chunk
        buffer += chunk
        const closeIdx = buffer.indexOf('</think>')
        if (closeIdx !== -1) {
            const after = buffer.slice(closeIdx + '</think>'.length)
            done = true
            buffer = ''
            return after
        }
        const looksLikeOpeningTag = '<think>'.startsWith(buffer) || buffer.includes('<think>')
        if (!looksLikeOpeningTag) {
            done = true
            const out = buffer
            buffer = ''
            return out
        }
        return ''
    }
}

export function startN8nBridge(port = 3200) {
    const app = express()
    app.use(express.json())

    app.get('/v1/models', (req, res) => {
        res.json({
            object: 'list',
            data: [{ id: 'Lily', object: 'model', created: Date.now(), owned_by: 'local' }]
        })
    })

    app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body
        const opts = getConfig()
        const messages = [...body.messages]

        if (messages[0]?.role === 'system') {
            messages[0] = { role: 'system', content: `${SYSTEM_PROMPT}\n\n${messages[0].content}` }
        } else {
            messages.unshift({ role: 'system', content: SYSTEM_PROMPT })
        }

        const wantsStream = body.stream === true

        if (!wantsStream) {
            try {
                const { data } = await axios.post(`${opts.ollamaUrl}/v1/chat/completions`, {
                    ...body,
                    messages,
                    stream: false,
                }, { timeout: opts.ollamaTimeout })

                if (data.choices?.[0]?.message?.content) {
                    data.choices[0].message.content = data.choices[0].message.content
                        .replace(/<think>[\s\S]*?<\/think>/g, '')
                        .trim()
                }

                res.json(data)
            } catch (err) {
                console.error(err.message)
                res.status(500).json({ error: err.message })
            }
            return
        }

        try {
            const response = await axios.post(`${opts.ollamaUrl}/v1/chat/completions`, {
                ...body,
                messages,
                stream: true,
            }, {
                responseType: 'stream',
                timeout: opts.ollamaTimeout,
            })

            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')

            const stripThink = createThinkStripper()
            let raw = ''

            response.data.on('data', chunk => {
                raw += chunk.toString()
                const frames = raw.split('\n\n')
                raw = frames.pop()

                for (const frame of frames) {
                    const trimmed = frame.replace(/^data: /, '').trim()
                    if (!trimmed) continue
                    if (trimmed === '[DONE]') {
                        res.write('data: [DONE]\n\n')
                        continue
                    }
                    try {
                        const parsed = JSON.parse(trimmed)
                        const delta = parsed.choices?.[0]?.delta
                        if (delta && typeof delta.content === 'string') {
                            delta.content = stripThink(delta.content)
                        }
                        res.write(`data: ${JSON.stringify(parsed)}\n\n`)
                    } catch {
                        res.write(frame + '\n\n')
                    }
                }
            })

            response.data.on('end', () => res.end())
            response.data.on('error', err => {
                console.error(err.message)
                res.end()
            })
        } catch (err) {
            console.error(err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(port, () => console.log(`n8n bridge listening on ${port}`))
}