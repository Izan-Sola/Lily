import { readFileSync, watch } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

let cache = {};
let debounceTimer = null;

function loadConfigFile() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[config] failed to read/parse config.json, keeping previous values: ${err.message}`);
    return null;
  }
}

// Initial load is synchronous -- every other module does `import cfg from
// "./config.js"` and expects values to be ready immediately, so this can't
// be deferred to an async read.
cache = loadConfigFile() ?? {};
console.log("[config] loaded config.json");

// Live reload: watch the file and swap `cache` whenever it changes, so
// edits to config.json (including `context`) take effect without
// restarting the app.
function watchConfig() {
  try {
    const watcher = watch(CONFIG_PATH, (eventType) => {
      // Editors often fire several events (and some replace the file via a
      // temp-file + rename) for a single save -- debounce and re-arm.
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = loadConfigFile();
        if (next) {
          cache = next;
          console.log("[config] config.json changed, reloaded");
        }
      }, 150);

      if (eventType === "rename") {
        watcher.close();
        setTimeout(watchConfig, 150);
      }
    });
  } catch (err) {
    console.error(`[config] could not watch config.json for live reload: ${err.message}`);
  }
}
watchConfig();

// A Proxy keeps every existing `cfg.SOMETHING` access across the codebase
// working exactly as before, but each access now reads the current
// `cache` instead of a value frozen at import time.
const cfg = new Proxy(
  {},
  {
    get(_target, prop) {
      return cache[prop];
    },
    has(_target, prop) {
      return prop in cache;
    },
    ownKeys() {
      return Reflect.ownKeys(cache);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(cache, prop);
    },
  }
);

export default cfg;