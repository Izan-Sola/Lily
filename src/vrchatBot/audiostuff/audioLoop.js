import { spawn } from "child_process";
import { unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { RealTimeVAD } from "@ericedouard/vad-node-realtime";
import cfg from "../util/config.js";
import { requestReply } from "../server.js";
import { setStatus } from "../util/chatbox.js";

// KDE and GNOME both drive audio through PulseAudio/PipeWire the same
// way (parec), so only WINDOWS branches differently here. Set PLATFORM
// in config.json to "KDE", "GNOME", or "WINDOWS".
const isWindows = String(cfg.PLATFORM || "GNOME").toUpperCase() === "WINDOWS";

const realLog = (msg) => process.stdout.write(msg + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = false;
let ambientBuffer = [];
let lastTranscript = ""; // most recent non-empty ambient transcription -- backspace/tab force-send this
let buttInTimer = null;
let buttInEnabled = true;

// -- VAD-driven ambient listening ---------------------------------------
// Replaces the old fixed-duration (AUDIO_CHUNK_SECONDS) recording loop.
// A single parec process streams raw PCM continuously; Silero VAD (via
// @ericedouard/vad-node-realtime) watches that stream and fires
// onSpeechStart/onSpeechEnd around actual speech, so we only ever
// transcribe real utterances instead of a fixed window that might cut
// someone off or capture a bunch of silence.
const VAD_SAMPLE_RATE = 16000;
let vad = null;
let ambientProc = null;
let vadSpeaking = false;
let carryByte = null; // holds a leftover odd byte between stdout chunks so 16-bit samples never split
let discardNextResult = false; // set when manual mode interrupts an in-progress ambient utterance

// -- manual (untimed) push-to-talk recording ----------------------------
const MANUAL_AUDIO_PATH = join(tmpdir(), "lily_manual_audio.wav");
let manualProc = null;
let manualActive = false;

// -- Whisper sidecar ------------------------------------------------------
async function sendToWhisper(form) {
  try {
    const res = await fetch(cfg.WHISPER_SIDECAR_URL, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      realLog(`[voice] whisper server returned ${res.status}`);
      return "";
    }

    const data = await res.json();
    if (data.error) {
      realLog(`[voice] whisper server error: ${data.error}`);
      return "";
    }
    return (data.text ?? "").replace(/\n/g, " ").trim();
  } catch (err) {
    realLog(`[voice] transcription request failed: ${err.message}`);
    return "";
  }
}

async function transcribe(wavPath) {
  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  return sendToWhisper(form);
}

async function transcribeBuffer(wavBuffer) {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
  return sendToWhisper(form);
}

function cleanTranscript(text) {
  return text.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
}

function extractWakeSentence(text) {
  const wakeWords = (Array.isArray(cfg.VOICE_WAKE_WORD) ? cfg.VOICE_WAKE_WORD : [cfg.VOICE_WAKE_WORD])
    .map(w => w.toLowerCase());
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const sLower = s.toLowerCase();
    if (wakeWords.some(w => sLower.includes(w))) return s.trim();
  }
  return null;
}

// Wraps 16-bit PCM samples (what the VAD hands back) in a minimal WAV
// header so they can go straight to the whisper sidecar without ever
// touching disk.
function floatToWav(float32Audio, sampleRate = VAD_SAMPLE_RATE) {
  const pcm16 = new Int16Array(float32Audio.length);
  for (let i = 0; i < float32Audio.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Audio[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const dataSize = pcm16.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).copy(buffer, 44);
  return buffer;
}

function int16BufferToFloat32(buf) {
  const sampleCount = buf.length >> 1;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2);
    out[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// Triggered by pressing Backspace (no image) or Tab (with image) in the
// terminal. Force-sends whatever the last ambient chunk transcribed, no
// wake word or cooldown required -- sends unconditionally, same as the
// manual (Enter) path does. `withImage` opts into a screenshot for this
// one forced send only; the regular voice paths stay text-only since
// attaching a screenshot every turn was too slow for live back-and-forth.
export async function forceSendLastTranscript(withImage = false) {
  const text = lastTranscript;
  if (!text) {
    realLog(`[voice] force-send pressed but nothing transcribed yet`);
    return;
  }
  lastTranscript = "";

  realLog(`[voice] input (forced${withImage ? " +image" : ""}): ${text}`);
  const { reply, error } = await requestReply("user", text, { withImage, bypassCooldown: true });
  if (error) {
    realLog(`[voice] force-send skipped: ${error}`);
    return;
  }
  realLog(`[voice] lily response (forced): ${reply}`);
}

// Cuts the current in-progress ambient utterance short (spacebar pressed)
// instead of waiting for the VAD's own silence/redemption window to
// finalize it. flush() asks the VAD to process whatever it's buffered so
// far, which finalizes the segment and fires onSpeechEnd with it -- same
// spirit as the old "kill the timed recording early" behaviour, just
// driven by the VAD instead of a countdown.
export function skipCurrentRecording() {
  if (vad && vadSpeaking) {
    realLog("[voice] skip requested -- finalizing current speech now");
    vad.flush().catch((err) => realLog(`[voice] flush failed: ${err.message}`));
  }
}

// Same idea, but used when switching into manual recording: whatever the
// VAD was mid-way through hearing gets thrown away instead of
// transcribed/processed.
function interruptForManualMode() {
  if (vad && vadSpeaking) {
    discardNextResult = true;
    vad.flush().catch(() => {});
  }
}

async function handleSpeechStart() {
  if (manualActive) return; // ambient stream is paused while push-to-talk owns the mic
  vadSpeaking = true;
  realLog("[voice] > speech detected, listening...");
  setStatus("Listening...");
}

async function handleSpeechEnd(float32Audio) {
  vadSpeaking = false;

  if (manualActive || discardNextResult) {
    discardNextResult = false;
    return;
  }

  realLog(`[voice] > Processing audio...`);
  setStatus("Processing audio...");
  const rawText = await transcribeBuffer(floatToWav(float32Audio));
  realLog(`[voice] > Processed audio.`);

  const text = cleanTranscript(rawText);
  realLog(`[voice] > Heard: "${text}"`);
  if (!text) return;

  ambientBuffer.push(text);
  lastTranscript = text;

  const trigger = extractWakeSentence(text);
  if (trigger) {
    realLog(`[voice] input: ${trigger}`);
    const { reply, error } = await requestReply("user", trigger); // waits for her to actually finish speaking before looping
    if (error) {
      realLog(`[voice] wake-word trigger skipped: ${error}`);
    } else {
      realLog(`[voice] lily response: ${reply}`);
    }
  }
}

async function initVad() {
  vad = await RealTimeVAD.new({
    // tune via config.json -- sane Silero defaults if unset
    positiveSpeechThreshold: cfg.VAD_POSITIVE_THRESHOLD ?? 0.6,
    negativeSpeechThreshold: cfg.VAD_NEGATIVE_THRESHOLD ?? 0.4,
    minSpeechFrames: cfg.VAD_MIN_SPEECH_FRAMES ?? 4,
    // How many consecutive below-threshold frames it waits through before
    // deciding speech has actually ended and firing onSpeechEnd. frameSamples
    // defaults to 1536 (~96ms/frame @16kHz), so 8 frames is roughly 0.75s of
    // silence. Lower = snappier but risks cutting mid-sentence pauses; higher
    // = more patient but adds latency before she responds.
    redemptionFrames: cfg.VAD_REDEMPTION_FRAMES ?? 8,
    // onSpeechStart only fires once minSpeechFrames worth of audio has
    // already scored as speech, so without padding the segment handed to
    // onSpeechEnd is missing whatever was said during that confirmation
    // window -- clipped sentence starts. preSpeechPadFrames prepends that
    // many already-buffered frames from before the detected onset back
    // onto the segment. frameSamples defaults to 1536 (~96ms/frame @16kHz),
    // so 12 frames covers a little over 1s of lead-in; trim it down if
    // replies start feeling like they're reacting to dead air.
    preSpeechPadFrames: cfg.VAD_PRE_SPEECH_PAD_FRAMES ?? 12,
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
  });
  vad.start();
}

// Persistent raw-PCM stream from the same monitor source the old timed
// chunks used. PulseAudio monitor sources support multiple simultaneous
// readers, so this runs alongside the separate manual-recording parec
// process fine -- we just drop ambient chunks while manual mode owns the
// turn (see the `manualActive` check below) instead of tearing this down.
function startAmbientStream() {
  // Linux/GNOME: parec streams raw PCM straight off a PulseAudio monitor
  // source (AUDIO_MONITOR_SOURCE, e.g. the sink monitor name from `pactl
  // list sources`). Windows has no PulseAudio/parec, so ffmpeg (already a
  // dependency) captures from a DirectShow audio device instead --
  // AUDIO_MONITOR_SOURCE should then be a device name from
  // `ffmpeg -list_devices true -f dshow -i dummy` (e.g. "Stereo Mix" or a
  // virtual cable's output rendered as a recording device).
  ambientProc = isWindows
    ? spawn("ffmpeg", [
        "-loglevel", "error",
        "-f", "dshow",
        "-i", `audio=${cfg.AUDIO_MONITOR_SOURCE}`,
        "-ac", "1",
        "-ar", "16000",
        "-f", "s16le",
        "pipe:1",
      ])
    : spawn("parec", [
        "--channels=1",
        "--rate=16000",
        "--format=s16le",
        "-d", cfg.AUDIO_MONITOR_SOURCE,
      ]);

  ambientProc.stdout.on("data", (chunk) => {
    if (carryByte !== null) {
      chunk = Buffer.concat([carryByte, chunk]);
      carryByte = null;
    }
    if (chunk.length % 2 !== 0) {
      carryByte = Buffer.from(chunk.subarray(chunk.length - 1));
      chunk = chunk.subarray(0, chunk.length - 1);
    }

    if (manualActive || !vad) return;

    vad.processAudio(int16BufferToFloat32(chunk)).catch((err) => {
      realLog(`[voice] VAD processing error: ${err.message}`);
    });
  });

  ambientProc.on("error", (err) => {
    realLog(`[voice] ambient ${isWindows ? "ffmpeg" : "parec"} failed to start: ${err.message}`);
  });

  ambientProc.on("exit", (code) => {
    ambientProc = null;
    if (running) {
      realLog(`[voice] ambient ${isWindows ? "ffmpeg" : "parec"} exited (code ${code}), restarting...`);
      setTimeout(startAmbientStream, 500);
    }
  });
}

function scheduleNextButtIn() {
  const delay = cfg.BUTTIN_MIN_MS + Math.random() * (cfg.BUTTIN_MAX_MS - cfg.BUTTIN_MIN_MS);
  buttInTimer = setTimeout(runButtInCheck, delay);
}

async function runButtInCheck() {
  if (manualActive) {
    scheduleNextButtIn();
    return;
  }

  const transcript = ambientBuffer.join(" ").trim();
  ambientBuffer = [];

  if (buttInEnabled && transcript) {
    const { reply, error } = await requestReply("ambient", transcript);
    if (!error && reply && reply !== "NONE") {
      realLog(`[voice] butt-in: ${reply}`);
    }
  }

  scheduleNextButtIn();
}

// Toggled by pressing "b" in the terminal.
export function toggleButtIn() {
  buttInEnabled = !buttInEnabled;
  realLog(`[voice] butt-in ${buttInEnabled ? "enabled" : "disabled"}`);
  return buttInEnabled;
}

export function isButtInEnabled() {
  return buttInEnabled;
}

// Toggled by pressing Enter on an empty line. Records with no timer at
// all -- everything said between the two Enter presses gets transcribed
// and sent straight to the brain, bypassing the wake word entirely.
export async function toggleManualRecording() {
  if (manualActive) {
    await stopManualRecording();
  } else {
    startManualRecording();
  }
}

export function isManualRecording() {
  return manualActive;
}

function startManualRecording() {
  if (manualActive) return;
  manualActive = true;

  // hand over the mic if the VAD is mid-way through an ambient utterance
  interruptForManualMode();

  realLog("[voice] manual recording started (press Enter to stop)...");
  setStatus("Listening...");

  manualProc = isWindows
    ? spawn("ffmpeg", [
        "-y",
        "-loglevel", "error",
        "-f", "dshow",
        "-i", `audio=${cfg.AUDIO_MONITOR_SOURCE}`,
        "-ac", "1",
        "-ar", "16000",
        MANUAL_AUDIO_PATH,
      ])
    : spawn("parec", [
        "--file-format=wav",
        "--channels=1",
        "--rate=16000",
        "-d", cfg.AUDIO_MONITOR_SOURCE,
        MANUAL_AUDIO_PATH,
      ]);
  manualProc.on("error", (err) => {
    realLog(`[voice] manual recording failed to start: ${err.message}`);
    manualActive = false;
    manualProc = null;
  });
}

async function stopManualRecording() {
  if (!manualActive || !manualProc) return;
  const proc = manualProc;
  manualProc = null;
  // manualActive stays true through transcription + reply, same as the
  // timed path staying inside its own await chain -- otherwise the ambient
  // stream jumps in and starts feeding a new utterance mid-processing.

  realLog("[voice] manual recording stopped, processing...");
  setStatus("Processing audio...");

  await new Promise((resolve) => {
    proc.once("exit", resolve);
    if (isWindows) {
      // ffmpeg needs a graceful "q" on stdin to finalize the wav file's
      // header/size fields -- SIGTERM would leave it truncated/unreadable.
      proc.stdin.write("q");
    } else {
      proc.kill("SIGTERM");
    }
  });

  const rawText = await transcribe(MANUAL_AUDIO_PATH);
  await unlink(MANUAL_AUDIO_PATH).catch(() => {});
  const text = cleanTranscript(rawText);
  realLog(`[voice] manual heard: "${text}"`);

  if (!text) {
    realLog("[voice] manual recording was empty, nothing to send");
    manualActive = false;
    return;
  }

  realLog(`[voice] input (manual): ${text}`);
  const { reply, error } = await requestReply("user", text, { bypassCooldown: true });
  if (error) {
    realLog(`[voice] manual send skipped: ${error}`);
  } else {
    realLog(`[voice] lily response (manual): ${reply}`);
  }
  manualActive = false;
}

export async function startVoiceListener() {
  running = true;
  await initVad();
  startAmbientStream();
  realLog(`[voice] listening for "${cfg.VOICE_WAKE_WORD}"... (VAD mode)`);
  scheduleNextButtIn();
}

export function stopVoiceListener() {
  running = false;
  if (buttInTimer) clearTimeout(buttInTimer);
  if (ambientProc) ambientProc.kill("SIGTERM");
  if (manualProc) manualProc.kill("SIGTERM");
  if (vad) vad.destroy();
}