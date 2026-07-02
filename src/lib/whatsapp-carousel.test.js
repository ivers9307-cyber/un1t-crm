import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the config module BEFORE importing whatsapp.js so resolveConfig
// resolves a deterministic phone number + token without env/db.
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({ phoneNumberId: 'pn1', token: 'tok' })),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))

import { buildMediaCarouselPayload, sendMediaCarousel } from './whatsapp.js'

const card = (i, extra = {}) => ({ image_url: `https://cdn.test/${i}.jpg`, title: `Card ${i}`, ...extra })

describe('buildMediaCarouselPayload', () => {
  it('2 cards → carousel shape with indexed image-header cards', () => {
    const p = buildMediaCarouselPayload('353871234567', {
      bodyText: 'This week at the gym',
      cards: [card(1, { body: 'Sub line' }), card(2)],
    })
    expect(p.to).toBe('353871234567')
    expect(p.type).toBe('interactive')
    expect(p.interactive.type).toBe('carousel')
    expect(p.interactive.body.text).toBe('This week at the gym')
    const cards = p.interactive.action.cards
    expect(cards).toHaveLength(2)
    expect(cards[0].card_index).toBe(0)
    expect(cards[1].card_index).toBe(1)
    expect(cards[0].header).toEqual({ type: 'image', image: { link: 'https://cdn.test/1.jpg' } })
    expect(cards[1].header).toEqual({ type: 'image', image: { link: 'https://cdn.test/2.jpg' } })
    // title + optional body joined with a newline
    expect(cards[0].body.text).toBe('Card 1\nSub line')
    expect(cards[1].body.text).toBe('Card 2')
    // no links on either card → no per-card action
    expect(cards[0].action).toBeUndefined()
    expect(cards[1].action).toBeUndefined()
  })

  it('all cards linked → per-card cta_url action present (display_text capped at 20)', () => {
    const p = buildMediaCarouselPayload('353871234567', {
      bodyText: 'Offers',
      cards: [
        card(1, { link_url: 'https://un1t.test/a', link_text: 'A twenty-plus character label' }),
        card(2, { link_url: 'https://un1t.test/b' }),
      ],
    })
    const cards = p.interactive.action.cards
    // Live-verified: Meta requires a card-level `type` naming the button kind.
    expect(cards[0].type).toBe('cta_url')
    expect(cards[1].type).toBe('cta_url')
    expect(cards[0].action).toEqual({
      name: 'cta_url',
      parameters: { display_text: 'A twenty-plus charac', url: 'https://un1t.test/a' },
    })
    expect(cards[1].action).toEqual({
      name: 'cta_url',
      parameters: { display_text: 'Open', url: 'https://un1t.test/b' },
    })
  })

  it('mixed links → throws (Meta requires consistent buttons)', () => {
    expect(() => buildMediaCarouselPayload('1', {
      bodyText: 'x',
      cards: [card(1, { link_url: 'https://un1t.test/a' }), card(2)],
    })).toThrow('Carousel cards must all have a link, or none')
  })

  it('1 card → throws', () => {
    expect(() => buildMediaCarouselPayload('1', { bodyText: 'x', cards: [card(1)] }))
      .toThrow('Carousel needs 2-10 cards')
  })

  it('11 cards → throws', () => {
    const cards = Array.from({ length: 11 }, (_, i) => card(i))
    expect(() => buildMediaCarouselPayload('1', { bodyText: 'x', cards }))
      .toThrow('Carousel needs 2-10 cards')
  })
})

describe('sendMediaCarousel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the carousel payload to /messages and returns the messageId', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ messages: [{ id: 'wamid.CAROUSEL1' }] }) }))
    const res = await sendMediaCarousel('353871234567', {
      bodyText: 'Check these out',
      cards: [card(1), card(2)],
    }, { locationId: 'loc1' })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/messages')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.type).toBe('interactive')
    expect(body.interactive.type).toBe('carousel')
    expect(body.interactive.action.cards).toHaveLength(2)
    expect(res.messageId).toBe('wamid.CAROUSEL1')
  })

  it('Meta error → throws with the error message', async () => {
    global.fetch = vi.fn(async () => ({ json: async () => ({ error: { message: 'carousel not available' } }) }))
    await expect(sendMediaCarousel('1', { bodyText: 'x', cards: [card(1), card(2)] }))
      .rejects.toThrow('carousel not available')
  })
})
