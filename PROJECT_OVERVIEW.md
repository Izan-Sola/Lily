# Lily's brain - Overview

###### Last edit: September 2026 (unfinished)

# Index

- [Systems](#systems)
  
  - [Tools](#tools)
    
    - [Tool executors](#tool-executors)
      
  - [Modularity](#modularity)
    
  - [Automatic training data generation](#automatic-training-data-generation)
 
  - [Custom Logger](#custom-logger)

- [Main Functionalities](#main-functionalities)
  
  - [Discord](#discord)
    
    - [Features](#features)
      
    - [Commands](#commands)

  - [STTS](#stts)
    
  - [Minecraft](#minecraft)
    
    - [Neoforge (Arclight server)](#neoforge-arclight-server)
      
      - [State Machine](#state-machine)
        
        - [States](#states)
          
        - [Helpers](#helpers)
          
      - [Prompt Builders](#prompt-builders)
        
    - [Mineflayer (wip)](#mineflayer-wip)
      
  - [Vtubing (early wip)](#vtubing-early-wip)
    
  - [VRChat](#vrchat)
 
    - [Listening and voice](#listening-and-voice)

- [Other Functionalities](#other-functionalities)
  
  - [VSC Integration](#vsc-integration)
    
  - [Pi dev](#pi-dev)
<br>

# Systems

## Tools

###### `src/ai/tools/`

- Each main functionality has its own `ToolExecutor` which contains the tool definitions for that specific functionality, its own code logic, and tool functions. Combining functionalities will make each's executor tools available globally. Note that some tools might be filtered in certains part of the code depending on the source of the user message to avoid misuse.

- The main file is `toolRouter.js` which can initialize each independent tool executor for each distinct functionality. It also includes a bunch of helper functions, and routes shared functions that pertain to a specific `ToolExecutor`.

- **Tool executors**:

  - **`ChatToolExecutor`**: Contains all tools for a conversational discord bot. Memory tools, gif/meme tools and web search. If `discord` flag is used, this executor will be enabled.

  - **`MinecraftToolExecutor`**: Contains all the tools for an assitant-like minecraft bot. Mining, dropping, attacking, etc... If either the `mineflayer` or `modded` flag is used, this executor will be enabled.

  - **`VtubeToolExecutor`**: Contains all the tools related to vtubing. Triggering expressions, etc... If the `vtube` flag is used, this executor will be enabled.
<br>

## Modularity

- The brain contains many functionalities, but not all need to be active at the same time. By mixing different flags such as `discord`, `modded`, `vtube` etc... You can choose to enable the functionalities you are actually going to use, anything else will not be enabled.

- The `start.js` file handles the brain initiation, checking the flags that were used and enabling each correspondent functionality.

- `startUtils.js` contains a bunch of helper functions to check which modes are enabled or which tools to use.
<br>

## Automatic training data generation

- The brain inlcudes a system (`saveFlawlessTurns.js`) to automatically records as many flawless turns as configurated in the `config.json` "trainingTurnWindow", and saves the entire conversation in ShareGPT format into a file named `pending_review.jsonl` to review and use as training data for finetuning. Flawless turns are such turns that execute without a single error or warning caused by the AI messing up. If a turn is not flawless, the entire conversation is dropped, and the count is restarted.
<br>

## Custom logger.

- The brain inlcudes a custom logger used by calling `Logger(message, title)`. Displays a formatted log for visual clarity both in the terminal and, if available, a discord channel. Inlcudes the methods `info`, `warning`, `success` and `error`, each with a different color. "title" helps quickly identifying where each log is from, and the color the type of the log.

# Main functionalities

## Discord

###### `src/discord/`

- The main file is `bot.js`, containing all the logic for the discord bot functionality. Handling replies, voice calls, media...

### Features

- Will respond to messages when pinged or replied to.
- Has a very small chance to butt-in and reply to someone when not directly addressed.
- Can send gifs and memes.
- Can see images sent and videos (just a few frames here and there).
- Can send audios and join calls.

### Commands

- **/about**: Displays information about the bot, see `src/discord/commands/about.js` to change the information.
- **/preferences**: Adjust your preferences such as, disabling pings, voice processing (she wont listen to you in voice calls), disabling spontaneous replies to your messages...
- **/voice join/leave**: To make her join or leave a voice channel.
- **/audio**: To make her respond with an audio message.
<br>

## STTS

###### `src/STTS/`

- Shared speech pipeline used by both the voice assistant (`voiceAssistant/`) and the VRChat bot (`vrchatBot/audiostuff/`), so wake-word detection, transcription and TTS playback aren't duplicated per surface.

- **`transcription/`**: `vad.js` wraps `@ericedouard/vad-node-realtime` (Silero VAD) to detect speech start/end from a continuous mic stream. On speech end, `recorder.js`'s buffered audio gets converted and passed to `transcriber.js`, which shells out to `faster-whisper` and cleans up the raw transcript. `index.js` ties this into an `EventEmitter`, emitting `speechStart`, `speech` (every utterance, used for ambient/butt-in buffering) and `wake` (only when the wake word is matched, unless `enableWakeWord` is off in config, in which case everything is treated as a wake). Also exposes manual/forced-recording helpers used by the CLI key bindings.

- **`voice/`**: `index.js`'s `speak()` handles TTS playback. Spawns either `edge-tts` or the `StyleTTS2` python script (`tts_safe.py`, see `STYLETTS2_SCRIPT`) depending on `tts.engine`, pipes the raw PCM into `paplay`/`ffplay` depending on platform. Tracks a generation counter so a new `speak()` call can cleanly kill and wait out the previous playback chain before starting, instead of racing it for the audio sink.

- **`config/`**: `config.json` + `index.js`, hot-reloaded via `fs.watch` so tuning VAD thresholds, the wake words list, or the TTS sink doesn't require a restart.

- Both consumers (`voiceAssistant/index.js`, `vrchatBot/audiostuff/audioLoop.js`) just subscribe to `stt.on('wake', ...)` / `stt.on('speech', ...)` and call `tts.speak(...)`, the actual mic/VAD/whisper/TTS plumbing lives entirely in this module.
<br>

## Minecraft

### Neoforge (Arclight server)

###### `src/ai/minecraft/neoforgemod-way/`

#### **State Machine**

###### `src/ai/minecraft/neoforgemod-way/state-machine/`

- The main file is `bot.js`, which handles communication between the NodeJS server and the Java client via the `mcSend(type, data = {})` function:

  - **"chat"**: Displays a message in-game.
  - **"request_ability_data"**: Requests the data of all the abilities in the server. Returns the **"ability_data"** message.
  - **"get_bindings"**: Requests the current bindings of the bot. Returns the **"bindings_update"** message.
  - **"run_command"**: Runs the specified in-game command.
  - **"move_to"**: Moves to the specified coordinates.
  - **"move"**: Moves towards the specified direction.
  - **"stop"**: Stop the bot movement.
  - **"craft"**: Requests crafting the specified item. Returns **"craft_result"**.
  - **"look_at"**: Look towards the specified coordinates.
  - **"attack"**: Simulates left click, optionally swaps to the specified slot.
  - **"break"**: Breaks the block at the target coordinates, or if instead a type of block is sent, the nearest one of the same type is located.
  - **"cancel_break"**: When exiting mining state, cancels any of the tasks  started by `MiningManager.java` and resets state.
  - **"use"**: Simulates right click, optionally swaps to the specified slot.
  - **"drop"**: Drops an item, optionally swaps to the specified slot.
  - **"jump"**: Jumps.
  - **"sneak"**: Simulates shifting.
  - **"sprint"** and **"unsprint"**: Activates/cancels sprint.
  - **"hotbar"**: Swaps to the specified slot.
  - **"spawn"** Handles spawning/respawning.
  - **"look_dir"**: Offsets current look direction.
  - **"fire_pk_event"**: Handles firing events that ProjectKorra listens to, to effectively trigger abilities:

    - **"click"**: Calls `PlayerAnimationEvent`
    - **"sneak"** and **"unsneak"**: Handles sneaking.
    - **"slot"**: Handles swapping slot.
   
  - **"get_lily_state"**: Request data of the bot such as HP, coordinates, armor, food level...
  - **"get_environment_scan"**: Request data of the environment around the bot, such as biome, entities, unique blocks...
  - **"get_source_block"**: Finds the closest valid source block specified. Returns **"source_block"**.
  <br>

- The way the bot's state is managed is via a "state machine". The main file is `StateController.js` which contains a bunch of helper functions, ticks the current state, dispatches in-game actions and updates live in-game data. All states are smoothly transitioned to u sing the `transitionTo(stateName, payload = {}))` function, which can either make the bot re-enter the state with a new payload (data), or stop the current state and enter a new one.
<br>

#### **States** 

###### `states/`

  - **`AttackingSatate.js`**: Activated when a hostile mob gets too close, or via tool calling. Tracks the mob, handles look direction and attacking.
  - **`FollowingState.js`**: A simple state that handles following the player. Handles look direction and movement.
  - **`IdleState.js`**: Idle state, triggered when no condition for any other state is met. `onTick()` Checks different conditions to transtion to any other state.
  - **`MiningState.js`**: Handles mining. The `NodeJS` side only knows when the bot is busy mining, and when it has finished, the Java mod handles everything else.
  - **`RecoveringState.js`**: When low HP, the bot will automatically run towards the closes player.
  - **`DuelingState.js`**: Activated using the duel command. This state handles dueling with ProjectKorra abilities. Handles moving and look direction, block sourcing, when to send the next duel prompt, handles the ability queue, etc... Periodically requests all the necessary data to the Java mod such as coordinates, abilities binded, HP...
<br>

#### **Helpers**

###### `helpers/`

  - **`comboExecutor.js`**: Handles executing the array of abilities returned by the AI when prompted in the dueling state. `data/` Contains all the data of the server's current abilities and all the required manually-inputted information to properly executed them. Example:

      ```json
          {
              "name": "FireKick",
              "description": "[ATTACK] close range.",
              "bindsRequired": ["FireBlast"],
              "actions": ["swap:slot:FireBlast","click:left:2", "sneak:hold:1:continue", "click:left:1"],
              "cooldown": 5000,
              "range": 10,
              "actionsTime": [ 100, 250, 250, 400, 250]
          },                
      ```

  - **"bindsRequired"**: For combos only, is an array containig all the abilities required for the AI to have binded to execute the combo.
  - **"actions"**: It is the list of actions that need to be executed to perform the ability or combo, with a concrete format:

    - **"swap:slot:\<Ability>"**: Swaps to the slot on which that ability is binded. Blocking.
      
    - **"locklook"**: Locks the look direction of the bot to the current look direction. Non-blocking.
      
    - **"source:\<blocks>:<dist>"**: Finds the nearest valid source block. Non-blocking.
      
    - **"click:left|right[:N]"**: Left or right click N times. Blocking per click.
      
    - **"sneak:hold|tap[:N][:cont]"**: Hold or tap sneak, N times. Blocking by default, unless :cont is used.
      
    - **"jump[:N]"**: Jumps N times. Blocking per jump.
      
    - **"forward|back|left|right"**: Forces direction for the duration of the acion. Blocking.
      
    - **"wait"**: Sleep for the duration of the action. Blocking.
      
    - **"look:\<dir>:\<deg>"**: Offsets look direction. Blocking.
      
    - **"stop"**: Stops movement for the duration of the action. Blocking.

  - **"actionsTime"**: The time in ms that each action takes. Note that if an action is specified to be executed more than once using :N, then you will have to specifiy an action time for each.
  
> Blocking means the queue of actions will be paused until the current action finishes. Non-blocking means the queue will continue to be drained while the current action is being executed.
<br>

- **`survivalLoop.js`**: Periodically sends a prompt to the bot with all the necessary information for the bot to decide which action to take.
- **`sneak.js`**: Handles the sneak timing.
- **`movement.js`**: Handles moving to the target location. Re sends "move_to" if the target moves too far.
<br>

#### **Prompt Builders** 

###### `prompt-builders/`

  - **`duelPromptBuilder.js`**: Builds the prompt for dueling with ProjectKorra abilities with data such as cooldown, range, velocity, and short recommendations depending on the situation.
  - **`suvivalPrompBuilder.js`**: Builds the prompt for the survival loop with all the necessary information provided by the `environmentScan` by the Java mod. Formats entity data, block data, etc...
<br>    
  
### Mineflayer (wip)

###### `src/minecraft/mineflayer/`

- A second, alternate Minecraft backend for cracked/plugin servers, using [mineflayer](https://github.com/PrismarineJS/mineflayer) instead of a server-side mod. Mutually exclusive with the Neoforge backend (`modded` vs `mineflayer` flags), can't run both at once.

- Ports the same `StateController` architecture 1:1 in spirit: `IDLE → RECOVERING → ATTACKING → FOLLOWING`, same priority order, same `survivalLoop.js`/`survivalPromptBuilder.js` shape and `ctx` property names, so existing persona/prompt work transfers over mostly unchanged.

- `MovementHelper` wraps `mineflayer-pathfinder` instead of the mod's custom `move_to`; `SneakHelper` drives `bot.setControlState('sneak', ...)` behind the same `pulse()`/`hold()`/`cancelHold()` API. `MiningState` now issues real `bot.dig()` calls instead of a break event + callback round-trip.

- The **dueling/combo system is entirely dropped** here, still wip.

- New over the mod version: `helpers/whisper.js` detects incoming private messages (mineflayer's built-in `whisper` event plus a regex fallback for plugins that format `/msg` differently) and `StateController.setLastUserMessage(player, message, channel)` tracks which channel (`'public'`/`'whisper'`) a message came in on, so replies route back the same way (`/msg` stays private, public chat stays public) without needing her name mentioned first for whispers.

## Vtubing (early wip)

###### `src/vtubing/`

- Lets the AI control a VTube Studio avatar and read a YouTube live chat while doing so, active under the `vtube` flag.

- **`VTSClient.js`**: A persistent authenticated WebSocket connection to VTube Studio's own local API. Handles the one-time plugin authorization handshake, caches the resulting token to `vts_token.json` so it isn't asked again on every restart, and exposes hotkey listing/triggering which `VtubeToolExecutor` calls into.

- **`youtube/liveClient.js`**: Polls a live stream's chat via the YouTube Data API (`YOUTUBE_API_KEY` + `YOUTUBE_VIDEO_ID`), calling back per new message. Poll interval is floored server-side so a misconfigured value can't burn API quota.

- **`youtube/chatBuffer.js`**: Batches incoming chat messages instead of forwarding each one individually, flushing to Lily once both a batch size and a cooldown window are satisfied (sliding window if the buffer fills before the cooldown elapses), so she comments on a digest of chat rather than replying to every single line.

- **`vtubeConfig.js`**: Shared tunables (batch size, cooldown, poll floor) for the above.

## VRChat 

###### `src/vrchatBot/`

- The VRChat surface: an OSC bridge to control a VRChat avatar plus a voice loop, meant to run following the user around in-game. Kept intentionally separate from the main brain's persistent memory/tools (no tool calls here beyond what's wired through `ai`), active under the `vrchat` flag.

- **`vrchat/osc.js`**: Low-level OSC send/receive to VRChat's local OSC endpoints (movement inputs, avatar parameters, chatbox).

- **`bot/follow.js`**: Reads proximity values from the 5 Contact Receiver parameters set up on the bot's avatar (center/front/back/left/right) and drives movement input addresses toward the player, with hysteresis between a start and stop range so it doesn't flap on/off right at the follow threshold.

- **`bot/avatarActions.js`**: Fires default VRChat expressions/animations over OSC, either from a tool call or directly via the 1-8 CLI keys (bypassing the brain, for testing).

- **`bot/perception.js`**: Screenshot capture for "what do you see" style prompts, platform-specific command (`spectacle`/`ffmpeg`+gdigrab/`gnome-screenshot`) picked from the `PLATFORM` config value, since there's no reliable way to sniff KDE vs GNOME from Node.

- **`vrchat/vrchatBridge.js`**: Handles auto-accepting invites from trusted user IDs, and the Steam/Proton launch plumbing on Linux.

- **`server.js`**: Exposes a small web UI on port 3030 as a text-based alternative to talking to the bot, optionally attaching a screenshot, replies still land in-game either way.

### Listening and voice

- Voice input/output for VRChat reuses the shared `STTS` module (see [STTS](#stts)) rather than having its own pipeline: `audiostuff/audioLoop.js` subscribes to `stt.on('wake', ...)` for direct replies and `stt.on('speech', ...)` to accumulate an ambient buffer.

- **Butt-in**: on a randomized timer (`BUTTIN_MIN_MS`-`BUTTIN_MAX_MS`), the accumulated ambient buffer (audio picked up even without a wake word) gets sent to Lily as a one-off "ambient" prompt; she can choose to reply or return `NONE` to stay quiet. This is what lets her occasionally comment on conversation she wasn't directly addressed in, same idea as Discord's butt-in chance.

- `chatbox.js` pushes whatever she's currently doing/saying to VRChat's in-game chatbox/status indicator so it's visible to other players even before/without an audio line.

# Other functionalities

## VSC Integration

###### `src/coding/`

- Runs a small Express server (`continue-bridge.js`, `BRAIN_PORT`, default 8767) that speaks the OpenAI chat-completions format expected by the [Continue](https://continue.dev/) VS Code extension, so Continue's chat/edit roles both talk to the same shared `ai` instance as everything else instead of a generic API.

- Two roles are handled differently: the **chat/agent role** (tool-use capable) gets Lily's persona; the **apply role** (the one that writes file content straight to disk with no tool call in between) is locked to a strict code-merging-only system prompt (`codeEditShared.js`'s `CODE_SYSTEM_PROMPT`) since there's no tool-call layer to intercept a bad response on that path.

- **Overwrite guard** (`codeEditShared.js`): before trusting an apply-role rewrite, checks the new content isn't a suspiciously large shrink of the original (`maxShrinkRatio`) and doesn't contain stub bodies like `{ ... }` in place of real code, both are telltale signs of a lazily-hallucinated rewrite rather than the actual requested edit. Shared with the voice "edit this file" tool path so both call sites enforce the same safety checks.

- **`tavily-mcp-server.js`**: A standalone stdio MCP server exposing an image-search tool backed by the Tavily API, wired into Continue's `mcpServers` config so image search works from inside VS Code the same way it does elsewhere.

## Pi dev

###### `src/pidev-bridge/`

- `pidev-bridge.js` runs its own small Express server (`PIDEV_BRIDGE_PORT`, default 3100) exposing an OpenAI-compatible `/v1/chat/completions` endpoint, used as the model backend for the `pi` coding-agent CLI (running in its own terminal, not spawned by the brain).

- Deliberately spins up its **own fresh `Lily` instance** (not the shared `ai` from `bot.js`), on its own channel id (`"pi-dev"`), so Pi gets an isolated memory/history lane instead of bleeding into Discord/Minecraft context.

- A persona-only excerpt of the main system prompt (no tool defs, no Minecraft-specific instructions) is appended after Pi's own system prompt, so Pi's built-in tool/dev instructions stay fully intact and Lily just rides on top as a personality layer, replies get wrapped in-character but the actual file/OS operations are handled entirely by Pi's own tools, the bridge never calls into Pi directly.
