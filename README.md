# My Daughter Lily (WIP)

- My daughter Lily, capable of using discord, playing minecraft, and beating your ahh. (wip, objective is to give her as much autonomy as possible considering limitations)
- Related: https://github.com/Izan-Sola/Lily-Minecraft, https://lilyblog.duckdns.org/

## Stuff used

- Mold for my daughter: Qwen3-8B-VL-Instruct
- Home for my daughter: RTX 3060 12GB VRAM
- Edge TTS, for her voice. Alterantively, Styles-2TTS to use a custom voice. 
- Faster-Whisper, for speech recognition.
- Unsloth studio, to teach my daughter.
- Ollama, to accomodate my daughter on her home.
- NodeJS, to allow her to communicate in discord.

## Features

- Chat with Lily by pinging her or replying to one of her messages. She may rarely respond spontaneously to a message without being directly addressed.
- She can send gifs, audio messages, talk in voice calls, and listen to your voice.
- ~~She has access to a vectorized database containing the scrapped Hytale Wiki that she can query using a tool~~ (Droping this).
- She has a memory database that she can query, add, update and remove memory from using tools.
- SUCCUMB TO HER MAD BENDING SKILLS IN A DUEL (wip)

## Commands

### Discord

- /aboutlily: Displays information about Lily
- /lilyprefs: Adjust your preferences such as, disabling pings, voice processing (she wont listen to you in voice calls), disabling spontaneous replies to your messages...
- /voice join/leave: To make her join or leave a voice channel.
- /audiolily: To make her respond with an audio message.
  
### Minecraft

- /lily duel (difficulty)
- /lily duel stop
- /lily bend (element) [only fire atm]
- /lily come
- /lily follow (user)
  
## Info

- Your voice is only processed in real time and not stored anywhere. An history of messages sent in the current channel is stored for memory and context enhancement purposes.
