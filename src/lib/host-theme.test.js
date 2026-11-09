import { describe, it, expect } from 'vitest'
import { HOST_THEME_COOKIE, HOST_THEMES, HOST_THEME_DEFAULT, hostThemeFromCookie, hostThemeCookieString } from './host-theme'

describe('host theme cookie', () => {
  it('names the cookie and the two explicit themes', () => {
    expect(HOST_THEME_COOKIE).toBe('host_theme')
    expect(HOST_THEMES).toEqual(['light', 'dark'])
  })
  it('reads light and dark, and gives light to a host who has not chosen (HOSTTHEME.2)', () => {
    expect(HOST_THEME_DEFAULT).toBe('light')
    expect(hostThemeFromCookie('light')).toBe('light')
    expect(hostThemeFromCookie('dark')).toBe('dark')
    // No cookie, a junk value, or the retired 'system': light, never the device's preference.
    for (const v of [undefined, null, '', 'blue', 'system', 'LIGHT']) expect(hostThemeFromCookie(v)).toBe('light')
  })
  it('writes a one-year, site-wide, lax cookie', () => {
    expect(hostThemeCookieString('light')).toBe('host_theme=light; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(hostThemeCookieString('dark')).toBe('host_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax')
  })
})
