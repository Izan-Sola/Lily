import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, "config.json")

export function getConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
}