import { send } from "../vrchat/osc.js";

const STATUS_TITLE = "[Lily - ENG]";

export function say(text, { immediate = true, sfx = false } = {}) {
  if (!text) return;
  const clipped = text.length > 144 ? text.slice(0, 141) + "..." : text;
  send("/chatbox/input", [
    { type: "s", value: clipped },
    { type: "i", value: immediate ? 1 : 0 },
    { type: "i", value: sfx ? 1 : 0 },
  ]);
}

export function setStatus(line) {
  say(`${STATUS_TITLE}\n${line}`);
}