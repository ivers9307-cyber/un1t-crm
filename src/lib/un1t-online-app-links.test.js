import { describe, it, expect } from 'vitest'
import {
  appLinksFrom,
  renderAppDownloadLinks,
  renderStudioLogo,
  renderAppSection,
  DEFAULT_APP_SECTION_COPY,
} from './un1t-online-app-links.js'

describe('appLinksFrom', () => {
  it('keeps https links only and falls back to the default copy', () => {
    expect(appLinksFrom({ un1t_online: { app_links: { ios_url: 'https://apps.apple.com/x', android_url: 'http://bad' } } })).toEqual({
      iosUrl: 'https://apps.apple.com/x',
      androidUrl: null,
      heading: DEFAULT_APP_SECTION_COPY.heading,
      body: DEFAULT_APP_SECTION_COPY.body,
    })
  })

  it('reads nothing from null or malformed settings', () => {
    const expected = { iosUrl: null, androidUrl: null, heading: DEFAULT_APP_SECTION_COPY.heading, body: DEFAULT_APP_SECTION_COPY.body }
    expect(appLinksFrom(null)).toEqual(expected)
    expect(appLinksFrom({ un1t_online: 'x' })).toEqual(expected)
    expect(appLinksFrom({ un1t_online: { app_links: 'x' } })).toEqual(expected)
  })

  it('uses a custom heading and body, and falls back when they are blank', () => {
    const custom = appLinksFrom({ un1t_online: { app_links: { heading: ' Get the app ', body: ' Tap below. ' } } })
    expect(custom.heading).toBe('Get the app')
    expect(custom.body).toBe('Tap below.')
    const blank = appLinksFrom({ un1t_online: { app_links: { heading: '  ', body: '' } } })
    expect(blank.heading).toBe(DEFAULT_APP_SECTION_COPY.heading)
    expect(blank.body).toBe(DEFAULT_APP_SECTION_COPY.body)
  })
})

describe('renderAppDownloadLinks', () => {
  it('is empty when both links are missing', () => {
    expect(renderAppDownloadLinks({ iosUrl: null, androidUrl: null })).toBe('')
  })

  it('leaves out a missing link', () => {
    const html = renderAppDownloadLinks({ iosUrl: 'https://a', androidUrl: null })
    expect(html).toContain('Download on the App Store')
    expect(html).not.toContain('Google Play')
  })

  it('renders both and escapes the href', () => {
    const html = renderAppDownloadLinks({ iosUrl: 'https://a?x=1&y=2', androidUrl: 'https://b' })
    expect(html).toContain('Download on the App Store')
    expect(html).toContain('Get it on Google Play')
    expect(html).toContain('href="https://a?x=1&amp;y=2"')
  })
})

describe('renderStudioLogo', () => {
  it('falls back to the text wordmark', () => {
    const html = renderStudioLogo({ logoUrl: null, name: 'UN1T Hatch Street' })
    expect(html).toContain('UN1T')
    expect(html).not.toContain('<img')
  })

  it('renders the logo image with escaped alt', () => {
    const html = renderStudioLogo({ logoUrl: 'https://x/logo.png', name: 'UN1T "Hatch" Street' })
    expect(html).toContain('<img')
    expect(html).toContain('alt="UN1T &quot;Hatch&quot; Street"')
    expect(renderStudioLogo({ logoUrl: 'https://x/l.png', name: 'UN1T Hatch Street' })).toContain('alt="UN1T Hatch Street"')
  })
})

describe('renderAppSection', () => {
  const links = { iosUrl: 'https://a', androidUrl: 'https://b', heading: 'Book <now>', body: 'Body text.' }
  it('is empty with no links', () => {
    expect(renderAppSection({ ...links, iosUrl: null, androidUrl: null })).toBe('')
  })
  it('carries the heading, body and buttons', () => {
    const html = renderAppSection(links)
    expect(html).toContain('Book &lt;now&gt;')
    expect(html).toContain('Body text.')
    expect(html).toContain('Download on the App Store')
  })
})

describe('no dashes in customer copy', () => {
  it('has no em or en dash anywhere', () => {
    const all = [
      DEFAULT_APP_SECTION_COPY.heading,
      DEFAULT_APP_SECTION_COPY.body,
      renderAppDownloadLinks({ iosUrl: 'https://a', androidUrl: 'https://b' }),
      renderStudioLogo({ logoUrl: null, name: 'UN1T' }),
      renderStudioLogo({ logoUrl: 'https://x', name: 'UN1T' }),
      renderAppSection({ iosUrl: 'https://a', androidUrl: 'https://b', ...DEFAULT_APP_SECTION_COPY }),
    ].join('\n')
    expect(all).not.toMatch(/[—–]/)
  })
})
