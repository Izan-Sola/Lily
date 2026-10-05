# Lily — mineflayer port

Ports the `StateController` architecture from LilyBridge (the NeoForge mod +
WebSocket bridge) over to [mineflayer](https://github.com/PrismarineJS/mineflayer),
so Lily can join a cracked plugin server directly as a bot client instead of
needing a mod installed server-side.

## What carried over 1:1 (in spirit)

- **State machine**: `IDLE → RECOVERING → ATTACKING → FOLLOWING`, same
  priority order, same file-per-state structure.
- **MiningState**: same `{x,y,z,amount}` / `{block,radius,amount}` payload
  shape, now driven by `bot.dig()` instead of a `break` WS event + `block_broken`
  callback.
- **MovementHelper**: same "don't re-issue the goal unless the target drifted
  >2 blocks" throttling idea, now wrapping `mineflayer-pathfinder` instead of
  a custom Java-side `move_to`.
- **SneakHelper**: identical `pulse()`/`hold()`/`cancelHold()` API, now driving
  `bot.setControlState('sneak', ...)`.
- **survivalLoop.js / survivalPromptBuilder.js**: same Ollama-based tick loop,
  same prompt shape and `ctx` property names (`lilyHp`, `lilyPos`, `players`,
  `hostiles`, `opts.followTarget`, etc.) so your existing AI persona prompt
  work should mostly transfer.

## What was dropped, and why

The **combo/dueling system** (`comboExecutor.js`, `duelPromptBuilder.js`,
`PKCombosData.json`, the `DUELING` state) is entirely built around
**ProjectKorra bending abilities** — swap-slot ability binds, cooldowns,
elements. That doesn't exist on a vanilla-ish cracked plugin server, so
faking it would just be dead code. If your target server runs some other
PvP/duel plugin with its own ability set, that'd need a new state built from
scratch against that plugin's mechanics — happy to help with that once you
know which plugin it is.

`ATTACKING`'s swing timing was changed from the original's 1100ms (tuned for
a PK weapon) to ~650ms (closer to vanilla sword cooldown) — adjust
`ATTACK_INTERVAL_MS` in `AttackingState.js` to taste.

## The new bit: replying via `/msg`

This is the actual feature you asked for. Two pieces:

1. **`helpers/whisper.js`** — listens for incoming private messages two ways:
   - mineflayer's built-in `whisper` event (catches vanilla `/tell` and a lot
     of common plugin formats automatically)
   - a fallback regex match against the raw chat line (`WHISPER_PATTERNS`),
     for plugins that format `/msg` differently (EssentialsX-style
     `[Player -> me] ...`, `Player whispers: ...`, etc.)
   - both are deduped so you don't get double-fires if a line matches both paths

   If your server's `/msg` plugin uses a format that isn't in
   `WHISPER_PATTERNS`, log a line with `bot.on('message', m => console.log(JSON.stringify(m.toString())))`
   and add a pattern for it.

2. **Reply routing** — `StateController.setLastUserMessage(player, message, channel)`
   now tracks *which channel* a message came in on (`'public'` or `'whisper'`).
   Both the direct chat handler (`index.js` → `_handleIncomingMessage`) and the
   autonomous survival loop check that channel before replying:
   - `channel === 'whisper'` → `stateController.mcWhisper(player, text)` → sends `/msg <player> <text>`
   - otherwise → `stateController.mcChat(text)` → normal public chat

   So if you `/msg` her, she replies with `/msg` back — nobody else in public
   chat sees it. Talking to her in public chat still gets a public reply, same
   as before.

   One behavior difference from public chat: **whispers don't require her
   name to be mentioned** to trigger a reply (a DM is inherently directed at
   her), whereas public messages still need "lily" in them or a `!` prefix,
   same as the original mod version.

## Wiring your AI

`index.js` calls `aiInstance.chat(...)` and `buildMinecraftSystemPrompt(...)`
the same way `lilybot.js` did — pass in the same `ai` instance you already
use elsewhere. The `ctx` object passed to your system-prompt builder
(`stateController`) keeps the same property names as the mod version
wherever practical, so that function likely needs zero changes.

The survival-loop tool executor (`_executeMinecraftTool` in `index.js`) is a
minimal stand-in — swap it for your real `ai/tools.js` `ToolExecutor` if you
want one shared implementation across Discord/VSCode/Minecraft. The action
names (`follow`, `break`, `attack`, `retreat`, `stop`, `move_to`, `use`,
`drop`, `chat`) match `dispatchAction()` exactly, same as before.

## Usage

```js
import { startMinecraftBot } from './index.js'

startMinecraftBot({
  host: 'play.someserver.net',
  port: 25565,
  username: 'Lily',          // cracked/offline — any name works
  followTarget: 'shinyshadow_',
  ai: myExistingAiInstance,
})
```

```
npm install
```

## Files

```
index.js                                    — bot creation, chat/whisper wiring, entry point
state-machine/
  StateController.js                        — orchestrator, dispatchAction, world-state refresh
  states/
    IdleState.js                            — decision hub (no DUELING branch)
    FollowingState.js
    AttackingState.js
    RecoveringState.js
    MiningState.js                          — bot.dig()-based, coords or block-name search
  helpers/
    movement.js                             — mineflayer-pathfinder wrapper
    sneak.js                                — bot.setControlState('sneak', ...) wrapper
    whisper.js                              — NEW: /msg detection + reply routing
    survivalLoop.js                         — Ollama tick loop, whisper-aware replies
  prompt-builders/
    survivalPromptBuilder.js                — same shape as original, notes whisper channel
```
