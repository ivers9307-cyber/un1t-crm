// HOSTTHEME.1 — the host portal's light/dark choice. One cookie, per browser,
// no database. No imports: the toggle (client) and the layouts (server) share it.

export const HOST_THEME_COOKIE = 'host_theme'
export const HOST_THEMES = ['light', 'dark']

// The look a host gets before they have chosen one (HOSTTHEME.2: light, whatever
// the device prefers). The wrapper, the CSS and the toggle still understand
// 'system' (follow the device), but nothing hands it out any more.
export const HOST_THEME_DEFAULT = 'light'

export function hostThemeFromCookie(value) {
  return value === 'light' || value === 'dark' ? value : HOST_THEME_DEFAULT
}

export function hostThemeCookieString(theme) {
  return `${HOST_THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
}
