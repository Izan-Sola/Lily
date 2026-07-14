import dotenv from "dotenv"
dotenv.config()

export const config = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    ollamaUrl: process.env.OLLAMA_URL,
    model: "Lily",
    modelName: "Lily",
    bannedUsers: ["not pikarohan", "pikarohan", "_helixer_",
                  "H-Elixer", "[H-Elixer]", "IsGone", "isgone_forever",
                  "rottenpotato001", "_RottenPotato_[BetweenTheOffice]"]
};
  //  model: "qwen3.5:9b",               // keep this
 //   modelName: "qwen3.5:9b"            // add this for compatibility