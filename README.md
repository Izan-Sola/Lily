# My Daughter Lily (WIP) 
### initially supposed to be a hytale bot, but oh well...

- My daughter Lily, capable of using discord, playing minecraft, and beating your ahh. (wip)
- This is the code for her brain, where many functions are centralized while trying to keep it clean (discord, minecraft, coding and whatever I add in the future). You are free to make use of it for your own thing if you want.
- Related: https://github.com/Izan-Sola/Lily-Minecraft , https://github.com/Izan-Sola/LilyBlog , https://github.com/Izan-Sola/LilyGnomeWidget
- Currently working on her being able to play survival minecraft decently.
- Eventually I want her to have a vtuber model.

#### current todos so i dont forget
- ~~make break action actually require the correct tools and blocks drop correct item~~ DONE
- ~~manage her entire inventory, not just hotbar slots~~ DONE
- ~~make her sleep when u sleep, mount on a boat/minecart with you.~~ DONE (tbh a bit buggy could be improved)
- dedicated specifically named dc voice channel for when playing mc survival (chatting there goes threough the mc pipeline)
- ~~uh, drop use action and rename it to eat? cuz what the helly is she realistically gonna do with other stuff anywas.~~ DONE
- ~~Make drop tool require to specify the amount to throw.~~ DONE
- refactor minecraft actions break_listed break_unlisted into just one break. blocks of interest will instead be a list of the closest block for any type of block nearby. wether it is ores or dirt, the closest one (but not the ones directly below her to avoid trapping herself, nor any inaccessible blocks) will be shown. break tool will require the amount of blocks to break. she will choose the block and the amount as arguments, and the code will handle the rest. This way she will be more consistent and will not be unavailable to reply to you while mining, given she isn't constantly tool calling.
- ~~make her autowear armor if its better than what she currently has~~ DONE
- ~~give her info of current biome, time of the day, weather...~~ DONE
- ~~on the automatic prompt loop for autonomous action, give her recommendations depending on the environament. mining if in a cave per example. prolly also show her last user message since if it contains an order like "attack anything you see" or "mine all iron you can find" then it would make her act on that without having to be telling her what to do constantly or at specific moments.~~ DONE

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
