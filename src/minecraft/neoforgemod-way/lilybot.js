import { WebSocketServer } from "ws"
import { StateController } from "./state-machine/StateController.js"
import { MINECRAFT_SYSTEM_PROMPT } from '../../ai/ollama.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadCombos, enrichCombosData } from './state-machine/helpers/comboExecutor.js'
import { startSurvivalLoop } from './survivalLoop.js'

export function requestDuelData(opponentName) {
    mcSend('get_duel_data', { opponent: opponentName });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODE = process.env.MODE ?? 'bendcraft'
export const isSurvival = MODE === 'survival'
export const isBendcraft = MODE === 'bendcraft'

let wss = null
let ws = null
let stateController = null
let aiInstance = null
let reconnectTimer = null

let staticAbilities = {}

function loadStaticAbilityData() {
    const jsonPath = path.join(__dirname, './state-machine/states/data/PKAbilitiesData.json')
    try {
        const data = fs.readFileSync(jsonPath, 'utf8')
        const json = JSON.parse(data)
        staticAbilities = json.abilities || {}
        console.log(`[ABILITY] Loaded ${Object.keys(staticAbilities).length} static ability definitions from PKAbilitiesData.json`)
    } catch (err) {
        console.error('[ABILITY] Failed to load PKAbilitiesData.json:', err.message)
        staticAbilities = {}
    }
}

function mergeAbilityData(liveData) {
    console.log('[ABILITY] Received live data. Abilities:', Object.keys(liveData));
    let updatedCount = 0;

    for (const [ability, stats] of Object.entries(liveData)) {
        const old = staticAbilities[ability];
        if (old) {
            const oldRange = old.range;
            const oldCooldown = old.cooldown;
            old.range = stats.range;
            old.cooldown = stats.cooldown;
            updatedCount++;
            console.log(`[ABILITY] Updated ${ability}: range ${oldRange}→${stats.range}, cooldown ${oldCooldown}→${stats.cooldown}`);
        } else {
            staticAbilities[ability] = {
                description: "Unknown ability",
                actions: [],
                actionTimes: [],
                range: stats.range,
                cooldown: stats.cooldown
            };
            updatedCount++;
            console.log(`[ABILITY] Created new entry for ${ability}: range=${stats.range}, cooldown=${stats.cooldown}`);
        }
    }

    if (updatedCount > 0) {
        try {
            const jsonPath = path.join(__dirname, './state-machine/states/data/PKAbilitiesData.json');
            const output = { abilities: staticAbilities };
            fs.writeFileSync(jsonPath, JSON.stringify(output, null, 4));
            console.log(`[ABILITY] Saved PKAbilitiesData.json (${updatedCount} entries updated/added).`);
        } catch (err) {
            console.error('[ABILITY] Failed to write PKAbilitiesData.json:', err.message);
        }
    } else {
        console.warn('[ABILITY] No abilities matched – check ability name casing.');
    }
}

function requestAbilityData() {
    mcSend('request_ability_data')
}

export function startMinecraftBot({ port = 8765, ai }) {
    aiInstance = ai
    if (isBendcraft) {
        loadCombos()
        loadStaticAbilityData()
    }
    _connect(port)
}

function _connect(port = 8765) {
    wss = new WebSocketServer({ port })
    console.log(`⛏️ [MC] WebSocket server listening on port ${port} (mode: ${MODE})`)

    wss.on("connection", (socket) => {
        ws = socket
        console.log("⛏️ [MC] Java mod connected")
        clearTimeout(reconnectTimer)

        if (!stateController) {
            stateController = new StateController(mcSend, {
                followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
                followDistance: 3,
                attackRange: 4,
                lowHpThreshold: 6,
                tickMs: 25,
                ai: aiInstance
            })
            if (isBendcraft) stateController.updateAbilityStats(staticAbilities)
        }
        stateController.start()

        if (isBendcraft) requestAbilityData()
        if (isSurvival) startSurvivalLoop(stateController, mcSend, mcChat)

        socket.on("message", async (data) => {
            try {
                const event = JSON.parse(data.toString())
                await _handleEvent(event)
            } catch (err) {
                console.error("⛏️ [MC] Message error:", err.message)
            }
        })

        socket.on("close", () => {
            console.log("⛏️ [MC] Java mod disconnected")
            stateController?.stop()
            ws = null
        })

        socket.on("error", err => {
            console.error("⛏️ [MC] WS error:", err.message)
        })
    })
}

async function _handleEvent(event) {
    switch (event.type) {
        case "chat": {
            console.log(`⛏️ [MC CHAT] ${event.player}: ${event.message}`)
            aiInstance?.pushRawMessage("minecraft", event.player, event.message)

            const lower = event.message.toLowerCase()
            const addressed = lower.includes("lily") || lower.includes("hylily")

            if (addressed || (Math.random() < 0.05 && stateController?.currentStateName !== 'DUELING')) {
                if (stateController?.currentStateName === 'DUELING') {
                    mcChat("Lily is busy in a duel!")
                    break
                }
                try {
                    const formatted = addressed
                        ? `[${event.player}] says to you in Minecraft: ${event.message}`
                        : `[${event.player}] said in Minecraft nearby: ${event.message}`
                    const reply = await aiInstance?.chat("minecraft", formatted, MINECRAFT_SYSTEM_PROMPT)
                    const text = typeof reply === "object" ? reply?.text : reply
                    if (text) _splitMessage(text).forEach(chunk => mcChat(chunk))
                } catch (err) {
                    console.error("⛏️ [MC] Chat handler error:", err.message)
                }
            }
            break
        }

        case "duel_data": {
            if (!isBendcraft) break
            stateController.updateLilyState(
                { x: event.lily.x, y: event.lily.y, z: event.lily.z },
                event.lily.hp
            );
            const opp = event.opponent;
            stateController.updatePlayers({
                [opp.name]: {
                    x: opp.x, y: opp.y, z: opp.z,
                    hp: opp.hp
                }
            });
            const bindingsMap = event.bindings;
            if (bindingsMap) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability);
                }
            }
            break;
        }

        case "players_list": {
            const players = {}
            if (event.players) {
                event.players.split(";").filter(Boolean).forEach(entry => {
                    try {
                        const colonIdx = entry.indexOf(":")
                        const name = entry.slice(0, colonIdx)
                        const parts = entry.slice(colonIdx + 1).split(",")
                        players[name] = {
                            x: parseFloat(parts[0]),
                            y: parseFloat(parts[1]),
                            z: parseFloat(parts[2]),
                            hp: parseFloat((parts[3] ?? "hp=20").split("=")[1] ?? "20")
                        }
                    } catch { /* skip malformed */ }
                })
            }
            stateController?.updatePlayers(players)
            break
        }

        case "lily_state": {
            stateController?.updateLilyState(
                { x: event.x, y: event.y, z: event.z },
                event.hp ?? 20,
                event.food ?? 20
            )
            break
        }

        case "hostiles": {
            stateController?.updateHostiles(event.hostiles ?? [])
            break
        }

        case "ability_data": {
            if (!isBendcraft) break
            mergeAbilityData(event.abilities)
            if (stateController?.updateAbilityStats) {
                stateController.updateAbilityStats(staticAbilities)
                enrichCombosData(staticAbilities)
            }
            break
        }

        case "set_duel_target": {
            if (!isBendcraft) break
            stateController?.setDuelTarget(event.target)
            stateController.duelDifficulty = event.difficulty || "medium"
            console.log(`[DUEL] Difficulty: ${stateController.duelDifficulty}`)
            break
        }

        case "set_follow_target": {
            stateController?.setFollowTarget(event.target)
            break
        }

        case "player_join":
            console.log(`⛏️ [MC] ${event.player} joined`)
            break

        case "player_leave":
            console.log(`⛏️ [MC] ${event.player} left`)
            break

        case "player_death":
            console.log(`⛏️ [MC] ${event.player} died: ${event.cause}`)
            break
    }
}

export function mcSend(type, data = {}) {
    if (!ws || ws.readyState !== 1) {
        console.warn(`⛏️ [MC] WS not ready, dropping: ${type}`)
        return
    }
    ws.send(JSON.stringify({ type, ...data }))
}

export function mcChat(message) { mcSend("chat", { message }) }
export function mcCommand(cmd) { mcSend("run_command", { command: cmd }) }
export function mcGetPlayers() { mcSend("get_players") }
export function mcGetScoreboard() { mcSend("get_scoreboard") }

export function stopMinecraftBot() {
    clearTimeout(reconnectTimer)
    stateController?.stop()
    ws?.close()
    wss?.close()
    ws = null
    wss = null
    stateController = null
}

export function getStateController() { return stateController }

function _splitMessage(text, limit = 250) {
    const words = text.split(" ")
    const chunks = []
    let current = ""
    for (const word of words) {
        if ((current + " " + word).trim().length > limit) {
            if (current) chunks.push(current.trim())
            current = word
        } else {
            current = current ? current + " " + word : word
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}