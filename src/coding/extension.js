// vscode-companion/extension.js
//
// Companion extension for Lily's voice-triggered VS Code edits. Exposes the
// active editor over a small local HTTP server so Lily's STTS tool
// (edit_active_vscode_file in discord/tools/sttsTools.js) can read the open
// file and write an edit back via vscode.workspace.applyEdit, which makes it
// a normal, undo-able, reviewable change instead of a silent disk write.
//
// This is separate from Continue. Continue only runs tool calls for requests
// it initiates itself, so a voice command reaching in from outside needs this.
//
// Install as a real extension (vsce package + code --install-extension), NOT
// via F5 / "Run Extension": that opens a separate Extension Development Host
// window and tracks the active editor of that debug window.
//
// Settings (or env fallbacks): lilyCompanion.port / LILY_COMPANION_PORT,
// lilyCompanion.token / LILY_COMPANION_TOKEN, lilyCompanion.allowOutsideWorkspace.
const vscode = require('vscode')
const http = require('http')
const path = require('path')
const crypto = require('crypto')

const MAX_BODY_BYTES = 20 * 1024 * 1024

function cfg() {
    const c = vscode.workspace.getConfiguration('lilyCompanion')
    return {
        port: c.get('port') || parseInt(process.env.LILY_COMPANION_PORT || '', 10) || 8768,
        token: c.get('token') || process.env.LILY_COMPANION_TOKEN || '',
        allowOutside: c.get('allowOutsideWorkspace') === true,
    }
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', chunk => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function tokenOk(req, expected) {
    if (!expected) return true
    const header = req.headers['authorization'] || ''
    const given = Buffer.from(header.replace(/^Bearer\s+/i, '') || String(req.headers['x-lily-token'] || ''))
    const want = Buffer.from(expected)
    return given.length === want.length && crypto.timingSafeEqual(given, want)
}

// The "active" editor is lost whenever focus moves to a terminal, the output
// panel or a webview (exactly where you are when you speak a command), so
// remember the last real file editor and fall back to it.
let lastEditor
function track(editor) {
    if (editor && editor.document.uri.scheme === 'file') lastEditor = editor
}
function targetEditor() {
    const active = vscode.window.activeTextEditor
    if (active && active.document.uri.scheme === 'file') return active
    if (lastEditor && !lastEditor.document.isClosed) return lastEditor
    return undefined
}

function isInside(parent, child) {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function pathAllowed(fsPath, allowOutside) {
    if (allowOutside) return true
    const target = targetEditor()
    if (target && path.resolve(target.document.uri.fsPath) === path.resolve(fsPath)) return true
    return (vscode.workspace.workspaceFolders || []).some(f => isInside(f.uri.fsPath, path.resolve(fsPath)))
}

// Replace only the changed span instead of the whole document, so cursor,
// scroll position and folding survive and the undo entry is small.
function minimalReplace(doc, newText) {
    let text = newText.replace(/\r\n/g, '\n')
    if (doc.eol === vscode.EndOfLine.CRLF) text = text.replace(/\n/g, '\r\n')
    const oldText = doc.getText()
    if (oldText === text) return null

    const max = Math.min(oldText.length, text.length)
    let start = 0
    while (start < max && oldText[start] === text[start]) start++
    let endOld = oldText.length
    let endNew = text.length
    while (endOld > start && endNew > start && oldText[endOld - 1] === text[endNew - 1]) { endOld--; endNew-- }

    return {
        range: new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)),
        text: text.slice(start, endNew),
    }
}

async function handle(req, res, settings) {
    // Bound to localhost below, but check the peer defensively too: this
    // endpoint can write files.
    const remote = req.socket.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        return sendJson(res, 403, { error: 'forbidden' })
    }
    if (!tokenOk(req, settings.token)) return sendJson(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && req.url === '/health') {
        const editor = targetEditor()
        return sendJson(res, 200, { ok: true, activeFile: editor ? editor.document.uri.fsPath : null })
    }

    if (req.method === 'GET' && req.url === '/active-file') {
        const editor = targetEditor()
        if (!editor) return sendJson(res, 404, { error: 'no active editor' })
        const sel = editor.selection
        return sendJson(res, 200, {
            path: editor.document.uri.fsPath,
            content: editor.document.getText(),
            languageId: editor.document.languageId,
            isDirty: editor.document.isDirty,
            selection: sel.isEmpty ? null : editor.document.getText(sel),
        })
    }

    if (req.method === 'POST' && req.url === '/apply-edit') {
        let body
        try { body = JSON.parse(await readBody(req)) } catch (e) {
            return sendJson(res, e.message === 'body too large' ? 413 : 400, { error: e.message === 'body too large' ? e.message : 'invalid json' })
        }
        const { path: filePath, content, save } = body
        if (!filePath || typeof content !== 'string') {
            return sendJson(res, 400, { error: 'path and content required' })
        }
        if (!pathAllowed(filePath, settings.allowOutside)) {
            return sendJson(res, 403, { error: 'path is outside the workspace' })
        }

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
        const change = minimalReplace(doc, content)
        if (!change) return sendJson(res, 200, { applied: true, changed: false })

        const edit = new vscode.WorkspaceEdit()
        edit.replace(doc.uri, change.range, change.text)
        if (!(await vscode.workspace.applyEdit(edit))) {
            return sendJson(res, 500, { error: 'applyEdit failed' })
        }

        // Show the change, but leave it as a dirty, undo-able (Ctrl+Z) buffer
        // unless the caller explicitly asked to save.
        await vscode.window.showTextDocument(doc, { preview: false })
        if (save === true) await doc.save()
        return sendJson(res, 200, { applied: true, changed: true, saved: save === true })
    }

    if (req.method === 'POST' && req.url === '/create-file') {
        let body
        try { body = JSON.parse(await readBody(req)) } catch (e) {
            return sendJson(res, e.message === 'body too large' ? 413 : 400, { error: e.message === 'body too large' ? e.message : 'invalid json' })
        }
        const { path: filePath, content, overwrite } = body
        if (!filePath || typeof filePath !== 'string') {
            return sendJson(res, 400, { error: 'path required' })
        }
        if (!pathAllowed(filePath, settings.allowOutside)) {
            return sendJson(res, 403, { error: 'path is outside the workspace' })
        }

        const uri = vscode.Uri.file(filePath)

        // Never clobber an existing file unless the caller explicitly opted in.
        let alreadyExists = true
        try { await vscode.workspace.fs.stat(uri) } catch { alreadyExists = false }
        if (alreadyExists && !overwrite) {
            return sendJson(res, 409, { error: 'file already exists', path: filePath })
        }

        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)))
        } catch (e) {
            return sendJson(res, 500, { error: `couldn't create parent directory: ${e.message}` })
        }
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(typeof content === 'string' ? content : '', 'utf8'))
        } catch (e) {
            return sendJson(res, 500, { error: `couldn't write file: ${e.message}` })
        }

        try {
            const doc = await vscode.workspace.openTextDocument(uri)
            await vscode.window.showTextDocument(doc, { preview: false })
        } catch {
            // File exists even if opening it failed: non-fatal.
        }
        return sendJson(res, 200, { created: true, path: filePath, overwritten: alreadyExists })
    }

    sendJson(res, 404, { error: 'not found' })
}

function activate(context) {
    track(vscode.window.activeTextEditor)
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(track))

    const settings = cfg()
    const server = http.createServer((req, res) => {
        handle(req, res, cfg()).catch(err => {
            if (!res.headersSent) sendJson(res, 500, { error: err.message })
            else res.end()
        })
    })

    // Without this, a second VS Code window hitting EADDRINUSE would throw an
    // unhandled 'error' event inside the extension host.
    server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[Lily Companion] port ${settings.port} already in use (another VS Code window?). This window is not serving.`)
        } else {
            console.error('[Lily Companion] server error:', err)
        }
    })

    server.listen(settings.port, '127.0.0.1', () => {
        console.log(`[Lily Companion] listening on http://127.0.0.1:${settings.port}`)
    })

    context.subscriptions.push({ dispose: () => server.close() })
}

function deactivate() { }

module.exports = { activate, deactivate }