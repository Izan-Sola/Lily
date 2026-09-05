import { spawn } from "child_process";
import cfg from "../util/config.js";

const SINK_NAME = "lily_voice";
const SAMPLE_RATE = 24000; // edge-tts's default output rate for most neural voices

// Which edge-tts voice to speak with -- set EDGE_TTS_VOICE in config.json
// to override. Run `edge-tts --list-voices` to see all options; anything
// like "en-US-AvaNeural", "en-US-AnaNeural" (younger-sounding), or a
// non-English voice all work the same way.
const DEFAULT_VOICE = "en-US-AnaNeural";

// Which backend to speak with. Set TTS_ENGINE in config.json to
// "edge-tts" or "xtts". Defaults to "edge-tts" if unset.
const TTS_ENGINE = (cfg.TTS_ENGINE || "edge-tts").toLowerCase();

const isWindows = String(cfg.PLATFORM || "GNOME").toUpperCase() === "WINDOWS";

// paplay/PulseAudio (SINK_NAME) is how the Linux setup (KDE or GNOME --
// both use PulseAudio/PipeWire the same way here) routes Lily's voice
// into VRChat's mic input. Windows has no paplay, so instead we use
// ffplay (ships with ffmpeg, already a dependency here) to play the raw
// PCM through the system's DEFAULT playback device -- to get the same
// "into VRChat's mic" routing on Windows, set your virtual cable (e.g.
// VB-Audio Virtual Cable) as the Windows default output device.
// Set PLATFORM in config.json to "KDE", "GNOME", or "WINDOWS".
function spawnPlayer() {
  const player = isWindows
    ? spawn("ffplay", [
        "-loglevel", "quiet",
        "-nodisp",
        "-autoexit",
        "-f", "s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", "1",
        "-i", "pipe:0",
      ])
    : spawn("paplay", [
        "--raw",
        `--rate=${SAMPLE_RATE}`,
        "--format=s16le",
        "--channels=1",
        `--device=${SINK_NAME}`,
      ]);
  player.on("error", (err) => console.error("[voice] audio player failed to start:", err.message));
  return player;
}

// The pipeline lock in server.js (requestReply/pipelineBusy) should
// already guarantee speak() is never called while a previous call is
// still playing. These track the in-flight processes anyway as a second
// line of defense -- if that guarantee is ever violated, we tear down the
// old pipeline instead of letting two audio streams overlap.
let activePlayer = null;
let activeUpstream = []; // subprocesses feeding activePlayer -- killed alongside it
let activeAbort = null; // AbortController for an in-flight xtts fetch, if any

function sanitizeInput(text) {
  return text.replace(/[\r\n]+/g, " ").trim();
  // No shell-escaping needed -- spawn() below passes args straight to
  // execve (no shell:true), so apostrophes/quotes in the text are safe
  // as-is; this is just cleaning up line breaks so the TTS backend gets
  // one continuous utterance.
}

function killActive() {
  activeUpstream.forEach((p) => p.kill("SIGTERM"));
  if (activePlayer) activePlayer.kill("SIGTERM");
  if (activeAbort) activeAbort.abort();
  activeUpstream = [];
  activePlayer = null;
  activeAbort = null;
}

// Plays raw s16le PCM (already decoded) through the platform player
// (spawnPlayer(): paplay on Linux, ffplay on Windows). Returns a promise
// that resolves when playback finishes. Used by the edge-tts path (ffmpeg
// decodes mp3 into this); xtts skips this and pipes its own player
// directly since the sidecar already outputs raw PCM.
function playPcmStream(pcmStream) {
  const player = spawnPlayer();

  pcmStream.pipe(player.stdin);

  activePlayer = player;

  return new Promise((resolve) => {
    player.on("exit", () => {
      if (activePlayer === player) activePlayer = null;
      resolve();
    });
  });
}

// Three chained processes, piped stdout->stdin, so playback can start
// before the whole utterance has finished synthesizing (same "start
// talking before the full reply is ready" goal the old XTTS streaming
// path had):
//   edge-tts --write-media -   (streams mp3 bytes to stdout as it synths)
//     -> ffmpeg (decodes mp3 -> raw s16le PCM on the fly)
//       -> platform player (plays the raw PCM -- paplay/lily_voice on Linux, ffplay/default device on Windows)
async function speakEdgeTts(clean) {
  const voice = cfg.EDGE_TTS_VOICE || DEFAULT_VOICE;
  const rate = cfg.EDGE_TTS_RATE || "+20%";
  const synth = spawn("edge-tts", ["--voice", voice, "--rate", rate, "--text", clean, "--write-media", "-"]);
  synth.on("error", (err) => console.error("[voice] edge-tts failed to start:", err.message));
  synth.stderr.on("data", () => {}); // edge-tts logs progress to stderr -- noise, ignore

  const decoder = spawn("ffmpeg", [
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "pipe:1",
  ]);
  decoder.on("error", (err) => console.error("[voice] ffmpeg failed to start:", err.message));

  synth.stdout.pipe(decoder.stdin);

  activeUpstream = [synth, decoder];

  await playPcmStream(decoder.stdout);

  if (activeUpstream[0] === synth) activeUpstream = [];
}

// Hits the XTTS sidecar server (VOICE_SIDECAR_URL, POST /speak) for
// synthesis. The sidecar streams back raw s16le PCM mono at SAMPLE_RATE
// directly -- no container/codec, so unlike edge-tts this skips ffmpeg
// entirely and feeds the platform player straight from the HTTP response
// body. Speaker
// and language are fixed server-side (baked into the sidecar's startup
// conditioning latents), so the request body is just { text }.
async function speakXtts(clean) {
  if (!cfg.VOICE_SIDECAR_URL) {
    console.error("[voice] TTS_ENGINE is 'xtts' but VOICE_SIDECAR_URL is not set in config");
    return;
  }

  const player = spawnPlayer();

  activePlayer = player;

  const playDone = new Promise((resolve) => {
    player.on("exit", () => {
      if (activePlayer === player) activePlayer = null;
      resolve();
    });
  });

  const abort = new AbortController();
  activeAbort = abort;

  try {
    const res = await fetch(cfg.VOICE_SIDECAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      console.error("[voice] xtts sidecar returned an error:", res.status, res.statusText);
      player.stdin.end();
    } else {
      // Node's fetch gives a web ReadableStream; pipe raw PCM straight into the player.
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!player.stdin.writable) break;
          player.stdin.write(Buffer.from(value));
        }
      } catch (err) {
        if (err.name !== "AbortError") console.error("[voice] xtts stream read error:", err.message);
      } finally {
        player.stdin.end();
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") console.error("[voice] xtts request failed:", err.message);
    player.stdin.end();
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }

  await playDone;
}

export async function speak(text) {
  const clean = sanitizeInput(text);
  if (!clean) return;

  if (activePlayer) {
    console.warn("[voice] speak() called while already playing -- stopping previous playback");
    killActive();
  }

  if (TTS_ENGINE === "xtts") {
    await speakXtts(clean);
  } else {
    if (TTS_ENGINE !== "edge-tts") {
      console.warn(`[voice] unknown TTS_ENGINE "${TTS_ENGINE}", falling back to edge-tts`);
    }
    await speakEdgeTts(clean);
  }
}