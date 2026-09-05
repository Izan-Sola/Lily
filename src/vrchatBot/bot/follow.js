import cfg from "../util/config.js";
import { send, onOscMessage, setAxis } from "../vrchat/osc.js";

const realLog = (msg) => process.stdout.write(msg + "\n");

// Direction -> OSC input address for VRChat's button-style movement
// inputs (same convention cli.js already uses for MoveForward).
const MOVE_ADDRESSES = {
  forward: "/input/MoveForward",
  backward: "/input/MoveBackward",
  left: "/input/MoveLeft",
  right: "/input/MoveRight",
};

// Reads each Contact Receiver's parameter name live from config.json, so
// renaming them in Unity only means updating config.json -- not this file.
// e.g. set FOLLOW_PARAM_FRONT: "MyOtherName" in config.json to override.
function paramAddress(key) {
  return `/avatar/parameters/${key}`;
}

function paramAddresses() {
  return {
    center: "/avatar/parameters/ProximityToCenter",
    front: "/avatar/parameters/ProximityToFront",
    back: "/avatar/parameters/ProximityToBack",
    left: "/avatar/parameters/ProximityToLeft",
    right: "/avatar/parameters/ProximityToRight",
  };
}

// Latest known 0-1 proximity value per direction. VRChat's Proximity
// receivers report 0 at the shape's edge/outside and 1 at dead center, and
// only send an OSC update when a value actually changes -- so these just
// hold whatever was last heard until the next change comes in.
const proximity = { center: 0, front: 0, back: 0, left: 0, right: 0 };

// Whether she's currently mid-walk toward you. Hysteresis between
// FOLLOW_START_RANGE and FOLLOW_STOP_RANGE (see tick()) keeps this from
// flapping on/off right at the boundary between the two thresholds.
let followingActive = false;

// Master on/off switch for the whole feature -- toggled with 'f' in the
// terminal. Independent of followingActive: this is "is following allowed
// to run at all", that's "is she walking right this second".
let followFeatureEnabled = cfg.FOLLOW_ENABLED_ON_START ?? true;

let tickTimer = null;
const buttonState = { forward: false, backward: false, left: false, right: false };
let runState = false;
let lastSentTurn = 0;

function setMoveInput(key, active) {
  if (buttonState[key] === active) return; // only send on actual change, don't spam OSC every tick
  buttonState[key] = active;
  send(MOVE_ADDRESSES[key], [{ type: "i", value: active ? 1 : 0 }]);
}

function stopAllMovement() {
  Object.keys(MOVE_ADDRESSES).forEach((key) => setMoveInput(key, false));
}

function setRunning(desired) {
  if (runState === desired) return;
  runState = desired;
  send("/input/Run", [{ type: "i", value: desired ? 1 : 0 }]);
}
// LookHorizontal is a continuous float axis. Only the repeated-zero case is
// worth deduping (avoid spamming 0 while idle) -- any non-zero value gets
// resent every tick, since VRChat's OSC input appears to treat this as a
// held-axis signal that needs continuous refreshing rather than a value
// that persists on its own once set.
function setLookTurn(value) {
  if (value === 0 && lastSentTurn === 0) return;
  lastSentTurn = value;
  setAxis("/input/LookHorizontal", value);
 // realLog(`[follow] turn -> ${value.toFixed(3)}`);
}

function stopEverything() {
  stopAllMovement();
  setLookTurn(0);
  setRunning(false);
}

function tick() {
  if (!followFeatureEnabled) return;

  const stopRange = cfg.FOLLOW_STOP_RANGE ?? 0.55;
  const startRange = cfg.FOLLOW_START_RANGE ?? 0.15;
  const deadzone = cfg.FOLLOW_DIRECTION_DEADZONE ?? 0.05;

  if (followingActive) {
    if (proximity.center >= stopRange) {
      followingActive = false;
      stopAllMovement();
      setRunning(false);
     // realLog("[follow] close enough, stopping");
    }
  } else if (proximity.center <= startRange) {
    followingActive = true;
  //  realLog("[follow] too far, starting to follow");
  }

  const forwardSignal = proximity.front - proximity.back;
  const strafeSignal = proximity.right - proximity.left;

  if (followingActive) {
    setMoveInput("forward", forwardSignal > deadzone);
    setMoveInput("backward", forwardSignal < -deadzone);
    setMoveInput("left", strafeSignal > deadzone);
    setMoveInput("right", strafeSignal < -deadzone);
    setRunning(cfg.FOLLOW_RUN_ENABLED ?? true);
  } else {
    stopAllMovement();
    setRunning(false);
  }

  // Facing now runs every tick, regardless of followingActive, so she
  // keeps turning to face you even after she's stopped walking.
  const turnSpeed = cfg.FOLLOW_TURN_SPEED ?? 0.6;
  const turnInvert = cfg.FOLLOW_TURN_INVERT ?? false;
  if (Math.abs(strafeSignal) > deadzone) {
    let turnValue = strafeSignal > 0 ? 1 : -1;
    if (turnInvert) turnValue *= -1;
    setLookTurn(turnValue);
   // realLog(`[follow] TEST turn -> ${turnValue}`);
  } else {
    setLookTurn(0);
  }
}

function handleOscMessage(msg) {
  const addrs = paramAddresses();
  const value = Array.isArray(msg.args) ? msg.args[0] : msg.args;
  if (typeof value !== "number") return;

  for (const [key, addr] of Object.entries(addrs)) {
    if (msg.address === addr) {
      proximity[key] = value;
      return;
    }
  }
}

export function initFollow() {
  onOscMessage(handleOscMessage);
  const intervalMs = cfg.FOLLOW_TICK_MS ?? 150;
  tickTimer = setInterval(tick, intervalMs);
//  realLog(`[follow] initialized, ${followFeatureEnabled ? "enabled" : "disabled"} on start`);
}

export function stopFollow() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  stopEverything();
}

// Toggled by pressing 'f' in the terminal.
export function toggleFollowFeature() {
  followFeatureEnabled = !followFeatureEnabled;
  if (!followFeatureEnabled) {
    followingActive = false;
    stopEverything();
  }
  //realLog(`[follow] feature ${followFeatureEnabled ? "enabled" : "disabled"}`);
  return followFeatureEnabled;
}

export function isFollowFeatureEnabled() {
  return followFeatureEnabled;
}

export function isCurrentlyFollowing() {
  return followingActive;
}

export function getProximitySnapshot() {
  return { ...proximity };
}