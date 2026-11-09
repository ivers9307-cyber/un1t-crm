import { describe, it, expect } from 'vitest'
import { HOST_THEME_COOKIE, HOST_THEMES, hostThemeFromCookie, hostThemeCookieString } from './host-theme'

describe('host theme cookie', () => {
  it('names the cookie and the two explicit themes', () => {
    expect(HOST_THEME_COOKIE).toBe('host_theme')
    expect(HOST_THEMES).toEqual(['light', 'dark'])
  })
  it('reads light and dark and treats anything else as system', () => {
    expect(hostThemeFromCookie('light')).toBe('light')
    expect(hostThemeFromCookie('dark')).toBe('dark')
    for (const v of [undefined, null, '', 'blue', 'system', 'LIGHT']) expect(hostThemeFromCookie(v)).toBe('system')
  })
  it('writes a one-year, site-wide, lax cookie', () => {
    expect(hostThemeCookieString('light')).toBe('host_theme=light; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(hostThemeCookieString('dark')).toBe('host_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax')
  })
})
