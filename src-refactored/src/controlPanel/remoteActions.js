// src/controlPanel/remoteActions.js
//
// Registry of actions the control panel can trigger on a remote host.
// Each action maps to an n8n webhook. Keep webhook URLs in env vars
// so they don't need to be edited when the n8n instance moves.

export const REMOTE_ACTIONS = {
    'health-check': {
        label: 'Health Check',
        webhook:
            process.env.N8N_HEALTH_WEBHOOK ||
            'http://localhost:5678/webhook/health-check',
        timeoutMs: 15 * 60 * 1000,
        description: 'Full system diagnostic + AI review',
    },
    'cleanup': {
        label: 'System Cleanup',
        webhook:
            process.env.N8N_CLEANUP_WEBHOOK ||
            'http://localhost:5678/webhook/cleanup',
        timeoutMs: 20 * 60 * 1000,
        description: 'Non-interactive system cleanup + AI review',
    },
}

export function listActions() {
    return Object.entries(REMOTE_ACTIONS).map(([id, info]) => ({
        id,
        label: info.label,
        description: info.description || '',
    }))
}