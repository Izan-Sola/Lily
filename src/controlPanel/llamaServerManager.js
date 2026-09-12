
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { Logger } from '../utils/Logger.js'

const execFileAsync = promisify(execFile)

const LLAMA_BIN = '/mnt/CA200B97200B8A21/llama.cpp/build/bin/llama-server'
const LLAMA_ARGS = [
    '--model', '/mnt/GAMES/test/qwen3.5-9b-Q6-Lily-gguf-2_gguf/Qwen3.5-9B.Q6_K.gguf',
    '--mmproj', '/mnt/CA200B97200B8A21/mmproj-Qwen3.5-9B-Q8_0.gguf',
    '--jinja',
    '--parallel', '1',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--port', '11435',
    '-c', '64000',
    '--context-shift',
    '--image-min-tokens', '1024',
    '--host', '0.0.0.0',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--reasoning-format', 'none',
    '-ngl', '999',
    '--flash-attn', 'on',
]
const LLAMA_ENV = { ...process.env, CUDA_VISIBLE_DEVICES: '0' }
const LLAMA_HEALTH_URL = 'http://localhost:11435/health'
const LOG_PATH = path.join(process.cwd(), 'logs', 'llama-server.log')

async function killExisting() {
    try {
        await execFileAsync('pkill', ['-f', LLAMA_BIN])
        Logger.info('Killed existing llama-server process(es)', "LLAMA")
    } catch (e) {
        // pkill exits 1 when nothing matched — not an error for us
        if (e.code !== 1) {
            Logger.error(`pkill failed: ${e.message}`, "LLAMA")
        }
    }
    // give the port a moment to actually free up
    await new Promise(r => setTimeout(r, 1500))
}

export async function isRunning() {
    try {
        await axios.get(LLAMA_HEALTH_URL, { timeout: 1500 })
        return true
    } catch {
        return false
    }
}

export function startLlamaServer() {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    const out = fs.openSync(LOG_PATH, 'a')
    const err = fs.openSync(LOG_PATH, 'a')

    const proc = spawn(LLAMA_BIN, LLAMA_ARGS, {
        env: LLAMA_ENV,
        detached: true,
        stdio: ['ignore', out, err],
    })
    proc.unref()

    Logger.success(`llama-server spawned (pid ${proc.pid}), logging to ${LOG_PATH}`, "LLAMA")
    return proc.pid
}

export async function restartLlamaServer() {
    await killExisting()
    return startLlamaServer()
}

export async function stopLlamaServer() {
    await killExisting()
}