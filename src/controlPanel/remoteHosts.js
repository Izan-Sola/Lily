// Configure the machines you can trigger the health check on from the panel.
//
// Format:
//   'Display name in panel': {
//       discordId: 'DISCORD_USER_ID',   // gets the health report DM
//       tailscaleIp: 'TAILSCALE_IP',    // use 'local' for the minipc itself
//   }
//
// The key is what shows up in the dropdown. Add as many as you want.

export const REMOTE_HOSTS = {
    'Izan (minipc)': {
        discordId: '572121744253386792',
        tailscaleIp: 'local',
    },
    'Izan (laptop)': {
        discordId: '572121744253386792',
        tailscaleIp: '100.82.135.120',
    },
    'Izan (desktop)': {
        discordId: '572121744253386792',
        tailscaleIp: '100.79.58.32',
    },
    'ThePhantomDX (laptop)': {
        discordId: '612325709691748394',
        tailscaleIp: '100.108.3.123',
    },
}