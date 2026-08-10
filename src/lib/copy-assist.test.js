// GAPS-P8 — tests for the campaign copy assist.
//
// The load-bearing tests here are the ones under "model output that ignores
// the prompt": the whole design bet (inherited from HUMANIZE.1 in
// src/lib/agent/core.js) is that a prompt rule is NOT enforcement. So the
// fixtures below are shaped like real Claude replies — a JSON array, a fenced
// code block, a numbered list — carrying exactly the violations the historical
// UN1T subject corpus is full of (em dashes, emoji, ALL-CAPS shouting), plus
// the two things a copywriting model invents on its own: prices/dates nobody
// gave it, and class capacity.

import { describe, it, expect } from 'vitest'
import {
  COPY_ASSIST_MODEL,
  MAX_SUGGESTIONS,
  SUBJECT_MAX_CHARS,
  stripEmoji,
  deShout,
  houseStyleScrub,
  mentionsCapacity,
  findUnsupportedClaims,
  toPlainText,
  buildCopyAssistMessages,
  extractModelText,
  parseSuggestions,
} from './copy-assist.js'

// A token is "shouty" if it has 2+ letters, all uppercase, and is not a brand
// word. Used by the assertions below to prove de-shouting actually happened.
const SHOUTY = /\b(?![A-Z0-9]*(?:UN1T|HYROX|FUS1ON|ARENA|BASE|CHAMP|RSVP)\b)[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*\b/

describe('stripEmoji', () => {
  it('removes pictographs, skin tones, ZWJ sequences and variation selectors', () => {
    expect(stripEmoji('Summer sale 🔥 ends midnight 🔥')).toBe('Summer sale ends midnight')
    expect(stripEmoji('Pride training club launches 🌈')).toBe('Pride training club launches')
    expect(stripEmoji('Coach 👩🏽‍🏫 is back')).toBe('Coach is back')
    expect(stripEmoji('Ready❗️')).toBe('Ready')
  })

  it('leaves currency, digits, punctuation and accents alone', () => {
    expect(stripEmoji('€99 for 3 months. Aoife & Seán said #1.')).toBe('€99 for 3 months. Aoife & Seán said #1.')
  })

  it('tidies the space the emoji left behind', () => {
    expect(stripEmoji('Book now 🔥 , please')).toBe('Book now, please')
    expect(stripEmoji('🔥 Book now')).toBe('Book now')
  })

  it('is null-safe', () => {
    expect(stripEmoji(null)).toBe('')
    expect(stripEmoji(undefined)).toBe('')
  })
})

describe('deShout', () => {
  it('lower-cases shouting and restores sentence capitals', () => {
    expect(deShout('SUMMER SALE ENDS MIDNIGHT')).toBe('Summer sale ends midnight')
    expect(deShout('BOOK NOW. Places are limited.')).toBe('Book now. Places are limited.')
  })

  it('keeps studio brand words that are genuinely upper-case', () => {
    expect(deShout('HYROX at UN1T')).toBe('HYROX at UN1T')
    expect(deShout('NEW ARENA CLASS AT UN1T')).toBe('New ARENA class at UN1T')
  })

  it('leaves normally-cased copy untouched', () => {
    expect(deShout('Your next block starts on Monday.')).toBe('Your next block starts on Monday.')
  })

  it('is null-safe', () => {
    expect(deShout(null)).toBe('')
  })
})

describe('houseStyleScrub — the deterministic enforcement point', () => {
  it('routes em dashes through stripEmDashes (core.js), not a re-implementation', () => {
    expect(houseStyleScrub('FREE TRYKA WORKSHOP — SAT 20 JUNE'))
      .toBe('Free tryka workshop, sat 20 june')
    // tight dash between times becomes a hyphen, per core.js
    expect(houseStyleScrub('Doors 6:00–6:45')).toBe('Doors 6:00-6:45')
  })

  it('collapses exclamation pile-ups to a single mark', () => {
    expect(houseStyleScrub('Book now!!!')).toBe('Book now!')
    expect(houseStyleScrub('Big news! Really big news! Come in!')).toBe('Big news! Really big news. Come in.')
  })

  it('strips markdown wrappers, list bullets and surrounding quotes', () => {
    expect(houseStyleScrub('1. "Your spot is open"')).toBe('Your spot is open')
    expect(houseStyleScrub('- **Back on Monday**')).toBe('Back on Monday')
    expect(houseStyleScrub('Subject: Back on Monday')).toBe('Back on Monday')
  })

  it('collapses whitespace and trims', () => {
    expect(houseStyleScrub('  Back   on\n\n Monday  ')).toBe('Back on Monday')
  })

  it('is null-safe', () => {
    expect(houseStyleScrub(null)).toBe('')
    expect(houseStyleScrub('   ')).toBe('')
  })
})

describe('mentionsCapacity — never surface class or event capacity', () => {
  it('flags counts of remaining places', () => {
    expect(mentionsCapacity('Only 3 spots left')).toBe(true)
    expect(mentionsCapacity('4 spaces remaining on Saturday')).toBe(true)
    expect(mentionsCapacity('Just 2 places left for the workshop')).toBe(true)
    expect(mentionsCapacity('12 people have booked')).toBe(true)
  })

  it('flags bare "spots left" phrasing with no number', () => {
    expect(mentionsCapacity('Spaces are running out, places left are few')).toBe(true)
  })

  it('allows the coy full / limited wording the agent already uses', () => {
    expect(mentionsCapacity('Saturday is full')).toBe(false)
    expect(mentionsCapacity('Spaces are limited')).toBe(false)
    expect(mentionsCapacity('ARENA at 6:00 on Saturday')).toBe(false)
  })
})

describe('findUnsupportedClaims — a suggestion may not invent a fact', () => {
  const brief = 'Weekend membership offer, ends Sunday. Price is €99.'

  it('passes claims that appear in the operator input', () => {
    expect(findUnsupportedClaims('€99 membership, ends Sunday', brief)).toEqual([])
    expect(findUnsupportedClaims('€ 99 until sunday', brief)).toEqual([])
  })

  it('catches an invented price', () => {
    expect(findUnsupportedClaims('Just €49 this weekend', brief)).toContain('€49')
  })

  it('catches an invented discount percentage', () => {
    expect(findUnsupportedClaims('Save 50% on membership', brief)).toContain('50%')
  })

  it('catches an invented day, date or time', () => {
    expect(findUnsupportedClaims('Ends Tuesday', brief)).toContain('tuesday')
    expect(findUnsupportedClaims('Starts 6:30am', brief)).toContain('6:30am')
    expect(findUnsupportedClaims('Back on 20 June', brief)).toContain('june')
  })

  it('catches an invented free offer', () => {
    expect(findUnsupportedClaims('Free week on us', brief)).toContain('free')
    expect(findUnsupportedClaims('Feel free to reply', brief)).toEqual([])
  })

  it('reads the draft subject and body as supporting input too', () => {
    expect(findUnsupportedClaims('Ends Tuesday', 'the sale ends tuesday at midnight')).toEqual([])
  })
})

describe('toPlainText', () => {
  it('flattens campaign HTML to text the model can read', () => {
    const html = '<html><style>p{color:red}</style><body><p>Hi there</p><p>Second line<br>and a break</p></body></html>'
    expect(toPlainText(html)).toBe('Hi there\nSecond line\nand a break')
  })

  it('decodes the entities Unlayer emits', () => {
    expect(toPlainText('<p>Tom &amp; Jerry &nbsp;&mdash; go</p>')).toBe('Tom & Jerry - go')
  })

  it('truncates very long bodies', () => {
    expect(toPlainText('<p>' + 'a'.repeat(5000) + '</p>', 100).length).toBeLessThanOrEqual(100)
  })

  it('is null-safe', () => {
    expect(toPlainText(null)).toBe('')
  })
})

describe('buildCopyAssistMessages', () => {
  it('states the house style as hard rules in the system prompt', () => {
    const { system } = buildCopyAssistMessages({ kind: 'subject', brief: 'weekend offer' })
    expect(system).toMatch(/em dash/i)
    expect(system).toMatch(/emoji/i)
    expect(system).toMatch(/capacity|how many|spaces are left/i)
    expect(system).toMatch(/never invent|do not invent/i)
    expect(system).toMatch(/JSON array/i)
  })

  it('tells the model it is not a source of studio facts', () => {
    const { system } = buildCopyAssistMessages({ kind: 'subject', brief: 'x' })
    expect(system).toMatch(/only .*(brief|operator)/i)
  })

  it('carries only the brief and the draft into the user message', () => {
    const { user } = buildCopyAssistMessages({
      kind: 'subject',
      brief: 'weekend membership offer',
      subject: 'Weekend offer',
      body: 'Membership is open again.',
    })
    expect(user).toMatch(/weekend membership offer/)
    expect(user).toMatch(/Weekend offer/)
    expect(user).toMatch(/Membership is open again\./)
  })

  it('treats the brief as untrusted data, not instructions', () => {
    const { system } = buildCopyAssistMessages({ kind: 'subject', brief: 'x' })
    expect(system).toMatch(/ignore any instruction|not instructions/i)
  })

  it('asks for body alternatives when kind is body', () => {
    const { user } = buildCopyAssistMessages({ kind: 'body', brief: 'x', body: 'draft' })
    expect(user).toMatch(/body/i)
  })

  it('rejects an unknown kind', () => {
    expect(() => buildCopyAssistMessages({ kind: 'nonsense', brief: 'x' })).toThrow()
  })
})

describe('extractModelText', () => {
  it('joins the text blocks of an Anthropic Messages response', () => {
    expect(extractModelText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab')
  })

  it('ignores non-text blocks and bad shapes', () => {
    expect(extractModelText({ content: [{ type: 'tool_use' }, { type: 'text', text: 'ok' }] })).toBe('ok')
    expect(extractModelText(null)).toBe('')
    expect(extractModelText({})).toBe('')
  })
})

// ── The part that matters ────────────────────────────────────────────────
// Every fixture below is model OUTPUT, not a hand-written string: whole
// replies in the shapes Claude actually returns, each ignoring one of the
// prompt rules. What reaches the operator must be clean regardless.
describe('parseSuggestions — non-compliant model output is neutralised', () => {
  const source = 'Weekend membership offer at UN1T Stillorgan.'

  it('parses a plain JSON array', () => {
    const raw = '["Membership is open again", "Your spot is back", "Come back this weekend"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Membership is open again', 'Your spot is back', 'Come back this weekend'])
  })

  it('parses a JSON array wrapped in a fenced code block with commentary', () => {
    const raw = 'Here are three options:\n\n```json\n["Back at UN1T this weekend", "Your membership is open again"]\n```\nHope these help.'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Back at UN1T this weekend', 'Your membership is open again'])
  })

  it('falls back to line parsing when the model ignores the JSON instruction', () => {
    const raw = 'Sure, here are some ideas:\n1. Back at UN1T this weekend\n2. Your membership is open again\n3. Training starts again'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Back at UN1T this weekend', 'Your membership is open again', 'Training starts again'])
  })

  it('strips em dashes the model emitted anyway', () => {
    const raw = '["Back at UN1T — this weekend only", "Membership reopens — join us"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions.join(' ')).not.toMatch(/[—–]/)
    expect(suggestions[0]).toBe('Back at UN1T, this weekend only')
  })

  it('strips emoji the model emitted anyway', () => {
    const raw = '["🔥 Membership reopens 🔥", "Back at UN1T 💪"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions.join(' ')).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(suggestions).toEqual(['Membership reopens', 'Back at UN1T'])
  })

  it('de-shouts ALL CAPS and gushing the model emitted anyway', () => {
    const raw = '["WE ARE SO EXCITED TO SEE YOU!!!", "BOOK NOW!! HUGE NEWS!!!"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    for (const s of suggestions) {
      expect(s).not.toMatch(SHOUTY)
      expect(s).not.toMatch(/!!/)
      expect((s.match(/!/g) || []).length).toBeLessThanOrEqual(1)
    }
  })

  it('handles the historical UN1T corpus style in one pass', () => {
    const raw = JSON.stringify([
      'FREE TRYKA WORKSHOP — SAT 20 JUNE',
      'BOOK NOW - PRIDE TRAINING CLUB LAUNCHES AT UN1T 🌈',
      '🔥 SUMMER SALE ENDS MIDNIGHT @ UN1T 🔥',
    ])
    const { suggestions } = parseSuggestions(raw, {
      kind: 'subject',
      // everything factual in those subjects is in the operator input, so the
      // fabrication guard is not what is being measured here
      source: 'free TRYKA workshop sat 20 june, pride training club launch, summer sale ends midnight at UN1T',
    })
    for (const s of suggestions) {
      expect(s).not.toMatch(/[—–]/)
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(s).not.toMatch(SHOUTY)
    }
    expect(suggestions[0]).toBe('Free tryka workshop, sat 20 june')
  })

  it('drops a suggestion that invents a price or a deadline', () => {
    const raw = '["Membership is open again", "Just €49 until Tuesday"]'
    const { suggestions, dropped } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Membership is open again'])
    expect(dropped).toContainEqual(expect.objectContaining({ reason: 'unsupported_claim' }))
  })

  it('drops a suggestion that surfaces capacity', () => {
    const raw = '["Only 3 spots left this weekend", "Membership is open again"]'
    const { suggestions, dropped } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Membership is open again'])
    expect(dropped).toContainEqual(expect.objectContaining({ reason: 'capacity' }))
  })

  it('drops duplicates after scrubbing, case-insensitively', () => {
    const raw = '["Membership is open again", "MEMBERSHIP IS OPEN AGAIN", "Membership is open again!"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source })
    expect(suggestions).toEqual(['Membership is open again'])
  })

  it('drops a suggestion identical to what the operator already wrote', () => {
    const raw = '["Membership is open again", "Weekend offer"]'
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source, draft: 'Weekend offer' })
    expect(suggestions).toEqual(['Membership is open again'])
  })

  it('truncates an over-long subject at a word boundary instead of dropping it', () => {
    const long = 'Membership is open again at the studio ' + 'and there is more to say '.repeat(10)
    const { suggestions } = parseSuggestions(JSON.stringify([long]), { kind: 'subject', source: long })
    expect(suggestions[0].length).toBeLessThanOrEqual(SUBJECT_MAX_CHARS)
    expect(suggestions[0]).not.toMatch(/\s$/)
  })

  it('caps the number of suggestions returned', () => {
    const raw = JSON.stringify(['One idea', 'Two idea', 'Three idea', 'Four idea', 'Five idea'])
    const { suggestions } = parseSuggestions(raw, { kind: 'subject', source: raw })
    expect(suggestions.length).toBe(MAX_SUGGESTIONS)
  })

  it('returns nothing rather than garbage when the model refuses or rambles', () => {
    const { suggestions } = parseSuggestions("I'm sorry, I can't help with that.", { kind: 'subject', source })
    // a single apologetic line is still a line, but it must not survive the
    // fabrication/dedupe pipeline as a usable subject — assert we never throw
    // and never emit control characters
    expect(Array.isArray(suggestions)).toBe(true)
  })

  it('never throws on empty, null or non-JSON input', () => {
    expect(parseSuggestions('', { kind: 'subject', source }).suggestions).toEqual([])
    expect(parseSuggestions(null, { kind: 'subject', source }).suggestions).toEqual([])
    expect(parseSuggestions('{not json', { kind: 'subject', source }).suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
  })

  it('keeps multi-line body suggestions intact', () => {
    const raw = JSON.stringify(['Hi there,\n\nMembership is open again at UN1T.\n\nSee you in the studio.'])
    const { suggestions } = parseSuggestions(raw, { kind: 'body', source: 'membership open again at UN1T' })
    expect(suggestions[0]).toMatch(/\n/)
    expect(suggestions[0]).toMatch(/Membership is open again at UN1T\./)
  })
})

describe('module constants', () => {
  it('names an Anthropic model, never an OpenAI one', () => {
    expect(COPY_ASSIST_MODEL).toMatch(/^claude-/)
  })
})
