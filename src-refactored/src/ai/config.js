import path from "path"
import { fileURLToPath } from "url"
import { createConfig } from "../config/loader.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fallbacks so a missing key in config.json never turns into NaN/undefined
// at runtime. Only sections this folder reads are listed; the rest of
// config.json (llama, voice, controlPanel, remoteHosts, ...) belongs to
// other modules.
const SECTION_DEFAULTS = {
    discord: { discordUserID: null },
    llm: {
        agentMaxTokens: 8000, agentTemperature: 0.15,
        summaryTemperature: 0.3, summaryMaxTokens: 300,
        maxRetries: 6, duelMaxTokens: 120, budgetFallbackRepeatPenalty: 1.3,
        presencePenaltyMinecraft: 0, repeatLastNMinecraft: 64,
    },
    toolLimits: {
        memoryQuery: 10, memoryWrite: 10, media: 10, webSearch: 10,
        total: 10, narration: 10, badArgs: 10,
        maxDropsPerCall: 64, maxAmount: 32, maxCraftQuantity: 64,
    },
    search: {
        tavilyMaxResults: 3, tavilyIncludeImages: true,
        klipyPerPage: 10, klipyCustomerId: "lily-bot", klipyPickPool: 8,
    },
    timeouts: {
        piMs: 90000, screenshotMs: 15000, fileAppearMs: 3000, fileAppearPollMs: 100,
        companionRequestMs: 5000, askUserMs: 120000, approvalTtlMs: 600000,
        blogPushMs: 3000, mineCooldownMs: 9000, dropDelayMs: 250, mineBatchDelayMs: 1500,
        vtubeExpressionCooldownMs: 800, channelLockPollMs: 50, workingMemorySaveDebounceMs: 1000,
    },
    memory: {
        workingMemoryStorePath: "./working_memory.json",
        maxPeople: 8, maxThreads: 6, maxLen: 140,
        presenceTtlMs: 2700000, threadTtlMs: 21600000,
        explicitMinWords: 2, explicitMaxLen: 150,
        recentLimit: 10, recentMinImportance: 0.3, lookupEntityLimit: 20,
    },
    paths: { flawlessTurnsDir: "./data/flawless_turns" },
}

const source = createConfig(path.join(__dirname, "config.json"), { defaults: SECTION_DEFAULTS, name: "ai/config.json" })

// Cached + live-reloaded. Treat the result as read-only.
export const getConfig = () => source.get()

// getSection("llm") -> config.json's "llm" block layered over the defaults.
export const getSection = name => source.section(name)

// Owner Discord ID, used for the trusted-DM check.
export const getOwnerId = () => getSection("discord").discordUserID
