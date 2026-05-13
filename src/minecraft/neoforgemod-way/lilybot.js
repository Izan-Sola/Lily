import { WebSocket } from "ws"
import { StateController } from "./state-machine/StateController.js"
import { MINECRAFT_SYSTEM_PROMPT } from '../../ai/ollama.js'
import fs, { stat } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadCombos, enrichCombosData } from './state-machine/states/comboExecutor.js'
export function requestDuelData(opponentName) {
    mcSend('get_duel_data', { opponent: opponentName });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let ws = null
let stateController = null
let aiInstance = null
let reconnectTimer = null
let wsHost = null
let wsPort = null

// Static ability definitions (actions, descriptions, etc.)
let staticAbilities = {}

// Load static ability data from PKAbilitiesData.json
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

// Merge live range/cooldown from server config and write back to file
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

// Request ability data from mod
function requestAbilityData() {
    mcSend('request_ability_data')
}

export function startMinecraftBot({ host = "localhost", port = 8765, ai }) {
    aiInstance = ai
    wsHost = host
    wsPort = port
    loadCombos()      // load static JSON once
    loadStaticAbilityData() // load static JSON once
    
    _connect()
}

function _connect() {
    ws = new WebSocket(`ws://${wsHost}:${wsPort}`)

    ws.on("open", () => {
        console.log("⛏️ [MC] Connected to LilyBotBridge")
        clearTimeout(reconnectTimer)

        if (!stateController) {
            stateController = new StateController(mcSend, {
                followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
                followDistance: 3,
                attackRange: 4,
                lowHpThreshold: 6,
                tickMs: 75,
                ai: aiInstance
            })
            // IMPORTANT: Load the ability stats from our JSON into the controller
            stateController.updateAbilityStats(staticAbilities)
            // Also ensure the controller's abilityStats is used for cooldowns/ranges
        }
        stateController.start()

        // Request ability data from the mod after connection
        requestAbilityData()
    })

    ws.on("message", async (data) => {
        try {
            const event = JSON.parse(data.toString())
            await _handleEvent(event)
        } catch (err) {
            console.error("⛏️ [MC] Message error:", err.message)
        }
    })

    ws.on("close", () => {
        console.log("⛏️ [MC] Disconnected, reconnecting in 15s...")
        stateController?.stop()
        reconnectTimer = setTimeout(_connect, 15000)
    })

    ws.on("error", err => {
        console.error("⛏️ [MC] WS error:", err.message)
    })
}

async function _handleEvent(event) {
    switch (event.type) {
        case "chat": {
            console.log(`⛏️ [MC CHAT] ${event.player}: ${event.message}`)
            aiInstance?.pushRawMessage("minecraft", event.player, event.message)

            const lower = event.message.toLowerCase()
            const addressed = lower.includes("lily") || lower.includes("hylily")

            if (addressed || Math.random() < 0.05 && stateController?.currentStateName !== State.DUELING) {
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
            // Update Lily
            stateController.updateLilyState(
                { x: event.lily.x, y: event.lily.y, z: event.lily.z },
                event.lily.hp
            );
            // Update opponent
            const opp = event.opponent;
            stateController.updatePlayers({
                [opp.name]: {
                    x: opp.x, y: opp.y, z: opp.z,
                    hp: opp.hp
                }
            });
            // Update bindings
            const bindingsMap = event.bindings;
            if (bindingsMap) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability);
                }
            }
            // The prompt will be built in DuelingState using local PKAbilitiesData.json
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
                event.hp ?? 20
            )
            break
        }

        case "hostiles": {
            stateController?.updateHostiles(event.hostiles ?? [])
            break
        }

        case "ability_data": {
            mergeAbilityData(event.abilities)
            if (stateController?.updateAbilityStats) {
                stateController.updateAbilityStats(staticAbilities)
                enrichCombosData(staticAbilities)
            }
            break
        }

        case "set_duel_target": {

            stateController?.setDuelTarget(event.target)

            stateController.duelDifficulty =
                event.difficulty || "medium"

            console.log(
                `[DUEL] Difficulty: ${stateController.duelDifficulty}`
            )

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

// ─── Send helpers ─────────────────────────────────────────────────────────────
export function mcSend(type, data = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
    ws = null
    stateController = null
}

export function getStateController() { return stateController }

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
/**
 * STATE CONTROLLER
 * ─────────────────────────────────────────────────────────────────────────────
 * Central orchestrator for Lily's in-game behavior. Owns all shared game state,
 * manages state transitions, runs the main tick loop, and provides helper
 * methods used by individual states.
 *
 * ARCHITECTURE:
 *   Each behavior is a separate state class (IdleState, FollowingState, etc.)
 *   The controller delegates onTick() to the current active state every tickMs.
 *   States call back into the controller via this.ctx for shared data and helpers.
 *
 * KEY OPTIONS (opts):
 *   followTarget    → username to follow, default "shinyshadow_"
 *   followDistance  → blocks before following kicks in, default 3
 *   attackRange     → blocks to scan for hostiles, default 4
 *   lowHpThreshold  → HP floor for recovering state, default 6
 *   tickMs          → tick interval in ms, default 75
 *
 * SHARED STATE:
 *   this.players         → { name: { x, y, z, hp } } updated every tick from mod
 *                          e.g. { shinyshadow_: { x: 100, y: 64, z: 200, hp: 20 } }
 *   this.lilyPos         → { x, y, z } Lily's position, null until first update
 *   this.lilyHp          → Lily's HP 0–20, default 20
 *   this.hostiles        → [{ x, y, z, type, id, hp }] nearby hostile entities
 *                          e.g. [{ x: 105, y: 64, z: 202, type: "zombie", id: 42, hp: 10 }]
 *   this.duelTarget      → player name being dueled or null
 *   this.bindings        → { slot: rawAbilityName } e.g. { 1: "§cFireBall", 2: "FireShots" }
 *   this.abilityCooldowns → { abilityName: expiryMs } e.g. { FireBall: 1716123456789 }
 *   this.abilityStats    → { abilityName: { range, cooldown, actions, actionTimes, description } }
 *
 * HELPERS AVAILABLE TO STATES:
 *   this.sneak           → SneakHelper — setSneaking(bool), cancelHold()
 *   this.move            → MovementHelper — moveToward(from, to), stop()
 *   this.mcSend(type, data) → sends WebSocket command to Java mod
 *   this.getFollowTarget()  → returns players[followTarget] or null
 *   this.nearestHostile()   → nearest hostile within attackRange or null
 *   this._dist(a, b)        → Math.hypot distance between two {x,y,z} points
 *   this.transitionTo(name) → triggers onExit → onEnter for state change
 */