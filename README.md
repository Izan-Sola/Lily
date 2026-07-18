# My Daughter Lily (WIP) 
### initially supposed to be a hytale bot, but oh well...

- My daughter Lily, capable of using discord, playing minecraft, and beating your ahh. (wip)
- Related: https://github.com/Izan-Sola/Lily-Minecraft , https://github.com/Izan-Sola/LilyBlog , https://github.com/Izan-Sola/LilyGnomeWidget
- Currently working on her being able to play survival minecraft decently.
- Eventually I want her to have a vtuber model.

## Stuff used

- Mold for my daughter: Qwen3-8B-VL-Instruct
- Home for my daughter: RTX 3060 12GB VRAM
- Edge TTS, for her voice. Alternatively, Styles-2TTS to use a custom voice. 
- Faster-Whisper, for speech recognition.
- Unsloth studio, to teach my daughter.
- Ollama, to accomodate my daughter on her home.
- NodeJS, to allow her to communicate in discord.
- Continue VSC extension, so she can vibecode herself (lol)
- Tavily API, for web search, Klipy API for gifs and memes.

## Features

- Chat with Lily by pinging her or replying to one of her messages. She may rarely respond spontaneously to a message without being directly addressed.
- She can send gifs, memes, audio messages, talk in voice calls, and listen to your voice.
- She has a memory database that she can query, add, update and remove memory from using tools.
- SUCCUMB TO HER MAD BENDING SKILLS IN A DUEL (wip, showcases at https://www.youtube.com/@ShinyShadow_)
- She can mine blocks, attack mobs, use items, swap slots, follow you and drop items.

## Commands

### Discord

- /aboutlily: Displays information about Lily
- /lilyprefs: Adjust your preferences such as, disabling pings, voice processing (she wont listen to you in voice calls), disabling spontaneous replies to your messages...
- /voice join/leave: To make her join or leave a voice channel.
- /audiolily: To make her respond with an audio message.
  
### Minecraft

- /lily duel (start, stop)
- /lily bend (element) [only fire, earth and air atm]
- /lily come
- /lily follow (user)
- /lily stop
  
## Info

- Your voice is only processed in real time and not stored anywhere. An history of messages sent in the current channel is stored for memory and context enhancement purposes.
