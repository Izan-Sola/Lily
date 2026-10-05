import { Logger } from "../../../../utils/Logger.js"
import { extractChatText } from "./chatText.js"

/**
 * Handles AuthMe-style (or similar) /register + /login plugins.
 * Most cracked servers with those plugins send a chat prompt on join like:
 *   "Please register using /register <password> <password>"
 *   "Please login using /login <password>"
 * and later, once you're registered:
 *   "Please login using /login <password>"
 *
 * This listens for those prompts and responds automatically, AND sends a
 * proactive /register + /login shortly after spawn as a fallback for
 * servers that don't prompt in chat (or prompt via title/actionbar instead,
 * which mineflayer's 'message' event won't catch).
 *
 * If the account is already registered, /register just replies with
 * something like "You are already registered" — harmless, ignored.
 */

const REGISTER_PROMPT = /register|not registered|please register/i
const LOGIN_PROMPT = /login|not logged in|please login|enter.*password/i
const REGISTER_SUCCESS = /successfully registered/i
const LOGIN_SUCCESS = /successfully logged in|logged in successfully/i
const AUTH_FAILURE = /wrong password|invalid password|incorrect password/i

/** @deprecated kept as a thin wrapper — logic now lives in chatText.js so
 * auth.js and whisper.js share one implementation. */
function extractText(jsonMsg) {
    return extractChatText(jsonMsg)
}

export function attachAuthHandler(bot, password, { autoSendDelayMs = 1500 } = {}) {
    if (!password) {
        Logger.warning('No MC_AUTH_PASSWORD set — skipping /register /login handling. If the server requires it, the bot will just sit unregistered.', "AUTH")
        return
    }

    let registered = false
    let loggedIn = false

    const tryRegister = () => {
        if (registered) return
        setTimeout(() => {
            registered = true
            bot.chat(`/register ${password} ${password}`)
            Logger.info('Sent /register', "AUTH")
         }, 800)
      

    }

    const tryLogin = () => {
        if (loggedIn) return
        setTimeout(() => {
        loggedIn = true
        bot.chat(`/login ${password}`)
        Logger.info('Sent /login', "AUTH")
        }, 800)
    }

    bot.on('message', (jsonMsg) => {
        const text = extractText(jsonMsg)
        if (!text) return

        if (LOGIN_SUCCESS.test(text)) {
            Logger.success('Logged in', "AUTH")
            return
        }
        if (REGISTER_SUCCESS.test(text)) {
            Logger.success('Registered — logging in next', "AUTH")
            tryLogin()
            return
        }
        if (AUTH_FAILURE.test(text)) {
            Logger.error(`Auth failed: "${text}" — check MC_AUTH_PASSWORD`, "AUTH")
            return
        }
        // Check register before login — a lot of plugins' unregistered-prompt
        // text also happens to contain the word "login" further down the line.
        if (REGISTER_PROMPT.test(text) && !registered) {
            tryRegister()
            // give /register a moment to land before following up with /login
            setTimeout(tryLogin, 800)
            return
        }
        if (LOGIN_PROMPT.test(text) && !loggedIn) {
            tryLogin()
        }
    })

    bot.on('error', (err) => {
        Logger.error(`Bot error during auth: ${err?.message ?? String(err)}`, "AUTH")
    })

    // Fallback for servers that gate movement/chat instead of prompting,
    // or prompt via a channel mineflayer doesn't see (title/actionbar/GUI).
    setTimeout(() => {
        if (!registered) tryRegister()
        setTimeout(() => { if (!loggedIn) tryLogin() }, 800)
    }, autoSendDelayMs)
}