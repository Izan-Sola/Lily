# Lily - Overview 
###### Last edit: September 2026 (unfinished)

## Index

- [Lily - Overview](#lily---overview)
          - [Last edit: September 2026 (unfinished)](#last-edit-september-2026-unfinished)
  - [Index](#index)
  - [Main systems](#main-systems)
    - [Tools](#tools)
          - [`src/ai/tools/`](#srcaitools)
    - [Modularity](#modularity)
    - [Automatic training data generation](#automatic-training-data-generation)
  - [Main functionalities](#main-functionalities)
    - [Discord](#discord)
          - [`src/discord/`](#srcdiscord)
      - [Features:](#features)
      - [Commands:](#commands)

## Main systems


### Tools 
###### `src/ai/tools/`

- Each main functionality has its own `ToolExecutor` which contains the tool definitions for that specific functionality, its own code logic, and tool functions. Combining functionalities will make each's executor tools available globally. Note that some tools might be filtered in certains part of the code depending on the source of the user message to avoid misuse.

- The main file is `toolRouter.js` which can initialize each independent tool executor for each distinct functionality. It also includes a bunch of helper functions, and routes shared functions that pertain to a specific `ToolExecutor`.

- **Tool executors**:

  - **`ChatToolExecutor`**: Contains all tools for a conversational discord bot. Memory tools, gif/meme tools and web search. If `discord` flag is used, this executor will be enabled.

  - **`MinecraftToolExecutor`**: Contains all the tools for an assitant-like minecraft bot. Mining, dropping, attacking, etc... If either the `mineflayer` or `modded` flag is used, this executor will be enabled.

  - **`VtubeToolExecutor`**: Contains all the tools related to vtubing. Triggering expressions, etc... If the `vtube` flag is used, this executor will be enabled.


### Modularity

- The brain contains many functionalities, but not all need to be active at the same time. By mixing different flags such as `discord`, `modded`, `vtube` etc... You can choose to enable the functionalities you are actually going to use, anything else will not be enabled.

- The `start.js` file handles the brain initiation, checking the flags that were used and enabling each correspondent functionality.

- `startUtils.js` contains a bunch of helper functions to check which modes are enabled or which tools to use.


### Automatic training data generation

- The brain inlcudes a system (`saveFlawlessTurns.js`) to automatically records as many flawless turns as configurated in the `config.json` "trainingTurnWindow", and saves the entire conversation in ShareGPT format into a file named `pending_review.jsonl` to review and use as training data for finetuning. Flawless turns are such turns that execute without a single error or warning caused by the AI messing up. If a turn is not flawless, the entire conversation is dropped, and the count is restarted.
<br>

## Main functionalities

### Discord

###### `src/discord/`


  - The main file is `discordBot.js`, containing all the logic for the discord bot functionality. Handling replies, voice calls, media...


#### Features:

  - Will respond to messages when pinged or replied to.
  - Has a very small chance to butt-in and reply to someone when not directly addressed.
  - Can send gifs and memes.
  - Can see images sent and videos (just a few frames here and there).
  - Can send audios and join calls.

  #### Commands:

  - **/aboutlily**: Displays information about Lily
  - **/lilyprefs**: Adjust your preferences such as, disabling pings, voice processing (she wont listen to you in voice calls), disabling spontaneous replies to your messages...
  - **/voice join/leave**: To make her join or leave a voice channel.
  - **/audiolily**: To make her respond with an audio message.



















