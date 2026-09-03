#!/usr/bin/env node
import readline from 'readline'
import { VTSClient } from './VTSClient.js'

async function main() {
    const client = new VTSClient({
        host: process.env.VTS_HOST || 'localhost',
        port: parseInt(process.env.VTS_PORT || '8001'),
        pluginName: process.env.VTS_PLUGIN_NAME || 'LilyVTS',
        pluginDev: process.env.VTS_PLUGIN_DEV || 'Izan'
    })

    try {
        await client.connect()
    } catch (err) {
        console.error(err.message)
        process.exit(1)
    }

    const hotkeys = await client.listHotkeys()

    // Expects hotkeys in VTS literally named "1", "2", "3", etc.
    const byKey = new Map(hotkeys.map((h) => [h.name.trim(), h]))

    console.log('Connected. Live mode, tap a number key to trigger that hotkey. q to quit.\n')
    hotkeys.forEach((h) => console.log(`  [${h.name}] ${h.hotkeyID} (${h.type})`))
    console.log('')

    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()

    process.stdin.on('keypress', async (str, key) => {
        if (key?.ctrl && key.name === 'c') {
            await client.disconnect()
            process.exit(0)
        }
        if (str === 'q') {
            await client.disconnect()
            process.exit(0)
        }
        const match = byKey.get(str)
        if (match) {
            try {
                await client.triggerHotkeyID(match.hotkeyID)
                console.log(`-> ${match.name}`)
            } catch (err) {
                console.error('Error:', err.message)
            }
        }
    })
}

main().catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
})