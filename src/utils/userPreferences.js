import fs from "fs"

const PREFS_PATH = "./data/user_preferences.json"

function load() {
    if (!fs.existsSync(PREFS_PATH)) return {}
    return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"))
}

function save(data) {
    fs.mkdirSync("./data", { recursive: true })
    fs.writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2))
}

export function getPrefs(userId) {
    const all = load()
    return all[userId] ?? {
        spontaneousReplies: true,   // lily can randomly reply to their messages
        pingOnSpontaneous: true,    // lily pings them when doing so
        voiceProcess: true,          // lily listens to them in voice
        wakeWordRequired: true,     // lily only responds to wake word in voice
    }
}

export function setPrefs(userId, updates) {
    const all = load()
    all[userId] = { ...getPrefs(userId), ...updates }
    save(all)
    return all[userId]
}