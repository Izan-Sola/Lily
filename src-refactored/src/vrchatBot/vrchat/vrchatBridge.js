import { spawn, spawnSync } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import cfg from "../util/config.js";

const realLog = (msg) => process.stdout.write(msg + "\n");

const API_BASE = "https://api.vrchat.cloud/api/1";
// VRChat's API policy wants a descriptive User-Agent with contact info --
// generic ones get rate-limited harder. Override via config if you want.
const USER_AGENT = cfg.VRCHAT_USER_AGENT || "LilyVRBridge/1.0 contact@example.com";
const SESSION_PATH = cfg.VRCHAT_SESSION_PATH || "./.vrchat_session.json";

// Cookie jar. VRChat auth is old-school cookie-based (an "auth" cookie,
// briefly a "twoFactorAuth" cookie mid-login) -- there's no OAuth flow.
const cookies = new Map();

let ws = null;
let reconnectTimer = null;
let autoJoinEnabled = cfg.VRCHAT_AUTOJOIN_ON_START ?? true;

function storeCookiesFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeaderString() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function loadSession() {
  try {
    const raw = await readFile(SESSION_PATH, "utf-8");
    for (const [k, v] of Object.entries(JSON.parse(raw))) cookies.set(k, v);
  } catch {
    // no saved session yet -- fine, ensureLoggedIn() will do a fresh login
  }
}

async function saveSession() {
  try {
    await writeFile(SESSION_PATH, JSON.stringify(Object.fromEntries(cookies)), "utf-8");
  } catch (err) {
    realLog(`[vrchat] couldn't persist session: ${err.message}`);
  }
}

// Reuses a saved cookie if it's still valid, so this doesn't hit VRChat's
// login rate limit on every restart.
async function verifySession() {
  if (!cookies.has("auth")) return false;
  const res = await fetch(`${API_BASE}/auth/user`, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookieHeaderString() },
  });
  storeCookiesFrom(res);
  if (!res.ok) return false;
  const data = await res.json();
  return Boolean(data?.id);
}
async function inviteSelf(location) {
  const sep = location.indexOf(":");
  const worldId = location.slice(0, sep);
  const instanceId = location.slice(sep + 1);
  const res = await fetch(`${API_BASE}/invite/myself/to/${worldId}:${encodeURIComponent(instanceId)}`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Cookie: cookieHeaderString() },
  });
  storeCookiesFrom(res);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`invite-self failed: ${res.status} ${res.statusText} -- ${body}`);
  }
}
async function rawLogin() {
  const basic = Buffer.from(
    `${encodeURIComponent(cfg.VRCHAT_USERNAME)}:${encodeURIComponent(cfg.VRCHAT_PASSWORD)}`
  ).toString("base64");
  const res = await fetch(`${API_BASE}/auth/user`, {
    headers: { "User-Agent": USER_AGENT, Authorization: `Basic ${basic}` },
  });
  storeCookiesFrom(res);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`login failed: ${res.status} ${res.statusText} -- ${body}`);
  }
  return res.json();
}

// method is one of VRChat's requiresTwoFactorAuth values: "totp", "otp"
// (recovery codes), or "emailOtp".
async function getTwoFactorCode(method) {
  if (method === "totp" && cfg.VRCHAT_TOTP_SECRET) {
    const { generate } = await import("otplib");
    const secret = cfg.VRCHAT_TOTP_SECRET.replace(/\s+/g, "").toUpperCase();
    return generate({ secret });
  }
  throw new Error(
    `2FA required (${method}) but no VRCHAT_TOTP_SECRET is set in config.json -- ` +
    `either set that (your authenticator app's setup secret, not a single code), ` +
    `or log in once yourself and copy the resulting "auth" cookie value into ${SESSION_PATH} ` +
    `as {"auth": "..."}`
  );
}

async function verifyTwoFactor(method, code) {
  const endpoint = method === "emailOtp" ? "emailotp" : method;
  const res = await fetch(`${API_BASE}/auth/twofactorauth/${endpoint}/verify`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Cookie: cookieHeaderString() },
    body: JSON.stringify({ code }),
  });
  storeCookiesFrom(res);
  if (!res.ok) throw new Error(`2FA verification failed: ${res.status} ${res.statusText}`);
}

async function ensureLoggedIn() {
  await loadSession();
  if (await verifySession()) {
    realLog("[vrchat] reusing saved session");
    return;
  }

  realLog("[vrchat] logging in...");
  const data = await rawLogin();
  if (data.requiresTwoFactorAuth?.length) {
    const method = data.requiresTwoFactorAuth.includes("totp") ? "totp" : data.requiresTwoFactorAuth[0];
    await verifyTwoFactor(method, await getTwoFactorCode(method));
  }
  await saveSession();
  realLog("[vrchat] logged in");
}

// Best-effort parse -- VRChat doesn't publish a formal schema for
// NotificationDetailInvite. Community bots/tools read the join location
// out of details.worldId, which for a real invite holds the FULL
// "wrld_xxx:instanceId~params..." string, not just the world's GUID. The
// debug log in handleInviteNotification() prints the raw shape the first
// few times so you can confirm/adjust this if VRChat's changed it.
function extractLocation(details) {
  const worldId = details?.worldId;
  if (typeof worldId === "string" && worldId.includes(":")) return worldId;
  return null;
}

// --- Launch invocation -----------------------------------------------
//
// This is the fiddly part. What actually works differs a lot by platform:
//
// WINDOWS: the native VRChat installer registers the vrchat:// scheme for
// you, and an already-running instance picks up new launch args via its
// own Windows IPC. `start "" "<url>"` just works.
//
// LINUX/PROTON: there is no shortcut here. `xdg-open` + a registered
// .desktop handler technically fires, but Steam's `-applaunch` against an
// *already-running* game just refocuses the window -- it never forwards
// the new URI to the game process at all. The only way that actually
// works is invoking VRChat's own `launch.exe` directly through Proton
// (bypassing Steam's applaunch shortcut entirely), with
// STEAM_COMPAT_DATA_PATH / STEAM_COMPAT_CLIENT_INSTALL_PATH set so Proton
// can find your existing prefix and Steam session. Going straight to
// VRChat.exe instead of launch.exe skips VRChat's own Steam-ticket
// handshake and drops you into offline testing mode, which can't travel
// to online worlds -- launch.exe is required.
//
// All of the paths below are configurable in config.json because every
// install differs (distro package vs. manual Steam install, custom
// library folders, non-default Proton version, etc). Defaults assume a
// fairly standard manual Steam install under ~/.local/share/Steam.

const VRCHAT_APP_ID = String(cfg.VRCHAT_STEAM_APP_ID || "438100");

function defaultSteamRoot() {
  return path.join(os.homedir(), ".local", "share", "Steam");
}

function resolveLinuxLaunchPaths() {
  const steamRoot = cfg.VRCHAT_STEAM_ROOT || defaultSteamRoot();

  const protonPath = cfg.VRCHAT_PROTON_PATH
    || path.join(steamRoot, "steamapps", "common", "Proton 10.0", "proton");

  const compatDataPath = cfg.VRCHAT_STEAM_COMPAT_DATA_PATH
    || path.join(steamRoot, "steamapps", "compatdata", VRCHAT_APP_ID);

  const compatClientInstallPath = cfg.VRCHAT_STEAM_COMPAT_CLIENT_INSTALL_PATH
    || steamRoot;

  const launchExePath = cfg.VRCHAT_LAUNCH_EXE_PATH
    || path.join(steamRoot, "steamapps", "common", "VRChat", "launch.exe");

  return { protonPath, compatDataPath, compatClientInstallPath, launchExePath };
}

// Returns { file, args, options } suitable for child_process.spawn(),
// or throws if required paths are missing so the caller can log clearly
// instead of failing silently deep inside spawn().
function buildLaunchInvocation(url) {
  const platform = String(cfg.PLATFORM || "GNOME").toUpperCase();

  if (platform === "WINDOWS") {
    // `start` is a cmd.exe builtin, not a real executable -- has to go
    // through cmd.exe /c. The empty "" is the (required) window title arg.
    return { file: "cmd.exe", args: ["/c", "start", "", url], options: {} };
  }

  // Linux / Proton path.
  const { protonPath, compatDataPath, compatClientInstallPath, launchExePath } = resolveLinuxLaunchPaths();

  for (const [label, p] of [
    ["VRCHAT_PROTON_PATH", protonPath],
    ["VRCHAT_STEAM_COMPAT_DATA_PATH", compatDataPath],
    ["VRCHAT_LAUNCH_EXE_PATH", launchExePath],
  ]) {
    if (!existsSync(p)) {
      throw new Error(
        `${label} does not exist: ${p} -- set it explicitly in config.json if your ` +
        `Steam/Proton/VRChat install lives somewhere non-default`
      );
    }
  }

  return {
    file: protonPath,
    args: ["run", launchExePath, url],
    options: {
      env: {
        ...process.env,
        STEAM_COMPAT_DATA_PATH: compatDataPath,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: compatClientInstallPath,
      },
    },
  };
}

// --- Kill-and-cold-relaunch (Linux only) ------------------------------
//
// Confirmed empirically: invoking launch.exe through Proton while VRChat
// is ALREADY running does not hot-swap the existing session into the new
// world the way native Windows does (Windows VRChat detects the second
// launch attempt and forwards the join over its own IPC to the running
// instance). Under Proton it just spins up a second, fully separate
// VRChat process -- a disconnected "ghost" client with no OSC binding to
// your actual bot logic, while the original session keeps running
// untouched.
//
// So on Linux, the only way to actually land in the new world with zero
// manual clicks is to close the existing instance first and cold-launch
// straight into the target world -- cold launches DO honor the URI
// correctly, as verified. It's more disruptive (the game visibly
// restarts) but it's the only path that's actually correct here.
//
// Set VRCHAT_KILL_BEFORE_JOIN: false in config.json to skip this (e.g.
// if a future Proton/VRChat build fixes hot-swapping and you'd rather
// try that first).
function isVrchatRunningLinux() {
  const res = spawnSync("pgrep", ["-f", "VRChat.exe"]);
  return res.status === 0;
}

async function killExistingVrchatLinux() {
  if (!isVrchatRunningLinux()) return;

  realLog("[vrchat] an instance is already running -- closing it first (Proton can't hot-swap instances, only cold-launch into them correctly)");
  spawnSync("pkill", ["-f", "VRChat.exe"]);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!isVrchatRunningLinux()) {
      realLog("[vrchat] previous instance closed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  realLog("[vrchat] warning: previous instance didn't fully exit within 15s, launching anyway");
}

async function handleInviteNotification(content) {
  if (cfg.VRCHAT_TRUSTED_INVITERS_IDS && !cfg.VRCHAT_TRUSTED_INVITERS_IDS.includes(content.senderUserId)) {
    realLog(`[vrchat] ignoring invite from ${content.senderUserId} (not a trusted inviter)`);
    return;
  }
  if (!autoJoinEnabled) {
    realLog("[vrchat] invite received but auto-join is toggled off");
    return;
  }

  let details = content.details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { details = {}; }
  }
  realLog(`[vrchat] invite details: ${JSON.stringify(details)}`);

  const location = extractLocation(details);
  if (!location) {
    realLog("[vrchat] couldn't find a joinable location in this invite, skipping auto-join");
    return;
  }

  // IMPORTANT: do NOT encodeURIComponent() the whole location. VRChat's
  // launch URI parser expects the worldId:instanceId colon -- and the
  // ~tag(...) segments -- literally. encodeURIComponent turns ":" into
  // "%3A", which VRChat silently fails to parse (no error, just a no-op).
  // The location string comes from VRChat's own invite payload, not
  // untrusted user input, so it's safe to interpolate as-is.
  const url = `vrchat://launch?ref=vrchat.com&id=${location}`;
  realLog(`[vrchat] auto-joining: ${location}`);
  realLog(`[vrchat] launch url: ${url}`);

  let invocation;
  try {
    invocation = buildLaunchInvocation(url);
  } catch (err) {
    realLog(`[vrchat] couldn't build launch command: ${err.message}`);
    inviteSelf(location).catch((e) => realLog(`[vrchat] self-invite fallback failed: ${e.message}`));
    return;
  }

  const platform = String(cfg.PLATFORM || "GNOME").toUpperCase();
  if (platform !== "WINDOWS" && cfg.VRCHAT_KILL_BEFORE_JOIN !== false) {
    await killExistingVrchatLinux();
  }

  // Fire-and-forget: on a cold launch this process is the whole VRChat
  // session and won't exit for hours, so we don't wait around for it --
  // just detach it and move on. We still listen for an immediate spawn
  // error (bad path, ENOENT, etc), which fires fast if something's wrong.
  const child = spawn(invocation.file, invocation.args, {
    ...invocation.options,
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (err) => {
    realLog(`[vrchat] launch command failed: ${err.message}`);
    inviteSelf(location).catch((e) => realLog(`[vrchat] self-invite fallback failed: ${e.message}`));
  });
  child.unref();
  realLog("[vrchat] launch command issued");
}

function connectPipeline() {
  const authToken = cookies.get("auth");
  if (!authToken) {
    realLog("[vrchat] no auth token, can't open pipeline websocket");
    return;
  }

  ws = new WebSocket(`wss://pipeline.vrchat.cloud/?authToken=${authToken}`, {
    headers: { "User-Agent": USER_AGENT },
  });

  ws.on("open", () => realLog("[vrchat] pipeline connected"));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "notification") return;

    let content = msg.content;
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch { return; }
    }
    if (content?.type === "invite") {
      handleInviteNotification(content).catch((err) => realLog(`[vrchat] invite handling failed: ${err.message}`));
    }
  });

  ws.on("close", () => {
    realLog("[vrchat] pipeline closed, reconnecting in 5s...");
    reconnectTimer = setTimeout(connectPipeline, 5000);
  });

  ws.on("error", (err) => realLog(`[vrchat] pipeline error: ${err.message}`));
}

export async function initVrchatAutoJoin() {
  if (!cfg.VRCHAT_USERNAME || !cfg.VRCHAT_PASSWORD) {
    realLog("[vrchat] VRCHAT_USERNAME/VRCHAT_PASSWORD not set in config.json, auto-join disabled");
    return;
  }
  try {
    await ensureLoggedIn();
    connectPipeline();
  } catch (err) {
    realLog(`[vrchat] setup failed: ${err.message}`);
  }
}

export function stopVrchatAutoJoin() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
}

// Toggled by pressing 'j' in the terminal.
export function toggleAutoJoin() {
  autoJoinEnabled = !autoJoinEnabled;
  realLog(`[vrchat] auto-join ${autoJoinEnabled ? "enabled" : "disabled"}`);
  return autoJoinEnabled;
}

export function isAutoJoinEnabled() {
  return autoJoinEnabled;
}
