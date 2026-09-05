import express from "express";
import { setStatus } from "./util/chatbox.js";
import { captureBase64 } from "./bot/perception.js";
import { speak } from "./audiostuff/voice.js";
import { VRCHAT_CHANNEL_ID } from "../ai/index.js";
import { buildVrchatSystemPrompt } from "../ai/prompts.js";

// Set once at startup by vrchatBot/index.js (startVrchatBot({ ai })) --
// the same Lily instance every other backend (Discord/Minecraft) in this
// process shares. Replaces the old standalone brain.js, which hit a
// local Ollama endpoint directly with its own copy of the personality
// prompt and its own tiny tool set; queryBrain() below is what used to
// live in bot/brain.js's queryBrainMessage(), now delegating the actual
// thinking to ai.chat()/ai.buttIn() instead.
let ai = null;

export function setBrain(lilyInstance) {
    ai = lilyInstance;
}

// situation is "user" (direct address, whatever the input method) or
// "ambient" (butt-in commentary on a conversation she wasn't addressed
// in) -- same distinction the old brain.js made via queryBrainMessage's
// SITUATION_PREFIXES, now expressed as which Lily method to call and
// which system-prompt variant (buildVrchatSystemPrompt's ambient flag)
// to pass in.
async function queryBrain(situation, text, { withImage = false } = {}) {
    if (!ai) {
        console.error("[vrchat] queryBrain called before setBrain() wired up the shared Lily instance");
        return "... (•ᴗ•)";
    }

    const systemPromptOverride = buildVrchatSystemPrompt(situation === "ambient");

    let images = [];
    if (withImage) {
        try {
            const base64 = await captureBase64();
            images = [{ mimeType: "image/png", base64 }];
        } catch (err) {
            console.error(`[vrchat] screenshot capture failed, falling back to text-only: ${err.message}`);
        }
    }

    const result = situation === "ambient"
        ? await ai.buttIn(VRCHAT_CHANNEL_ID, text, systemPromptOverride)
        : await ai.chat(VRCHAT_CHANNEL_ID, text, systemPromptOverride, {}, images);

    // handleMessage() returns null if the channel's lock was already held
    // (a race between two requestReply() callers) -- treat that the same
    // as a deliberate ambient non-reaction rather than erroring.
    if (!result) return "NONE";
    return result.text ?? "NONE";
}

//const IDLE_MESSAGE = "[ShinyShadow_'s AI Daughter] Talk to me via the web interface linked in my profile. (WIP: prompt her via voice)";
const IDLE_MESSAGE = "";

const IDLE_RESEND_INTERVAL_MS = 15000;
const REPLY_HOLD_MS = 8500;
const COOLDOWN_MS = 5000;

let idleInterval = null;
let replyTimer = null;
let lastSentAt = 0;

// True from the moment a reply pipeline starts (the brain query) until
// speak() has finished playing. This is the single source of truth that
// stops two replies from overlapping -- everything that can trigger a
// reply (wake word, butt-in, manual recording, force-send, terminal
// `!text`, the web console) goes through requestReply() below instead of
// separately calling queryBrainMessage + handleReply, so this flag is
// always accurate no matter which path fired.
let pipelineBusy = false;

export function isBusy() {
  return pipelineBusy;
}

export function showIdleMessage() {
  setStatus(IDLE_MESSAGE);
}

function startIdleLoop() {
  stopIdleLoop();
  showIdleMessage();
  idleInterval = setInterval(showIdleMessage, IDLE_RESEND_INTERVAL_MS);
}

function stopIdleLoop() {
  if (idleInterval) clearInterval(idleInterval);
  idleInterval = null;
}

// Sets the chatbox to the reply and speaks it, then reverts to idle after
// REPLY_HOLD_MS. This is the ONLY place speak() is called from -- every
// caller goes through requestReply(), which holds `pipelineBusy` for the
// whole span so a second pipeline can never start (and therefore never
// call speak()) while this one is still running.
async function handleReply(reply) {
  stopIdleLoop();
  if (replyTimer) clearTimeout(replyTimer);
  setStatus(reply);
  await speak(reply);
  replyTimer = setTimeout(startIdleLoop, REPLY_HOLD_MS);
}

function timeRemaining() {
  const elapsed = Date.now() - lastSentAt;
  return elapsed < COOLDOWN_MS ? Math.ceil((COOLDOWN_MS - elapsed) / 1000) : 0;
}

// Single entry point for every reply pipeline in the app. Replaces the old
// pattern where audioLoop.js, index.js, and the web routes each separately
// checked checkCooldown(), called queryBrainMessage(), then called
// handleReply() themselves -- that duplication is exactly what let two
// pipelines run at once (e.g. a wake-word reply still mid-speak() while a
// force-send or a web request slipped past its own independent check).
//
// Returns { reply } on success (reply may be "NONE" for a deliberate
// ambient non-reaction), or { error } if the request was turned away.
//
// `bypassCooldown` skips the *time* cooldown -- used by the manual/
// force-send keys, which are meant to feel instant once she's free -- but
// it never skips the busy lock, so those paths still can't talk over an
// in-flight reply, they just don't have to wait out the full window once
// one finishes.
export async function requestReply(situation, text, { withImage = false, bypassCooldown = false } = {}) {
  if (pipelineBusy) {
    return { error: "still speaking, one sec" };
  }
  if (!bypassCooldown) {
    const remaining = timeRemaining();
    if (remaining > 0) {
      return { error: `Cooldown active, wait ${remaining}s` };
    }
  }

  pipelineBusy = true;
  lastSentAt = Date.now();
  setStatus(withImage ? "Thinking (with image)..." : "Thinking...");
  try {
  const reply = await queryBrain(situation, text, { withImage });
  if (reply !== "NONE") {
    await handleReply(reply);
  }
  return { reply };
  } finally {
    pipelineBusy = false;
  }
}

const PAGE = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Lily VRChat Console</title>
  <style>
    body { font-family: sans-serif; background: #1a1a1e; color: #eee; padding: 2rem; max-width: 600px; margin: auto; }
    textarea { width: 100%; height: 80px; font-size: 1rem; padding: 0.5rem; box-sizing: border-box; }
    button { font-size: 1rem; padding: 0.6rem 1.2rem; margin-top: 0.5rem; margin-right: 0.5rem; cursor: pointer; }
    #log { margin-top: 1.5rem; white-space: pre-wrap; background: #111; padding: 1rem; border-radius: 6px; min-height: 4rem; }
    .sent { color: #8ab4f8; }
    .reply { color: #7ee787; }
  </style>
</head>
<body>
  <h2>Lily VRChat Console</h2>
  <textarea id="msg" placeholder="Type a message..."></textarea><br/>
  <button id="sendText">Send</button>
  <button id="sendVision">Send + Screenshot of what SHE sees. </button>
  <div id="log"></div>
 <h1> Info: <br> <br> </h1>
  <p> Via this web interface you can input prompts to her and she will reply in game. There is a 10 second global cooldown. <br> <br>
      The screenshot option might take a bit longer to process. If you wanna know more about Lily, check the whole project: https://github.com/Izan-Sola/Lily
 </p> <script>
    const msgEl = document.getElementById("msg");
    const logEl = document.getElementById("log");

    function logLine(cls, text) {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function send(withVision) {
      const text = msgEl.value.trim();
      if (!text) return;
      logLine("sent", "You" + (withVision ? " (+screenshot)" : "") + ": " + text);
      msgEl.value = "";
      try {
        const res = await fetch(withVision ? "/api/vision" : "/api/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (res.status === 429) {
          logLine("reply", "(" + data.error + ")");
          return;
        }
        logLine("reply", "Lily: " + (data.reply ?? "(error)"));
      } catch (err) {
        logLine("reply", "Lily: (request failed)");
      }
    }

    document.getElementById("sendText").onclick = () => send(false);
    document.getElementById("sendVision").onclick = () => send(true);
    msgEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(false); }
    });
  </script>
</body>
</html>
`;

export function startWebServer(port = 3000) {
  const app = express();
  app.use(express.json());
  startIdleLoop();

  app.get("/", (req, res) => res.send(PAGE));

  app.post("/api/text", async (req, res) => {
    const text = (req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    console.log(`[chat] IN  (text): ${text}`);
    try {
      const { reply, error } = await requestReply("user", text);
      if (error) return res.status(429).json({ error });
      console.log(`[chat] OUT (text): ${reply}`);
      res.json({ reply });
    } catch (err) {
      console.error(`[chat] text failed: ${err.message}`);
      res.status(500).json({ error: "message processing failed" });
    }
  });

  app.post("/api/vision", async (req, res) => {
    const text = (req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    console.log(`[chat] IN  (vision): ${text}`);
    try {
      const { reply, error } = await requestReply("user", text, { withImage: true });
      if (error) return res.status(429).json({ error });
      console.log(`[chat] OUT (vision): ${reply}`);
      res.json({ reply });
    } catch (err) {
      console.error(`[chat] vision failed: ${err.message}`);
      res.status(500).json({ error: "screenshot capture failed" });
    }
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`[web] Lily console at http://<laptop-ip>:${port}`);
  });
}