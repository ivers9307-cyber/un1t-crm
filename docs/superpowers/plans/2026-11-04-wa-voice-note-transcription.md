# VOICENOTE.1 WhatsApp voice-note transcription — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inbound WhatsApp voice notes of up to 3 minutes are transcribed by ElevenLabs Scribe inside the webhook. Mia answers clear ones like text, staff see every transcript on web and phone, and anything Mia can't answer becomes a real hand-off.

**Architecture:**
- **Transport:** `src/lib/elevenlabs.js` is the HTTP transport, which never throws.
- **Orchestrator:** `src/lib/wa-voice/transcribe.js` handles the org switch, the cap, the bytes, the duration, Scribe, the clarity judge, metering and the row write.
- **Webhook and agent:** the webhook calls the orchestrator between the media rehost and `maybeAutoReply`. The agent reads the transcript from the stored row, so the history formatter swaps it in for audio rows whose status is `ok`.
- **Staff view:** web and phone both render through one pure helper in `shared/voice-note.js`.

**Tech Stack:** Next.js 16 route handlers, supabase-js (service role), vitest, Expo/RN (rendering only).

**Spec:** `docs/superpowers/specs/2026-11-04-wa-voice-note-transcription-design.md` (approved by Richard, 4 Nov 2026). Read it before any task.

## Global Constraints

- **Vendor:** no OpenAI anywhere. ElevenLabs only, model `scribe_v2`, endpoint `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key: $ELEVENLABS_API_KEY`.
- **Zero retention:** `enable_logging=false` is sent only when `process.env.ELEVENLABS_ZERO_RETENTION === 'true'`.
- **Limits:**
  - transport timeout 20 000 ms, no retry;
  - length limit 180 s;
  - Ogg duration = final page granule position ÷ 48000;
  - fallback size bound 2 MB (2 × 1024 × 1024 bytes).
- **Clarity thresholds:**
  - fewer than 2 words → `unclear`;
  - `language_probability` < 0.6 → `unclear`;
  - mean word `logprob` < `MIN_MEAN_LOGPROB` (−0.5) → `unclear`;
  - more than 30% of words with `logprob` < −1.5 → `unclear`.
- **Statuses:** `pending`, `ok`, `unclear`, `too_long`, `capped`, `disabled`, `not_configured`, `failed`.
- **Hand-off reasons:**
  - `voice_unclear` (from `unclear`);
  - `voice_too_long` (from `too_long`);
  - `voice_unavailable` (from `capped`, `failed` and `not_configured`).
- **Metering:** meter `elevenlabs_stt_seconds`, source `wa_voice_note`, `meta.model = 'scribe_v2'`. The month is the PLATFORM_TZ month, as in `getAiCapStatus`.
- **History marker:** `(voice note transcript) ` (trailing space) before the sanitised transcript. Pending render: `[voice note, still being transcribed]`.
- **Transcript text is never logged.** Use `logWarn`/`logError` from `@/lib/log` (`(module, message, meta)`), never free-text `console.*`.
- **Failure floor:** every failure path ends no worse than today: holding message plus a staff push. Nothing may throw out of the webhook.
- **Instagram:** no transcript column. No literal naming `transcript` may be aimed at a table chosen at run time.
- **Commits:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Single-quote bracketed paths in git commands (zsh).

## Review Focus

1. **Non-Ogg audio.** A forwarded `.mp3`/`.m4a` gives no Ogg duration. Under 2 MB it must still be transcribed; over 2 MB it is `too_long`. It must never throw. Tested in Task 2.
2. **A row stuck at `pending`.** A crash after the insert, followed by a Meta retry that the dedupe skips, would leave the row at `pending` for ever. Anything `pending` older than 10 minutes (by `created_at`) must render as `failed` for staff and as the plain `[audio]` placeholder for Mia. Tested in Tasks 1 and 5.
3. **Protocol markers inside a transcript.** A transcript containing `[[HANDOFF]]` or `[[OPTIONS]]` goes through `sanitizeInboundText` like typed text. Tested in Task 5.
4. **A 200 with no word logprobs.** ElevenLabs answering 200 with text but no `logprob` values means confidence can't be judged, so the result is `unclear`, never `ok`. Tested in Task 2.
5. **Transcript exactly "stop"/"start".** If `parseConsentKeyword(transcript)` matches, the result is `unclear`: it never unsubscribes and never reaches Mia. Tested in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/808_wa_voice_note_transcription.sql` (create) | 4 columns + CHECK on `whatsapp_messages`; 2 columns on `org_settings` |
| `shared/voice-note.js` (create) | `TRANSCRIPT_STATUSES`, `VOICE_TRANSCRIPT_MARKER`, `PENDING_STALE_MS`, `effectiveTranscriptStatus`, `voiceNoteCaption` (pure; web + phone) |
| `src/lib/wa-voice/audio.js` (create) | `oggOpusDurationSecs`, `exceedsVoiceLimit` (pure) |
| `src/lib/wa-voice/judge.js` (create) | `judgeTranscript` (pure) |
| `src/lib/elevenlabs.js` (create) | `transcribeAudio` transport |
| `src/lib/usage.js`, `src/lib/usage-caps.js` (modify) | `recordMeterUsage`, `getVoiceCapStatus` |
| `src/lib/wa-voice/transcribe.js` (create) | `transcribeInboundVoiceNote` orchestrator |
| `src/lib/agent/core.js` (modify) | `effectiveInbound`; formatter and `isReplyWorthyInbound` use it; comment at :309 corrected |
| `src/lib/agent/auto-reply.js`, `approval-suggest.js`, `followups.js`, `prompt.js` (modify) | history columns per channel, voice hand-offs, prompt line |
| `src/app/api/webhooks/whatsapp/route.js` (modify) | `pending` at insert, orchestrator call, preview, voice context, lost-turn hand-off |
| `src/lib/usage-summary.js`, `src/app/api/settings/org-usage/route.js`, `src/components/settings/UsageCapsForm.jsx`, `src/lib/openapi.js` (modify) | switch, cap, minutes used |
| `src/components/WAMediaContent.jsx`, `src/components/WAInbox.jsx`, `mobile/components/WAMediaThumb.jsx`, `src/components/inbox/MiaDecisionTrace.jsx` (modify) | rendering, realtime UPDATE, reason labels |

---

### Task 1: Migration and the shared voice-note helpers

**Files:**
- Create: `supabase/migrations/808_wa_voice_note_transcription.sql` (renumber if `origin/main` has moved past 807)
- Create: `shared/voice-note.js`
- Test: `shared/voice-note.test.js`, `tests/voice-note-migration.test.js`

**Interfaces:**
- Produces:
  - `TRANSCRIPT_STATUSES: readonly string[]` (the 8 statuses, in the Global Constraints order);
  - `VOICE_TRANSCRIPT_MARKER = '(voice note transcript) '`;
  - `PENDING_STALE_MS = 600_000`;
  - `effectiveTranscriptStatus(row: {transcript_status?, created_at?}, nowMs = Date.now()): string|null`, which maps `pending` older than `PENDING_STALE_MS` to `'failed'`;
  - `voiceNoteCaption(msg, nowMs = Date.now()): null | { transcript: string|null, note: string|null, language: string|null }`.

- [ ] **Step 0: Install deps in the worktree:** `cd /Users/richardivers/code/un1t-crm-voice-notes && npm ci`. Expected: it completes (app worktrees start with empty `node_modules`).
- [ ] **Step 1: Write the failing tests**

`tests/voice-note-migration.test.js`: read the migration file. Assert:
- it contains `ADD COLUMN IF NOT EXISTS transcript text`, `transcript_status text`, `transcript_language text`, `transcribed_at timestamptz`;
- the CHECK list parsed from `transcript_status IN (...)` equals `[...TRANSCRIPT_STATUSES]`;
- it contains `voice_transcription_enabled boolean NOT NULL DEFAULT false` and `voice_transcription_monthly_cap_minutes integer`;
- it contains `-- column-grant:`;
- it does not match `/instagram_messages/`.

`shared/voice-note.test.js`:
```js
test('non-audio and pre-launch audio have no caption', () => {
  expect(voiceNoteCaption({ message_type: 'text', body: 'hi' })).toBeNull()
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: null })).toBeNull()
})
test('ok shows the transcript, with language only when not English', () => {
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'Can I book 7am?', transcript_language: 'en' }))
    .toEqual({ transcript: 'Can I book 7am?', note: null, language: null })
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'Olá', transcript_language: 'por' }).language).toBe('Portuguese')
})
test('notes per status', () => {
  const c = (s, t = null) => voiceNoteCaption({ message_type: 'audio', transcript_status: s, transcript: t, created_at: new Date().toISOString() })
  expect(c('unclear', 'mumble')).toEqual({ transcript: 'mumble', note: "Couldn't make it out clearly:", language: null })
  expect(c('too_long').note).toBe('Over 3 minutes, not transcribed')
  expect(c('capped').note).toBe('Monthly transcription limit reached')
  expect(c('failed').note).toBe('Transcription unavailable')
  expect(c('not_configured').note).toBe('Transcription unavailable')
  expect(c('pending').note).toBe('Transcribing…')
  expect(c('disabled')).toBeNull()
})
test('stale pending reads as failed', () => {
  const old = new Date(Date.now() - 11 * 60_000).toISOString()
  expect(effectiveTranscriptStatus({ transcript_status: 'pending', created_at: old })).toBe('failed')
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'pending', created_at: old }).note).toBe('Transcription unavailable')
})
```
- [ ] **Step 2: Run** `npx vitest run shared/voice-note.test.js tests/voice-note-migration.test.js`. Expected: FAIL (modules or file missing).
- [ ] **Step 3: Write the migration and `shared/voice-note.js`**
  - **Migration:** a header in the house style (WHY, APPLY BEFORE the code deploys, IDEMPOTENT), wrapped in `BEGIN; … COMMIT;`.
    - `whatsapp_messages`: the 4 columns, plus `whatsapp_messages_transcript_status_check CHECK (transcript_status IS NULL OR transcript_status IN (…8…))`, added via `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`.
    - `org_settings`: `voice_transcription_enabled boolean NOT NULL DEFAULT false` and `voice_transcription_monthly_cap_minutes integer` with `CHECK (… IS NULL OR … > 0)`.
    - The comment `-- column-grant: whatsapp_messages keeps table-level SELECT for authenticated (read-only, no client write); org_settings has no client privilege (mig 730)`.
    - `COMMENT ON COLUMN` for each.
  - **Language names:** map ISO-639-1/-3 codes to names for `en/eng` (null), `pt/por` Portuguese, `es/spa` Spanish, `pl/pol` Polish, `ga/gle` Irish, `fr/fra` French, `it/ita` Italian, `de/deu` German, `ro/ron` Romanian, `lt/lit` Lithuanian. Any other code shows the code upper-cased.
- [ ] **Step 4: Run the same command.** Expected: PASS. Then apply the migration via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj`, verify the columns with `information_schema.columns`, and run `get_advisors` (security). **Ask Richard before applying**: it is a prod DDL change.
- [ ] **Step 5: Commit:** `git add supabase/migrations/808_wa_voice_note_transcription.sql shared/voice-note.js shared/voice-note.test.js tests/voice-note-migration.test.js && git commit -m "VOICENOTE.1a — transcript columns, org switch and cap, shared caption helper"`

### Task 2: Pure audio and clarity checks

**Files:**
- Create: `src/lib/wa-voice/audio.js`, `src/lib/wa-voice/judge.js`
- Test: `src/lib/wa-voice/audio.test.js`, `src/lib/wa-voice/judge.test.js`, fixtures in `src/lib/wa-voice/__fixtures__/`

**Interfaces:**
- Produces:
  - `oggOpusDurationSecs(bytes: Uint8Array): number|null`. Scan backwards for the last `OggS` page, read the 64-bit LE granule at offset 6, ÷ 48000. Return null for non-Ogg, a truncated page or a granule ≤ 0.
  - `exceedsVoiceLimit(bytes: Uint8Array): { tooLong: boolean, durationSecs: number|null }`. Use the Ogg duration > 180 if there is one, else `bytes.length > 2*1024*1024`.
  - `judgeTranscript({ text, languageProbability, words }): 'ok'|'unclear'`, with exported `MIN_MEAN_LOGPROB = -0.5`.

- [ ] **Step 1: Write the failing tests**
  - **Fixtures:** build synthetic Ogg buffers in a helper `makeOgg(granule)`: an `OggS` header with the granule field set, padded. No real audio is needed.
  - **`audio.test.js` asserts:**
    - granule 48000×5 → 5;
    - 48000×179 → not tooLong;
    - 48000×181 → tooLong;
    - random 1 MB non-Ogg → `{ tooLong: false, durationSecs: null }`;
    - random 3 MB non-Ogg → tooLong;
    - a buffer cut mid-header → null, no throw.
  - **`judge.test.js`** (`w(lp)` = `{ type:'word', text:'x', logprob: lp }`):
    ```js
    expect(judgeTranscript({ text: 'Can I book the seven am class', languageProbability: 0.98, words: Array(7).fill(w(-0.1)) })).toBe('ok')
    expect(judgeTranscript({ text: 'Hi', languageProbability: 0.99, words: [w(-0.05)] })).toBe('unclear')
    expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.4, words: Array(3).fill(w(-0.1)) })).toBe('unclear')
    expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words: Array(3).fill(w(-0.8)) })).toBe('unclear')
    expect(judgeTranscript({ text: 'a b c d e f g h i j', languageProbability: 0.9, words: [...Array(6).fill(w(-0.1)), ...Array(4).fill(w(-2))] })).toBe('unclear') // 40% < -1.5
    expect(judgeTranscript({ text: 'Can I book', languageProbability: 0.9, words: [] })).toBe('unclear')          // Review Focus 4
    expect(judgeTranscript({ text: 'Stop', languageProbability: 0.99, words: [w(-0.01)] })).toBe('unclear')
    expect(judgeTranscript({ text: 'stop please', languageProbability: 0.99, words: Array(2).fill(w(-0.01)) })).toBe(parseConsentKeyword('stop please') ? 'unclear' : 'ok') // Review Focus 5: mirrors the real keyword parser
    ```
    Only `type: 'word'` entries are counted, so `spacing` and `audio_event` are ignored.
- [ ] **Step 2: Run** `npx vitest run src/lib/wa-voice/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both files.** `judge.js` imports `parseConsentKeyword` from `@/lib/whatsapp` and returns `unclear` when it matches the trimmed text. If that import pulls heavy server modules into a pure file, move `parseConsentKeyword` into a small module re-exported from `whatsapp.js` (no behaviour change).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"VOICENOTE.1b — Ogg duration and transcript clarity judge"`

### Task 3: ElevenLabs transport, metering and the cap

**Files:**
- Create: `src/lib/elevenlabs.js`
- Modify: `src/lib/usage.js` (add a function), `src/lib/usage-caps.js` (add a function)
- Test: `src/lib/elevenlabs.test.js`, `src/lib/usage.test.js`, `src/lib/usage-caps.test.js` (extend the existing ones)

**Interfaces:**
- Produces:
  - `transcribeAudio({ bytes, mime, keyterms = [] }, { fetchImpl = fetch } = {})`. It returns `Promise<{ ok: true, text, languageCode, languageProbability, durationSecs: number|null, words: object[] } | { ok: false, reason: 'not_configured'|'http_error'|'timeout'|'bad_response', status?: number }>` and never throws.
  - `recordMeterUsage({ organizationId, locationId, meter, source, quantity, costCents, meta }, { db } = {}): Promise<void>`. It is one `usage_events` insert, swallows its own errors, and logs through `logError('usage', …)`.
  - `getVoiceCapStatus({ organizationId }, { db } = {})`. It returns `Promise<{ capped: boolean, capMinutes: number|null, usedSeconds: number|null }>` and fails OPEN (`capped: false`) on any read error.

- [ ] **Step 1: Write the failing tests**
  - **`elevenlabs.test.js`**, with a stub `fetchImpl` capturing `(url, init)`:
    - with no `ELEVENLABS_API_KEY` → `{ ok:false, reason:'not_configured' }` and fetch not called;
    - the url is `https://api.elevenlabs.io/v1/speech-to-text` with no query when zero retention is unset, and ends `?enable_logging=false` when `ELEVENLABS_ZERO_RETENTION='true'`;
    - `init.headers['xi-api-key']` is the key;
    - the FormData has `model_id === 'scribe_v2'`, `diarize === 'false'`, `tag_audio_events === 'false'`, no `language_code`, and each keyterm appended as `keyterms`;
    - a 500 → `{ ok:false, reason:'http_error', status:500 }`;
    - a fetch that never resolves + fake timers 20 000 ms → `reason:'timeout'` (advance inside `act`/`await vi.advanceTimersByTimeAsync`; attach the promise first);
    - a 200 `{ text:'hi', language_code:'en', language_probability:0.9, words:[], audio_duration_secs:2.1 }` → `ok:true, durationSecs:2.1`;
    - a 200 with non-JSON → `bad_response`.
  - **`usage.test.js`:** `recordMeterUsage` inserts `{ organization_id, location_id, meter:'elevenlabs_stt_seconds', source:'wa_voice_note', quantity:42, cost_estimate_cents:1.5, meta:{ model:'scribe_v2' } }`; a mock insert returning `{ error }` resolves without throwing.
  - **`usage-caps.test.js`:**
    - cap null → `{ capped:false, capMinutes:null }`;
    - cap 10 with used 600 s → capped;
    - with used 599 → not capped;
    - the `usage_events` read filters `meter = 'elevenlabs_stt_seconds'`, the org and `occurred_at >= <platform month start>`;
    - an org_settings read error → `capped:false`.
- [ ] **Step 2: Run** `npx vitest run src/lib/elevenlabs.test.js src/lib/usage.test.js src/lib/usage-caps.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **`getVoiceCapStatus`** sums `quantity` in JS from a `.select('quantity')` read paged with `.range()` + `.order('occurred_at')` (the 1 000-row cap). Volume is tiny, but the rule is repo-wide.
  - **`recordMeterUsage`** destructures `error` (the `no-unchecked-supabase-write` class).
  - **The cost constant** `ELEVENLABS_STT_CENTS_PER_MINUTE` lives in `elevenlabs.js` as an estimate. Take the value from Richard's plan; if unknown, use `0.4` with a `// ESTIMATE — confirm against the ElevenLabs plan` comment.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"VOICENOTE.1c — ElevenLabs Scribe transport, STT metering and the voice cap"`

### Task 4: The orchestrator

**Files:**
- Create: `src/lib/wa-voice/transcribe.js`
- Test: `src/lib/wa-voice/transcribe.test.js`

**Interfaces:**
- Consumes: Task 2 (`exceedsVoiceLimit`, `judgeTranscript`), Task 3 (`transcribeAudio`, `recordMeterUsage`, `getVoiceCapStatus`, `ELEVENLABS_STT_CENTS_PER_MINUTE`).
- Produces: `transcribeInboundVoiceNote(db, { messageId, locationId, storagePath }, deps = {})`. It returns `Promise<{ status: string, transcript: string|null, language: string|null }>`, never throws, and always writes a final status to the row.
  - `deps` is for tests: `{ transcribe, recordUsage, voiceCap, now }`.
  - It exports `buildKeyterms(db, locationId): Promise<string[]>`, which returns the studio name, the first names of coaches with active `profile_locations` at that studio, and `['UN1T', 'HYROX', 'Glofox', 'class pack', 'trial']`. It is deduped, each term ≤ 50 characters and ≤ 5 words, and a failed read gives the fixed list only.

- [ ] **Step 1: Write the failing tests.** Use a mock db recording every `.update()` on `whatsapp_messages`. One test per path, each asserting the returned status AND the written status:
  - **Org switch:** off → `disabled`, no transcribe call. A `locations`/`org_settings` read error → `failed`.
  - **Cap:** `voiceCap` capped → `capped`.
  - **Bytes:** `storagePath` null → `failed`; a storage download error → `failed`.
  - **Length:** a 181 s Ogg → `too_long`, no transcribe call.
  - **Transport:** `transcribe` `not_configured` → `not_configured`; `http_error` → `failed`. Neither calls `recordUsage`.
  - **Answered:** clear text → `ok`, `transcript` trimmed, `language` set, `recordUsage` called once with `quantity = durationSecs` and `costCents = durationSecs/60 × ELEVENLABS_STT_CENTS_PER_MINUTE`. Unclear → `unclear`, with the transcript still written.
  - **Failed row write:** the update returns `{ error }` or 0 rows → the result is `failed`, followed by a second best-effort update to `transcript_status: 'failed'`.
  - **Every write:** `.eq('id', messageId)` with `transcribed_at` set.
  - **Logging:** no logged meta contains the transcript text (spy on `logWarn`/`logError`).
- [ ] **Step 2: Run** `npx vitest run src/lib/wa-voice/transcribe.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the spec's §3 steps 1–8 in order, passing
  `buildKeyterms(db, locationId)` as `keyterms` to `transcribe`. Add a test that
  the keyterms reach the transcribe call and that a failed `profile_locations`
  read still passes the fixed list.
  - Get the org from `locations.organization_id` by id, then `org_settings.voice_transcription_enabled`. A missing org_settings row counts as `disabled`.
  - Download the bytes with `db.storage.from('whatsapp-media').download(storagePath)` → `new Uint8Array(await blob.arrayBuffer())`.
  - Use `exceedsVoiceLimit`'s `durationSecs` when Scribe omits `audio_duration_secs`. With neither, meter 0 and `logWarn`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"VOICENOTE.1d — transcribeInboundVoiceNote orchestrator"`

### Task 5: Mia's history and gates (pure, core.js)

**Files:**
- Modify: `src/lib/agent/core.js` (`formatHistoryForClaude` :363, `isReplyWorthyInbound` :421, the comment at :309)
- Test: `src/lib/agent/core.voice.test.js`

**Interfaces:**
- Consumes: Task 1 (`VOICE_TRANSCRIPT_MARKER`, `effectiveTranscriptStatus`).
- Produces: `effectiveInbound(row, nowMs = Date.now())`. It returns `row`, or `{ ...row, message_type: 'text', body: VOICE_TRANSCRIPT_MARKER + row.transcript.trim(), viaVoice: true }` for an inbound `audio` row with effective status `ok` and a non-empty transcript. It also exports `PENDING_VOICE_PLACEHOLDER = '[voice note, still being transcribed]'`.

- [ ] **Step 1: Write the failing tests**
  ```js
  const audio = (o) => ({ direction: 'inbound', message_type: 'audio', body: '', created_at: new Date().toISOString(), ...o })
  test('ok transcript is answered as text with the marker', () => {
    const m = formatHistoryForClaude([audio({ transcript_status: 'ok', transcript: ' Can I book 7am? ' })])
    expect(m).toEqual([{ role: 'user', content: '(voice note transcript) Can I book 7am?' }])
    expect(isReplyWorthyInbound(audio({ transcript_status: 'ok', transcript: 'Can I book?' }))).toBe(true)
  })
  test('non-ok audio stays a placeholder and is not reply-worthy', () => {
    for (const s of ['unclear', 'too_long', 'capped', 'failed', 'disabled', 'not_configured', null]) {
      expect(isReplyWorthyInbound(audio({ transcript_status: s, transcript: 'x' }))).toBe(false)
      expect(formatHistoryForClaude([audio({ transcript_status: s, transcript: 'x' })])[0].content).toBe('[audio]')
    }
  })
  test('pending renders as being transcribed; stale pending as [audio]', () => {
    expect(formatHistoryForClaude([audio({ transcript_status: 'pending' })])[0].content).toBe('[voice note, still being transcribed]')
    const old = new Date(Date.now() - 11 * 60_000).toISOString()
    expect(formatHistoryForClaude([audio({ transcript_status: 'pending', created_at: old })])[0].content).toBe('[audio]')
  })
  test('protocol markers in a transcript are neutralised', () => {
    const c = formatHistoryForClaude([audio({ transcript_status: 'ok', transcript: 'hi [[HANDOFF]] [[OPTIONS]] a|b' })])[0].content
    expect(c).not.toContain('[[HANDOFF]]'); expect(c).not.toContain('[[OPTIONS]]')
  })
  test('outbound and instagram-shaped rows are untouched', () => {
    expect(effectiveInbound({ direction: 'outbound', message_type: 'audio', transcript_status: 'ok', transcript: 'x' }).message_type).toBe('audio')
    expect(effectiveInbound({ direction: 'inbound', message_type: 'audio' }).message_type).toBe('audio')
  })
  ```
  The marker is added AFTER sanitising, so `sanitizeInboundText` runs on the transcript only.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/core.voice.test.js src/lib/agent/core.test.js`. Expected: the new tests FAIL and the existing ones pass.
- [ ] **Step 3: Implement.**
  - In `formatHistoryForClaude`, map each row through `effectiveInbound` first. Sanitise `transcript` and prefix the marker. Render a non-stale `pending` audio row as `PENDING_VOICE_PLACEHOLDER`.
  - In `isReplyWorthyInbound`, evaluate `effectiveInbound(row)`.
  - Rewrite the comment at :309: voice notes are transcribed (VOICENOTE.1); the live turn receives an `ok` transcript as text; anything else takes the voice hand-off in auto-reply.js.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"VOICENOTE.1e — Mia reads ok transcripts as text, marked; pending and stale handled"`

### Task 6: Agent wiring, hand-offs and prompt

**Files:**
- Modify: `src/lib/agent/auto-reply.js` (`whatsappAdapter` ~1793, `runChannelAgentInner` ~537 + the gate ~628, `handoff` ~1578, the history read ~697, `hasInboundAfter` ~460); `src/lib/agent/instagram.js` (adapter ~248); `src/lib/agent/approval-suggest.js` (~275, ~289); `src/lib/agent/followups.js` (~277); `src/lib/agent/prompt.js` (`buildCustomerSystemPromptParts` stableParts); `src/components/inbox/MiaDecisionTrace.jsx` (`REASON_LABELS`)
- Test: `src/lib/agent/auto-reply-voice.test.js`, `tests/voice-transcript-select-guard.test.js`

**Interfaces:**
- Consumes: Task 5 (`effectiveInbound`).
- Produces:
  - `maybeAutoReply(db, { …, voiceTranscript?: { status: string, text: string|null } })`.
  - `adapter.historyColumns: string`. WhatsApp: `'direction, body, message_type, created_at, source, transcript, transcript_status'`. Instagram: `'direction, body, message_type, created_at, source'`.
  - `HISTORY_COLUMNS_BY_CHANNEL` in approval-suggest.js (without `source`, to match its current select).
  - `VOICE_HANDOFF_REASON: Record<status, reason>`.
  - `export async function markVoiceNoteForStaff(db, { conversationId, locationId }): Promise<void>`. It stamps `agent_handed_off_at = now` and `handoff_escalated_at = null` with `agent_active` left unchanged, so Mia stays on (a plan-level call: the spec's "same stamp, no holding message" without silencing Mia, who may have answered the text correctly). It then pushes managers with title `WhatsApp · voice note needs a look` and body `A voice note arrived while Mia was answering another message — check it was covered.` It is deliberately not debounced: volume is tiny and a missed voice note matters more than a second push.

- [ ] **Step 1: Write the failing tests** (`auto-reply-voice.test.js`, using the mocking pattern of `auto-reply-no-credits.test.js`):
  - **`ok`:** `voiceTranscript: { status: 'ok', text: 'Can I book 7am?' }` with `messageType: 'audio'`. `shouldAgentReply` receives `message: { type: 'text', body: 'Can I book 7am?' }`, and the turn proceeds (the model is called).
  - **Hand-off statuses:** for `unclear`, `too_long`, `capped`, `failed` and `not_configured` while on duty, the conversation update has `agent_active: false` + `agent_handed_off_at` (i.e. `handoff()` ran), the result is `{ handled: true, action: 'handoff', reason: <voice reason> }`, and the push body names the reason.
  - **`disabled`, or no `voiceTranscript`** on audio: today's `softHandoff` (result `action: 'soft_handoff'`, reason `unsupported_type`). This is an assertion on current behaviour.
  - **Off duty:** Mia disabled or in quiet hours with an `unclear` status → no hand-off, `{ handled: false, reason: 'disabled' | 'quiet_hours' }`.
  - **History select:** the WhatsApp history select string includes `transcript, transcript_status`; the Instagram adapter's does not.
  - **`markVoiceNoteForStaff`:** the update has no `agent_active` key, and the push fires once.
  - **`tests/voice-transcript-select-guard.test.js`:** scan `src/lib/agent/**/*.js` (non-test). Fail if any `.select(` literal containing `transcript` sits in a chain whose `.from(` argument is not the literal `'whatsapp_messages'`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/auto-reply-voice.test.js tests/voice-transcript-select-guard.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **In `runChannelAgentInner`:** read `voiceTranscript` from `ctx`. Build `message` as `{ type: 'text', body: voiceTranscript.text }` when `messageType === 'audio' && voiceTranscript?.status === 'ok'`, else as today.
  - **In the `!decision.reply` branch:** before the existing `unsupported_type` → `softHandoff`, add: if `decision.onDuty && messageType === 'audio' && VOICE_HANDOFF_REASON[voiceTranscript?.status]`, then `await handoff(... reason: VOICE_HANDOFF_REASON[status] ...)` and return `{ handled: true, action: 'handoff', reason }`.
  - **`handoff()`'s push body:** pass the human text (`Voice note Mia couldn't make out`, `Voice note over 3 minutes`, `Voice note: transcription unavailable`) as its `reason` argument, keyed by the reason code.
  - **Selects:** the history read at ~697 and `hasInboundAfter` at ~463 both select `adapter.historyColumns` (`hasInboundAfter` keeps its `direction = 'inbound'` filter; the wider list gives `isReplyWorthyInbound` the `created_at` it needs for the stale check). `approval-suggest.js:289` selects `HISTORY_COLUMNS_BY_CHANNEL[row.channel]`. `followups.js:277` reads `'whatsapp_messages'` literally, so add `transcript, transcript_status` there.
  - **`prompt.js`:** push this paragraph into `stableParts` right after the base prompt, verbatim:
    `'## Voice notes\nMessages that begin "(voice note transcript)" are automatic transcripts of a voice note the customer sent, and may contain small mis-hearings. Answer them exactly as you would the same words typed. Never mention the label, never say it was a voice note, and never comment on the format. If a transcript does not make sense, hand off rather than guess. A message reading "[voice note, still being transcribed]" is not ready: do not guess at what it says.'`
  - **`REASON_LABELS`:** `voice_unclear: "Voice note Mia couldn't make out"`, `voice_too_long: 'Voice note over 3 minutes'`, `voice_unavailable: 'Voice note: transcription unavailable'`.
- [ ] **Step 4: Run** `npx vitest run src/lib/agent/` and the guard. Expected: all PASS, with existing agent tests unchanged. Then run `npm run check:select-columns`. Expected: clean (Task 1's migration defines the columns).
- [ ] **Step 5: Commit:** `"VOICENOTE.1f — Mia answers ok voice notes; real hand-off for the rest; per-channel history columns"`

### Task 7: Webhook wiring

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (insert ~593, after the rehost ~710, the `maybeAutoReply` call ~780)
- Test: `src/app/api/webhooks/whatsapp/route.voice-note.test.js`

**Interfaces:**
- Consumes: Task 4 (`transcribeInboundVoiceNote`), Task 6 (`maybeAutoReply` with `voiceTranscript`, `markVoiceNoteForStaff`).
- Produces: `VOICE_LOST_TURN_REASONS = new Set(['in_flight', 'nothing_to_answer'])`, exported from `src/lib/wa-voice/transcribe.js`.

- [ ] **Step 1: Write the failing tests** (the mocking pattern of `route.flow-ack.test.js`):
  - **Insert:** an inbound `audio` message's insert row carries `transcript_status: 'pending'`. A `text` insert carries no `transcript_status` key.
  - **Order:** the orchestrator is called after `ensureMediaRehosted` with `{ messageId, locationId, storagePath }` (the returned path), and before `maybeAutoReply`.
  - **Agent context:** `maybeAutoReply` receives `voiceTranscript: { status, text }` from the orchestrator.
  - **Preview:** when there is a transcript, a checked update sets `last_message_preview` to `'Voice note: ' + text.slice(0, 80)`.
  - **Lost turn:** an orchestrator `ok` + a `maybeAutoReply` result `{ handled:false, reason:'in_flight' }` → `markVoiceNoteForStaff` called once. The same with `nothing_to_answer` → called. A result of `{ handled:true, action:'reply' }` → not called. `{ handled:false, reason:'quiet_hours' }` → not called.
  - **Errors:** an orchestrator that throws → `maybeAutoReply` is still called with `voiceTranscript: { status: 'failed', text: null }`, and the response is still 200.
  - **Other types:** `text` and `image` inbound → the orchestrator is not called.
  - **Consent:** an audio message never calls `applyWhatsappConsentKeyword` (pins the existing `messageType === 'text'` gate).
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/webhooks/whatsapp/route.voice-note.test.js'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Insert:** add `...(messageType === 'audio' ? { transcript_status: 'pending' } : {})` to the insert.
  - **Keep the path:** capture `ensureMediaRehosted`'s return value in `rehostedPath`.
  - **Orchestrator call:** when `messageType === 'audio' && insertedMessage?.id`, call it in its own try/catch. On a throw, `logError('wa-webhook', 'voice transcription threw', { conversationId, err })` and set `{ status: 'failed', transcript: null }`.
  - **Agent call:** pass `voiceTranscript: { status: r.status, text: r.transcript }` to `maybeAutoReply`.
  - **After the agent turn:** apply the lost-turn rule (`r.status === 'ok' && agentResult && !(agentResult.handled && agentResult.action === 'reply') && VOICE_LOST_TURN_REASONS.has(agentResult.reason)`) in its own try/catch.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/app/api/webhooks/whatsapp/`. Expected: all PASS.
- [ ] **Step 5: Commit:** `git add 'src/app/api/webhooks/whatsapp/route.js' 'src/app/api/webhooks/whatsapp/route.voice-note.test.js' src/lib/wa-voice/transcribe.js && git commit -m "VOICENOTE.1g — webhook transcribes voice notes before Mia's turn"`

### Task 8: Settings (switch, cap, minutes used)

**Files:**
- Modify: `src/lib/usage-summary.js` (~54), `src/app/api/settings/org-usage/route.js`, `src/components/settings/UsageCapsForm.jsx`, `src/lib/openapi.js`
- Test: `src/lib/usage-summary.test.js`, `src/app/api/settings/org-usage/route.test.js` (create if missing)

**Interfaces:**
- Consumes: Task 3 (`getVoiceCapStatus`).
- Produces:
  - `getOrgUsageSummary` returns, in addition, `voice: { enabled: boolean, capMinutes: number|null, usedMinutes: number }`, where `usedMinutes = Math.ceil(usedSeconds/60)`.
  - The PUT body accepts `voice_transcription_enabled: z.boolean().optional()` and `voice_transcription_monthly_cap_minutes: z.number().int().positive().max(100000).nullable().optional()`.

- [ ] **Step 1: Write the failing tests:**
  - the summary includes `voice` from mocked org_settings + usage;
  - the PUT patches only the keys present;
  - a non-org-admin gets 403;
  - `voice_transcription_monthly_cap_minutes: 0` gets 400;
  - the upsert's `.select(...)` names both new columns, and the response returns them.
- [ ] **Step 2: Run** `npx vitest run src/lib/usage-summary.test.js 'src/app/api/settings/org-usage/route.test.js'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The form:** a new section "Voice notes" with:
    - a toggle "Transcribe WhatsApp voice notes";
    - a number input "Monthly limit (minutes)" (empty = no limit);
    - the line `{usedMinutes} minutes used this month`;
    - the copy `Voice notes are sent to ElevenLabs to be transcribed.`
  - **Styling:** light theme tokens; `type="button"` on any non-submit button.
  - **OpenAPI:** register the two fields on the org-usage PUT schema in `openapi.js`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"VOICENOTE.1h — voice transcription switch, monthly cap and minutes used on the usage settings"`

### Task 9: Staff view (web + phone)

**Files:**
- Modify: `src/components/WAMediaContent.jsx` (audio branch ~65), `src/components/WAInbox.jsx` (realtime ~380), `mobile/components/WAMediaThumb.jsx`
- Test: `src/components/WAMediaContent.voice.test.jsx` (mobile has no component test harness; its rendering is a thin call to `voiceNoteCaption`, which Task 1 tests, and is checked by `check:mobile-lint` + `check:mobile-imports`)

**Interfaces:**
- Consumes: Task 1 (`voiceNoteCaption` from `@shared/voice-note` on web, `shared/voice-note` on mobile).

- [ ] **Step 1: Write the failing tests.**
  - **Web:** rendering an audio message with `{ transcript_status:'ok', transcript:'Can I book 7am?' }` shows that text under the player. `unclear` shows `Couldn't make it out clearly:` and the text. `too_long` shows `Over 3 minutes, not transcribed`. `disabled` shows no caption. A non-English `ok` shows `Transcribed from Portuguese`.
- [ ] **Step 2: Run** `npx vitest run src/components/WAMediaContent.voice.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Web caption:** a `<p className="mt-1 text-sm text-un1t-muted max-w-[260px] whitespace-pre-wrap">`, with the note in `text-un1t-subtle`.
  - **Realtime:** in `WAInbox.jsx`, add `.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'whatsapp_messages' }, …)`, which calls `fetchMessages(convId)` only when `payload.new.conversation_id === selectedIdRef.current` (no `fetchConversations`; the conversation preview update already triggers that).
  - **Mobile:** the same caption in `WAMediaThumb.jsx` under the audio button, built from `voiceNoteCaption(msg)` and using the RN `Text` styles already in the file. Import from `shared/voice-note`, never a relative path.
- [ ] **Step 4: Run** the same commands, then `npm run check:mobile-imports` and `npm run check:mobile-lint`. Expected: PASS and clean.
- [ ] **Step 5: Commit:** `"VOICENOTE.1i — transcripts under voice notes on web and phone; live on UPDATE"`

### Task 10: Ship checks, PR and changelog

- [ ] **Step 1: Run the full CI mirror once** (the 13 commands in CLAUDE.md). Expected: all green.
  - Then run `npm run build`. Expected: success (new imports and routes).
  - Do not run the suite again beside the build (8 GB Mac).
- [ ] **Step 2: Push and open the PR.** `git push -u origin HEAD`, then `gh pr create --base main --fill`. The PR body:
  - says the migration was applied before merge;
  - lists Richard's go-live steps (spec "Calibration and go-live", plus the DPA, the privacy-policy subprocessor line and `ELEVENLABS_API_KEY` in Vercel);
  - ends with the Claude Code attribution line.
- [ ] **Step 3: Add the changelog entry.** Add `docs/changelog/entries/<PR>.md` with one row keyed `#<PR>`, then commit and push it.
