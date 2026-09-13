import http from 'node:http'
import { exec } from 'node:child_process'

const SCRIPT_PATH = '/mnt/GAMES/n8n/steam-watch/bin/run_steam.sh'

export default function start(port = 3401) {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/run-steam-check') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
        }

        exec(SCRIPT_PATH, { maxBuffer: 1024 * 1024 * 20, timeout: 1000 * 60 * 5 }, (err, stdout, stderr) => {
            if (err) {
                console.error('run_steam.sh failed:', err.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: err.message, stderr }))
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ stdout, stderr }))
        })
    })

    server.listen(port, () => console.log(`Steam trigger listening on ${port}`))
    return server
}