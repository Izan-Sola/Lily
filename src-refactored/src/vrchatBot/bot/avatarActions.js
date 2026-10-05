import { send } from "../vrchat/osc.js";

// VRChat's default avatar wires up VRCEmote (Int) to 8 built-in actions.
// Sending a value plays that action; the animator does NOT reset the
// parameter back to 0 on its own when the action finishes, so anything
// that loops (dancing, in particular -- also the held poses for sadness
// and dying) will just keep playing forever until something sends 0.
// `holdMs` is how long we let each action run before auto-resetting it.
const VRCEMOTE_ADDRESS = "/avatar/parameters/VRCEmote";

const ACTIONS = {
  wave: { id: 1, holdMs: 3000 },
  clap: { id: 2, holdMs: 2500 },
  point: { id: 3, holdMs: 3000 },
  cheer: { id: 4, holdMs: 3000 },
  dance: { id: 5, holdMs: 8000 }, // loops -- auto-stopped after a few seconds
  backflip: { id: 6, holdMs: 2500 },
  sadness: { id: 7, holdMs: 5000 }, // holds a crying pose -- auto-stopped
  die: { id: 8, holdMs: 5000 }, // holds a lying-down pose -- auto-stopped
};

let resetTimer = null;

export function getActionNames() {
  return Object.keys(ACTIONS);
}

// Triggers a default avatar action over OSC, then schedules VRCEmote back
// to 0 after that action's hold time so nothing plays forever. Returns a
// short string describing what happened, meant to be fed back to the
// brain as the tool's result.
export function triggerAvatarAction(name) {
  const key = String(name ?? "").toLowerCase().trim();
  const action = ACTIONS[key];

  if (!action) {
    return `"${name}" isn't a valid action. Valid actions: ${getActionNames().join(", ")}.`;
  }

  if (resetTimer) clearTimeout(resetTimer);

  // VRCEmote only replays an animation when its value actually CHANGES --
  // if it's already sitting on this id (e.g. same action fired again
  // before the previous hold timer reset it), sending the same int again
  // is a no-op and nothing plays. Force it through 0 first so every
  // trigger is a guaranteed value change, then set the real target.
  send(VRCEMOTE_ADDRESS, [{ type: "i", value: 0 }]);
  setTimeout(() => {
    send(VRCEMOTE_ADDRESS, [{ type: "i", value: action.id }]);
  }, 50);

  resetTimer = setTimeout(() => {
    send(VRCEMOTE_ADDRESS, [{ type: "i", value: 0 }]);
    resetTimer = null;
  }, action.holdMs + 50);

  return `Triggered the "${key}" avatar action.`;
}

// Same as triggerAvatarAction, but looked up by the numeric VRCEmote id
// (1-8) instead of the name. Used by the CLI's number-key test bindings
// so pressing "5" fires whatever action currently owns id 5, without
// hardcoding name<->key assumptions in index.js.
export function triggerAvatarActionById(id) {
  const entry = Object.entries(ACTIONS).find(([, action]) => action.id === id);
  if (!entry) {
    return `No avatar action with id ${id}. Valid ids: ${Object.values(ACTIONS).map(a => a.id).join(", ")}.`;
  }
  return triggerAvatarAction(entry[0]);
}