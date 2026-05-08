import dotenv from "dotenv"
dotenv.config()

export const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    ollamaUrl: process.env.OLLAMA_URL,
    model: "Lily",               // keep this
    modelName: "Lily"            // add this for compatibility
};