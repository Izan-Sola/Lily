// src/n8n/triggers/health.js
import http from 'node:http'
import { exec } from 'node:child_process'

const SCRIPT_PATH = '/mnt/GAMES/n8n/system-health/bin/run-agent.sh'

export default function start(port = 3400) {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/run-health-check') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
        }

        exec(SCRIPT_PATH, { maxBuffer: 1024 * 1024 * 20, timeout: 1000 * 60 * 10 }, (err, stdout, stderr) => {
            if (err) {
                console.error('run-agent.sh failed:', err.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: err.message, stderr }))
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ stdout, stderr }))
        })
    })

    server.listen(port, () => console.log(`Health trigger listening on ${port}`))
    return server
}