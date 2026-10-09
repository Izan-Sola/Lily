---
name: fill-form
description: fill in a form, signup page or dialog with several text fields, in any app or website
---
Use this when the user wants a form or dialog filled in.

1. Call get_screenshot to see the form and which field has focus.
2. If you don't know a value (name, email, address, phone...), ask the user out loud. Never invent personal details.
3. The FIRST field must have focus. If it doesn't, ask the user to click into it, then continue.
4. For each text field, in order: type_text with the value and then="tab". That types it and moves to the next field in one step.
5. Dropdowns, checkboxes and radio buttons are not text. Use press_keys instead: "space" toggles a checkbox, "down" or "up" changes a choice, then "tab".
6. Skip password fields. Tell the user to type those themselves.
7. Call get_screenshot once at the end to check the result and fix anything that went into the wrong field.
8. NEVER submit. Do not press enter. Tell the user the form is ready. If they then say "submit it" or "send it", call press_keys with "enter" (they will be asked to approve).
