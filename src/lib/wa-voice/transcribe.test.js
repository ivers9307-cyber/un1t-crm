import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn, logError } from '@/lib/log'
import { transcribeInboundVoiceNote, buildKeyterms, VOICE_LOST_TURN_REASONS } from './transcribe.js'
import { ELEVENLABS_STT_CENTS_PER_MINUTE } from '@/lib/elevenlabs'
import { makeOgg } from './test-helpers.js'

const SECRET = 'my card number is four four four'
const w = (lp) => ({ type: 'word', text: 'x', logprob: lp })

function makeDb({
  location = { name: 'UN1T Hatch Street', organization_id: 'org-1' },
  locationError = null,
  settings = { voice_transcription_enabled: true },
  settingsError = null,
  staff = [{ profiles: { full_name: 'Dean Murphy', active: true, deleted_at: null } }],
  staffError = null,
  bytes = makeOgg(48000 * 6),
  downloadError = null,
  updateResults = [],
} = {}) {
  const updates = []
  let u = 0
  const db = {
    updates,
    from: vi.fn((table) => {
      if (table === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: locationError ? null : location, error: locationError }) }) }) }
      if (table === 'org_settings') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settingsError ? null : settings, error: settingsError }) }) }) }
      if (table === 'profile_locations') return { select: () => ({ eq: () => ({ limit: async () => ({ data: staffError ? null : staff, error: staffError }) }) }) }
      if (table === 'whatsapp_messages') {
        return {
          update: (patch) => {
            const rec = { patch, eq: null }
            updates.push(rec)
            return {
              eq: (col, val) => {
                rec.eq = [col, val]
                return { select: async () => updateResults[u++] || { data: [{ id: val }], error: null } }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => (downloadError ? { data: null, error: downloadError } : { data: new Blob([bytes], { type: 'audio/ogg' }), error: null })),
      })),
    },
  }
  return db
}

const args = { messageId: 'msg-1', locationId: 'loc-1', storagePath: 'loc-1/msg-1.ogg' }
const okTranscribe = (text = ' Can I book the seven am class ') =>
  vi.fn(async () => ({ ok: true, text, languageCode: 'en', languageProbability: 0.97, durationSecs: 6.5, words: Array(7).fill(w(-0.1)) }))
const deps = (o = {}) => ({ transcribe: okTranscribe(), recordUsage: vi.fn(async () => {}), voiceCap: vi.fn(async () => ({ capped: false })), ...o })
const lastStatus = (db) => db.updates.at(-1)?.patch.transcript_status

beforeEach(() => { vi.mocked(logWarn).mockClear(); vi.mocked(logError).mockClear() })

describe('transcribeInboundVoiceNote', () => {
  test('org switch off → disabled, no transcription', async () => {
    const db = makeDb({ settings: { voice_transcription_enabled: false } })
    const d = deps()
    expect((await transcribeInboundVoiceNote(db, args, d)).status).toBe('disabled')
    expect(lastStatus(db)).toBe('disabled')
    expect(d.transcribe).not.toHaveBeenCalled()
  })

  test('no org_settings row → disabled', async () => {
    const db = makeDb({ settings: null })
    expect((await transcribeInboundVoiceNote(db, args, deps())).status).toBe('disabled')
  })

  test('a locations or org_settings read error → failed', async () => {
    for (const db of [makeDb({ locationError: { message: 'x' } }), makeDb({ settingsError: { message: 'x' } })]) {
      const d = deps()
      expect((await transcribeInboundVoiceNote(db, args, d)).status).toBe('failed')
      expect(lastStatus(db)).toBe('failed')
      expect(d.transcribe).not.toHaveBeenCalled()
    }
  })

  test('cap reached → capped', async () => {
    const db = makeDb()
    const d = deps({ voiceCap: vi.fn(async () => ({ capped: true })) })
    expect((await transcribeInboundVoiceNote(db, args, d)).status).toBe('capped')
    expect(lastStatus(db)).toBe('capped')
    expect(d.voiceCap).toHaveBeenCalledWith({ organizationId: 'org-1' })
    expect(d.transcribe).not.toHaveBeenCalled()
  })

  test('no storage path, or a download error → failed', async () => {
    const db1 = makeDb()
    expect((await transcribeInboundVoiceNote(db1, { ...args, storagePath: null }, deps())).status).toBe('failed')
    expect(lastStatus(db1)).toBe('failed')
    const db2 = makeDb({ downloadError: { message: 'gone' } })
    expect((await transcribeInboundVoiceNote(db2, args, deps())).status).toBe('failed')
  })

  test('over 3 minutes → too_long, no transcription', async () => {
    const db = makeDb({ bytes: makeOgg(48000 * 181) })
    const d = deps()
    expect((await transcribeInboundVoiceNote(db, args, d)).status).toBe('too_long')
    expect(lastStatus(db)).toBe('too_long')
    expect(d.transcribe).not.toHaveBeenCalled()
  })

  test('not_configured and http errors: no usage recorded', async () => {
    const db1 = makeDb()
    const d1 = deps({ transcribe: vi.fn(async () => ({ ok: false, reason: 'not_configured' })) })
    expect((await transcribeInboundVoiceNote(db1, args, d1)).status).toBe('not_configured')
    expect(lastStatus(db1)).toBe('not_configured')
    expect(d1.recordUsage).not.toHaveBeenCalled()
    const db2 = makeDb()
    const d2 = deps({ transcribe: vi.fn(async () => ({ ok: false, reason: 'http_error', status: 500 })) })
    expect((await transcribeInboundVoiceNote(db2, args, d2)).status).toBe('failed')
    expect(d2.recordUsage).not.toHaveBeenCalled()
  })

  test('a clear answer → ok, trimmed, metered once', async () => {
    const db = makeDb()
    const d = deps()
    const r = await transcribeInboundVoiceNote(db, args, d)
    expect(r).toEqual({ status: 'ok', transcript: 'Can I book the seven am class', language: 'en' })
    const write = db.updates.at(-1)
    expect(write.eq).toEqual(['id', 'msg-1'])
    expect(write.patch).toMatchObject({ transcript: 'Can I book the seven am class', transcript_status: 'ok', transcript_language: 'en' })
    expect(typeof write.patch.transcribed_at).toBe('string')
    expect(d.recordUsage).toHaveBeenCalledTimes(1)
    expect(d.recordUsage.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1', locationId: 'loc-1', meter: 'elevenlabs_stt_seconds', source: 'wa_voice_note',
      quantity: 6.5, costCents: (6.5 / 60) * ELEVENLABS_STT_CENTS_PER_MINUTE, meta: { model: 'scribe_v2' },
    })
  })

  test('meters the Ogg duration when Scribe omits it', async () => {
    const db = makeDb({ bytes: makeOgg(48000 * 6) })
    const d = deps({ transcribe: vi.fn(async () => ({ ok: true, text: 'Can I book please', languageCode: 'en', languageProbability: 0.9, durationSecs: null, words: Array(4).fill(w(-0.1)) })) })
    await transcribeInboundVoiceNote(db, args, d)
    expect(d.recordUsage.mock.calls[0][0].quantity).toBe(6)
  })

  test('an unclear answer → unclear, transcript still written', async () => {
    const db = makeDb()
    const d = deps({ transcribe: vi.fn(async () => ({ ok: true, text: 'mumble mumble', languageCode: 'en', languageProbability: 0.3, durationSecs: 3, words: Array(2).fill(w(-0.1)) })) })
    const r = await transcribeInboundVoiceNote(db, args, d)
    expect(r.status).toBe('unclear')
    expect(db.updates.at(-1).patch).toMatchObject({ transcript: 'mumble mumble', transcript_status: 'unclear' })
    expect(d.recordUsage).toHaveBeenCalledTimes(1)
  })

  test('a failed row write → failed, then a best-effort failed stamp', async () => {
    for (const first of [{ data: null, error: { message: 'x' } }, { data: [], error: null }]) {
      const db = makeDb({ updateResults: [first] })
      const r = await transcribeInboundVoiceNote(db, args, deps())
      expect(r.status).toBe('failed')
      expect(db.updates).toHaveLength(2)
      expect(db.updates[1].patch.transcript_status).toBe('failed')
      expect(db.updates[1].eq).toEqual(['id', 'msg-1'])
    }
  })

  test('keyterms reach the transcription call', async () => {
    const db = makeDb()
    const d = deps()
    await transcribeInboundVoiceNote(db, args, d)
    const keyterms = d.transcribe.mock.calls[0][0].keyterms
    expect(keyterms).toEqual(expect.arrayContaining(['UN1T Hatch Street', 'Dean', 'UN1T', 'HYROX', 'Glofox', 'class pack', 'trial']))
  })

  test('the transcript text is never logged', async () => {
    const db = makeDb({ updateResults: [{ data: null, error: { message: 'x' } }] })
    await transcribeInboundVoiceNote(db, args, deps({ transcribe: okTranscribe(SECRET) }))
    const db2 = makeDb()
    await transcribeInboundVoiceNote(db2, args, deps({ transcribe: vi.fn(async () => ({ ok: true, text: SECRET, languageCode: 'en', languageProbability: 0.2, durationSecs: 2, words: [] })) }))
    const logged = JSON.stringify([...vi.mocked(logWarn).mock.calls, ...vi.mocked(logError).mock.calls])
    expect(logged).not.toContain('four four four')
    expect(vi.mocked(logWarn).mock.calls.length + vi.mocked(logError).mock.calls.length).toBeGreaterThan(0)
  })

  test('never throws, even when everything throws', async () => {
    const db = { from: () => { throw new Error('boom') }, storage: { from: () => { throw new Error('boom') } } }
    await expect(transcribeInboundVoiceNote(db, args, deps())).resolves.toMatchObject({ status: 'failed' })
  })
})

describe('buildKeyterms', () => {
  test('studio name, active coaches first names, fixed list; deduped and bounded', async () => {
    const db = makeDb({
      staff: [
        { profiles: { full_name: 'Dean Murphy', active: true, deleted_at: null } },
        { profiles: { full_name: 'dean o brien', active: true, deleted_at: null } },
        { profiles: { full_name: 'Gone Person', active: false, deleted_at: null } },
        { profiles: { full_name: 'Ghost', active: true, deleted_at: '2026-01-01' } },
        { profiles: null },
      ],
    })
    const terms = await buildKeyterms(db, 'loc-1', { studioName: 'UN1T Hatch Street' })
    expect(terms).toEqual(['UN1T Hatch Street', 'Dean', 'UN1T', 'HYROX', 'Glofox', 'class pack', 'trial'])
    for (const t of terms) { expect(t.length).toBeLessThanOrEqual(50); expect(t.split(/\s+/).length).toBeLessThanOrEqual(5) }
  })

  test('a failed staff read gives the fixed list only (plus the studio name)', async () => {
    const terms = await buildKeyterms(makeDb({ staffError: { message: 'x' } }), 'loc-1', { studioName: null })
    expect(terms).toEqual(['UN1T', 'HYROX', 'Glofox', 'class pack', 'trial'])
  })
})

test('lost-turn reasons', () => {
  expect([...VOICE_LOST_TURN_REASONS]).toEqual(['in_flight', 'nothing_to_answer'])
})
