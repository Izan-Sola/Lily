# Lily's brain - Overview

###### Last edit: September 2026 (unfinished)

# Index

- [Main Systems](#main-systems)

  - [Tools](#tools)
    - [Tool executors](#tool-executors)

  - [Modularity](#modularity)

  - [Automatic training data generation](#automatic-training-data-generation)

- [Main functionalities](#main-functionalities)

- [Other functionalities](#other-functionalities)
<br>

# Main systems

## Tools

###### `src/ai/tools/`

- Each main functionality has its own `ToolExecutor` which contains the tool definitions for that specific functionality, its own code logic, and tool functions. Combining functionalities will make each's executor tools available globally. Note that some tools might be filtered in certains part of the code depending on the source of the user message to avoid misuse.

- The main file is `toolRouter.js` which can initialize each independent tool executor for each distinct functionality. It also includes a bunch of helper functions, and routes shared functions that pertain to a specific `ToolExecutor`.

- **Tool executors**:

  - **`ChatToolExecutor`**: Contains all tools for a conversational discord bot. Memory tools, gif/meme tools and web search. If `discord` flag is used, this executor will be enabled.

  - **`MinecraftToolExecutor`**: Contains all the tools for an assitant-like minecraft bot. Mining, dropping, attacking, etc... If either the `mineflayer` or `modded` flag is used, this executor will be enabled.

  - **`VtubeToolExecutor`**: Contains all the tools related to vtubing. Triggering expressions, etc... If the `vtube` flag is used, this executor will be enabled.

## Modularity

- The brain contains many functionalities, but not all need to be active at the same time. By mixing different flags such as `discord`, `modded`, `vtube` etc... You can choose to enable the functionalities you are actually going to use, anything else will not be enabled.

- The `start.js` file handles the brain initiation, checking the flags that were used and enabling each correspondent functionality.

- `startUtils.js` contains a bunch of helper functions to check which modes are enabled or which tools to use.

## Automatic training data generation

- The brain inlcudes a system (`saveFlawlessTurns.js`) to automatically records as many flawless turns as configurated in the `config.json` "trainingTurnWindow", and saves the entire conversation in ShareGPT format into a file named `pending_review.jsonl` to review and use as training data for finetuning. Flawless turns are such turns that execute without a single error or warning caused by the AI messing up. If a turn is not flawless, the entire conversation is dropped, and the count is restarted.
<br>

# Main functionalities

## Discord

###### `src/discord/`

- The main file is `discordBot.js`, containing all the logic for the discord bot functionality. Handling replies, voice calls, media...

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

## Minecraft

### Neoforge (Arclight server)

###### `src/ai/minecraft/neoforgemod-way/`

#### State Machine

###### `src/ai/minecraft/neoforgemod-way/state-machine/`

- The way the bot's state is managed is via a "state machine". The main file is `StateController.js` which contains a bunch of helper functions, ticks the current state, dispatches in-game actions and updates live in-game data. All states are smoothly transitioned to u sing the `transitionTo(stateName, payload = {}))` function, which can either make the bot re-enter the state with a new payload (data), or stop the current state and enter a new one.

- **States**:

###### `src/ai/minecraft/neoforgemod-way/state-machine/states/`

  - **`AttackingSatate.js`**: Activated when a hostile mob gets too close, or via tool calling. Tracks the mob, handles look direction and attacking.
  - **`FollowingState.js`**: A simple state that handles following the player. Handles look direction and movement.
  - **`IdleState.js`**: Idle state, triggered when no condition for any other state is met. `onTick()` Checks different conditions to transtion to any other state.
  - **`MiningState.js`**: Handles mining. The `NodeJS` side only knows when the bot is busy mining, and when it has finished, the Java mod handles everything else.
  - **`RecoveringState.js`**: When low HP, the bot will automatically run towards the closes player.
  - **`DuelingState.js`**: Activated using the duel command. This state handles dueling with ProjectKorra abilities. Handles moving and look direction, block sourcing, when to send the next duel prompt, handles the ability queue, etc... (s

- **Helpers**:

###### `src/ai/minecraft/neoforgemod-way/state-machine/states/helpers`

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

    - **"swap:slot:<Ability>"**: Swaps to the slot on which that ability is binded. Blocking.
    - **"locklook"**: Locks the look direction of the bot to the current look direction. Non-blocking.
    - **"source:<blocks>:<dist>"**: Finds the nearest valid source block. Non-blocking.
    - **"click:left|right[:N]"**: Left or right click N times. Blocking per click.
    - **"sneak:hold|tap[:N][:cont]"**: Hold or tap sneak, N times. Blocking by default, unless :cont is used.
    - **"jump[:N]"**: Jumps N times. Blocking per jump.
    - **"forward|back|left|right"**: Forces direction for the duration of the acion. Blocking.
    - **"wait"**: Sleep for the duration of the action. Blocking
    - **"look:<dir>:<deg>"**: Offsets look direction. Blocking.
    - **"stop"**: Stops movement for the duration of the action. Blocking.

> Blocking means the queue of actions will be paused until the current action finishes. Non-blocking means the queue will continue to be drained while the current action is being executed.

### Mineflayer (wip)


## Vtubing (early wip)

## VRChat (currently unwired)

# Other functionalities

## VSC Integration

## Pi dev
s
