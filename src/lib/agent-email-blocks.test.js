import { describe, it, expect } from 'vitest'
import {
  EmailBlocksSchema,
  validateBlocks,
  renderAgentEmail,
  unknownMergeTags,
} from '@/lib/agent-email-blocks'

const branding = { companyName: 'UN1T Stillorgan', logoUrl: 'https://cdn.example.com/logo.png' }
const lib = { allowedImageUrls: new Set(['https://cdn.example.com/a.jpg']) }
const render = (blocks, b = branding) => renderAgentEmail({ blocks, branding: b })

describe('agent email blocks', () => {
  it('escapes markup in every text field', () => {
    const x = '<script>x</script>'
    const html = render([
      { type: 'heading', text: x, level: 1 },
      { type: 'paragraph', text: x },
      { type: 'list', items: [x] },
      { type: 'button', label: x, url: 'https://x.ie/' },
      { type: 'image', url: 'https://cdn.example.com/a.jpg', alt: x },
    ], { companyName: x, logoUrl: null })
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders bold, italic and an https link, and leaves other punctuation alone', () => {
    const html = render([{ type: 'paragraph', text: 'A **bold** and *it* [go](https://x.ie/a?b=1&c=2) _under_ # not-a-heading' }])
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<a href="https://x.ie/a?b=1&amp;c=2"')
    expect(html).toContain('>go</a>')
    expect(html).toContain('_under_ # not-a-heading')
  })

  it('refuses an http link, a javascript: link and an unparseable url', () => {
    const v = (b) => validateBlocks([b], lib)
    expect(v({ type: 'button', label: 'Go', url: 'http://x.ie/' })).toContain('http://x.ie/')
    expect(v({ type: 'button', label: 'Go', url: 'javascript:alert(1)' })).toContain('javascript:alert(1)')
    expect(v({ type: 'button', label: 'Go', url: 'not a url' })).toContain('not a url')
    expect(v({ type: 'paragraph', text: 'see [x](http://x.ie/)' })).toContain('http://x.ie/')
    expect(v({ type: 'list', items: ['[x](javascript:void0)'] })).toContain('javascript:void0')
    expect(v({ type: 'button', label: 'Go', url: 'https://x.ie/' })).toBeNull()
  })

  it('refuses an image url that is not in the studio library', () => {
    expect(validateBlocks([{ type: 'image', url: 'https://evil.example/p.png', alt: 'a' }], lib)).toContain('https://evil.example/p.png')
    expect(validateBlocks([{ type: 'image', url: 'https://cdn.example.com/a.jpg', alt: 'a' }], lib)).toBeNull()
  })

  it('refuses an unknown merge tag and accepts {{first_name}}', () => {
    expect(validateBlocks([{ type: 'paragraph', text: 'Hi {{nope}}' }], lib)).toContain('nope')
    expect(validateBlocks([{ type: 'paragraph', text: 'Hi {{first_name}}' }], lib)).toBeNull()
    expect(validateBlocks([{ type: 'paragraph', text: '{{glofox_passcode}}' }], lib)).toContain('glofox_passcode')
    expect(unknownMergeTags('{{first_name}} {{ bad }} {{bad}} {{x_y}}')).toEqual([' bad ', 'bad', 'x_y'])
    expect(validateBlocks([{ type: 'paragraph', text: 'Hi {{ first_name }}' }], lib)).toContain('{{first_name}}')
  })

  it('accepts merge tags in button urls, including a url that is only a tag', () => {
    expect(validateBlocks([{ type: 'button', label: 'Go', url: 'https://x.ie/?t={{booking_token}}' }], lib)).toBeNull()
    expect(validateBlocks([{ type: 'button', label: 'Go', url: '{{unsubscribe_url}}' }], lib)).toBeNull()
    expect(validateBlocks([{ type: 'button', label: 'Go', url: '{{nope}}' }], lib)).toContain('nope')
  })

  it('refuses tags in URL positions other than the two URL tags and booking_token', () => {
    const btn = (url) => validateBlocks([{ type: 'button', label: 'Go', url }], lib)
    const lnk = (url) => validateBlocks([{ type: 'paragraph', text: `[x](${url})` }], lib)
    for (const f of [btn, lnk]) {
      expect(f('{{first_name}}')).toContain('first_name')
      expect(f('{{app_download_links}}')).toContain('app_download_links')
      expect(f('https://x.ie/?n={{first_name}}')).toContain('first_name')
      expect(f('{{unsubscribe_url}}')).toBeNull()
      expect(f('{{preference_url}}')).toBeNull()
      expect(f('https://x.ie/?t={{booking_token}}')).toBeNull()
    }
    expect(validateBlocks([{ type: 'image', url: 'https://cdn.example.com/a.jpg?t={{booking_token}}', alt: 'a' }],
      { allowedImageUrls: new Set(['https://cdn.example.com/a.jpg?t={{booking_token}}']) })).toContain('merge tags')
    const html = render([{ type: 'paragraph', text: '[u]({{unsubscribe_url}}) [f]({{first_name}})' }])
    expect(html).toContain('<a href="{{unsubscribe_url}}"')
    expect(html).not.toContain('href="{{first_name}}"')
  })

  it('keeps merge tags verbatim in the output', () => {
    const html = render([
      { type: 'paragraph', text: 'Hi {{first_name}}' },
      { type: 'button', label: 'Book', url: 'https://x.ie/?t={{booking_token}}' },
    ])
    expect(html).toContain('Hi {{first_name}}')
    expect(html).toContain('https://x.ie/?t={{booking_token}}')
  })

  it('caps the list at 60 blocks', () => {
    const p = { type: 'paragraph', text: 'x' }
    expect(EmailBlocksSchema.safeParse(Array(60).fill(p)).success).toBe(true)
    expect(EmailBlocksSchema.safeParse(Array(61).fill(p)).success).toBe(false)
    expect(EmailBlocksSchema.safeParse([]).success).toBe(false)
    expect(EmailBlocksSchema.safeParse([{ type: 'paragraph', text: 'x'.repeat(5001) }]).success).toBe(false)
    expect(EmailBlocksSchema.safeParse([{ type: 'heading', text: 'x', level: 3 }]).success).toBe(false)
    expect(EmailBlocksSchema.safeParse([{ type: 'list', items: [] }]).success).toBe(false)
    expect(EmailBlocksSchema.safeParse([{ type: 'divider' }]).success).toBe(true)
  })

  it('omits the logo when branding has none and still names the company', () => {
    const html = render([{ type: 'divider' }], { companyName: 'Acme Gym', logoUrl: null })
    expect(html).not.toContain('<img')
    expect(html).toContain('Acme Gym')
    expect(render([{ type: 'divider' }])).toContain('<img')
  })

  it('adds no footer, unsubscribe or preheader', () => {
    const html = render([{ type: 'paragraph', text: 'x' }])
    expect(html).not.toMatch(/unsubscribe|display:none/i)
  })

  it('renders lists, buttons, images and a 600px table layout', () => {
    const html = render([
      { type: 'list', items: ['a', 'b'], ordered: true },
      { type: 'list', items: ['c'] },
      { type: 'button', label: 'Go', url: 'https://x.ie/' },
      { type: 'image', url: 'https://cdn.example.com/a.jpg', alt: 'pic' },
    ])
    expect(html).toContain('<ol')
    expect(html).toContain('<ul')
    expect(html).toContain('width="600"')
    expect(html).toContain('alt="pic"')
  })

  it('is deterministic: the same blocks and branding render byte-identical html', () => {
    const blocks = [{ type: 'heading', text: 'H', level: 2 }, { type: 'paragraph', text: '**a** [b](https://x.ie/)' }]
    expect(render(blocks)).toBe(render(JSON.parse(JSON.stringify(blocks))))
  })
})
