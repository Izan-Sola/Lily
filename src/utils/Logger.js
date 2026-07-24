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

function sendToLogChannel(message) {
    const truncated = message.length > 3200 ? message.slice(0, 3200) + "..." : message;
    logChannel?.send(`\`\`\`\n${truncated}\n\`\`\``).catch(() => { });
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

function wrapLine(line, width) {
    if (line.length <= width) return [line];
    const words = line.split(" ");
    const wrapped = [];
    let current = "";

    for (const word of words) {
        // wrap text out of the box
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

    // equally distribute dashes left and right no matter the title length
    const sidePad = Math.max(0, BOX_WIDTH - titleTag.length);
    const left = "─".repeat(Math.floor(sidePad / 2));
    const right = "─".repeat(Math.ceil(sidePad / 2));
    const topLine = `${left}${titleTag}${right}`;

    const { bg, fg } = TYPE_STYLE[type] || {};
    const paint = (line) => `       ${bg}${fg}${colors.bold}${padLine(line, BOX_WIDTH)}${colors.reset}`;

    console.log(paint(topLine));

    message.split("\n").forEach(rawLine => {
        wrapLine(rawLine, BOX_WIDTH-4).forEach(line => console.log(paint("    " + line)));
    });

    console.log("");
}

export class Logger {
    static setChannel(channel) {
        logChannel = channel;
    }

    static error(message, title = "ERROR") {
        sendToLogChannel(message);
        drawBox("error", title, message);
    }

    static info(message, title = "INFO") {
        sendToLogChannel(message);
        drawBox("info", title, message);
    }

    static warning(message, title = "WARNING") {
        sendToLogChannel(message);
        drawBox("warning", title, message);
    }

    static success(message, title = "SUCCESS") {
        sendToLogChannel(message);
        drawBox("success", title, message);
    }
}

globalThis.Logger = Logger;

export default Logger;