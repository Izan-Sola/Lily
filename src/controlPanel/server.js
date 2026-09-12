// src/controlPanel/server.js
import express from 'express'
import session from 'express-session'
import { Logger } from '../utils/Logger.js'
import {
    isLockedOut, recordFailure, recordSuccess,
    verifyPassword, verifyUsername, newCsrfToken,
} from './auth.js'
import { isRunning, restartLlamaServer, startLlamaServer, stopLlamaServer } from './llamaServerManager.js'
import { TOGGLEABLE_MODULES } from '../ai/tools/toolRouter.js'

function requireAuth(req, res, next) {
    if (req.session?.authed) return next()
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Not authenticated' })
    }
    return res.redirect('/login')
}

function requireCsrf(req, res, next) {
    const token = req.headers['x-csrf-token']
    if (!token || token !== req.session?.csrfToken) {
        return res.status(403).json({ error: 'Bad CSRF token' })
    }
    next()
}

function loginPage(error = '') {
    return `<!DOCTYPE html><html><head><title>Lily Control Panel — Login</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #12121a; color: #eee; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        form { background: #1c1c28; padding: 2rem; border-radius: 12px; width: 280px; }
        input { width: 100%; padding: 0.6rem; margin: 0.4rem 0; border-radius: 6px; border: 1px solid #333; background: #0f0f16; color: #eee; box-sizing: border-box; }
        button { width: 100%; padding: 0.6rem; margin-top: 0.6rem; border-radius: 6px; border: none; background: #7c5cff; color: white; cursor: pointer; }
        .err { color: #ff6b6b; font-size: 0.85rem; min-height: 1.2rem; }
    </style></head><body>
    <form method="POST" action="/login">
        <h2>🔒 Lily Control Panel</h2>
        <div class="err">${error}</div>
        <input name="username" placeholder="Username" autocomplete="username" required>
        <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
        <button type="submit">Log in</button>
    </form>
    </body></html>`
}

function dashboardPage(csrfToken) {
    return `<!DOCTYPE html><html><head><title>Lily Control Panel</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #12121a; color: #eee; margin: 0; padding: 2rem; }
        h1 { display: flex; justify-content: space-between; align-items: center; }
        h1 a { font-size: 0.9rem; color: #aaa; text-decoration: none; }
        .card { background: #1c1c28; padding: 1.2rem 1.5rem; border-radius: 12px; margin-bottom: 1rem; }
        .row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #2a2a38; }
        .row:last-child { border-bottom: none; }
        .name { font-weight: 600; text-transform: capitalize; }
        .unavailable { color: #666; font-size: 0.8rem; }
        .switch { position: relative; width: 46px; height: 24px; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; inset: 0; background: #444; border-radius: 24px; transition: 0.2s; }
        .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
        input:checked + .slider { background: #7c5cff; }
        input:checked + .slider:before { transform: translateX(22px); }
        input:disabled + .slider { opacity: 0.3; cursor: not-allowed; }
        button.action { padding: 0.5rem 1rem; border-radius: 8px; border: none; background: #7c5cff; color: white; cursor: pointer; margin-right: 0.5rem; }
        button.danger { background: #d64545; }
        .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.5rem; }
        .status-up { background: #4caf50; } .status-down { background: #d64545; }
        #llamaStatus { display:flex; align-items:center; margin-bottom: 1rem; }
        .toast { position: fixed; bottom: 1rem; right: 1rem; background: #1c1c28; padding: 0.8rem 1.2rem; border-radius: 8px; border-left: 4px solid #7c5cff; display:none; }
    </style></head><body>
    <h1>Lily Control Panel <a href="/logout">Log out</a></h1>

    <div class="card">
        <h3>Modules</h3>
        <div id="modules">Loading...</div>
    </div>

    <div class="card">
        <h3>llama-server</h3>
        <div id="llamaStatus"><span class="status-dot" id="dot"></span><span id="statusText">Checking...</span></div>
        <button class="action" onclick="llamaAction('start')">Start</button>
        <button class="action" onclick="llamaAction('restart')">Restart</button>
        <button class="action danger" onclick="llamaAction('stop')">Stop</button>
    </div>

    <div class="toast" id="toast"></div>

    <script>
    const CSRF = ${JSON.stringify(csrfToken)}

    function toast(msg) {
        const t = document.getElementById('toast')
        t.textContent = msg
        t.style.display = 'block'
        setTimeout(() => t.style.display = 'none', 2500)
    }

    async function api(path, opts = {}) {
        const res = await fetch(path, {
            ...opts,
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF, ...(opts.headers || {}) },
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || res.statusText)
        }
        return res.json()
    }

    async function loadModules() {
        const status = await api('/api/modules')
        const el = document.getElementById('modules')
        el.innerHTML = Object.entries(status).map(([name, s]) => \`
            <div class="row">
                <div>
                    <span class="name">\${name}</span>
                    \${!s.available ? '<div class="unavailable">not started at boot</div>' : ''}
                </div>
                <label class="switch">
                    <input type="checkbox" \${s.enabled ? 'checked' : ''} \${!s.available ? 'disabled' : ''}
                        onchange="toggleModule('\${name}', this.checked)">
                    <span class="slider"></span>
                </label>
            </div>
        \`).join('')
    }

    async function toggleModule(name, enabled) {
        try {
            await api(\`/api/modules/\${name}/toggle\`, { method: 'POST', body: JSON.stringify({ enabled }) })
            toast(\`\${name} \${enabled ? 'enabled' : 'disabled'}\`)
        } catch (e) {
            toast('Error: ' + e.message)
            loadModules()
        }
    }

    async function loadLlamaStatus() {
        const { running } = await api('/api/llama/status')
        document.getElementById('dot').className = 'status-dot ' + (running ? 'status-up' : 'status-down')
        document.getElementById('statusText').textContent = running ? 'Running' : 'Not responding'
    }

    async function llamaAction(action) {
        toast(\`\${action}ing llama-server...\`)
        try {
            await api(\`/api/llama/\${action}\`, { method: 'POST' })
            toast(\`llama-server \${action} sent\`)
            setTimeout(loadLlamaStatus, 4000)
        } catch (e) {
            toast('Error: ' + e.message)
        }
    }

    loadModules()
    loadLlamaStatus()
    setInterval(loadLlamaStatus, 8000)
    </script>
    </body></html>`
}

export function startControlPanel(ai, { port, username, passwordHash, sessionSecret, trustProxy = true }) {
    const app = express()
    if (trustProxy) app.set('trust proxy', 1)

    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))
    app.use(session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: trustProxy,
            sameSite: 'lax',
            maxAge: 12 * 60 * 60 * 1000,
        },
    }))

    app.get('/login', (req, res) => {
        if (req.session?.authed) return res.redirect('/')
        res.send(loginPage())
    })

    app.post('/login', async (req, res) => {
        const ip = req.ip
        if (isLockedOut(ip)) {
            return res.send(loginPage('Too many failed attempts. Try again later.'))
        }

        const { username: u, password: p } = req.body
        const validUser = verifyUsername(u, username)
        const validPass = await verifyPassword(p, passwordHash)

        if (!validUser || !validPass) {
            recordFailure(ip)
            return res.send(loginPage('Invalid username or password.'))
        }

        recordSuccess(ip)
        req.session.regenerate((err) => {
            if (err) return res.send(loginPage('Login error, try again.'))
            req.session.authed = true
            req.session.csrfToken = newCsrfToken()
            res.redirect('/')
        })
    })

    app.get('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/login'))
    })

    app.use(requireAuth)

    app.get('/', (req, res) => {
        res.send(dashboardPage(req.session.csrfToken))
    })

    app.get('/api/modules', (req, res) => {
        res.json(ai.getModuleStatus())
    })

    app.post('/api/modules/:name/toggle', requireCsrf, (req, res) => {
        const { name } = req.params
        const { enabled } = req.body
        if (!TOGGLEABLE_MODULES.includes(name)) {
            return res.status(400).json({ error: 'Unknown module' })
        }
        const result = ai.setModuleEnabled(name, !!enabled)
        if (!result.ok) return res.status(400).json({ error: result.reason })
        res.json({ ok: true })
    })

    app.get('/api/llama/status', async (req, res) => {
        res.json({ running: await isRunning() })
    })

    app.post('/api/llama/restart', requireCsrf, async (req, res) => {
        try {
            const pid = await restartLlamaServer()
            res.json({ ok: true, pid })
        } catch (e) {
            Logger.error(`Restart failed: ${e.message}`, "LLAMA")
            res.status(500).json({ error: e.message })
        }
    })

    app.post('/api/llama/start', requireCsrf, async (req, res) => {
        try {
            const pid = startLlamaServer()
            res.json({ ok: true, pid })
        } catch (e) {
            res.status(500).json({ error: e.message })
        }
    })

    app.post('/api/llama/stop', requireCsrf, async (req, res) => {
        try {
            await stopLlamaServer()
            res.json({ ok: true })
        } catch (e) {
            res.status(500).json({ error: e.message })
        }
    })

    app.listen(port, () => {
        Logger.success(`Control panel listening on port ${port}`, "CONTROL PANEL")
    })

    return app
}