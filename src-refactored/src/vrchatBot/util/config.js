import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfig } from '../../config/loader.js'

const source = createConfig(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json'),
    { name: 'vrchatBot/util/config.json' },
)

// Property access always reads the current (live-reloaded) config.
export default new Proxy({}, {
    get: (_, prop) => source.get()[prop],
    has: (_, prop) => prop in source.get(),
    ownKeys: () => Reflect.ownKeys(source.get()),
    getOwnPropertyDescriptor: (_, prop) => Object.getOwnPropertyDescriptor(source.get(), prop),
})
