// HOSTTHEME.1 — the host portal's light/dark choice. One cookie, per browser,
// no database. No imports: the toggle (client) and the layouts (server) share it.

export const HOST_THEME_COOKIE = 'host_theme'
export const HOST_THEMES = ['light', 'dark']

// 'system' = the host has not chosen; the CSS follows the device.
export function hostThemeFromCookie(value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function hostThemeCookieString(theme) {
  return `${HOST_THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
}
