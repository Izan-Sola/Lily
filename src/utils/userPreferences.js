import fs from "fs"

const PREFS_PATH = "./data/user_preferences.json"

const DEFAULTS = {
    spontaneousReplies: true,   // lily can randomly reply to their messages
    pingOnSpontaneous: true,    // lily pings them when doing so
    voiceProcess: true,         // lily listens to them in voice
    wakeWordRequired: true,     // lily only responds to wake word in voice
}

let store = null

function all() {
    store ??= fs.existsSync(PREFS_PATH) ? JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) : {}
    return store
}

export function getPrefs(userId) {
    return all()[userId] ?? { ...DEFAULTS }
}

export function setPrefs(userId, updates) {
    const data = all()
    data[userId] = { ...getPrefs(userId), ...updates }
    fs.mkdirSync("./data", { recursive: true })
    fs.writeFileSync(PREFS_PATH, JSON.stringify(data, null, 2))
    return data[userId]
}
