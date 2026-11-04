import { describe, test, expect } from 'vitest'
import {
  MAX_SPOKEN_CHARS, VOICE_REPLY_PROMPT_LINE, spokenTextFor, splitForVoice, voiceKindFor, voiceFor,
  isOggOpus, toolResultSucceeded, isVoiceTrigger,
} from './reply-rules.js'

describe('what is spoken', () => {
  test('emoji, markup, bullets and blank lines are tidied; words never change', () => {
    expect(spokenTextFor('Yes! 🎉 *7am* is free.\n\n• ENG1NE 7:00\n• HYROX 8:00')).toBe('Yes! 7am is free.\nENG1NE 7:00\nHYROX 8:00')
    expect(spokenTextFor('Book here https://x.test/b today')).toBe('Book here today')
    expect(spokenTextFor('_Thanks_ 👍🏽 see you')).toBe('Thanks see you')
    expect(spokenTextFor('')).toBe('')
  })
  test('a trailing link is spoken without it and follows as the link button', () => {
    expect(splitForVoice({ text: 'Great, book here https://x.test/b', options: null }))
      .toEqual({ spoken: 'Great, book here', followUp: { kind: 'cta_url', body: 'Great, book here', url: 'https://x.test/b' } })
  })
  test('options follow as buttons', () => {
    expect(splitForVoice({ text: 'Which time?', options: ['7am', '8am'] })).toEqual({ spoken: 'Which time?', followUp: { kind: 'options', options: ['7am', '8am'] } })
  })
  test('a link mid-text follows as the full original text', () => {
    expect(splitForVoice({ text: 'See https://x.test/t for times, then reply', options: null }))
      .toEqual({ spoken: 'See for times, then reply', followUp: { kind: 'text', text: 'See https://x.test/t for times, then reply' } })
  })
  test('a plain reply has no follow-up; a link-only reply has nothing to speak (Review Focus 2)', () => {
    expect(splitForVoice({ text: 'See you at 7!', options: null })).toEqual({ spoken: 'See you at 7!', followUp: null })
    expect(splitForVoice({ text: 'https://x.test/b', options: null }).spoken).toBe('')
  })
  test('options with a link keep the link in the follow-up (review I1)', () => {
    expect(splitForVoice({ text: 'Timetable here https://x.ie/t then pick one', options: ['Yes', 'No'] }))
      .toEqual({ spoken: 'Timetable here then pick one', followUp: { kind: 'options', options: ['Yes', 'No'], text: 'Timetable here https://x.ie/t then pick one' } })
  })
  test('markup is stripped only in pairs; emails, snake_case and ~ stay (review M3)', () => {
    expect(spokenTextFor('*7am* _today_ email a_b@x.ie snake_case ~7pm 1️⃣ ok')).toBe('7am today email a_b@x.ie snake_case ~7pm 1 ok')
  })
  test('the length limit and the prompt line', () => {
    expect(MAX_SPOKEN_CHARS).toBe(600)
    expect(spokenTextFor('a'.repeat(700)).length).toBe(700)
    expect(VOICE_REPLY_PROMPT_LINE.startsWith('## This reply will be spoken\nThe customer sent a voice note')).toBe(true)
    expect(VOICE_REPLY_PROMPT_LINE).toContain('they are sent as text after the voice note.')
  })
})

describe('which kind and which voice', () => {
  test('handoff > booking > member > lead', () => {
    expect(voiceKindFor({ isHandoff: true, bookingToolSucceeded: true, isMember: true })).toBe('handoff')
    expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: true, isMember: false })).toBe('booking')
    expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: false, isMember: true })).toBe('member')
    expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: false, isMember: false })).toBe('lead')
    expect(voiceKindFor({})).toBe('lead')
  })
  test('a missing voice falls back to the default, then to none', () => {
    expect(voiceFor('booking', { booking: { voice_id: 'b' }, default: { voice_id: 'd' } })).toEqual({ voice_id: 'b' })
    expect(voiceFor('booking', { default: { voice_id: 'd' } })).toEqual({ voice_id: 'd' })
    expect(voiceFor('booking', {})).toBeNull()
    expect(voiceFor('booking', null)).toBeNull()
    expect(voiceFor('booking', { booking: { voice_id: '' } })).toBeNull()
  })
  test('Ogg detection', () => {
    expect(isOggOpus(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0]))).toBe(true)
    expect(isOggOpus(new Uint8Array([0xff, 0xfb]))).toBe(false)
    expect(isOggOpus(null)).toBe(false)
  })
  test('booking tools that made a change', () => {
    expect(toolResultSucceeded('book_class', { booked: true })).toBe(true)
    expect(toolResultSucceeded('book_class', { booked: false })).toBe(false)
    expect(toolResultSucceeded('cancel_class_booking', { cancelled: true })).toBe(true)
    expect(toolResultSucceeded('move_class_booking', { moved: true })).toBe(true)
    expect(toolResultSucceeded('move_event_entry', { moved: false })).toBe(false)
    expect(toolResultSucceeded('list_upcoming_classes', { classes: [] })).toBe(false)
    expect(toolResultSucceeded('book_event', null)).toBe(false)
  })
  test('the trigger is the newest inbound (Review Focus 1)', () => {
    expect(isVoiceTrigger({ historyRows: [{ direction: 'inbound', message_type: 'audio' }, { direction: 'inbound', message_type: 'text' }] })).toBe(false)
    expect(isVoiceTrigger({ historyRows: [{ direction: 'inbound', message_type: 'text' }, { direction: 'inbound', message_type: 'audio' }, { direction: 'outbound', message_type: 'text' }] })).toBe(true)
    expect(isVoiceTrigger({ historyRows: [] })).toBe(false)
  })
})
