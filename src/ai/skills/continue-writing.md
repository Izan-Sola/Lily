---
name: continue-writing
description: continue, extend or add to text the user is already writing in a document, note or text box
---
Use this when the user says "continue this", "keep going", "add a paragraph about...", or "finish this".

1. Call read_text_field with scope="all" to read what is already there.
2. Unless the user said to insert at the cursor, call press_keys with "ctrl+end" to move to the end of the text.
3. Write ONLY the new text, in the same language, tone and formatting as the existing text. Never repeat what is already there.
4. Call type_text with the new text (no replace).
5. Tell the user briefly what you added. They can undo it with ctrl+z.

For fixing, shortening, translating or restyling existing text do NOT use this skill: use the rewrite_text tool.
