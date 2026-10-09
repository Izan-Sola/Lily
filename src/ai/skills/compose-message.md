---
name: compose-message
description: write or reply to a message in a chat or email app (Discord, WhatsApp, Gmail...) without sending it
---
Use this when the user asks you to reply to, answer or write a message in an app.

1. If you need to see what you're replying to: call read_text_field if they selected the message, otherwise get_screenshot.
2. Write the reply in the USER's voice: short, natural, no assistant phrases. Only use facts the user gave you or that are clearly in the conversation.
3. The message box must have focus. If you're not sure, ask the user to click into it first.
4. Call type_text with the draft. Do not use "then". Do not send.
5. Tell the user in one sentence what you typed and ask if they want it sent.
6. Only if they say yes: press_keys with "enter" (they will be asked to approve). Some apps send with ctrl+enter instead.
