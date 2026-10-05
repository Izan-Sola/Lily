import axios from 'axios'
import { Logger } from '../utils/Logger.js'
import { getSection } from './config.js'

// Fire-and-forget: mirrors the plain-text part of a channel's history to the blog.
export function pushHistoryToBlog(blogUrl, channelId, history) {
    const messages = history
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content.trim() }))
    if (!messages.length) return

    axios.post(`${blogUrl}/api/history`, { channelId, messages }, { timeout: getSection('timeouts').blogPushMs })
        .catch(err => Logger.error(`Push failed (non-fatal): ${err.message}`, 'BLOG HISTORY'))
}
