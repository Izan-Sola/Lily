// src/controlPanel/server.js
import express from 'express'
import session from 'express-session'
import axios from 'axios'
import { Logger, subscribeToLogs } from '../utils/Logger.js'
import { approvalStore } from '../ai/tools/riskyActionsManagement/approvalStore.js'
import {
    isLockedOut, recordFailure, recordSuccess,
    verifyPassword, verifyUsername, newCsrfToken,
} from './auth.js'
import { isRunning, restartLlamaServer, startLlamaServer, stopLlamaServer } from './llamaServerManager.js'
import { TOGGLEABLE_MODULES } from '../ai/tools/toolRouter.js'
import { REMOTE_HOSTS } from './remoteHosts.js'
import { REMOTE_ACTIONS, listActions } from './remoteActions.js'   // NEW

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
        *, *::before, *::after { box-sizing: border-box; }

        html, body { height: 100%; }
        body {
            font-family: system-ui, sans-serif;
            background: #12121a;
            color: #eee;
            margin: 0;
            padding: 1.25rem;
            overflow: hidden;
        }

        .layout {
            display: flex;
            gap: 1rem;
            height: 100%;
            align-items: stretch;
            width: 100%;
            max-width: 100%;
            min-width: 0;
        }

        .main {
            flex: 1 1 auto;
            min-width: 0;
            overflow-y: auto;
            padding-right: 0.25rem;
        }

        .logpanel {
            width: 520px;
            max-width: 45vw;
            flex-shrink: 0;
            min-width: 0;
            display: flex;
            overflow: hidden;
        }

        h1 { display: flex; justify-content: space-between; align-items: center; margin-top: 0; }
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
        .toast { position: fixed; bottom: 1rem; right: 1rem; background: #1c1c28; padding: 0.8rem 1.2rem; border-radius: 8px; border-left: 4px solid #7c5cff; display:none; z-index: 100; }

        /* Remote actions card: two selects + run button */
        .remote-row { display: flex; gap: 0.5rem; align-items: center; }
        .remote-row select {
            flex: 1 1 0;
            min-width: 0;
            padding: 0.5rem 0.6rem;
            border-radius: 8px;
            border: 1px solid #333;
            background: #0f0f16;
            color: #eee;
        }
        .remote-row button { flex: 0 0 auto; margin-right: 0; }

        .logpanel .card {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            padding: 1rem 1.1rem;
            margin-bottom: 0;
            min-height: 0;
            min-width: 0;
            overflow: hidden;
        }
        .logpanel h3 {
            margin: 0 0 0.7rem 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 1.02rem;
        }
        .logpanel h3 .clear {
            font-size: 0.76rem;
            color: #888;
            cursor: pointer;
            background: none;
            border: 1px solid #2a2a38;
            border-radius: 6px;
            padding: 0.18rem 0.55rem;
        }
        .logpanel h3 .clear:hover { color: #eee; border-color: #444; }

        #logfeed {
            flex: 1 1 auto;
            overflow-y: auto;
            overflow-x: hidden;
            font-family: ui-monospace, "SF Mono", Consolas, monospace;
            font-size: 0.9rem;
            line-height: 1.4;
            min-height: 0;
            min-width: 0;
        }
        #logfeed::-webkit-scrollbar { width: 8px; }
        #logfeed::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

        .log-entry {
            padding: 0.4rem 0.6rem;
            border-left: 3px solid #555;
            margin-bottom: 0.32rem;
            border-radius: 4px;
            background: #0f0f16;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: break-word;
            min-width: 0;
            max-width: 100%;
        }
        .log-entry .log-title { font-weight: 600; margin-right: 0.35rem; }
        .log-entry .log-time { color: #555; font-size: 0.78rem; margin-right: 0.4rem; }

        .log-error   { border-left-color: #ff6b6b; color: #ffb0b0; }
        .log-error   .log-title { color: #ff6b6b; }
        .log-warning { border-left-color: #ffb84d; color: #ffd9a8; }
        .log-warning .log-title { color: #ffb84d; }
        .log-info    { border-left-color: #4da6ff; color: #b3d9ff; }
        .log-info    .log-title { color: #4da6ff; }
        .log-success { border-left-color: #4caf50; color: #b7e8b9; }
        .log-success .log-title { color: #4caf50; }
    </style></head><body>
    <div class="layout">
      <div class="main">
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

        <!-- NEW: Device + Action selectors -->
        <div class="card">
            <h3>Remote Actions</h3>
            <div class="remote-row">
                <select id="remoteHost"><option>Loading...</option></select>
                <select id="remoteAction"><option>Loading...</option></select>
                <button class="action" onclick="runRemote()">Run</button>
            </div>
            <div class="unavailable" style="margin-top:0.5rem;">Report will arrive as a Discord DM.</div>
        </div>

        <div class="card">
            <h3>Pending Approvals</h3>
            <div id="approvals">None right now.</div>
        </div>
      </div>

      <aside class="logpanel">
        <div class="card">
          <h3>Live Logs <button class="clear" id="clearLogs">clear</button></h3>
          <div id="logfeed"></div>
        </div>
      </aside>
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

    const LABELS = {
        minecraft: 'Minecraft', vtube: 'VTube Studio', vrchat: 'VRChat',
        browser: 'Browser control', screenshot: 'Screenshot', pidev: 'Pi-dev / system commands',
        coding: 'VSCode editing',
    }

    async function loadModules() {
        const status = await api('/api/modules')
        const el = document.getElementById('modules')
        el.innerHTML = Object.entries(status).map(([name, s]) => \`
            <div class="row">
                <div>
                    <span class="name">\${LABELS[name] || name}</span>
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

    async function loadApprovals() {
        const list = await api('/api/approvals')
        const el = document.getElementById('approvals')
        if (!list.length) { el.textContent = 'None right now.'; return }
        el.innerHTML = list.map(a => \`
            <div class="row">
                <div>
                    <div><b>\${a.matched}</b> — \${a.instruction}</div>
                </div>
                <div>
                    <button class="action" onclick="decide('\${a.id}', true)">✅</button>
                    <button class="action danger" onclick="decide('\${a.id}', false)">❌</button>
                </div>
            </div>
        \`).join('')
    }

    async function decide(id, approved) {
        await api(\`/api/approvals/\${id}/decide\`, { method: 'POST', body: JSON.stringify({ approved }) })
        toast(approved ? 'Approved' : 'Denied')
        loadApprovals()
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

    // ---- Remote actions (device + action) ----
    async function loadRemoteOptions() {
        const [hosts, actions] = await Promise.all([
            api('/api/remote/hosts'),
            api('/api/remote/actions'),
        ])

        const hostSel = document.getElementById('remoteHost')
        if (!hosts.length) {
            hostSel.innerHTML = '<option value="">No hosts configured</option>'
        } else {
            hostSel.innerHTML = hosts.map(h =>
                \`<option value="\${h.name}">\${h.name}\${h.tailscaleIp === 'local' ? ' (local)' : ''}</option>\`
            ).join('')
        }

        const actSel = document.getElementById('remoteAction')
        if (!actions.length) {
            actSel.innerHTML = '<option value="">No actions</option>'
        } else {
            actSel.innerHTML = actions.map(a =>
                \`<option value="\${a.id}" title="\${a.description || ''}">\${a.label}</option>\`
            ).join('')
        }
    }

    async function runRemote() {
        const host = document.getElementById('remoteHost').value
        const action = document.getElementById('remoteAction').value
        if (!host || !action) return toast('Select a device and an action')

        const actionLabel = document.getElementById('remoteAction')
            .selectedOptions[0]?.textContent || action

        toast(\`Triggering "\${actionLabel}" on \${host}...\`)
        try {
            await api('/api/remote/run', {
                method: 'POST',
                body: JSON.stringify({ host, action }),
            })
            toast(\`Triggered on \${host} — check Discord for the report\`)
        } catch (e) {
            toast('Error: ' + e.message)
        }
    }

    // ---- Live log viewer ----
    const logFeed = document.getElementById('logfeed')
    const MAX_LOG_ENTRIES = 400

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ))
    }

    function appendLog(entry) {
        const div = document.createElement('div')
        div.className = 'log-entry log-' + (entry.type || 'info')
        const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString()
        div.innerHTML = \`<span class="log-time">\${time}</span><span class="log-title">[\${escapeHtml(entry.title || '')}]</span>\${escapeHtml(entry.message || '')}\`
        logFeed.appendChild(div)
        while (logFeed.children.length > MAX_LOG_ENTRIES) logFeed.removeChild(logFeed.firstChild)
        logFeed.scrollTop = logFeed.scrollHeight
    }

    const logSource = new EventSource('/api/logs/stream')
    logSource.onmessage = (e) => {
        try { appendLog(JSON.parse(e.data)) } catch { /* ignore */ }
    }

    document.getElementById('clearLogs').addEventListener('click', () => {
        logFeed.innerHTML = ''
    })

    loadModules()
    loadApprovals()
    setInterval(loadApprovals, 5000)
    loadLlamaStatus()
    setInterval(loadLlamaStatus, 8000)
    loadRemoteOptions()
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

    const recentLogs = []
    const MAX_LOG_BUFFER = 200
    subscribeToLogs((entry) => {
        recentLogs.push(entry)
        if (recentLogs.length > MAX_LOG_BUFFER) recentLogs.shift()
    })

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

    function requireApiKeyOrSession(req, res, next) {
        const key = req.headers['x-api-key']
        if (key && process.env.CP_API_KEY && key === process.env.CP_API_KEY) {
            req._viaApiKey = true
            return next()
        }
        if (req.session?.authed) return next()
        return res.status(401).json({ error: 'Not authenticated' })
    }

    function csrfUnlessApiKey(req, res, next) {
        if (req._viaApiKey) return next()
        return requireCsrf(req, res, next)
    }

    app.get('/api/approvals', requireApiKeyOrSession, (req, res) => {
        res.json(approvalStore.list())
    })

    app.post('/api/approvals/:id/decide', requireApiKeyOrSession, csrfUnlessApiKey, (req, res) => {
        const { id } = req.params
        const { approved } = req.body
        const resolved = approvalStore.resolve(id, !!approved, approved ? null : 'manual deny')
        if (!resolved) return res.status(404).json({ error: 'Not found or already resolved' })
        res.json({ ok: true })
    })

    app.use(requireAuth)

    app.get('/api/logs/stream', (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()

        for (const entry of recentLogs) {
            res.write(`data: ${JSON.stringify(entry)}\n\n`)
        }

        const unsubscribe = subscribeToLogs((entry) => {
            try {
                res.write(`data: ${JSON.stringify(entry)}\n\n`)
            } catch { /* client gone */ }
        })

        const keepalive = setInterval(() => {
            try { res.write(': keepalive\n\n') } catch { /* ignore */ }
        }, 25000)

        req.on('close', () => {
            clearInterval(keepalive)
            unsubscribe()
        })
    })

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

    // ---- Device + Action endpoints ----
    app.get('/api/remote/hosts', (req, res) => {
        res.json(
            Object.entries(REMOTE_HOSTS).map(([name, info]) => ({
                name,
                tailscaleIp: info.tailscaleIp,
            }))
        )
    })

    app.get('/api/remote/actions', (req, res) => {
        res.json(listActions())
    })

    app.post('/api/remote/run', requireCsrf, async (req, res) => {
        const { host, action } = req.body || {}
        const hostInfo = REMOTE_HOSTS[host]
        if (!hostInfo) return res.status(400).json({ error: 'Unknown host' })

        const actionInfo = REMOTE_ACTIONS[action]
        if (!actionInfo) return res.status(400).json({ error: 'Unknown action' })

        try {
            const { data } = await axios.post(
                actionInfo.webhook,
                {
                    tailscaleIp: hostInfo.tailscaleIp,
                    discordId: hostInfo.discordId,
                    sshUser: hostInfo.sshUser || '',
                    scriptMode: hostInfo.scriptMode || 'stdin',
                    hostName: host,
                    action,
                },
                { timeout: actionInfo.timeoutMs || 15 * 60 * 1000 }
            )
            res.json({ ok: true, n8n: data })
        } catch (e) {
            Logger.error(`Remote action "${action}" on "${host}" failed: ${e.message}`, 'CONTROL PANEL')
            res.status(500).json({ error: e.message })
        }
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