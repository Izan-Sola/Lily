import path from 'path'
import { fileURLToPath } from 'url'
import { createConfig } from '../config/loader.js'

// VTubing / YouTube settings (platform, TTS output device, chat batching).
const source = createConfig(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'vtube_config.json'),
    { name: 'vtube_config.json' },
)

export const getVtubeConfig = () => source.get()
export const reloadVtubeConfig = () => source.reload()
