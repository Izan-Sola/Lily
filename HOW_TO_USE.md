## HOW TO USE - WIP
##### Pending for an important update due to considerable refactors since im migrating the brain to a dedicated AI server and configuring proper remote access from other devices via tailscale. Oh my i regret making this MD. It is gonna be so fun updating it.
###### If you are interested in having your own VRChat bot or, for whatever reason you want to use this "brain" for your AI, you are free to do so, and you are gonna need to set up a bunch of stuff, plus a bunch of environment variables. I'm not gonna go too much into detail but all this should be helpful enough if you know what you are doing or at least are tech savvy. If not then well fuck around and find out, AI is free and learning is fun. Yes it is a lot of stuff to setup, welcome to local hosting or whatever. Yes some of my code might suck or be messy. Also this is a WIP, so yeah, it is not perfect. You might need to edit some of the provided python scripts, if you use them, just one or two variables.

###### Now theres also a video guide for the VRChat bot: https://www.youtube.com/watch?v=ylGpdnShBqA

## Index

* [Prerequisites](#prerequisites)
  
  * [Local AI set-up](#local-ai-set-up)
    
* [Start modes](#start-modes)
* [RAG Database](#rag-database)
* [Discord app set-up](#discord-app-set-up)
* [Memes and GIFS](#memes-and-gifs)
* [Voice](#voice)
* [Minecraft](#minecraft)

  * [Neoforge way](#neoforge-way)
  * [Mineflayer way](#mineflayer-way)

* [STTS](#stts)

  * [Remote devices](#remote-devices)
  * [Typing anywhere](#typing-anywhere)
  * [Skills](#skills)

* [VSC integration](#vsc-integration)
* [VRChat](#vrchat)

  * [CLI control](#cli-control)
  
* [Pi dev](#pi-dev)
* [VTube Studio](#vtube-studio)
* [Browser control](#browser-control)
* [n8n](#n8n)
* [Control panel](#control-panel)

### Prerequisites:

* Install [Node and NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm#using-a-node-installer-to-install-nodejs-and-npm). Also [Python](https://www.python.org/downloads/).
* Recommended to have a decent GPU (12GB vram atleast) if you want to run both a decent AI model and decent transcriptor tier. If not you are gonna have to sacrifice quality on one of those, or both.
* Note that each functionality is separate from others. So if you want to only run the discord bot, you don't need to set up anything else.

#### Local AI set-up:

* This uses [llama.cpp](https://llama-cpp.com/download/) with --port 11435 to talk to the AI. Personally I use this command and flags to run it:
```
CUDA_VISIBLE_DEVICES=0 /mnt/CA200B97200B8A21/llama.cpp/build/bin/llama-server \
  --model /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/qwen3-vl-8b-instruct.Q6_K.gguf \
  --mmproj /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf \
  --jinja \
  --parallel 1 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --port 11435 \
  -c 12000 \
  --image-min-tokens 1024 \
  --host 0.0.0.0 \
  -ngl 999
```
* Ofc you can change/add/remove any flags, and ofc you should change the model path.

* You can browse models in [Huggingface](https://huggingface.co/models).
* Remember to change the system prompts inside **src/ai/prompts.js**.

### Start modes:

- Everything the brain can do is a **module** (Discord, Minecraft, VTube Studio, STTS, VRChat...). Modules can be started and stopped live from the [control panel](#control-panel), no restart needed. The start flags are just a shortcut to pick which modules start at boot, handy for stuff like pm2. I.E, imagine you want discord and modded minecraft, you would use: `npm run start -- modded discord` or `npm run start -- discord modded`

- All the available flags are : `modded`, `stts`, `mineflayer`, `discord`, `bending`, `vrchat`, `coding`, `pidev`, `vtube`, `browser`, `n8n`.

- Some flags start more than one module: `stts` starts the speech pipeline plus the screenshot and typing tools, `vtube` starts VTube Studio plus YouTube chat, and `n8n` starts the n8n bridge plus the Discord notifications (those need `discord` too, otherwise they are skipped). `modded` and `mineflayer` are alternate Minecraft backends, you can't combine them as flags. From the control panel, turning one on turns the other off.

- You can also start with no flags at all and turn everything on from the control panel (it needs the [control panel variables](#control-panel) set).

All modes are configured through a unified start file (`src/start.js`) that builds the brain, starts the control panel and then starts the modules matching your flags. The brain is designed to be modular so you can mix and match features, at boot with flags or later from the panel.

> **Note:** Bending (ProjectKorra) functionality only works with the NeoForge modded Minecraft approach. Mineflayer mode does not currently support bending abilities. `bending` is a boot flag only, the mod also switches it live when the in-game mode changes.

### [RAG](https://aws.amazon.com/what-is/retrieval-augmented-generation) Database:

* For running the main brain, you are gonna need to run a RAG database with the same endpoints the brain uses. You can use [this](https://drive.google.com/file/d/1L3apugkfy83m9Lx7gJrxesGMYKFp7CdC/view?usp=sharing) script for the database.

### Discord app set-up:

* You are gonna need to sign up in the developer portal https://discord.com/developers/home
* You will need to run `node run deploy` to deploy all the commands globally.
* You are gonna need to add 2 environment variables:

  * **DISCORD_TOKEN**: Your application secret token found in the Bot tab in your application.
  * **CLIENT_ID**: Your bot's user client id. Inside its profile, or by right clicking its pfp in a message, "Copy User ID" (You need to activate developer mode in settings).

### Memes and GIFS:

* You are gonna need one environment variable:

  * **KLIPY_API_KEY**: Holding your [Klipy API](https://docs.klipy.com/getting-started) key.

### Voice

* Both `edge-tts` and `StyleTTS2` can be used for voice.

* The brain currently uses the `speak()` function for the custom voice generation in audios, and `speakEdge()` for, well, using the `edge-tts` voice. If you want to use custom voice for both, or the generic `edge-tts` voice for both, just swap the function calls in the code.

* You are gonna need a few environment variables:

  * **PYTHON_BIN**: Containing the path to your python binary.
  * **EDGE_TTS_BIN**: Containing the path to your `edge-tts` binary.
  * **STYLETTS2_SCRIPT**: Containing the path to the `StyleTTS2` script. I use [this](https://drive.google.com/file/d/1yHyk1kstwbgHXBLlUh3Cnqftlc968WA_/view?usp=sharing) giga vibecoded script to optimize it so my GPU doesn't implode.
  * **VOICE_SAMPLE_PATH**: Containing the path to your voice sample for custom voice generation with `StyleTTS2`.

* For speech transcription, you are going to need `faster-whisper`. The config is hard coded in the `transcribe()` function so go there if you wanna use cpu instead of cuda, a different model tier, etc...

### Minecraft

* Start it with the `modded` or `mineflayer` flag, or from the control panel ("Minecraft (NeoForge mod)" / "Minecraft (Mineflayer)"). Only one backend can run at a time: turning one on in the panel stops the other.

#### Neoforge way:

* The server or world is gonna need to use this mod: https://github.com/Izan-Sola/Lily-Minecraft. Note that to use projectkorra in a modded server, you need Arclight.
* You are also gonna need to download the [SiliconeDolls](https://www.curseforge.com/minecraft/mc-mods/siliconedolls) mod as a dependency.

* If the server does not run in the same local network, you are gonna need to register your own [DuckDNS](duckdns.org) (or any other) sub-domain and edit the config file `lilybridge-common.toml` generated in the config folder of the server:
  ```toml
  [network]
         #WebSocket URL of your Node.js server.
         serverUrl = ""
  ```

* Then, run [Caddy](https://caddyserver.com/) (or any proxy) in your machine with this config:
  ```
  yourURLhere.duckdns.org {
     reverse_proxy 127.0.0.1:8766
  }
  ```

  ###### (if you are a winslop user I think you can do it through a GUI)

* Then you are gonna need to allow the port 8766 in your firewall.

* If the server runs in the same local network, then you can just use `wss://localhost:8766` or `wss://127.0.0.1:8766` as the url.

#### Mineflayer way (early wip)

###### it is messy atm

* You are gonna need 4 environment variables:

  * **MC_SERVER_HOST**: The IP of the cracked server. If you wanted it to play in premium servers, your bot would need its own Microslop and Minecraft account (yes, that means paying for MC again for your bot).
  * **MC_SERVER_PORT**: The port of the server, default 25565.
  * **MC_BOT_USERNAME**: The username of your bot.
  * **MC_AUTH_PASSWORD**: The password your bot will use when attempting to /register and /login

### STTS

* Started with the `stts` flag or the "Speech-to-Text + Voice Assistant" module in the control panel.

* You are gonna need to change a bunch of values in the config:
 
  * **audioMonitorSource**: The microphone/audio input source to monitor. This is system-specific and needs to match the correct source on your machine. Example: `alsa_input.pci-0000_00_1f.3.analog-stereo.99`
  * **whisperSidecarUrl**: URL of the Whisper/STT server. Example: `http://192.168.18.61:8775/transcribe`
  * **wakeWords**: The words/variations that should activate the assistant when wake-word detection is enabled. Change these if your assistant uses a different name.
  * **sileroVadModelPath**: Path to the Silero VAD ONNX model. Make sure this points to the correct location relative to where the STTS process runs.
  * **tts.engine**: The TTS engine being used. This needs to match the engine you have installed/configured. The current setup uses `edge-tts`.
  * **tts.edgeVoice**: The voice ID used by Edge TTS. Choose a voice available for your language/accent.
  * **tts.xttsUrl**: URL of the XTTS server, if using XTTS. Example: `http://192.168.18.61:8790/speak`
  * **tts.platform**: "GNOME", "KDE" or "WINDOWS".
  * **tts.sinkName**: The audio output sink/device used for Lily's voice. This is important if the assistant's voice should be routed to a specific virtual or physical audio device. Example: `lily_voice`
  * **enableWakeWord**: Set this depending on whether you want STTS to wait for a wake word before processing speech.

#### Remote devices

* By default STTS only works on the machine running the brain. [This](https://github.com/Izan-Sola/STTS-Remote-Module) lets any other device (your laptop, for example) talk to the brain through the STTS web app and still use the tools **on that device**. If you ask her to look at your screen from the laptop, she screenshots the laptop, not the server. Same for typing and keys (see [Typing anywhere](#typing-anywhere)), the clipboard, the VSC tools, the popup and `pi`. Oh, and you also need to install the VSC extension located in `src/ai/coding/`.

* Nothing changes for local use. If `brain.url` is left empty in the web app, it keeps working on its own with a local `pi`.

* How it works: the web app records and sends the audio to whisper, then sends the text to the brain (`/stts/turn`). The brain runs the turn like it always does, and whenever a tool needs the device it calls back into the web app (`/device/*`). Edit generation, risk checks and approvals stay on the brain, so the control panel is still where you approve risky commands (they show up as `[on laptop] ...`). The typing approvals are the exception: those popups appear on the device itself.

* Remote tools use the same modules as local ones, so the brain needs `stts` running (flag or panel), plus `pidev` and/or `coding` if you want those tools. The typing tools only need `stts`. A tool is only offered to the AI while its module is running.

##### Brain side

* Run `npm install express` if it isn't already a dependency.
* Add the devices you want to allow in the brain's `config.json`:

```json
  "devices": {
    "laptop": { "url": "http://laptop-ip:3131", "token": "a-long-random-secret" }
  }
```

  * **devices.\<id\>.url**: Where the web app is reachable from the brain (Tailscale/LAN IP and its port).
  * **devices.\<id\>.token**: Shared secret, must match the one in the web app. Use something long and random. Requests with a wrong/missing token are rejected, and unknown device ids never fall back to the server.

* The brain listens for remote turns on port `8770`. Change it with the **STTS_REMOTE_PORT** environment variable.

##### Device side

* Run the STTS web app on the device **inside your desktop session** (not as a system service), otherwise screenshots won't work. Open it as `http://localhost:3131`, not by IP, or the browser will block the mic.
* The device also needs the VS Code companion extension installed (see [VSC integration](#vsc-integration)) if you want the file tools.
* Edit the web app's `config.json`:

  * **whisper.url**: URL of the Whisper server on the brain machine. Example: `http://100.98.234.114:8775/transcribe`
  * **brain.url**: URL of the brain's remote endpoint. Example: `http://100.98.234.114:8770/stts`. Leave it as `null` to run standalone with a local `pi`.
  * **brain.deviceId**: Name of this device. Must match the key used in the brain's `devices`.
  * **brain.token**: The same secret you put in the brain's config. If it's empty, the `/device/*` endpoints stay closed.
  * **brain.timeoutMs**: How long to wait for the brain's reply before giving up. Default `660000`.
  * **companionUrl**: Where the VS Code companion is listening on this device. Default `http://localhost:8768`.
  * **timeouts**: Per-tool timeouts (`screenshotMs`, `askUserMs`, `piMs`, `companionRequestMs`...). Edits apply without a restart.
  * **host** and **deviceHost**: Where the web app listens. Since she can now type on the device, don't leave the UI open to your whole network. Set `host` to `127.0.0.1` (UI only on this machine, use `tailscale serve` for your phone) and `deviceHost` to this device's Tailscale IP (only `/device/*`, token protected, for the brain). If you leave both unset, one listener on `0.0.0.0` serves everything like before.
  * **wake.leadingOnly**: Optional list of wake words that only count at the start of a sentence, i.e `["really", "clearly", "legally"]`. They are common words that whisper often hears as "Lily". Wake words are matched as whole words now, so "lil" no longer fires on "still".
  * **input**: The typing policy, see [Typing anywhere](#typing-anywhere).

* Screenshots on Linux try the tool for your desktop first (GNOME, KDE, grim on Wayland) and then fall back to `scrot`, `maim` and ImageMagick's `import`, so have at least one installed. The input popup needs `zenity` or `kdialog`. Windows works too.

* The web app shows a live feed of what the brain does on the device (screenshots, typing, key presses, clipboard...) as small lines in the log.

##### Ports

* **8770** on the brain (the device connects to it) and **3131** on the device (the brain connects to it). Both directions need to work. Whisper (**8775**) stays as it was. The companion's port (8768) is localhost only, don't open it.
* If you use Tailscale, allow them only on that interface, i.e `sudo ufw allow in on tailscale0 to any port 8770 proto tcp`.

> **Note:** Remote turns are processed one at a time, but they aren't coordinated with a turn from the brain's own mic. If you talk to both at the exact same time, screenshots may get mixed up.

#### Typing anywhere

* She can type into **any** text box on the device you are talking through (browser, Discord desktop app, notes, whatever has focus), read what's in it, rewrite it, press shortcuts and use the clipboard. It works on the brain's own machine and on remote devices, since both use the same device code (`deviceInput.js`).

* Tools: `type_text`, `read_text_field`, `rewrite_text`, `press_keys`, `clipboard` and `use_skill`. They come with the `stts` flag and can be started/stopped on their own from the control panel ("Typing, keys & clipboard tools"). While that module is stopped she doesn't even know the tools exist.

* Text is never typed key by key. It goes to the clipboard, gets pasted with Ctrl+V (Ctrl+Shift+V in terminals) and then your old clipboard is put back. Only text is restored, if you had an image copied it's gone.

* What each device needs:

  * **X11**: `sudo apt install xdotool xclip` and you are done. By far the easiest option, so if you are on Zorin/GNOME and don't care about Wayland, pick the Xorg session at the login screen.
  * **Wayland**: `ydotool` **with its daemon running** (`ydotoold`), plus `wl-clipboard`. `wtype` is tried first but only works on sway/Hyprland style compositors, not GNOME or KDE.
    * Without the daemon ydotool prints "backend unavailable" and does nothing. The brain reports that as an error instead of pretending it typed.
    * Your user needs access to `/dev/uinput` (a udev rule giving it to the `input` group, add yourself to the group and log out and in).
    * Run `ydotoold` as a user service with an explicit socket, i.e `ExecStart=/usr/local/bin/ydotoold --socket-path=%t/.ydotool_socket --socket-perm=0600`, and set `YDOTOOL_SOCKET=/run/user/1000/.ydotool_socket` in the environment of whatever runs the brain / web app (they spawn `ydotool` themselves). The apt package on older Ubuntu/Zorin doesn't ship the daemon, build it from the [repo](https://github.com/ReimuNotMoe/ydotool).
    * **GNOME**: it has no way of telling which window is focused, so install the [Window Calls](https://extensions.gnome.org/extension/4724/window-calls/) extension. Without it she refuses to type, since she can't check the window (`input.blind` overrides that, see below). KDE uses `kdotool`, Hyprland and sway work out of the box.
  * **Windows**: nothing to install, it uses PowerShell. It can't type into elevated (admin) windows and can't press the Windows key.
  * The approval popup needs `zenity` or `kdialog` (or PowerShell on Windows).
  * The process must run inside your desktop session, so `DISPLAY` / `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` are set.

* Safety is enforced on the device, no matter who asks:

  * She never presses Enter by herself. Typing never sends or submits anything. Enter (and ctrl+enter, alt+f4, ctrl+w, ctrl+q, super+l...) needs you to click Allow on a popup.
  * Password managers and banking windows are never touched.
  * Typing into a terminal, or pasting a long text, asks first.
  * If the turn read outside content (web search, browser, a text field, the clipboard), every paste asks first.
  * The focused window is checked again right before pasting, if it changed, nothing happens. The popup auto-denies after 20 seconds.

* Tune it with an optional `input` block, in the brain's `config.json` and in the web app's `config.json` (every key has a default, only add what you change):

```json
  "input": {
    "confirm": "risky",
    "confirmChars": 500,
    "maxChars": 4000,
    "settleMs": 400,
    "blockedWindows": ["keepass", "bitwarden", "paypal"],
    "terminals": ["terminal", "konsole", "kitty"],
    "confirmKeys": ["enter", "ctrl+enter", "alt+f4"],
    "blind": false
  }
```

  * **confirm**: `"risky"` (default) only asks in the cases above, `"always"` asks for everything, `"never"` turns popups off.
  * **confirmChars** / **maxChars**: Pastes longer than the first ask first, longer than the second are refused.
  * **settleMs**: Pause so the app reads the clipboard before it's restored. Raise it if pastes come out wrong on a slow machine.
  * **blockedWindows**: Words matched against the app name and window title. Lists replace the defaults, they don't add to them.
  * **terminals**: Matched against the app name only. These also paste with Ctrl+Shift+V.
  * **confirmKeys**: Key combos that always need approval.
  * **blind**: `true` lets her type even if the focused window can't be identified (always asks).

* In the brain's `config.json` you can also set **maxUsesPerInputTool** (default `12`). Typing tools get a higher per-turn cap than other tools because filling a form takes many small calls.

##### Skills

* Some jobs aren't one action, and the steps depend on what she finds (filling a form, answering a message). Those are skills: markdown playbooks in `src/ai/skills/`. She only sees each skill's name and one-line description, and loads the full steps with `use_skill` when the request matches.
* Included: `fill-form`, `compose-message` and `continue-writing`. Fixed sequences, like "fix the grammar of what I selected", aren't skills, they are the `rewrite_text` tool, which runs read, rewrite and paste in code.
* To add one, drop a `.md` file in the folder, no restart needed:

```
---
name: my-skill
description: one line saying WHEN to use it
---
Short numbered steps, written as instructions for the model...
```

* While a skill is running she can keep calling tools until it's done. Skills should never submit or send anything on their own.



### VSC integration

- Started with the `coding` flag or the "VSCode editing + coding bridge" module in the control panel (it also starts the Tavily MCP server).
- For this I used the extension called `Continue`.
- You need to edit `Continue`'s config, to look something like this:

   ```yaml
    name: Main Config
    version: 1.0.0
    schema: v1
    models:
      - name: a name
        provider: openai
        model: your model
        apiBase: http://localhost:8767/v1
      roles:
        - chat
        - edit
      capabilities:
        - tool_use
      requestOptions:
        timeout: 120000
    mcpServers:
     - name: a name
       type: stdio
       command: node
       args:
         - path/to/src/lilycoding/tavily-mcp-server.js
       env:
         TAVILY_API_KEY: your api key here
  ```

- Also add this tool with this config: <br><br> <img width="577" height="277" alt="image" src="https://github.com/user-attachments/assets/85b52a00-d5fe-4273-9982-adf34dd28677" /> <br>

### VRChat

###### I'm gonna assume you are going to run this on a separate machine and play with the bot, since the program is made for the bot to follow you.

* If you have been linked here directly, you may also want to check this: [Prerequisites](#prerequisites). And remember to change the prompts in `bot/prompts.js`
  
* Download this: https://github.com/Izan-Sola/LilyVrchat on the machine where your bot's game is gonna be running. Start it by running: `node index.js` and `node vrchatBridge.js`. For testing that the custom OSC parameters are working, you can use `node osc-test.js`, walk near your bot and check if the console logs anything. If you are gonna run it connected to the main brain, just run it with the `vrchat` flag (or start the "VRChat" module from the control panel).

* This thingy exposes a website in port 3030 as an alternative for talking to her through there via text (she will still respond in game), with an option to append a screenshot of what she sees. This is not necessary, but if you wanted to make it publicly accesible, then you would need to register a sub-domain with DuckDNS and reverse proxy. The site goes away when the module is stopped.

* Needless to say you are gonna need to allow all the ports mentioned in your firewall. And port 9000 for vrchat OSC stuff.

* You are going to need a second Steam account and VRChat account.

* You are also going to need to use `faster-whisper` for the transcription. You will need to expose a python server for it. I've used [this](https://drive.google.com/file/d/1EO6iuGRIuFvvgNk5T_PBZgZrUMSJ7ejD/view?usp=drive_link) script for it, runs on port 8775.

  * If you want to change the transcription language or the model size, you need to edit the python script, changing MODEL_SIZE without language termination (tiny, small medium...) and changing language here:
    ```python
    segments, info = model.transcribe(
        tmp_path,
        language="es", #en, es, etc...
        beam_size=3,
        vad_filter=True, 
    )
    ```
* You will need to download [`Silero VAD`](https://github.com/snakers4/silero-vad/tree/master/src/silero_vad/data), specifically the "silero_vad.onnx" file. This is for detecting when there is speech or silence, to know when to start processing audio.

* You will also need to change a bunch of the values in ```config.json```:

  * **BRAIN_URL**: URL to wherever llama-server, for the standalone version, I.E: http://192.168.3.24:11435/v1/chat/completions
  * **WHISPER_SIDECAR_URL**: URL to wherever `faster-whisper` is running, I.E: http://192.168.3.24:8775/transcribe
  * **VOICE_WAKE_WORD**: A list of words that will trigger a reply from your AI, probably its name. I recommend to add some mispronunciations and to check what the transcription often confuses its name for, to add it to the list, just to be safe.
  * **TTS_ENGINE**: "edge-tts" for, well, `edge-tts`. Or `xtts` to use your custom voice. `StyleTTS2` is too slow for live talk, so you are gonna need to download `xtts` and, again, assuming you are gonna run it on a different machine, you
    will need to run a server for it, I've used [this](https://drive.google.com/file/d/1fC84_PbgrWexmEqxdrlowFcIuEuw6eAx/view?usp=sharing) script for it, runs on 8790.
  * **SILERO_VAD_MODEL_PATH**: Path to the `Silero VAD` .onnx file.
  * **AUDIO_MONITOR_SOURCE**: The source of the game's audio. On Linux, check with `pactl list sources short`, on winslop, check with `ffmpeg -list_devices true -f dshow -i dummy`.
  * **PLATFORM**: "GNOME" for gnome desktop, "WINDOWS", for windows, "KDE" for kde desktop. Note that, while it should work just fine, I have yet to properly test it on windows cuz I'm lazy to set up a VM. But if there are any issues just let me know.
  * **VRCHAT_USERNAME** and **VRCHAT_PASSWORD**: Your bot's credentials.
  * **VRCHAT_TOTP_SECRET**: The autheticator app's set up secret. If you don't set this up, every time your bot's session expires you will need to verificate manually. If you want to automate this, you need to get the secret following these steps:

     * Go to https://vrchat.com/home/profile in your bot's account, and click enable 2FA. If you already had it enabled, you are gonna need to disable it and re-enable it.
     * On this step, click "enter key manually", copy it, and paste it without the spaces as the value of the variable in the `config.json` <br> <br>
     <img width="641" height="175" alt="image" src="https://github.com/user-attachments/assets/1585146c-5b1a-4c62-8110-8852e9113975" /><br>
     ```diff
     - For the love of god, don't ever share this. Don't ever expose it anywhere. 
     - Never share the config without removing all the credential values.
     - Hell, not even to people you trust. It is a "secret" for a very good reason.
     ``` 
  * **VRCHAT_TRUSTED_INVITERS_IDS**: List of the trusted users from whom your bot will automatically accept invites. To get this, just go to https://vrchat.com/home and click on your profile nickname. An ID should appear on the URL (usr_bunchOfNumbersAndLetters)

- These variables are only needed for Linux users (paths differ depending on installation type):

  * **VRCHAT_STEAM_ROOT**: Steam installation path (i.e home/yourUser/.local/share/Steam).
  * **VRCAHT_PROTON_PATH**: Path to the proton that vrchat is actually using. (i.e home/yourUser/.local/share/Steam/steamapps/common/Proton 10.0/proton).
  * **VRCHAT_STEAM_COMPAT_DATA_PATH**: Path to the compatdata of vrchat (i.e home/yourUser/.local/share/Steam/steamapps/compatdata/438100).
  * **VRCHAT_LAUNCH_EXE_PATH**: Path to VRChat's executable (i.e /home/yourUser/.local/share/Steam/steamapps/common/VRChat/launch.exe).
  * **VRCHAT_STEAM_COMPAT_CLIENT_INSTALL_PATH**: Should be the same as **VRCHAT_STEAM_ROOT** unless you have manually changed it.

- If the game closes after sending an invitation to your bot, that's normal. It will reopen and instantly join you.

* Alright now, you are gonna need to mess with your model and the bot's model in Unity, so you are gonna need the .unitypackage of both. You can browse for free downloadable models at [VRCMods](https://vrcmods.com)

* Download [ALCOM](https://vrc-get.anatawa12.com/en/alcom), it will make it easy to upload your model once finished and will install the VRChat SDK.

* First, let's start with your model. Create a project in Unity and import the model through Assets > Import Package > Custom Package. All you are going to need is to create an empty object wherever in the model, and attach the "VRC Sender" component: <br><br>
  <img width="643" height="509" alt="image" src="https://github.com/user-attachments/assets/0573690d-7637-4efe-a8cc-3a2defc9e74c" /></br>

* Make it small and center it on your model. Change the collision tag to something unique like your nickname.

* Then, click "VRChat SDK" option on the top, log-in with YOUR account. Then in the "Builder" tab set a name to the model and click "Build & Publish", "Build type" being set to "Build & Publish Your Avatar Online".

* Now, open a new project and import your bot's model.

* You are gonna need to add 5 receiver components, one for the center and one for each side, looking something like this:  <br> <br>
  <img width="1937" height="683" alt="image" src="https://github.com/user-attachments/assets/fbe8d0fb-dc55-40d6-8557-865fbbcd4dfe" /> <br>

* Each receiver's collision tag need to match your model's  sender's collision tag name. Make the boxes generously big. They won't affect anything other than the distance at which your bot's model can detect yours.

* Each receiver's type need to be set to "Proximity". The "Parameter" names are not arbitrary, the code for the VRChat bot expects the next parameters for each receiver:

  * **"ProximityToCenter"**: for the receiver on the center.
  * **"ProximityToBack"**: for the receiver on the back.
  * **"ProximityToFront"**: for the receiver on the front.
  * **"ProximityToRight"**: for the receiver on the right.
  * **"ProximityToLeft"**: for the receiver on the left.

* Now, in the "Project" tab below, click on the model's VRC Expression Parameters (wherever the fuck the author decided to put it, good luck)

* You need to create an entry for each receiver, like this: <br> <br>
  <img width="636" height="199" alt="image" src="https://github.com/user-attachments/assets/a2cbd376-d5b1-415c-9351-66c624d5ebbd" /> <br>

* Make sure "Saved" is unchecked for all of them, and "Synced" checked.

* Then, click on the model's Animator Controller (again, wherever the fuck it might be) and add one entry for each receiver, of "float" type, like this: <br> <br>
<img width="659" height="507" alt="image" src="https://github.com/user-attachments/assets/b28b4f9e-f088-4b67-a768-64903f2042e2" /> <br>

* And you are finally good to go. Log-out of YOUR account in the VRChat SDK control panel, and log-in with your bot's account. Then name the model and publish it the same way as with yours.

* Change yourself and your bot to the respective models and test. They will appear in https://vrchat.com/home/avatars. If it doesn't work, make sure you followed all of the steps, named everything correctly, etc... If it still doesn't work, skill issue, ask Claude.

#### CLI control

* Some keys are set to do some stuff when pressed on the terminal where this thingy is running:

  * **Enter**: Start/stop forcibly recording all audio until you press enter again. With a wake word included or not, it will respond to whatever was recorded.
  * **Backspace**: Force the last transcripted text to be sent as a prompt. Useful for when a wake word is misheard or you just want it to react to something that was said.
  * **Tab**: Same shit, but with a screenshot of its game included.
  * **b**: Toggle off/on butt-in replies. It won't ever respond to anything that doesn't contain a wake word.
  * **f**: Toggle off/on following.
  * **space**: Forcibly starts processing the audio. Not so useful anymore. It was for when it used to listen for X seconds then process, so I could force processing the audio without waiting the entire timer.
  * **1 to 8**: Forcibly make it perform a default VRChat expression.

### Pi dev

 - Started with the `pidev` flag or the "Pi-dev / system commands" module in the control panel. That one module runs the bridge and gives her the system command tools.
 - You will need to edit the `models.json` config of pi-dev to look something like this:
   
    ```json
      {
       "providers": {
         "llama-swap": {
           "baseUrl": "url-to-bridge:3100/v1/chat/completions",
           "api": "openai-completions",
           "apiKey": "not-required",
           "models": [
             {
               "id": "qwen3-vl-8b-instruct.Q6_K",
               "name": "qwen3-vl-8b-instruct.Q6_K",
               "contextWindow": 32000,
               "maxTokens": 8096
             }
           ]
         }
       }
     }
    ```
- Ofc adjust the model id/name, context window etc...

### VTube Studio

* For this you obviously need [VTube Studio](https://denchisoft.com/) running, model loaded, and the API enabled in its settings.
* Run with the `vtube` flag, or start "VTube Studio" from the control panel. First time it connects it'll ask you to allow the plugin inside VTube Studio itself, just click accept. If VTube Studio isn't open when it starts, the module fails to start and you can just start it again from the panel once it is.
* Environment variables (all optional, defaults shown):

  * **VTS_HOST**: default `localhost`.
  * **VTS_PORT**: default `8001`.
  * **VTS_PLUGIN_NAME**: default `LilyVTS`, whatever shows up as the plugin name inside VTS.
  * **VTS_PLUGIN_DEV**: default `Izan`, just the plugin dev/author name field, doesn't really matter what you put.

* If you also want it to read a YouTube live chat while vtubing (so she reacts to chat messages during a stream), the `vtube` flag also starts the "YouTube live chat" module (it's a separate switch in the panel), and you need:

  * **YOUTUBE_API_KEY**: A Youtube Data API v3 key from the [Google Cloud Console](https://console.cloud.google.com/).
  * **YOUTUBE_VIDEO_ID**: The video ID of the live stream (the part after `v=` in the URL).

### Browser control

* This uses the [`open-browser-control`](https://github.com/smankoo/open-browser-control) Chrome extension in its bridge mode, so the AI can navigate/click/type/scroll on your actual browser.
* You need to install the extension in Chrome first, following its own repo's instructions. The bridge itself (`npx -y open-browser-control --bridge`) gets spawned automatically when you run with the `browser` flag or start "Browser control" from the panel, you don't need to run it yourself. Stopping the module kills it.
* One environment variable, optional:

  * **BROWSER_BRIDGE_URL**: default `ws://localhost:9334`. Only change it if you've configured the extension to use a different port.

* This is currently only offered/used on the voice assistant / STTS side, not wired into Discord.
* For typing in a browser page the extension is still the better tool (it targets the page's DOM). The system-level typing from [Typing anywhere](#typing-anywhere) is for native apps and for anything the extension can't reach.

### n8n

* This spins up a small OpenAI-compatible endpoint (`/v1/chat/completions`) so you can point an [n8n](https://n8n.io/) AI node at the brain, plus loads any trigger files dropped in `src/n8n/triggers`.
* Run with the `n8n` flag, or start "n8n bridge + triggers" from the panel. No required environment variables, it defaults to port 3200 for the bridge.
* This also wires up a `/notify` endpoint on the Discord side so a workflow can DM you through the bot. That is its own module ("n8n Discord notifications") and needs both n8n and Discord running. With the flags it is skipped if you didn't pass `discord`. From the panel, turning it on also starts whatever it needs.

### Control panel

* A small local web dashboard to start and stop modules live and manage the llama-server process without touching the terminal.
* It will NOT start unless these 3 are set:

  * **CP_USERNAME**: login username.
  * **CP_PASSWORD_HASH**: bcrypt hash of your password, generate it with `node src/controlPanel/hashPassword.js "your password"` and paste the output.
  * **CP_SESSION_SECRET**: any random long string, used to sign the session cookie.

* Optional ones:

  * **CP_PORT**: default `4210`.
  * **CP_HTTPS**: set to `true` if you're putting it behind a reverse proxy with HTTPS, so it trusts the proxy correctly.
  * **CP_API_KEY**: only needed if you're hitting its API from outside the dashboard itself.

* **Modules**: every module has a switch. This is a real start/stop, not just hiding tools: turning one on connects it (opens its ports, logs in, spawns its bridge...) and gives the AI its tools, turning it off disconnects everything and takes the tools away. You don't need to have passed a flag at boot.
  * Modules that need another one start it for you (i.e. n8n Discord notifications starts n8n and Discord). Turning a module off also turns off everything that depends on it.
  * The two Minecraft backends swap: turning one on stops the other.
  * If a module fails to start (VTube Studio closed, a port in use...) the dashboard shows the error and the switch flips back.
  * The list refreshes every few seconds and the switches lock while something is starting or stopping.
  * Modules: Discord, Speech-to-Text + Voice Assistant, Screenshot, Typing/keys/clipboard, Pi-dev, VSCode editing + coding bridge, Browser control, VTube Studio, YouTube live chat, both Minecraft backends, VRChat, n8n and n8n Discord notifications.

* Same deal as the VRChat website, if you want it publicly reachable you're gonna need a sub-domain + reverse proxy.
