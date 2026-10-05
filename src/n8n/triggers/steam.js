import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { STEAM_RECIPIENTS } from '../steamRecipients.js'

const execAsync = promisify(exec)
const SCRIPT_PATH = '/srv/n8n/steam-watch/bin/run_steam.sh'

export const routes = [
    {
        method: 'POST',
        path: '/run-steam-check',
        async handler() {
            const { stdout, stderr } = await execAsync(SCRIPT_PATH, {
                maxBuffer: 1024 * 1024 * 20,
                timeout: 1000 * 60 * 5,
            })
            return { stdout, stderr, recipients: STEAM_RECIPIENTS }
        },
    },
]