import axios from "axios"

// Set this externally (e.g. Logger.logChannel = someDiscordChannel)
let logChannel = "hylily-livechat-logs";


export async function initLogChannel(client) {
    for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.find(c => c.name === "hylily-livechat-logs" && c.isTextBased())
        if (ch) {
            logChannel = ch
            Logger.info(`📋 [LOGS] Log channel found: #${ch.name} in ${guild.name}`)
            break
        }
    }
    if (!logChannel) console.warn("⚠️ [LOGS] No hylily-livechat-logs channel found")
}

export function log(message) { console.log(message); sendToLogChannel(message) }
export function logError(message) { console.error(message); sendToLogChannel(`❌ ${message}`) }
 
function sendToLogChannel(message) {
    const truncated = message.length > 3200 ? message.slice(0, 3200) + "..." : message
    logChannel?.send(`\`\`\`\n${truncated}\n\`\`\``).catch(() => { })
    axios.post("http://localhost:1234/log", { msg: truncated }, { timeout: 2000 }).catch(() => { })
}

export class Logger {

    static error(message) {
        sendToLogChannel(message);
        console.error(message);
    }

    static info(message) {
        sendToLogChannel(message);
        console.info(message);
    }

    static warning(message) {
        sendToLogChannel(message);
        console.warn(message);
    }

    static success(message) {
        sendToLogChannel(message);
        console.log(message);
    }
}
