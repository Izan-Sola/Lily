import axios from "axios";

let logChannel = null;

export async function initLogChannel(client) {
    for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.find(c => c.name === "hylily-livechat-logs" && c.isTextBased());
        if (ch) {
            logChannel = ch;
            Logger.info(`Log channel found: #${ch.name} in ${guild.name}`, "LOGGER");
            break;
        }
    }
    if (!logChannel) Logger.warning("No hylily-livechat-logs channel found", "LOGGER");
}

const DISCORD_ANSI = {
    reset: "\u001b[0m",
    bold: "\u001b[1m",
    red: "\u001b[1;31m",
    green: "\u001b[1;32m",
    yellow: "\u001b[1;33m",
    cyan: "\u001b[1;36m",
};

const TYPE_ANSI = {
    error: DISCORD_ANSI.red,
    warning: DISCORD_ANSI.yellow,
    info: DISCORD_ANSI.cyan,
    success: DISCORD_ANSI.green,
}

// discord logs
function sendToLogChannel(message, type = "info", title = "") {
    const truncated = message.length > 3200 ? message.slice(0, 3200) + "..." : message;
    const color = TYPE_ANSI[type] || DISCORD_ANSI.cyan;
    const header = title ? `[ ${title} ]\n` : "";
    const colored = `${color}${header}${truncated}${DISCORD_ANSI.reset}`;

    logChannel?.send(`\`\`\`ansi\n${colored}\n\`\`\``).catch(() => { });
    axios.post("http://localhost:1234/log", { msg: truncated }, { timeout: 2000 }).catch(() => { });
}

const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    black: "\x1b[38;5;16m",
    white: "\x1b[38;5;255m",
    bg_light_red: "\x1b[48;5;204m",
    bg_light_yellow: "\x1b[48;5;214m",
    bg_light_blue: "\x1b[48;5;110m",
    bg_light_green: "\x1b[48;5;114m",
};

const TYPE_STYLE = {
    error: { bg: colors.bg_light_red, fg: colors.white },
    warning: { bg: colors.bg_light_yellow, fg: colors.black },
    info: { bg: colors.bg_light_blue, fg: colors.black },
    success: { bg: colors.bg_light_green, fg: colors.black },
};

const BOX_WIDTH = 79;
const LEFT_INDENT = 4;
const RIGHT_MARGIN = 4;
const CONTENT_WIDTH = BOX_WIDTH - LEFT_INDENT - RIGHT_MARGIN;

function wrapLine(line, width) {
    if (line.length <= width) return [line];
    const words = line.split(" ");
    const wrapped = [];
    let current = "";

    for (const word of words) {
        if (word.length > width) {
            if (current) {
                wrapped.push(current);
                current = "";
            }
            for (let i = 0; i < word.length; i += width) {
                wrapped.push(word.slice(i, i + width));
            }
            continue;
        }

        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length > width) {
            wrapped.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) wrapped.push(current);
    return wrapped;
}

function padLine(line, width) {
    return line.length >= width ? line : line + " ".repeat(width - line.length);
}

function drawBox(type, title, message) {
    const titleTag = ` [ ${title} ] `;
    const sidePad = Math.max(0, BOX_WIDTH - titleTag.length);
    const left = "─".repeat(Math.floor(sidePad / 2));
    const right = "─".repeat(Math.ceil(sidePad / 2));
    const topLine = `${left}${titleTag}${right}`;

    const { bg, fg } = TYPE_STYLE[type] || {};
    const paint = (line) => `       ${bg}${fg}${colors.bold}${padLine(line, BOX_WIDTH)}${colors.reset}`;

    console.log(paint(topLine));

    message.split("\n").forEach(rawLine => {
        wrapLine(rawLine, CONTENT_WIDTH).forEach(line => {
            console.log(paint(" ".repeat(LEFT_INDENT) + line));
        });
    });

    console.log("");
}

export class Logger {
    static setChannel(channel) {
        logChannel = channel;
    }

    static error(message, title = "ERROR") {
        sendToLogChannel(message, "error", title);
        drawBox("error", title, message);
    }

    static info(message, title = "INFO") {
        sendToLogChannel(message, "info", title);
        drawBox("info", title, message);
    }

    static warning(message, title = "WARNING") {
        sendToLogChannel(message, "warning", title);
        drawBox("warning", title, message);
    }

    static success(message, title = "SUCCESS") {
        sendToLogChannel(message, "success", title);
        drawBox("success", title, message);
    }
}

globalThis.Logger = Logger;

export default Logger;