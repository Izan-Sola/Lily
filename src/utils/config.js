import dotenv from "dotenv"
dotenv.config()

export const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    ollamaUrl: process.env.OLLAMA_URL,
  //  model: "qwen3.5:9b",               // keep this
    model: "Lily",
    modelName: "Lily",
 //   modelName: "qwen3.5:9b"            // add this for compatibility
};