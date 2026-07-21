import { WebSocketServer } from "ws"
import { StateController } from "./state-machine/StateController.js"

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadCombos, enrichCombosData } from './state-machine/helpers/comboExecutor.js'
import { startSurvivalLoop } from './state-machine/helpers/survivalLoop.js'
import axios from "axios"
import { buildMinecraftSystemPrompt } from '../../ai/prompts.js'
export function requestDuelData(opponentName) {
    mcSend('get_duel_data', { opponent: opponentName });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let currentMode = process.env.MODE ?? 'bendcraft'
let survivalLoopStarted = false

export const getMode = () => currentMode

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

export function startMinecraftBot({ port, ai }) {
    aiInstance = ai
    if (getMode() === 'bendcraft') {
        loadCombos()
        loadStaticAbilityData()
    }
    const resolvedPort = port ?? (getMode() === 'survival' ? 8766 : 8765)
    _connect(resolvedPort)
}

function _connect(port) {
    wss = new WebSocketServer({ port })
    console.log(`⛏️ [MC] WebSocket server listening on port ${port} (mode: ${currentMode})`)

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
            if (getMode() === 'bendcraft') stateController.updateAbilityStats(staticAbilities)
        }
        stateController.start()

        if (getMode() === 'bendcraft') requestAbilityData()
        if (getMode() === 'survival' && !survivalLoopStarted) {
            startSurvivalLoop(stateController, mcSend, mcChat)
            survivalLoopStarted = true
        }

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
            const player = event.player ?? ""
            const message = event.message ?? ""

            if (player.toLowerCase() === "lily") break
            if (!event.message.toLowerCase().includes("lily") && !event.message.toLowerCase().startsWith("!")) break
            console.log(`[MC CHAT] ${player}: ${message}`)

            getStateController()?.setLastUserMessage(player, message)  

            try {
                const aiReply = await aiInstance.chat(
                    "minecraft",
                    `${player}: ${message}`,
                    buildMinecraftSystemPrompt(getStateController())
                )

                const text = aiReply?.text?.trim()
                const gifUrl = aiReply?.gifUrl

                if (text) {
                    _splitMessage(text).forEach(msg => mcChat(msg))
                }
                if (gifUrl) {
                    mcChat(gifUrl)
                }

            } catch (err) {
                console.error("[MC CHAT ERROR]", err)
            }

            break
        }
        case "duel_data": {
            stateController.updateLilyState(
                { x: event.lily.x, y: event.lily.y, z: event.lily.z },
                event.lily.hp,
                event.lily.hunger ?? 20
            );

            if (!stateController.lilyPrevPos) {
                stateController.lilyPrevPos = { x: event.lily.x, y: event.lily.y, z: event.lily.z };
            } else {
                stateController.lilyPrevPos = {
                    x: stateController.lilyPos?.x ?? event.lily.x,
                    y: stateController.lilyPos?.y ?? event.lily.y,
                    z: stateController.lilyPos?.z ?? event.lily.z
                };
            }

            const opp = event.opponent;

            if (!stateController.opponentPrevPos) {
                stateController.opponentPrevPos = {};
            }

            const currentOpp = stateController.players?.[opp.name];
            if (currentOpp) {
                stateController.opponentPrevPos[opp.name] = {
                    x: currentOpp.x,
                    y: currentOpp.y,
                    z: currentOpp.z
                };
            }

            stateController.updatePlayers({
                [opp.name]: {
                    x: opp.x,
                    y: opp.y,
                    z: opp.z,
                    hp: opp.hp
                }
            });

            const bindingsMap = event.bindings;
            if (bindingsMap) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability);
                }
            }

            if (event.duelDifficulty) {
                stateController.duelDifficulty = event.duelDifficulty;
            }

            if (event.lily?.sprinting !== undefined) {
                stateController.lilySprinting = event.lily.sprinting;
            }

            if (event.lily?.armor !== undefined) {
                stateController.lilyArmor = event.lily.armor;
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
            if (event.armor !== undefined) {
                stateController.lilyArmor = event.armor
            }
            break
        }
        case "element_changed": {
            stateController.currentElement = event.element
            console.log(`[BEND] Element changed to ${event.element}`)
            break
        }
        case "hostiles": {
            stateController?.updateHostiles(event.hostiles ?? [])
            break
        }
        case "environment_scan": {
            if (stateController) {
                stateController.hostiles = event.hostiles ?? []
                stateController.passives = event.passives ?? []
                stateController.blocksOfInterest = event.blocks_of_interest ?? []
                stateController.inventoryItems = event.inventory ?? {}
                stateController.environmentInfo = event.environment_info ?? {}   // NEW
            }
            break
        }
        case "bindings_update": {
            const bindingsMap = event.bindings ?? {}
            if (stateController) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability)
                }
            }
            break
        }
        case "ability_data": {
            if (getMode() === 'survival') break
            mergeAbilityData(event.abilities)
            if (stateController?.updateAbilityStats) {
                stateController.updateAbilityStats(staticAbilities)
                enrichCombosData(staticAbilities)
            }
            break
        }

        case "set_duel_target": {
            if (getMode() === 'survival') break
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

        // Clean Hook from your custom NeoForge / Arclight Event Listener
        case "duel_result": {
            const { winner, loser } = event;
            console.log(`🏆 [DUEL ENDED] Winner: ${winner} | Loser: ${loser}`);

            if (stateController) {
                stateController.duelTarget = null;
                if (stateController.currentStateName === 'DUELING') {
                    stateController.transitionTo('IDLE');
                }
            }

            axios.post("http://localhost:1234/duel-result", { winner, loser })
                .then(() => console.log("✉️ [DUEL] Successfully synced score update with Blog Server."))
                .catch(err => console.error("❌ [DUEL] Failed to update Blog Server:", err.message));

            break;
        }

        case "player_death": {
            const who = event.player
            console.log(`⛏️ [MC] ${who} died`)

            // Note: General match termination logic is handled cleanly by "duel_result" above.
            // This case handles fallback cleanups if non-duel entities drop.
            break
        }

        case "set_mode": {
            currentMode = event.mode
            console.log(`[MC] Mode switched to ${currentMode}`)

            if (currentMode === 'bendcraft') {
                loadCombos()
                loadStaticAbilityData()
                if (stateController) {
                    stateController.updateAbilityStats(staticAbilities)
                    requestAbilityData()
                }
                survivalLoopStarted = false
            }

            if (currentMode === 'survival' && !survivalLoopStarted) {
                survivalLoopStarted = true
                startSurvivalLoop(stateController, mcSend, mcChat)
            }

            break
        }
        case "block_found": {
            // Response to the 'break_closest_generic' request sent from
            // StateController.dispatchAction(). Java searched nearby for a
            // block matching the requested name and reports back either a
            // position or found:false. This is what actually kicks off
            // MINING for the generic-name path — dispatchAction() only sent
            // the search request, it couldn't transition into MINING itself
            // since it never knew a position at call time.
            if (!stateController) break

            if (!event.found) {
                console.log(`[MINE] No "${event.block}" found nearby`)
                mcChat(`can't find any ${event.block} around here (╥﹏╥)`)
                break
            }

            const target = { x: event.x, y: event.y, z: event.z, type: event.block }
            stateController.transitionTo('MINING', { blocks: [target] })
            break
        }
        case "source_block": {
            stateController?.handleSourceBlock(event);
            break;
        }   
        case "block_broken": {
            stateController?.handleBlockBroken(event);
            break;
        }
           
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