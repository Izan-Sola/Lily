# My Daughter Lily (WIP) 
### initially supposed to be a hytale bot, but oh well...

- My daughter Lily, capable of using discord, playing minecraft, and beating your ahh. (wip)
- Related: https://github.com/Izan-Sola/Lily-Minecraft , https://github.com/Izan-Sola/LilyBlog , https://github.com/Izan-Sola/LilyGnomeWidget
- Currently working on her being able to play survival minecraft decently.
- Eventually I want her to have a vtuber model.

#### current todos so i dont forget
- make break action actually require the correct tools and blocks drop correct item
~~ manage her entire inventory, not just hotbar slots ~~
- make her sleep when u sleep, mount on a boat/minecart with you.
- dedicated specifically named dc voice channel for when playing mc survival (chatting there goes threough the mc pipeline)
- uh, drop use action and rename it to eat? cuz what the helly is she realistically gonna do with other stuff anywas.
- Make drop tool require to specify the amount to throw.
- break closest generic tool either require amount of blocks to break (since she cant see generic blocks in her system prompt she migt not call it multiple times herself) or try to imrpove the instructions in her prompt
- make her autowear armor if its better than what she currently has

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
