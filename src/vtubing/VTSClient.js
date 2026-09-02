#!/usr/bin/env node
import WebSocket from 'ws';
import fs from 'fs';
import readline from 'readline';

const TOKEN_FILE = './vts_token.json';
const PLUGIN_NAME = 'LilyVTS';
const PLUGIN_DEV = 'Izan';

function send(ws, payload) {
    return new Promise((resolve, reject) => {
        const requestID = payload.requestID || Math.random().toString(36).slice(2);
        payload.requestID = requestID;
        const handler = (data) => {
            const msg = JSON.parse(data);
            if (msg.requestID === requestID) {
                ws.off('message', handler);
                if (msg.messageType === 'APIError') reject(new Error(msg.data.message));
                else resolve(msg);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(payload));
    });
}

async function authenticate(ws) {
    let token;
    if (fs.existsSync(TOKEN_FILE)) {
        token = JSON.parse(fs.readFileSync(TOKEN_FILE)).token;
    } else {
        const req = await send(ws, {
            apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'AuthenticationTokenRequest',
            data: { pluginName: PLUGIN_NAME, pluginDeveloper: PLUGIN_DEV },
        });
        token = req.data.authenticationToken;
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
        console.log('New token requested, approve the popup inside VTube Studio.');
    }
    const auth = await send(ws, {
        apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'AuthenticationRequest',
        data: { pluginName: PLUGIN_NAME, pluginDeveloper: PLUGIN_DEV, authenticationToken: token },
    });
    if (!auth.data.authenticated) {
        fs.unlinkSync(TOKEN_FILE);
        throw new Error('Token rejected, deleted it. Run again to request a fresh one.');
    }
}

async function listHotkeys(ws) {
    const res = await send(ws, {
        apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'HotkeysInCurrentModelRequest', data: {},
    });
    return res.data.availableHotkeys;
}

async function triggerHotkeyID(ws, hotkeyID) {
    await send(ws, {
        apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'HotkeyTriggerRequest',
        data: { hotkeyID },
    });
}

async function main() {
    const ws = new WebSocket('ws://localhost:8001');

    ws.on('open', async () => {
        try {
            await authenticate(ws);
            const hotkeys = await listHotkeys(ws);

            // Expects hotkeys in VTS literally named "1", "2", "3", etc.
            const byKey = new Map(hotkeys.map((h) => [h.name.trim(), h]));

            console.log('Connected. Live mode, tap a number key to trigger that hotkey. q to quit.\n');
            hotkeys.forEach((h) => console.log(`  [${h.name}] ${h.hotkeyID} (${h.type})`));
            console.log('');

            readline.emitKeypressEvents(process.stdin);
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();

            process.stdin.on('keypress', async (str, key) => {
                if (key.ctrl && key.name === 'c') process.exit(0);
                if (str === 'q') {
                    ws.close();
                    process.exit(0);
                }
                const match = byKey.get(str);
                if (match) {
                    try {
                        await triggerHotkeyID(ws, match.hotkeyID);
                        console.log(`-> ${match.name}`);
                    } catch (err) {
                        console.error('Error:', err.message);
                    }
                }
            });
        } catch (err) {
            console.error('Error:', err.message);
            process.exit(1);
        }
    });

    ws.on('error', () => {
        console.error('Could not connect. Is VTube Studio running with the API enabled (Settings > Start API)?');
        process.exit(1);
    });
}

main();