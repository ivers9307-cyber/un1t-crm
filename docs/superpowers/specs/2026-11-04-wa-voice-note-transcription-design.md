# VOICENOTE.1 — WhatsApp voice notes transcribed for Mia and staff

Date: 4 Nov 2026. Status: design, awaiting Richard's approval.

## Why

Mia sends every WhatsApp voice note to the staff review queue as a soft
handoff (`src/lib/agent/core.js:309`). This was Richard's call on 12 June 2026
because there was "no transcription vendor", and OpenAI is ruled out
everywhere, transcription included. ElevenLabs Scribe can be that vendor, and
Richard already has an ElevenLabs account.

**Volume is zero today.** On 4 Nov 2026, `whatsapp_messages` held 0 inbound
`audio` rows (680 texts since 29 Apr 2026), and `instagram_messages` held none
either. The webhook does not drop them: `case 'audio'` at
`src/app/api/webhooks/whatsapp/route.js:512` stores them like any other media.
Richard chose to build it anyway, so that a voice note gets a proper answer the
day one arrives. Keep the build small and proportionate to that.

## What Richard decided

| # | Question | Decision |
|---|---|---|
| 1 | What happens to a voice note | Mia answers it like a text when the transcript is clear. Staff always see the transcript. |
| 2 | Unclear transcript | Hand off to staff, with the transcript attached. Mia never guesses. Refined after review: this is a REAL hand-off that lands in the Agent hand-off queue (today's soft hand-off files nothing), for voice notes only. |
| 3 | Mia mentions it was a voice note | No. She just answers what they said. |
| 4 | Other languages | Transcribe any language. Mia replies in whatever language she already uses with that person. No new language rule. |
| 5 | Channels | WhatsApp only. Instagram is a later step. |
| 6 | Mia off or in quiet hours | Still transcribe, for staff. |
| 7 | Length limit | Up to 3 minutes. Longer notes go to staff with no transcript. |
| 8 | Old voice notes | New ones only. No backfill. |
| 9 | Account | Richard's existing ElevenLabs account. |
| 10 | Cost control | A separate monthly cap per organisation. When it is reached, voice notes fall back to today's hand-off. |
| 11 | Data | Go ahead with safeguards: sign ElevenLabs' DPA, switch off retention where the plan allows, add ElevenLabs to the privacy policy's subprocessors. |
| 12 | Rollout | Both studios at once. |
| 13 | Staff view | Under the voice note in the web inbox AND the phone app. |
| 14 | Success | Fewer voice-note hand-offs, and staff spot-checks find no wrong replies. |

## Goals

- An inbound WhatsApp voice note of up to 3 minutes is transcribed within the
  same webhook request, before Mia's turn.
- When the transcript is clear, Mia answers it as she would answer the same
  words typed. Every Mia rule (consent, studio, tools, caps) applies unchanged.
- Every voice note, whether transcribed or not, shows staff the result under
  the player: the transcript, or a short reason ("Too long to transcribe",
  "Couldn't make it out", "Transcription unavailable").
- A failure of any kind (ElevenLabs down, timeout, key missing, cap reached,
  audio unreadable) never does less than today: Mia's holding message and a
  staff notice, and now also a place in the Agent hand-off queue. It never adds
  a new way to lose a message.

## Non-goals

- Instagram DMs (see "Instagram later").
- Backfilling existing voice notes.
- Transcribing staff-sent or Mia-sent audio.
- Voice replies from Mia (text to speech).
- Copying the transcript into the contact timeline (`activities`). The
  timeline trigger keeps writing what it writes today.
- A usage-page chart for transcription minutes. A one-line counter on the
  settings card is enough for v1.
- Staff editing or correcting a transcript.

## Anti-goals (a failure even if it technically works)

- Mia replying to a mis-heard voice note with a confident wrong answer. The
  bar for "clear" is deliberately high, and doubt always means a hand-off.
- A voice note that is silently dropped, or that gets no staff push, because
  transcription failed. Today's hand-off must remain the floor.
- Mia saying "thanks for the voice note" or otherwise commenting on the format.
- A client session being able to write a transcript that Mia then reads as
  the customer's words.
- A spoken "stop" being taken as an unsubscribe because of a mis-hearing.
- Making the webhook slow or fragile for every other message type.

## Constraints from the codebase

- **No OpenAI anywhere** (CLAUDE.md). ElevenLabs is the vendor.
- **Mia stays on the Anthropic Messages API.** ElevenLabs only turns audio into
  text. Mia's loop, prompt and tools stay as they are.
- **Mia runs inline in the webhook** (`maybeAutoReply`, after
  `ensureMediaRehosted`). Transcription goes between those two steps, in the
  same request, bounded by a timeout.
- **Meta retries are already de-duplicated** (WA-DEDUP.2 returns early if the
  `wa_message_id` is stored), so a retry never transcribes twice.
- **`whatsapp_messages`** gives `authenticated` table-level SELECT only (checked
  live on 4 Nov 2026), so new columns are readable by the phone and the inbox
  realtime listener with no grant change, and clients cannot write them. The
  migration still states the decision in a comment.
- **The transcript columns exist on `whatsapp_messages` only.** The Mia history
  reads go through a shared adapter (`adapter.messagesTable`, used for both
  tables), and `approval-suggest.js` picks its table with
  `MESSAGES_TABLE_BY_CHANNEL[row.channel]` (line 275). So the select list must
  be per channel, not one shared string naming the new columns. A shared
  string would make every Instagram history read fail with 42703.
  (`instagram_messages` has table-level client grants, but mig 485's
  restrictive policies deny `authenticated` every write, so it is not
  client-writable.)
- **Mia reads history from the database, not the live message.** The inbound
  row is inserted (`route.js` ~593) before the rehost and the transcription,
  and `maybeAutoReply` builds the prompt from a history read
  (`auto-reply.js` ~697). Whatever the transcript is, Mia sees it only once it
  is on the row.
- **Staff clients:** the web inbox and the phone both load a thread through
  `GET /api/whatsapp/conversations/[id]`, which selects `*` (route.js:64), so
  the new columns reach both with no select change. The web inbox's realtime
  listener subscribes to `whatsapp_messages` INSERT only (`WAInbox.jsx:380`),
  so a transcript written later by UPDATE fires no event.
- **Today's "soft hand-off" files nothing in a queue.** `softHandoff`
  (`auto-reply.js:1725`) sends the holding message, stamps
  `agent_last_reply_at` and pushes managers (debounced 60 s), but does not set
  `agent_handed_off_at`. Since the holding message is then the last message,
  the thread leaves both the "needs reply" and the "agent hand-off" queues. Its
  `reason` reaches only `agent_decisions` (shown in `MiaDecisionTrace.jsx` via
  `REASON_LABELS`). The comment at `core.js:309` is wrong to call it a
  review-queue hand-off.
- **`check:select-columns`** must see the new columns in a migration.
- **Usage metering:** `usage_events` (mig 411) has a generic `meter` column. The
  AI hard cap (`getAiCapStatus`, mig 421) sums only `meter = 'anthropic_tokens'`,
  so a new meter does not count against Mia's AI cap. The builder confirms no
  later migration widened that filter.
- **`org_settings`** has no client privilege and no policy (mig 730), and is
  written through `/api/settings/org-usage` by masters and org admins
  (`resolveAdminOrgId`). New settings go there.
- **CLAUDE.md "never create a louder failure":** log with `logError`/`logWarn`,
  never free text, and every path falls back to today's hand-off.
- **No silent env fallbacks:** a missing `ELEVENLABS_API_KEY` is a recorded
  status (`not_configured`), logged, not a crash and not a pretend success.
- **Mobile OTA:** changing the phone's thread components publishes an OTA to
  every phone at 100% on merge. The phone change is rendering only. Apply the
  migration before the server code that names the columns deploys.

## Design

### 1. Data (one migration)

On `whatsapp_messages`:

| column | type | meaning |
|---|---|---|
| `transcript` | text, null | The ElevenLabs text, trimmed. Set only when the status is `ok` or `unclear`. |
| `transcript_status` | text, null, CHECK in the list below | Null on every non-audio row and on audio that arrived before launch. |
| `transcript_language` | text, null | ElevenLabs `language_code`. |
| `transcribed_at` | timestamptz, null | When the status was written. |

`transcript_status` values:
- `pending`: written AT INSERT on every inbound audio row (the webhook's insert
  sets it), so a concurrent turn can tell "being transcribed" from "old audio".
  The orchestrator always replaces it, whatever the result.
- `ok`: clear, and Mia may answer it.
- `unclear`: text came back but failed the clarity test. Staff see it, and Mia
  hands off.
- `too_long`: over 3 minutes.
- `capped`: the org's monthly cap has been reached.
- `disabled`: the org switch is off. Written so staff can tell "off" from
  "broken".
- `not_configured`: no API key.
- `failed`: an HTTP error, timeout, unreadable audio, or no media bytes.

Comment the migration `-- column-grant: table-level SELECT for authenticated
already covers these (read-only); no client write`.

On `org_settings`:
- `voice_transcription_enabled boolean NOT NULL DEFAULT false`
- `voice_transcription_monthly_cap_minutes integer NULL`, CHECK `> 0`. Null
  means no cap.

### 2. Transport: `src/lib/elevenlabs.js`

- `transcribeAudio({ bytes, mime, keyterms })` sends
  `POST https://api.elevenlabs.io/v1/speech-to-text` as multipart, with
  `model_id: 'scribe_v2'`, the file, no `language_code` (auto-detect),
  `tag_audio_events: false`, `diarize: false`, and `keyterms` (below). The
  `xi-api-key` header comes from `ELEVENLABS_API_KEY`.
- `enable_logging=false` (zero retention) is sent only when
  `ELEVENLABS_ZERO_RETENTION=true`. ElevenLabs documents zero retention as
  enterprise-only, so turning it on for a non-enterprise account would fail
  every call.
- An `AbortController` timeout of 20 s. No retry: the webhook must not hang,
  and a retry inside a Meta-retried webhook buys little.
- Returns `{ ok: true, text, languageCode, languageProbability, durationSecs,
  words }` or `{ ok: false, reason, status? }`. It never throws.
- **Keyterms:** the studio's name, its coaches' first names from active
  `profile_locations` at that studio, and a short fixed list ("UN1T", "HYROX",
  "Glofox", "class pack", "trial"). These help Scribe with Dublin-accented brand
  words. The fixed list is a constant in the module.

### 3. Orchestrator: `src/lib/wa-voice-transcribe.js`

`transcribeInboundVoiceNote(db, { messageId, locationId, storagePath,
mediaMime, externalId })` returns `{ status, transcript?, language? }`. It never
throws, and it writes its result to the row.

The steps, in order:
1. Resolve the org from `locationId`, then read `org_settings`. If the switch
   is off, return `disabled`. If the settings read fails, return `failed` (fail
   closed to today's hand-off, never to a transcription the org did not
   switch on).
2. Check the cap: the month-to-date sum of `usage_events.quantity` for meter
   `elevenlabs_stt_seconds` for this org (PLATFORM_TZ month, as
   `getAiCapStatus` does). If it is at or over `cap_minutes × 60`, return
   `capped`. A failed cap read fails open (transcribe), the same posture as the
   AI cap: metering trouble must not silence the feature.
3. Get the bytes from the `whatsapp-media` bucket at `storagePath`, which
   `ensureMediaRehosted` just wrote. If there is no path because the rehost
   missed, return `failed`. Do not add a second Meta media fetch here: that
   would make this a new caller of the WhatsApp config resolvers and need a
   row in `tests/whatsapp-config-callers.test.js`.
4. Check the duration before paying. WhatsApp voice notes are Ogg/Opus, so
   read the duration from the final Ogg page's granule position (÷ 48000). If
   the Ogg duration cannot be read, use a size bound: over 2 MB counts as too
   long (about 3 minutes at WhatsApp's bitrate is well under that; the builder
   confirms with a real 3-minute fixture). Over 180 s returns `too_long`.
5. Call `transcribeAudio`. A missing key returns `not_configured`. Any
   `ok: false` returns `failed`.
6. Judge clarity with `judgeTranscript()`, a pure function. It returns
   `unclear` if:
   - the text is empty or has fewer than 2 words,
   - `languageProbability` is below 0.6,
   - the mean `logprob` of `type: 'word'` entries is below the threshold
     constant `MIN_MEAN_LOGPROB` (starting value −0.5; tuned in the calibration
     step), or
   - more than 30% of words have a `logprob` below −1.5.

   Otherwise it returns `ok`.
7. Record usage: `usage_events` with meter `elevenlabs_stt_seconds`, quantity
   `durationSecs` (ElevenLabs' `audio_duration_secs`, else the Ogg duration),
   `cost_estimate_cents` from a per-minute constant (the builder takes the
   price from Richard's plan; it is an estimate, like the Anthropic one),
   source `wa_voice_note`, and `meta: { model: 'scribe_v2' }`. Awaited, inside
   its own try/catch, as in `anthropic.js`.
8. Write the four columns with
   `.update(...).eq('id', messageId).select('id')`, and check both `error` and
   the row count. A failed write is logged with `logError` and the result
   returned is `failed`: Mia reads history from the row, so a transcript that
   is not on the row cannot be answered. The code makes one best-effort
   attempt to write `transcript_status = 'failed'` so the row does not stay
   `pending`.

Every non-`ok` outcome is logged once with `logWarn('wa-voice', …)`, giving the
status and the ids. The transcript text is never logged.

### 4. Webhook (`src/app/api/webhooks/whatsapp/route.js`)

After `ensureMediaRehosted` and before `maybeAutoReply`, when
`messageType === 'audio'` and the inbound row was stored, call the
orchestrator in its own try/catch. Then:
- Set `last_message_preview` to `Voice note: <first 80 chars>` when there is a
  transcript, as a separate, checked update. Otherwise leave it.
- Pass the result into `maybeAutoReply` as `voiceTranscript: { status, text }`.
  `messageType` stays `'audio'`.

This runs whether Mia is on or off (decision 6). Mia's own gates still decide
whether she replies.

**A voice note must not be lost to a concurrent turn (my call).** Suppose a
customer sends a voice note and then a quick text. The text's webhook may win
the turn while the audio row is still `pending`, and the voice note's own turn
then returns `in_flight` or `nothing_to_answer`. The missed-inbound rerun will
not catch it either, because the audio row is older than the newest inbound
that turn saw. So:
- The history formatter renders a `pending` audio row as
  `[voice note, still being transcribed]`, and the prompt tells Mia not to
  guess at its content.
- In the voice note's own webhook, if the result was `ok` but
  `maybeAutoReply` did not send a reply (`in_flight`, `nothing_to_answer`, or
  any non-reply outcome other than Mia being off, quiet hours or a deliberate
  gate), the voice note is handed to staff with NO customer message: a staff
  push plus the hand-off described in section 5. Mia may already have answered
  the text, so a holding message here would read oddly.
- This is deliberately simple given the volume (zero today). A duplicate staff
  push is preferred over a lost voice note.

**Consent keywords (my call).** STOP/START are honoured only for `text`
(`route.js` ~756), and a mis-heard "stop" must not unsubscribe anyone. If a
transcript, trimmed and lower-cased, matches a consent keyword exactly, treat
it as `unclear` (hand off to staff) and never run the consent parser on it.

### 5. Mia's gates and history (`src/lib/agent/core.js`, `auto-reply.js`)

Add one pure helper, `effectiveInbound(row)`. For an `audio` row whose
`transcript_status === 'ok'` and whose `transcript` is non-empty, it returns
`{ ...row, message_type: 'text', body: transcript, viaVoice: true }`. Every
other row comes back unchanged. Use it in:
- `shouldAgentReply`, for the live message (built from `voiceTranscript`).
- `isReplyWorthyInbound`, `formatHistoryForClaude` and `hasInboundAfter`, for
  stored rows.

In `formatHistoryForClaude`, a `viaVoice` row's content is
`(voice note transcript) ` followed by the sanitised transcript (through the
same `sanitizeInboundText`). The marker is how Mia knows which turn was heard
rather than typed (my call). A customer typing the marker only makes Mia more
careful, so it needs no spoof protection. One line in the system prompt
(`prompt.js`) says that messages marked `(voice note transcript)` are automatic
transcripts that may contain small mis-hearings; that Mia should answer them
like typed messages and never mention the marker or that it was a voice note;
and that if one doesn't make sense, she should use her hand-off tool rather
than guess.

The history selects (`auto-reply.js` ~697 and ~463, and every other reader
that feeds Mia or the reply suggester: `approval-suggest.js:289`,
`followups.js:277`; the builder greps for the rest) add `transcript,
transcript_status` **for WhatsApp only**. The agent adapter gains a
`historyColumns` string (WhatsApp: the current list plus the two; Instagram:
unchanged), and `approval-suggest.js` gets the same per-channel map next to
`MESSAGES_TABLE_BY_CHANNEL`. No literal naming the new columns may be aimed at
a table chosen at run time.

**A voice note Mia can't answer is a REAL hand-off (Richard, 4 Nov 2026).**
When Mia is on duty and the status is anything but `ok` (`unclear`,
`too_long`, `capped`, `failed`, `not_configured`), the turn goes through the
existing escalation `handoff()` (`auto-reply.js` ~1578), not `softHandoff`.
`handoff()` sends the holding message, sets `agent_active: false` and
`agent_handed_off_at`, clears `handoff_escalated_at` (so the hand-off SLA
escalation re-arms) and notifies staff. The thread then sits in the "Agent
hand-off" queue (`src/lib/inbox-queues.js`: `agent_handed_off_at` set and not
resolved) until someone resolves it, and Mia re-arms on resolve or after the
usual cooldown, as for any hand-off.
- The reasons are `voice_unclear`, `voice_too_long` and
  `voice_unavailable` (for `capped`, `failed` and `not_configured`). Add them to
  `REASON_LABELS` (`MiaDecisionTrace.jsx`) and use them for the staff notice
  text ("Voice note Mia couldn't make out", "Voice note over 3 minutes",
  "Voice note: transcription unavailable").
- `disabled` keeps today's `softHandoff`, exactly as now. Photos, videos and
  documents are unchanged (Richard: voice notes only).
- For the concurrent-turn case in section 4 (status `ok`, but the voice note's
  own turn sent nothing), stamp `agent_handed_off_at` (so the thread is in
  the Agent hand-off queue) and notify staff, WITHOUT the holding message and
  WITHOUT setting `agent_active: false`. Mia may have answered the text
  correctly, and switching her off for the thread would be a worse failure
  than a duplicate check. (Refined while planning, my call.)

**Measuring success:** voice-note outcomes are in `agent_decisions` (replied
vs the three `voice_*` reasons) and in `whatsapp_messages.transcript_status`.
A weekly count of each is enough. No dashboard in v1.

### 6. Staff view

- **Web:** in `WAInbox.jsx` / `WAMediaContent.jsx`, under the audio player, show
  the transcript in a muted paragraph when there is one, with the language when
  it is not English ("Transcribed from Portuguese"). For the other statuses,
  show a one-line grey note: `unclear` → "Couldn't make it out clearly:" plus
  the text; `too_long` → "Over 3 minutes, not transcribed"; `capped` →
  "Monthly transcription limit reached"; `failed`/`not_configured` →
  "Transcription unavailable"; `disabled` → nothing. Use the existing light
  theme tokens (`un1t-muted` etc.).
- **Web realtime:** add an UPDATE subscription on `whatsapp_messages` beside
  the INSERT one in `WAInbox.jsx` (same filter), merging the changed row into
  the open thread, so a transcript appears without a reload.
- **Phone:** the thread already receives the columns through
  `GET /api/whatsapp/conversations/[id]`. `mobile/components/MessageBubble.jsx`
  / `WAMediaThumb.jsx` render the same text and notes. Whether the phone
  refreshes an open thread on UPDATE is the builder's call; a pull-to-refresh
  showing it is acceptable.
- **Push:** if the inbound push for a WhatsApp message includes a body preview,
  use the transcript for voice notes. The builder checks; if the push has no
  body preview today, leave it.

### 7. Settings

On the existing org usage settings surface (`/api/settings/org-usage` and its
page), add the switch "Transcribe WhatsApp voice notes", the monthly cap in
minutes (empty = no cap), and a read-only "N minutes used this month" line
computed live from `usage_events`. The schema goes through `validateBody` with
a Zod block, the route is registered in `openapi.js`, and the write goes
through the existing org admin gate. The card states that audio is sent to
ElevenLabs.

### 8. Key and data protection

- **The key is a platform env var, `ELEVENLABS_API_KEY`, in Vercel (my call).**
  That matches how the Anthropic key is held for Mia: transcription is a
  platform service metered per organisation, not a tenant's own account.
  Richard's existing account supplies the key. The Integrations hub needs no
  card for v1.
- Before switching it on (Richard): sign ElevenLabs' DPA, add ElevenLabs to the
  privacy policy's subprocessor list, and set `ELEVENLABS_ZERO_RETENTION=true`
  only if the plan is enterprise.

## Tests

- **Pure:** `judgeTranscript` (each threshold, empty text, audio events only);
  the Ogg duration reader (fixtures of 5 s, 179 s and 181 s, a corrupt file and
  a non-Ogg file); `effectiveInbound` and the history formatter (a transcript
  is answered; `unclear` is not; Instagram rows are untouched).
- **Orchestrator** with mocked db/fetch: each status path writes the right
  status, `usage_events` is written only when ElevenLabs answered, a failed row
  write still returns the result, and nothing throws.
- **Webhook:** audio with `ok` is answered from the stored transcript; each
  non-`ok` status takes `handoff()` with its `voice_*` reason (`disabled` takes
  today's soft hand-off); an `ok` voice note whose own turn sent nothing is
  handed off silently; a transcript that is exactly "stop" never reaches the
  consent parser; text, image and other messages make no ElevenLabs call and
  behave exactly as today.
- **Concurrency:** a text turn that reads a `pending` audio row renders it as
  being transcribed, and never as `[audio]`.
- **Guard:** a test that fails if a select of `transcript` is aimed at
  `instagram_messages` or at an adapter's `messagesTable` literal.
- **CI mirror,** including `check:select-columns` and `check:mobile-imports`.

## Calibration and go-live (no real voice notes exist yet)

1. Apply the migration, deploy, and set `ELEVENLABS_API_KEY`. The switch stays
   off.
2. Richard switches it on and sends 6 to 8 voice notes from his own phone to
   each studio number: a clear booking question, a noisy-gym one, a fast Dublin
   accent, one in another language, a 4-minute ramble, and pure background
   noise. Compare the transcripts and statuses with what was said, and tune
   `MIN_MEAN_LOGPROB` and the word-share threshold if a mis-heard one came
   back `ok`, or a clean one came back `unclear`.
3. Leave it on for both studios (decision 12). Each week, staff spot-check
   every voice-note thread Mia answered. Success = fewer voice-note hand-offs
   and no wrong replies.

## Instagram later

The same columns on `instagram_messages`, its `historyColumns` entry and its
`approval-suggest` map entry, and the IG webhook call. Before adding them,
confirm the mig 485 deny-write policies still stand, so no client can write a
transcript that Mia reads as the customer's words.

## Left to the builder

- Component placement and wording within the staff view rules above.
- The exact readers to update (grep every select on `whatsapp_messages` that
  feeds Mia or the suggester).
- The per-minute cost constant (from Richard's plan).
- Whether the preview update merges into the conversation stamp or stays a
  second update (it must be checked either way).
- Migration number: take the next free one after a fresh `origin/main` sync
  (807 is the latest today).
