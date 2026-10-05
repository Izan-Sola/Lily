# Lily's brain - Overview

###### Last edit: October 2026 (unfinished)

# Index

- [Systems](#systems)

  - [Core (`Lily`)](#core-lily)

  - [Startup and services](#startup-and-services)

  - [Configuration](#configuration)

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

  - [Voice assistant](#voice-assistant)

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

## Core (`Lily`)

###### `src/ai/`

- `Lily.js` is the AI core: per-channel history and raw buffers, prompt building, and the **tool loop** (`runToolLoop`). It knows nothing about Discord, Minecraft or any other surface; those are wired in from outside (see [Startup and services](#startup-and-services)).

- **Construction**: one options object, `new Lily({ overrides, mcSend, vtsClient, modules, stts, onVoiceGif, getStateController, replyGate })`. `modules` picks which tool executors get built (`minecraft`, `vtube`, `vrchat`, `stts`, `browser`), `overrides` layers over `config.json` for that instance (e.g. `{ model }`). Late wiring is done with `setMcSend`, `setVtsClient`, `setBrowserClient`, `setStateController` and `setReplyGate`.

- **`TurnContext`** (`TurnContext.js`): everything one pass of the loop needs (channel, system prompt override, caller options, images, allowed tools, in-turn `scratch` messages, repeat tracker, per-tool use counts, pending GIF, injected memory block). It's created in `handleMessage` / `resumeToolLoop` and passed down, instead of living in per-channel Maps on the class.

- **Tool loop**: each round asks the model and handles one of five response shapes, each in its own small method:

  - **Foreign (Continue) tool call** (`_handoff`): forwards the first call to the caller after the risk check.
  - **Native tool call** (`_nativeRound`): runs the calls, results go back as `tool` messages.
  - **Embedded `<tool_call>` XML/JSON** (`_embeddedRound`): same execution path as native, results go back as `<tool_response>`.
  - **Malformed call**: marks the turn flawed and nudges the model to use the right format.
  - **Narrated tool** (`_narratedRound`): the model described a tool instead of calling it; nudge, or force a reply once the narration budget runs out.

  Native and embedded rounds share `_runCalls` (per-turn caps, repeat guard, GIF capture) and `_afterToolRound` (screenshots, hard-stop check, Minecraft-action check). Every turn ending goes through `_reply` / `_end`, so the history push, logging, YouTube TTS and voice GIF hook live in one place. When tools are exhausted, `_finishWithoutTools` retries with tools removed until it gets a natural reply.

- **Reply gate**: `replyGate` is a `() => string | null` hook; if it returns text, the model is skipped and that text is the reply. `start.js` uses it to stop Lily answering while she's in a duel, so the core doesn't need to know about Minecraft states.

- **Modules split out of `Lily`**:

  - **`channelLocks.js`**: one in-flight turn per channel (`run` waits, `tryRun` skips if busy).
  - **`llmClient.js`**: a single chat-completion call plus response normalisation (strips `<think>`/`<answer>`, falls back to the reasoning field).
  - **`memory/summarizer.js`**: periodic conversation summaries and batched "observe" summaries, stored as episodic memories.
  - **`flawlessCapture.js`**: training-data capture (see [below](#automatic-training-data-generation)).
  - **`blogPush.js`**: fire-and-forget history push to the blog.
  - **`utils.js`**: input sanitising, repeat-call tracker, embedded tool-call parser.
<br>

## Startup and services

###### `src/start.js`, `src/startUtils.js`

- `start.js` is the composition root. It parses the flags once (`getRunConfig()`), builds the single `Lily` instance, and then starts everything from a `SERVICES` registry. Nothing imports `start.js`; the `ai` instance and the Discord client are passed in where they're needed (`createBot({ ai })`, `startVoiceAssistant({ ai, getDiscordClient })`), so there are no circular imports.

- Each service is `{ name, label, phase, enabled, needs, start, stop }`:

  - **`phase`**: `early` services start before Discord logs in, `ready` services start once it has (or immediately when the `discord` flag isn't used).
  - **`enabled`**: a function of the run config, so a service only starts if its flag is on.
  - **`needs`**: names a service that must have started first (e.g. the survival loop needs Minecraft).
  - **`stop`**: called on shutdown, in reverse start order.

  The same list drives the startup banner, startup and shutdown. A service that fails to start is logged and skipped; it doesn't take the others down.

- **Current services**: control panel, STTS, voice assistant, VTube Studio, YouTube chat, Minecraft, survival loop, n8n triggers, VRChat, coding (Continue) bridge, Tavily MCP server, browser bridge, Pi-dev bridge, n8n bridge, approval callbacks (Discord) and the n8n notify server (Discord).

- **Adding a service**: add an entry to `SERVICES` (plus a `label` if it should appear in the banner). Nothing else needs touching.

- `startUtils.js` holds `parseFlags`, `getConfigFromFlags`, `getRunConfig` (parsed once and cached), `lilyOptionsFor` (maps the run config to Lily's `modules`/`stts` options), `describeConfig` and `getToolConfig`. Modules read flag state through `getRunConfig()`, not by re-parsing `process.argv`.
<br>

## Configuration

###### `src/config/loader.js`

- All JSON config files go through one loader, `createConfig(file, { defaults, watch, strict, name })`. It parses each file once and caches it, reloads on change via `fs.watch` (debounced, re-armed after editors rename files), and deep-merges the file over in-code defaults. If a saved file has invalid JSON, the previous values are kept and the error is logged. `strict: true` makes a missing/unreadable file throw instead (used by the risk classifier so it fails closed).

- Config files using it:

  - `src/ai/config.json` via `ai/config.js` (`getConfig()`, `getSection(name)`, `getOwnerId()`). Section defaults live in `SECTION_DEFAULTS` in that file.
  - `src/minecraft/config.json` via `minecraft/config.js` (`getAppConfig()`, `loadAppConfig()`).
  - `src/vtubing/vtube_config.json` via `vtubing/vtubeConfig.js`.
  - `src/vrchatBot/util/config.json` and `src/STTS/config/config.json` (exported as live-reading proxies).
  - `src/ai/tools/riskyActionsManagement/riskConfig.json`.

- Values are shared cached objects, so treat them as **read-only**; copy before modifying.

- The owner's Discord ID is `discord.discordUserID` in `ai/config.json` (read with `getOwnerId()`).

- `utils/config.js` is separate: it only holds env-based values (token, client ID, banned users).
<br>

## Tools

###### `src/ai/tools/`

- Each main functionality has its own `ToolExecutor` which contains the tool definitions for that specific functionality, its own code logic, and tool functions. Combining functionalities will make each's executor tools available globally. Note that some tools might be filtered in certain parts of the code depending on the source of the user message to avoid misuse.

- The main file is `toolRouter.js` which can initialize each independent tool executor for each distinct functionality. It also includes a bunch of helper functions, and routes shared functions that pertain to a specific `ToolExecutor`.

- **Tool executors**:

  - **`ChatToolExecutor`**: Contains all tools for a conversational discord bot. Memory tools, gif/meme tools and web search. Always built; chat tools are the only executor with a per-turn budget (`toolLimits` in `config.json`).

  - **`MinecraftToolExecutor`**: Contains all the tools for an assistant-like minecraft bot. Mining, dropping, attacking, etc... Built if either the `mineflayer` or `modded` flag is used.

  - **`VtubeToolExecutor`**: Contains all the tools related to vtubing. Triggering expressions, etc... Built if the `vtube` flag is used.

  - **`VrchatToolExecutor`**, **`SttsToolExecutor`**, **`BrowserToolExecutor`**: VRChat avatar actions, voice-assistant/coding tools (screenshots, Pi-dev, Continue), and browser control. Built for the `vrchat`, `stts`/`pidev`/`coding` and `browser` flags respectively.

- Executors can be switched on and off at runtime from the control panel (`setModuleEnabled`).

- **Risky actions** (`riskyActionsManagement/`): commands handed off to Continue are checked by `riskClassifier.js`; anything flagged needs approval (`approvalStore.js`, `approvalRoutes.js`) from the control panel, and Discord is notified when an approval is needed.
<br>

## Modularity

- The brain contains many functionalities, but not all need to be active at the same time. By mixing different flags such as `discord`, `modded`, `vtube` etc... You can choose to enable the functionalities you are actually going to use, anything else will not be enabled.

- Known flags: `discord`, `modded`, `mineflayer`, `bending`, `vtube`, `vrchat`, `coding`, `pidev`, `stts`, `browser`, `n8n`. `modded` and `mineflayer` are alternate Minecraft backends and can't be combined; `bending` only has an effect with `modded`.

- `start.js` handles the brain initiation, checking the flags that were used and enabling each correspondent functionality through the service registry (see [Startup and services](#startup-and-services)).
<br>

## Automatic training data generation

- The brain includes a system (`flawlessCapture.js`, writing through `saveFlawlessTurns.js`) that automatically records as many flawless turns as configured in the `config.json` "trainingTurnWindow", and saves the entire conversation in ShareGPT format into a file named `pending_review.jsonl` to review and use as training data for finetuning. Flawless turns are such turns that execute without a single error or warning caused by the AI messing up. If a turn is not flawless, the entire conversation is dropped, and the count is restarted.
<br>

## Custom logger.

- The brain includes a custom logger used by calling `Logger(message, title)`. Displays a formatted log for visual clarity both in the terminal and, if available, a discord channel. Includes the methods `info`, `warning`, `success` and `error`, each with a different color. "title" helps quickly identifying where each log is from, and the color the type of the log.

# Main functionalities

## Discord

###### `src/discord/`

- The main file is `bot.js`, containing all the logic for the discord bot functionality. Handling replies, voice calls, media... It receives the `Lily` instance from `createBot({ ai })` and exports the Discord `client`.

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

- **`config/`**: `config.json` + `index.js`, hot-reloaded through the shared config loader so tuning VAD thresholds, the wake words list, or the TTS sink doesn't require a restart.

- Both consumers (`voiceAssistant/index.js`, `vrchatBot/audiostuff/audioLoop.js`) just subscribe to `stt.on('wake', ...)` / `stt.on('speech', ...)` and call `tts.speak(...)`, the actual mic/VAD/whisper/TTS plumbing lives entirely in this module.
<br>

## Voice assistant

###### `src/voiceAssistant/`

- Started by the `VOICE` service (needs `STTS`, so only under the `stts` flag). `startVoiceAssistant({ ai, getDiscordClient })` returns `{ stop() }` and **binds nothing at import time**.

- **Local mic**: on `stt.on('wake', ...)` it runs a turn on the voice-assistant channel and speaks the reply with `tts.speak`.

- **Remote devices**: one Express server on `STTS_REMOTE_PORT` (default 8770) serves `/stts` (turns from remote devices, which speak the reply themselves) and the approval routes.

- **GIFs**: if a turn produced a GIF, it's DMed to the owner through the Discord client (resolved lazily, since Discord may log in after this starts).
<br>

## Minecraft

### Neoforge (Arclight server)

###### `src/minecraft/neoforgemod-way/`

- The duel hook in `start.js` (`setStateController` / `setReplyGate`) is only wired for this backend: while the state is `DUELING`, Lily's chat replies are short-circuited with a canned message.

#### **State Machine**

###### `src/minecraft/neoforgemod-way/state-machine/`

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

- The way the bot's state is managed is via a "state machine". The main file is `StateController.js` which contains a bunch of helper functions, ticks the current state, dispatches in-game actions and updates live in-game data. All states are smoothly transitioned to using the `transitionTo(stateName, payload = {}))` function, which can either make the bot re-enter the state with a new payload (data), or stop the current state and enter a new one.
<br>

#### **States**

###### `states/`

  - **`AttackingState.js`**: Activated when a hostile mob gets too close, or via tool calling. Tracks the mob, handles look direction and attacking.
  - **`FollowingState.js`**: A simple state that handles following the player. Handles look direction and movement.
  - **`IdleState.js`**: Idle state, triggered when no condition for any other state is met. `onTick()` Checks different conditions to transition to any other state.
  - **`MiningState.js`**: Handles mining. The `NodeJS` side only knows when the bot is busy mining, and when it has finished, the Java mod handles everything else.
  - **`RecoveringState.js`**: When low HP, the bot will automatically run towards the closest player.
  - **`DuelingState.js`**: Activated using the duel command. This state handles dueling with ProjectKorra abilities. Handles moving and look direction, block sourcing, when to send the next duel prompt, handles the ability queue, etc... Periodically requests all the necessary data to the Java mod such as coordinates, abilities bound, HP...
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

  - **"bindsRequired"**: For combos only, is an array containing all the abilities required for the AI to have bound to execute the combo.
  - **"actions"**: It is the list of actions that need to be executed to perform the ability or combo, with a concrete format:

    - **"swap:slot:\<Ability>"**: Swaps to the slot on which that ability is bound. Blocking.

    - **"locklook"**: Locks the look direction of the bot to the current look direction. Non-blocking.

    - **"source:\<blocks>:<dist>"**: Finds the nearest valid source block. Non-blocking.

    - **"click:left|right[:N]"**: Left or right click N times. Blocking per click.

    - **"sneak:hold|tap[:N][:cont]"**: Hold or tap sneak, N times. Blocking by default, unless :cont is used.

    - **"jump[:N]"**: Jumps N times. Blocking per jump.

    - **"forward|back|left|right"**: Forces direction for the duration of the action. Blocking.

    - **"wait"**: Sleep for the duration of the action. Blocking.

    - **"look:\<dir>:\<deg>"**: Offsets look direction. Blocking.

    - **"stop"**: Stops movement for the duration of the action. Blocking.

  - **"actionsTime"**: The time in ms that each action takes. Note that if an action is specified to be executed more than once using :N, then you will have to specify an action time for each.

> Blocking means the queue of actions will be paused until the current action finishes. Non-blocking means the queue will continue to be drained while the current action is being executed.
<br>

- **`survivalLoop.js`**: Periodically sends a prompt to the bot with all the necessary information for the bot to decide which action to take. Started by the `SURVIVAL` service (modded backend only) and stopped through its `stop()`.
- **`sneak.js`**: Handles the sneak timing.
- **`movement.js`**: Handles moving to the target location. Re sends "move_to" if the target moves too far.
<br>

#### **Prompt Builders**

###### `prompt-builders/`

  - **`duelPromptBuilder.js`**: Builds the prompt for dueling with ProjectKorra abilities with data such as cooldown, range, velocity, and short recommendations depending on the situation.
  - **`survivalPromptBuilder.js`**: Builds the prompt for the survival loop with all the necessary information provided by the `environmentScan` by the Java mod. Formats entity data, block data, etc...
<br>

### Mineflayer (wip)

###### `src/minecraft/mineflayer/`

- A second, alternate Minecraft backend for cracked/plugin servers, using [mineflayer](https://github.com/PrismarineJS/mineflayer) instead of a server-side mod. Mutually exclusive with the Neoforge backend (`modded` vs `mineflayer` flags), can't run both at once.

- Ports the same `StateController` architecture 1:1 in spirit: `IDLE → RECOVERING → ATTACKING → FOLLOWING`, same priority order, same `survivalLoop.js`/`survivalPromptBuilder.js` shape and `ctx` property names, so existing persona/prompt work transfers over mostly unchanged.

- `MovementHelper` wraps `mineflayer-pathfinder` instead of the mod's custom `move_to`; `SneakHelper` drives `bot.setControlState('sneak', ...)` behind the same `pulse()`/`hold()`/`cancelHold()` API. `MiningState` now issues real `bot.dig()` calls instead of a break event + callback round-trip.

- The **dueling/combo system is entirely dropped** here, still wip. `start.js` doesn't inject a state controller or reply gate for this backend yet.

- New over the mod version: `helpers/whisper.js` detects incoming private messages (mineflayer's built-in `whisper` event plus a regex fallback for plugins that format `/msg` differently) and `StateController.setLastUserMessage(player, message, channel)` tracks which channel (`'public'`/`'whisper'`) a message came in on, so replies route back the same way (`/msg` stays private, public chat stays public) without needing her name mentioned first for whispers.

## Vtubing (early wip)

###### `src/vtubing/`

- Lets the AI control a VTube Studio avatar and read a YouTube live chat while doing so, active under the `vtube` flag (`VTUBE` and `YOUTUBE` services).

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

- Runs a small Express server (`continue-bridge.js`, `BRAIN_PORT`, default 8767) that speaks the OpenAI chat-completions format expected by the [Continue](https://continue.dev/) VS Code extension, so Continue's chat/edit roles both talk to the same shared `ai` instance as everything else instead of a generic API. Started by the `CODING` service, with the Tavily MCP server (`TAVILY`) alongside it.

- Two roles are handled differently: the **chat/agent role** (tool-use capable) gets Lily's persona; the **apply role** (the one that writes file content straight to disk with no tool call in between) is locked to a strict code-merging-only system prompt (`codeEditShared.js`'s `CODE_SYSTEM_PROMPT`) since there's no tool-call layer to intercept a bad response on that path.

- Tools that Continue owns are handed back to it by the tool loop (the "foreign" call path), and a later `resumeToolLoop` call continues the turn once Continue returns the result.

- **Overwrite guard** (`codeEditShared.js`): before trusting an apply-role rewrite, checks the new content isn't a suspiciously large shrink of the original (`maxShrinkRatio`) and doesn't contain stub bodies like `{ ... }` in place of real code, both are telltale signs of a lazily-hallucinated rewrite rather than the actual requested edit. Shared with the voice "edit this file" tool path so both call sites enforce the same safety checks.

- **`tavily-mcp-server.js`**: A standalone stdio MCP server exposing an image-search tool backed by the Tavily API, wired into Continue's `mcpServers` config so image search works from inside VS Code the same way it does elsewhere.

## Pi dev

###### `src/pidev-bridge/`

- `pidev-bridge.js` runs its own small Express server (`PIDEV_BRIDGE_PORT`, default 3100) exposing an OpenAI-compatible `/v1/chat/completions` endpoint, used as the model backend for the `pi` coding-agent CLI (running in its own terminal, not spawned by the brain). Started by the `PIDEV` service.

- Deliberately spins up its **own fresh `Lily` instance** (`new Lily()`, not the shared `ai` built in `start.js`), on its own channel id (`"pi-dev"`), so Pi gets an isolated memory/history lane instead of bleeding into Discord/Minecraft context.

- A persona-only excerpt of the main system prompt (no tool defs, no Minecraft-specific instructions) is appended after Pi's own system prompt, so Pi's built-in tool/dev instructions stay fully intact and Lily just rides on top as a personality layer, replies get wrapped in-character but the actual file/OS operations are handled entirely by Pi's own tools, the bridge never calls into Pi directly.
</document_content>
