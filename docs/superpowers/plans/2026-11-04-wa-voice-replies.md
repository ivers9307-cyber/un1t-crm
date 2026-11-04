# VOICEREPLY.1 Mia's WhatsApp voice replies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the customer message Mia is answering is a WhatsApp voice note, her reply goes out as a voice note (ElevenLabs text-to-speech, in a manager-chosen voice per kind of reply), with any link or buttons as a short text after it. Every failure falls back to today's text.

**Architecture:**
- Pure rules (what is spoken, which kind, which voice) live in `src/lib/wa-voice/reply-rules.js`.
- `src/lib/wa-voice/reply.js` is the gate and send: mode, test list, cap, voice, speech, storage, the WhatsApp voice send, metering. It never throws.
- The agent calls it from `sendAndLog` and the two holding-message paths, falling back to the existing text send on any `sent: false`.
- A `failed` delivery status on a voice-reply row resends the text once from the webhook.

**Tech Stack:** Next.js 16 route handlers, supabase-js (service role), vitest, Expo/RN (rendering only).

**Spec:** `docs/superpowers/specs/2026-11-04-wa-voice-replies-design.md` (approved by Richard, 4 Nov 2026). Read it before any task. It builds on VOICENOTE.1 (`src/lib/wa-voice/`, `src/lib/elevenlabs.js`, `shared/voice-note.js`).

## Global Constraints

- **Vendor:** ElevenLabs only. TTS is `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=opus_48000_64`, header `xi-api-key: $ELEVENLABS_API_KEY`, body `{ text, model_id }`. Voices: `GET https://api.elevenlabs.io/v2/voices?page_size=100` (paged by `next_page_token`). No OpenAI.
- **Model:** `ELEVENLABS_TTS_MODEL = 'eleven_v4_turbo'` (Task 3's probe may change it to `'eleven_flash_v2_5'`).
- **Price:** `ELEVENLABS_TTS_CENTS_PER_1K_CHARS = 4` ($0.04 per 1,000 characters, Richard's price sheet, 4 Nov 2026).
- **Timeout:** 15 000 ms, no retry.
- **Trigger:** voice only when the newest inbound Mia answers is `message_type 'audio'`. A typed message never voices.
- **Kinds:** `lead`, `booking`, `member`, `handoff`, `default`. Precedence is handoff > booking > member > lead. A missing voice falls back to `default`, and a missing default means text.
- **Spoken text:** emoji, `*`/`_` markup, bullet markers and URLs are removed. Words are never added or changed. Over `MAX_SPOKEN_CHARS = 600` → text, reason `too_long`.
- **Mode:** `org_settings.voice_reply_mode` is `'off' | 'test' | 'on'` (ONE column; never two booleans). In `test`, only numbers in `voice_reply_test_phones` (matched with `phoneMatchesAllowlist` from `src/lib/agent/core.js`) get voice.
- **Cap:** `voice_reply_monthly_cap` counts voice replies per PLATFORM_TZ month (meter `elevenlabs_tts_replies`, quantity 1). Characters are metered as `elevenlabs_tts_characters`. A failed cap read fails open.
- **Audio:** only bytes starting with `OggS` are sent as a voice note (`sendMediaMessage(..., 'audio', url, null, { voice: true, ...replyOpts })`). Anything else → text, reason `not_ogg`.
- **Signed URL TTL:** 3600 s.
- **Failure floor:** every `sent: false` path sends exactly today's text, buttons or cta_url. Log with `logWarn('wa-voice-reply', …)` with the reason and ids, never the text.
- **Prompt line (volatile suffix only, voice turns only), verbatim:**
  `'## This reply will be spoken\nThe customer sent a voice note, so your reply will be sent as a voice note. Write it as you would say it: short and conversational, no emoji, no lists or bullet points, no bold, and spell times the way you would say them. A booking link or buttons are still fine: they are sent as text after the voice note.'`
- **Commits:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Single-quote bracketed paths (zsh). Work in `/Users/richardivers/code/un1t-crm-voice-notes` on branch `wa-voice-replies` (run `npm ci` first if `node_modules` is stale).

## Review Focus

1. **A concurrent text after the voice note.** If the newest inbound is the text, the reply is text, even though `ctx.messageType` is `'audio'`. Tested in Task 5.
2. **A reply that is only a link or only options.** If the spoken text is empty after tidying, it goes as text with reason `nothing_to_speak`, never an empty voice note. Tested in Task 2.
3. **The voice note sent but the follow-up failed.** Log with `logError`. The reply is NOT resent as text, and the result still counts as sent. Tested in Task 5.
4. **A duplicate `failed` status webhook.** The text fallback is sent at most once (compare-and-set on `voice_fallback_sent_at`). Tested in Task 6.
5. **A studio at the cap mid-burst.** Two replies racing at `cap - 1` may both voice. That is accepted (fail-open posture). It must never throw or block the text. Tested in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/809_wa_voice_replies.sql` (create; renumber after a fresh `origin/main` sync) | `org_settings` mode/test phones/cap; `whatsapp_messages.voice_kind` + `voice_fallback_sent_at` |
| `shared/voice-note.js` (modify) | `VOICE_KINDS`, `VOICE_KIND_LABELS`, `voiceReplyLabel(msg)` |
| `src/lib/wa-voice/reply-rules.js` (create) | `spokenTextFor`, `splitForVoice`, `voiceKindFor`, `voiceFor`, `isOggOpus`, `toolResultSucceeded`, `isVoiceTrigger`, `MAX_SPOKEN_CHARS`, `VOICE_REPLY_PROMPT_LINE` |
| `src/lib/elevenlabs.js` (modify) | `synthesizeSpeech`, `listVoices`, TTS constants |
| `src/lib/usage-caps.js` (modify) | `meterSumThisMonth` (generalises `voiceSecondsThisMonth`), `getVoiceReplyCapStatus` |
| `scripts/elevenlabs-tts-probe.mjs` (create) | one-off live check of the Ogg container and the model |
| `src/lib/wa-voice/reply.js` (create) | `maybeSendVoiceReply` |
| `src/lib/agent/auto-reply.js`, `prompt.js` (modify) | trigger, prompt line, tool success on the trace, voice in `sendAndLog` / `handoff` / `softHandoff`, decision meta |
| `src/app/api/webhooks/whatsapp/route.js` (modify) | the `failed`-status text fallback |
| `src/app/api/settings/org-usage/route.js`, `src/lib/usage-summary.js`, `src/components/settings/UsageCapsForm.jsx` (modify) | mode, test numbers, cap, replies used |
| `src/app/api/settings/voice-replies/route.js` (create), `src/app/api/settings/voice-replies/sample/route.js` (create), `src/components/settings/MiaVoicesCard.jsx` (create), `src/app/settings/customer-agent/page.js` (modify), `src/lib/openapi.js` (modify) | the studio's voices |
| `src/components/WAMediaContent.jsx`, `mobile/components/WAMediaThumb.jsx` (modify) | the "Mia replied by voice · <kind>" label |
| `src/app/privacy/page.js`, `src/app/privacy/members/page.js`, `src/app/legal/subprocessors/page.js` (modify) | ElevenLabs also voices replies |

---

### Task 1: Migration and shared kinds

**Files:**
- Create: `supabase/migrations/809_wa_voice_replies.sql`
- Modify: `shared/voice-note.js`
- Test: `tests/voice-reply-migration.test.js`, `shared/voice-note.test.js` (extend)

**Interfaces:**
- Produces:
  - `VOICE_KINDS = ['lead', 'booking', 'member', 'handoff', 'default']` (frozen);
  - `VOICE_KIND_LABELS = { lead: 'Leads and trials', booking: 'Bookings', member: 'Member questions', handoff: 'Hand-off message', default: 'Default' }`;
  - `voiceReplyLabel(msg): string|null`, which returns `'Mia replied by voice · ' + VOICE_KIND_LABELS[kind]` for an outbound `audio` row with a `voice_kind`, else null.

- [ ] **Step 1: Write the failing tests.**
  - **Migration** (`tests/voice-reply-migration.test.js`), asserting the file contains:
    - `voice_reply_mode text NOT NULL DEFAULT 'off'` and a CHECK whose list is exactly `('off', 'test', 'on')`;
    - `voice_reply_test_phones text[] NOT NULL DEFAULT '{}'`;
    - `voice_reply_monthly_cap integer` with `> 0`;
    - `ADD COLUMN IF NOT EXISTS voice_kind text`, whose CHECK list equals `VOICE_KINDS`;
    - `ADD COLUMN IF NOT EXISTS voice_fallback_sent_at timestamptz`;
    - `-- column-grant:`;
    - nothing matching `/instagram_messages/`.
  - **Labels** (`voice-note.test.js`):
    - `voiceReplyLabel({ direction:'outbound', message_type:'audio', voice_kind:'booking' }) === 'Mia replied by voice · Bookings'`;
    - an inbound audio row → null;
    - an outbound audio row with no `voice_kind` → null.
- [ ] **Step 2: Run** `npx vitest run tests/voice-reply-migration.test.js shared/voice-note.test.js`. Expected: FAIL.
- [ ] **Step 3: Write the migration** in the 808 house style: WHY, APPLY BEFORE the code deploys, IDEMPOTENT, `BEGIN; … COMMIT;`.
  - Use `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` for each CHECK.
  - Add `COMMENT ON COLUMN` for each column.
  - Grant comment: `whatsapp_messages` keeps table-level SELECT for authenticated (read-only), and `org_settings` has no client privilege (mig 730).
  - Add the shared exports.
- [ ] **Step 4: Run** the same command. Expected: PASS. **Do not apply the migration yet.** Ask Richard at the end of the branch, as VOICENOTE.1 did.
- [ ] **Step 5: Commit** `"VOICEREPLY.1a — voice-reply settings and columns; shared kinds"`.

### Task 2: The pure rules

**Files:**
- Create: `src/lib/wa-voice/reply-rules.js`
- Test: `src/lib/wa-voice/reply-rules.test.js`

**Interfaces:**
- Produces:
  - `MAX_SPOKEN_CHARS = 600`.
  - `VOICE_REPLY_PROMPT_LINE` (the Global Constraints text, verbatim).
  - `spokenTextFor(text: string): string`.
  - `splitForVoice({ text, options }): { spoken: string, followUp: null | { kind: 'cta_url', body: string, url: string } | { kind: 'options', options: string[] } | { kind: 'text', text: string } }`:
    - a trailing link (`splitTrailingUrl` from `@/lib/whatsapp`) → `cta_url` with the spoken body;
    - options → `options`;
    - a URL elsewhere → `text` with the original full text;
    - otherwise `null`.
  - `voiceKindFor({ isHandoff, bookingToolSucceeded, isMember }): 'handoff'|'booking'|'member'|'lead'`.
  - `voiceFor(kind, voices): { voice_id, name } | null`.
  - `isOggOpus(bytes: Uint8Array): boolean` (`OggS` at offset 0).
  - `toolResultSucceeded(name, result): boolean`. It is true only for `book_class`/`book_consultation`/`book_event` with `booked === true`, `cancel_class_booking`/`cancel_event_registration` with `cancelled === true`, and `move_class_booking`/`move_event_entry` with `moved === true`.
  - `isVoiceTrigger({ historyRows }): boolean`: the newest `direction:'inbound'` row has `message_type === 'audio'`.

- [ ] **Step 1: Write the failing tests:**
  ```js
  expect(spokenTextFor('Yes! 🎉 *7am* is free.\n\n• ENG1NE 7:00\n• HYROX 8:00')).toBe('Yes! 7am is free.\nENG1NE 7:00\nHYROX 8:00')
  expect(spokenTextFor('Book here https://x.test/b today')).toBe('Book here today')
  expect(splitForVoice({ text: 'Great, book here https://x.test/b', options: null }))
    .toEqual({ spoken: 'Great, book here', followUp: { kind: 'cta_url', body: 'Great, book here', url: 'https://x.test/b' } })
  expect(splitForVoice({ text: 'Which time?', options: ['7am', '8am'] })).toEqual({ spoken: 'Which time?', followUp: { kind: 'options', options: ['7am', '8am'] } })
  expect(splitForVoice({ text: 'See https://x.test/t for times, then reply', options: null }).followUp)
    .toEqual({ kind: 'text', text: 'See https://x.test/t for times, then reply' })
  expect(splitForVoice({ text: 'https://x.test/b', options: null }).spoken).toBe('')   // Review Focus 2: the caller sends text
  expect(voiceKindFor({ isHandoff: true, bookingToolSucceeded: true, isMember: true })).toBe('handoff')
  expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: true, isMember: false })).toBe('booking')
  expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: false, isMember: true })).toBe('member')
  expect(voiceKindFor({ isHandoff: false, bookingToolSucceeded: false, isMember: false })).toBe('lead')
  expect(voiceFor('booking', { default: { voice_id: 'd' } })).toEqual({ voice_id: 'd' })
  expect(voiceFor('booking', {})).toBeNull()
  expect(isOggOpus(new Uint8Array([0x4f,0x67,0x67,0x53,0]))).toBe(true); expect(isOggOpus(new Uint8Array([0xff,0xfb]))).toBe(false)
  expect(toolResultSucceeded('book_class', { booked: true })).toBe(true); expect(toolResultSucceeded('book_class', { booked: false })).toBe(false)
  expect(toolResultSucceeded('list_upcoming_classes', { classes: [] })).toBe(false)
  expect(isVoiceTrigger({ historyRows: [{ direction:'inbound', message_type:'audio' }, { direction:'inbound', message_type:'text' }] })).toBe(false) // newest last
  ```
  Also: 600 characters of spoken text is allowed, and 601 is reported by the caller as `too_long`. Test the constant, and test `spokenTextFor` on a long string.
- [ ] **Step 2: Run** `npx vitest run src/lib/wa-voice/reply-rules.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Match emoji with `\p{Extended_Pictographic}` plus `️`/ZWJ. Bullets are `^\s*[•\-*]\s+`. `historyRows` are ascending, so the newest is last. `splitForVoice` uses `spokenTextFor` on the spoken part.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `"VOICEREPLY.1b — what is spoken, which kind and which voice"`.

### Task 3: ElevenLabs TTS transport, the voice-reply cap and the live probe

**Files:**
- Modify: `src/lib/elevenlabs.js`, `src/lib/usage-caps.js`
- Create: `scripts/elevenlabs-tts-probe.mjs`
- Test: `src/lib/elevenlabs.tts.test.js`, `src/lib/usage-caps.voice.test.js` (extend)

**Interfaces:**
- Produces:
  - `synthesizeSpeech({ text, voiceId, outputFormat = 'opus_48000_64' }, { fetchImpl } = {})`. It returns `Promise<{ ok: true, bytes: Uint8Array, mime: string } | { ok: false, reason: 'not_configured'|'http_error'|'timeout'|'bad_response', status?: number }>` and never throws. The mime is `'audio/ogg'` for opus and `'audio/mpeg'` for mp3.
  - `listVoices({ fetchImpl } = {})`. It returns `Promise<{ ok: true, voices: Array<{ voice_id, name, category, labels }> } | { ok: false, reason }>`, following `next_page_token` up to 10 pages.
  - Constants `ELEVENLABS_TTS_MODEL` and `ELEVENLABS_TTS_CENTS_PER_1K_CHARS = 4`.
  - `meterSumThisMonth(client, organizationId, meter): Promise<number|null>`. `voiceSecondsThisMonth` becomes `(c, o) => meterSumThisMonth(c, o, 'elevenlabs_stt_seconds')`, with its behaviour unchanged.
  - `getVoiceReplyCapStatus({ organizationId }, { db } = {})`. It returns `Promise<{ capped: boolean, cap: number|null, used: number|null }>` and fails open.

- [ ] **Step 1: Write the failing tests** (stub fetch, as in `elevenlabs.test.js`):
  - **Request:** the URL is `…/v1/text-to-speech/v-1?output_format=opus_48000_64`; the header `xi-api-key`; the JSON body `{ text, model_id: ELEVENLABS_TTS_MODEL }`.
  - **Failures:** no key → `not_configured`, with no call made; a 401 → `http_error, status 401`; a fetch that never resolves for 15 000 ms (fake timers, attach the promise first) → `timeout`; an empty body → `bad_response`.
  - **Success:** a 200 with bytes → `ok, bytes` (a `Uint8Array`).
  - **`listVoices`:** two pages are joined.
  - **Cap:** cap 3 with used 3 → capped; with used 2 → not; the read filters `meter = 'elevenlabs_tts_replies'`; a read error → `capped: false`; and the existing `usage-caps.voice.test.js` cases still pass.
- [ ] **Step 2: Run** `npx vitest run src/lib/elevenlabs.tts.test.js src/lib/usage-caps.voice.test.js src/lib/elevenlabs.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Read the response with `arrayBuffer()`.
  - **The probe** (`scripts/elevenlabs-tts-probe.mjs`, run with `node --env-file=.env.local`) calls TTS with `opus_48000_64` for both `eleven_v4_turbo` and `eleven_flash_v2_5` on a stock voice from `listVoices`. For each model it prints the HTTP status, the first 4 bytes and the byte size, and it writes nothing to the repo.
  - **Add a header comment saying:** "Richard runs this once with the key; if eleven_v4_turbo is refused set ELEVENLABS_TTS_MODEL to eleven_flash_v2_5; if neither returns OggS, stop and ask Richard (runtime sends text with reason not_ogg either way)."
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `"VOICEREPLY.1c — ElevenLabs text-to-speech and voice list; voice-reply cap; live probe"`.

### Task 4: The gate and the send

**Files:**
- Create: `src/lib/wa-voice/reply.js`
- Test: `src/lib/wa-voice/reply.test.js`

**Interfaces:**
- Consumes: Tasks 2 and 3; `sendMediaMessage` (`@/lib/whatsapp`); `signedMediaUrl` (`@/lib/whatsapp-media-server`); `recordMeterUsage` (`@/lib/usage`).
- Produces: `maybeSendVoiceReply(db, { conversationId, locationId, recipient, spoken, kind, replyOpts }, deps = {})`. It returns `Promise<{ sent: true, messageId: string|null, storagePath: string, voiceKind: string, chars: number, buttonsLine: string, aiNotice: string|null } | { sent: false, reason: 'disabled'|'not_in_test_list'|'settings_unreadable'|'capped'|'no_voice'|'too_long'|'nothing_to_speak'|'not_configured'|'http_error'|'timeout'|'bad_response'|'not_ogg'|'upload_failed'|'send_failed' }>` and never throws.
  - `deps` is for tests: `{ synthesize, capStatus, sendMedia, now }`.
  - `voiceKind` is `kind` when the studio has that voice, else `'default'`.
  - `buttonsLine` is `settings.voice_replies.buttons_line`, or `'Tap an option:'` when unset. `aiNotice` is the trimmed `settings.voice_replies.ai_notice`, or null.

- [ ] **Step 1: Write the failing tests,** one per reason, each asserting `sendMedia` was not called (except on the success path):
  - **Settings:** `voice_reply_mode` `off` → `disabled`; `test` with the recipient absent → `not_in_test_list`; `test` with the recipient present → proceeds; an `org_settings` read error → `settings_unreadable`.
  - **Before speaking:** capped → `capped`; studio `settings.voice_replies.voices` empty → `no_voice`; `spoken` of 601 chars → `too_long`; `spoken` `''` → `nothing_to_speak`.
  - **Speech failures:** each synthesize failure reason is passed through; non-Ogg bytes → `not_ogg`.
  - **Storage and send:** a storage upload error → `upload_failed`; `sendMedia` throwing → `send_failed`.
  - **Success:**
    - `sendMedia(recipient, 'audio', <signed url>, null, { ...replyOpts, voice: true })` is called once;
    - the storage path is `whatsapp-media` under `buildMediaObjectPath`'s location prefix, ending `.ogg`;
    - `recordMeterUsage` is called with meter `elevenlabs_tts_characters` (quantity = `spoken.length`) and meter `elevenlabs_tts_replies` (quantity 1);
    - the result is `{ sent: true, voiceKind: 'booking', chars }`.
  - **Meter failure:** a throw from the meter still leaves `sent: true`.
  - **Logging:** no `logWarn` call contains the spoken text.
  - **Cap race (Review Focus 5):** `capStatus` returning not capped in two calls lets both send; there is no throw.
- [ ] **Step 2: Run** `npx vitest run src/lib/wa-voice/reply.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Reads:** `locations` by id selects `organization_id, settings`. Use only `settings.voice_replies`, and never return the row; `redactLocationSecrets` is not needed because nothing leaves the function. Then read `org_settings` mode, test phones and cap.
  - **Order:** the gates run in the spec's §4 order, plus the two length checks before `synthesize`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `"VOICEREPLY.1d — maybeSendVoiceReply: gates, speech, storage, voice-note send"`.

### Task 5: Agent wiring

**Files:**
- Modify: `src/lib/agent/auto-reply.js` (`runChannelAgentInner`, the tool loop ~1208, `sendAndLog` ~1551, `handoff` ~1641, `softHandoff`, `whatsappAdapter.outboundRow`), `src/lib/agent/prompt.js` (`buildCustomerSystemPromptParts` volatile parts)
- Test: `src/lib/agent/auto-reply-voice-reply.test.js` (harness of `auto-reply-voice.test.js`)

**Interfaces:**
- Consumes: Task 2 (`isVoiceTrigger`, `splitForVoice`, `voiceKindFor`, `toolResultSucceeded`, `VOICE_REPLY_PROMPT_LINE`) and Task 4 (`maybeSendVoiceReply`).
- Produces:
  - `buildCustomerSystemPromptParts(opts)` accepts `opts.voiceReply === true`, which appends `VOICE_REPLY_PROMPT_LINE` to the volatile parts only;
  - `whatsappAdapter.sendVoice(db, args)` → `maybeSendVoiceReply(db, args)`. Instagram has no `sendVoice`;
  - `whatsappAdapter.outboundRow` accepts optional `{ messageType, mediaStoragePath, mediaMimeType, voiceKind }`;
  - `sendAndLog(db, adapter, { …, voice: null | { trigger: true, kind } })`.

- [ ] **Step 1: Write the failing tests:**
  - **Typed message:** a typed inbound never calls `sendVoice`, and its prompt has no "will be spoken" line.
  - **Voice-note turn:**
    - the history has the newest inbound as `audio` (`ok`);
    - the stable prompt equals the base fixture, and the volatile suffix contains the line;
    - `sendVoice` is called with `kind: 'lead'` (no booking, no member row);
    - one outbound row with `message_type: 'audio'`, `voice_kind`, `media_storage_path` and `body` = Mia's full text;
    - no text send.
  - **Booking:** a `book_class` result `{ booked: true }` makes `kind: 'booking'`. The trace entry gains `succeeded: true`.
  - **Member:** an active member `contact_studios` row at the studio makes `kind: 'member'`, and a failed read makes `lead`.
  - **Trailing link:** voice is sent, then `sendCtaUrlMessage`; the reply is recorded as two rows.
  - **Options:** voice is sent, then `sendInteractiveOptions` with the result's `buttonsLine` as its body.
  - **AI notice:** with `aiNotice` set and no earlier outbound row in the thread with `voice_kind` set, the notice goes as a text after the voice note; on the thread's second voice reply it does not. With `aiNotice` null nothing extra is sent (the default, Richard's decision 6).
  - **Fallback:** `sendVoice` → `{ sent:false, reason:'capped' }` gives exactly today's text send, and the decision meta has `voice: { sent: false, reason: 'capped' }`.
  - **Voice sent, follow-up failed (Review Focus 3):** `logError` is called, there is no text resend, and the result is `action:'reply'`.
  - **Concurrent text (Review Focus 1):** with `ctx.messageType 'audio'` but the newest inbound `text`, there is no voice and no prompt line.
  - **Holding messages:** the voice-hand-off branch (an `unclear` voice note) and `softHandoff` after a voice note voice the holding message with `kind: 'handoff'`. A failure there sends today's text.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/auto-reply-voice-reply.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Trigger:** compute `voiceTrigger` after the history read with `isVoiceTrigger`. For the two pre-history holding paths, use `ctx.messageType === 'audio'`.
  - **Prompt:** pass `voiceReply: voiceTrigger` into `systemOpts`.
  - **Tool loop:** in the tool loop set `trace.tools[last].succeeded = toolResultSucceeded(name, result)`.
  - **Member read:** `isMember` comes from `studiosOfContact(db, contactId)`: a row at `locationId` with `kind === 'member' && status === 'active'`, or `membership_status === 'active'`. Read it only on voice turns.
  - **`sendAndLog` order:** `splitForVoice` → `adapter.sendVoice` → on `sent`, record the audio row and send the follow-up through the existing text, options or cta paths. On `sent:false`, run today's code unchanged.
  - **AI notice:** on `sent`, if `aiNotice` is set, check for an earlier agent row with `voice_kind` in the thread; if there is none, send the notice as text after the voice note.
  - **Holding messages:** `handoff`/`softHandoff` take an optional `voice` argument the same way.
  - **Decision meta:** record `trace.voice = { sent, kind, reason }` into the decision meta (`compactDecisionMeta` keeps it).
- [ ] **Step 4: Run** `npx vitest run src/lib/agent/`. Expected: all PASS, with the prompt fixtures unchanged (the line is volatile-only).
- [ ] **Step 5: Commit** `"VOICEREPLY.1e — Mia replies to a voice note by voice; text after it for links and buttons"`.

### Task 6: The accepted-then-failed fallback

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (status handler ~940-1020), `tests/whatsapp-config-callers.test.js`
- Create: `src/lib/wa-voice/reply-fallback.js`
- Test: `src/lib/wa-voice/reply-fallback.test.js`, `src/app/api/webhooks/whatsapp/route.voice-reply-status.test.js`

**Interfaces:**
- Produces: `resendVoiceReplyAsText(db, msgRow, deps = {}): Promise<{ resent: boolean, reason?: string }>`. It never throws.
  - **Claim:** `.update({ voice_fallback_sent_at: now }).eq('id', id).is('voice_fallback_sent_at', null).select('id')`. Zero rows → `{ resent:false, reason:'already_sent' }`.
  - **Send:** `sendTextMessage(phone, msgRow.body, waReplyOpts)`, recording a text outbound row with `source` = the agent source.
  - **Refusals:** `WhatsAppNumberMissingError` → `{ resent:false, reason:'no_number' }`, plus a manager push `WhatsApp · voice reply not delivered`.

- [ ] **Step 1: Write the failing tests:**
  - a `failed` status for a row with `voice_kind` set calls `resendVoiceReplyAsText` once;
  - a second `failed` webhook for the same row gives `already_sent` with no send (Review Focus 4);
  - a `failed` status on a row without `voice_kind` → not called;
  - `delivered`/`read` → not called;
  - a resend that throws → the webhook still answers 200;
  - add the new caller's row to `tests/whatsapp-config-callers.test.js`, stating that a refusal is a recorded skip plus a staff push.
- [ ] **Step 2: Run** `npx vitest run src/lib/wa-voice/reply-fallback.test.js 'src/app/api/webhooks/whatsapp/' tests/whatsapp-config-callers.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Webhook select:** widen the status handler's `whatsapp_messages` select with `id, body, voice_kind, voice_fallback_sent_at, conversation_id, location_id, contact_id`.
  - **Phone:** read the recipient from the conversation's `wa_phone`.
  - **Isolation:** call the fallback in its own try/catch after the existing status write.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `"VOICEREPLY.1f — a voice reply WhatsApp fails to deliver is resent once as text"`.

### Task 7: Settings

**Files:**
- Modify: `src/app/api/settings/org-usage/route.js`, `src/lib/usage-summary.js`, `src/components/settings/UsageCapsForm.jsx`, `src/app/settings/customer-agent/page.js`, `src/lib/openapi.js`
- Create: `src/app/api/settings/voice-replies/route.js`, `src/app/api/settings/voice-replies/sample/route.js`, `src/components/settings/MiaVoicesCard.jsx`
- Test: `src/app/api/settings/org-usage/route.voice.test.js` (extend), `src/app/api/settings/voice-replies/route.test.js`, `src/components/settings/MiaVoicesCard.test.jsx`, `src/components/settings/UsageCapsForm.voice.test.jsx` (extend)

**Interfaces:**
- **Org settings (`org-usage`):**
  - the PUT accepts `voice_reply_mode: z.enum(['off','test','on']).optional()`, `voice_reply_test_phones: z.array(z.string().max(32)).max(20).optional()` and `voice_reply_monthly_cap: z.number().int().positive().max(100000).nullable().optional()`;
  - the summary gains `voiceReplies: { mode, testPhones, cap, usedThisMonth }`.
- **`/api/settings/voice-replies`:**
  - **GET:** `{ voices: studio voices, available: listVoices() }`.
  - **PUT:** body `{ voices: { [kind]: { voice_id, name } | null }, ai_notice?: string|null (max 300), buttons_line?: string (max 80) }`. It stores `locations.settings.voice_replies` for `user.activeLocation`.
  - **Gate:** `assertLocationAccessOr404`, then the role AT the studio must be `owner` or `manager` (`user.rolesByLocation[locationId]`), else 403.
  - **Validation:** a `voice_id` not in `listVoices()` → 400.
- **`/api/settings/voice-replies/sample`:** POST `{ voice_id }`, same gate. It answers with the bytes of `synthesizeSpeech({ text: SAMPLE_SENTENCE, voiceId, outputFormat: 'mp3_44100_64' })` as `audio/mpeg`, and meters it as a reply.
  - `SAMPLE_SENTENCE = 'Hi, it\'s Mia from UN1T. Your class is booked for seven tomorrow morning.'`

- [ ] **Step 1: Write the failing tests:**
  - **Route gate:** owner/manager at the studio 200; head coach/staff 403; a studio the caller is not at 404.
  - **Route validation:** an unknown `voice_id` 400; `ai_notice` over 300 400.
  - **Route write:** the PUT writes only `settings.voice_replies`, and other `settings` keys survive (read-merge-write).
  - **Sample:** returns `audio/mpeg`; an ElevenLabs failure → 502 with `{ success:false }`.
  - **`org-usage`:** `voice_reply_mode: 'maybe'` 400; the fields patch only when present.
  - **Card:** five pickers labelled with `VOICE_KIND_LABELS`, a Play sample button per picker, and Save sends the body above.
  - **Form:** the mode select, test numbers and cap, plus "N voice replies this month".
- [ ] **Step 2: Run** `npx vitest run src/app/api/settings/ src/components/settings/MiaVoicesCard.test.jsx src/components/settings/UsageCapsForm.voice.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Card placement:** on `/settings/customer-agent` (the page gate is already MANAGER_ROLES).
  - **Styling:** light tokens, and `type="button"` on every non-submit button.
  - **Register:** both routes in `openapi.js`; `npm run check:route-guards` must be clean.
- [ ] **Step 4: Run** the same command plus `npm run check:route-guards && npm run check:location-scoping`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `"VOICEREPLY.1g — voice reply mode, test numbers and cap; studio voices card"`.

### Task 8: Staff view and privacy pages

**Files:**
- Modify: `src/components/WAMediaContent.jsx`, `mobile/components/WAMediaThumb.jsx`, `src/app/privacy/page.js`, `src/app/privacy/members/page.js`, `src/app/legal/subprocessors/page.js`
- Test: `src/components/WAMediaContent.voice.test.jsx` (extend)

**Interfaces:**
- Consumes: Task 1 (`voiceReplyLabel`).

- [ ] **Step 1: Write the failing test:** an outbound audio row with `voice_kind: 'member'` renders `Mia replied by voice · Member questions` under the player. An inbound voice note still renders its transcript caption, unchanged.
- [ ] **Step 2: Run** `npx vitest run src/components/WAMediaContent.voice.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Web and phone:** render the label in both (the bubble already shows `body` under the media). On the phone, import from `shared/voice-note`.
  - **Privacy pages:** each ElevenLabs entry gains "and to voice the assistant's replies to them". The members' notice gets the sentence: "If you send a voice note, the reply may also come as a voice note created by ElevenLabs from the assistant's written reply."
  - **Page dates:** update the dates.
- [ ] **Step 4: Run** the same command, `npx vitest run tests/legal-entity-consistency.test.js src/public-compliance-paths.test.jsx`, `npm run check:mobile-imports` and `npm run check:mobile-lint`. Expected: PASS.
- [ ] **Step 5: Commit** `"VOICEREPLY.1h — voice replies labelled for staff; privacy pages"`.

### Task 9: Ship checks, PR and changelog

- [ ] **Step 1: Run the full CI mirror once** (the 13 commands in CLAUDE.md), then `npm run build`. Expected: green.
  - Do not run the suite beside the build.
  - If the suite's worker-start timeouts recur, rerun only the files that did not start.
- [ ] **Step 2: Ask Richard to apply migration 809.** Then apply it via Supabase MCP on `iyvtbjjxdggiadzwwvdj`, check `information_schema`, and run `get_advisors` (security).
- [ ] **Step 3: Push and open the PR.** The body lists the go-live steps from the spec, plus "run `scripts/elevenlabs-tts-probe.mjs` once". It ends with the Claude Code attribution line.
- [ ] **Step 4: Add the changelog entry.** Add `docs/changelog/entries/<PR>.md`, then commit and push.
