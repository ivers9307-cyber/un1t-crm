# VOICEREPLY.1 — Mia answers a WhatsApp voice note with a voice note

Date: 4 Nov 2026. Status: design, awaiting Richard's approval.
Follows VOICENOTE.1 (#2292, transcription) and uses the same ElevenLabs
account and `ELEVENLABS_API_KEY`.

## Why

VOICENOTE.1 lets Mia understand a customer's voice note and answer it, but
she answers in text. Someone who sends a voice note often prefers to listen.
Richard wants Mia to reply in kind: when the customer speaks, Mia speaks
back, in a voice chosen for what the reply is about.

Volume today is zero voice notes, as for VOICENOTE.1, so the build stays
small, switched off by default, and tried on Richard's own phone first.

## What Richard decided (4 Nov 2026)

| # | Question | Decision |
|---|---|---|
| 1 | When Mia speaks | Only when the customer's message she is answering is a voice note. Typed messages keep text replies. |
| 2 | Voices | One per kind of reply: **leads and trials**, **bookings**, **member questions**, **hand-off message**, plus a **default** for anything that fits none. |
| 3 | A reply that fits two kinds | What she did wins: a booking or a hand-off decides the voice, otherwise lead vs member does. |
| 4 | Who picks voices | Managers, in settings, from the ElevenLabs voice list with a play-sample button. |
| 5 | Links and buttons | The voice note first, then a short text carrying the link or the buttons. |
| 6 | Telling customers it's AI | No notice. (Built as an operator-editable notice that is empty by default, so it can be switched on without a code change if legal advice says so.) |
| 7 | Cost | A per-organisation switch, off by default, and a monthly limit. At the limit Mia replies in text. |
| 8 | Rollout | Richard's own phone number first, then both studios once he has heard and approved the voices. |
| 9 | How a spoken reply is written | On a voice-note turn Mia's prompt says the reply will be spoken: short, conversational, no emoji or lists. Leftover emoji and markup are also stripped before speaking. |
| 10 | Length | 45 seconds or less (about 600 characters of spoken text). Anything longer goes as text. |

## Goals

- When the newest inbound Mia is answering is a voice note (status `ok` or
  any VOICENOTE.1 hand-off status), her reply goes out as a WhatsApp voice
  note (mic icon and waveform, not an audio-file card), in the voice for its
  kind.
- The reply's words are what Mia wrote. Speech is a rendering of her text,
  tidied for listening (emoji, markup and links removed), never a second model
  call.
- Staff see the reply text in the inbox and can play the audio.
- Any failure (ElevenLabs down, no voice chosen, cap reached, an upload or
  send error) sends the reply as text exactly as today. A voice reply never
  costs the customer their answer.

## Non-goals

- Instagram (it has no transcription yet either).
- Voice for proactive messages (follow-ups, trial-done, reminders,
  broadcasts). Replies to a voice note only.
- Voice cloning of real people. Stock library voices, or voices designed in
  the ElevenLabs dashboard, only.
- Live calls or real-time voice.
- Choosing a voice per customer.

## Anti-goals

- A customer who sent a voice note gets nothing because text-to-speech
  failed. Text is always the fallback.
- A booking link or option buttons lost because they were spoken instead of
  sent.
- The audio saying something the stored text does not (tidying only removes
  emoji, markup and links; it never adds or rewords).
- Voice replies reaching real customers before Richard has heard them.
- The webhook getting slow or fragile for typed messages. Nothing on the
  text path changes.

## Constraints from the codebase

- **Mia's reply send is one function**, `sendAndLog` in
  `src/lib/agent/auto-reply.js`. It sends text, buttons (`adapter.sendOptions`),
  or a trailing link (`splitTrailingUrl` → `sendCtaUrlMessage`), records the
  outbound row and stamps the conversation. The holding message goes through
  `handoff()` and `softHandoff()` with `adapter.send`. Voice replies hook in at
  these three places, WhatsApp only.
- **WhatsApp voice notes already send:** `sendMediaMessage(to, 'audio', url,
  null, { voice: true })` in `src/lib/whatsapp.js` renders a true voice note
  (pinned by `src/lib/whatsapp-voice-reactions.test.js`). WhatsApp requires
  Ogg/Opus, mono, for the voice-note render.
- **The customer service window:** a reply to an inbound is inside the 24-hour
  window, so free-form media is allowed.
- **Mia's studio settings are owner-only** (`canEditMiaSettings`, MIAROLE.1).
  Richard chose managers for voices, so voices are their own setting with
  their own manager gate, not a field on Mia's settings.
- **`org_settings`** is service-role only (mig 730), written through
  `/api/settings/org-usage` by org admins. The switch, test numbers and cap go
  there, beside VOICENOTE.1's transcription switch.
- **`locations.settings`** is withheld from clients (mig 648), and a
  `locations` row read with `*` must go through `redactLocationSecrets`.
- **Usage:** `usage_events` with a new meter; `recordMeterUsage` and the cap
  pattern from VOICENOTE.1 (`getVoiceCapStatus`) are the template.
- **No server-side ffmpeg.** `src/lib/video-compress.js` uses ffmpeg.wasm in
  the browser. Any server-side audio conversion must be plain JS or
  unnecessary.
- **"enabled + test_mode = live for everyone"** (CLAUDE.md invariant). The
  rollout switch is ONE column with three values, never two booleans.

## Design

### 1. Data (one migration)

On `org_settings` (no client privilege, as mig 730):
- `voice_reply_mode text NOT NULL DEFAULT 'off'`, CHECK in `('off', 'test', 'on')`.
  - `off`: never.
  - `test`: only to the numbers in `voice_reply_test_phones`.
  - `on`: everyone.
- `voice_reply_test_phones text[] NOT NULL DEFAULT '{}'`, matched with the same
  phone matcher Mia's test allowlist uses (`phoneMatchesAllowlist`).
- `voice_reply_monthly_cap integer NULL`, CHECK `> 0`: voice replies per
  PLATFORM_TZ month. Null = no cap. (My call: a count of replies is easier for
  an operator to reason about than characters. Mia's replies are short, and
  the per-character cost is metered anyway.)

Per studio, in `locations.settings.voice_replies` (service-role only):
```
{ voices: { lead, booking, member, handoff, default }, ai_notice: string|null }
```
Each voice is `{ voice_id, name }` or null. Voices are per studio only, with
no organisation-level layer (my call: a voice is part of a studio's sound;
the settings card can offer "copy from the other studio").

Outbound rows: the voice reply is recorded as ONE `whatsapp_messages` row with
`message_type 'audio'`, `body` = the exact text spoken, `media_storage_path`
of the stored audio, `media_mime_type 'audio/ogg'`, `source` = the agent
source, plus a new column `voice_kind text NULL` (CHECK in the five kinds),
written only on agent voice replies. Mia's history reads `body` for her own
turns, so she sees what she said. The follow-up text (decision 5) is its own
ordinary text row.

### 2. Transport: `src/lib/elevenlabs.js` (extend)

- `synthesizeSpeech({ text, voiceId, languageCode? }, { fetchImpl })` calls
  `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=opus_48000_64`
  with `{ text, model_id }` and the `xi-api-key` header. It returns
  `{ ok: true, bytes, mime } | { ok: false, reason: 'not_configured'|'http_error'|'timeout'|'bad_response', status? }`
  and never throws. The timeout is 15 s and there is no retry.
- `listVoices({ fetchImpl })` calls `GET https://api.elevenlabs.io/v2/voices`
  (paged, `page_size` 100). It returns `voice_id`, `name`, `labels`, `category`
  and `preview_url` for the settings picker.
- **Model:** `eleven_v4_turbo` if the convert endpoint accepts it, else
  `eleven_flash_v2_5` (32 languages, ~100 ms). Constant `ELEVENLABS_TTS_MODEL`.
- **Two facts the docs do not settle, verified by a live call as the build's
  first step:**
  1. Whether `opus_48000_*` comes back in an Ogg container. If it does, it is
     sent as-is. If it is raw Opus, a small pure-JS Ogg page writer wraps it
     (no ffmpeg). If neither works, stop and ask Richard before shipping an
     audio-file card instead of a voice note.
  2. Whether `eleven_v4_turbo` works on `/v1/text-to-speech`. Otherwise use
     `eleven_flash_v2_5`.
- Cost constant `ELEVENLABS_TTS_CENTS_PER_1K_CHARS`: $0.04 per 1,000
  characters for v4 Turbo (Richard's price sheet, 4 Nov 2026), or the flash
  price if that model is used.

### 3. Choosing the kind and the voice: `src/lib/wa-voice/reply-voice.js` (pure)

`voiceKindFor({ isHandoff, bookingToolSucceeded, isMember })` returns
`'handoff' | 'booking' | 'member' | 'lead'`, in that order of precedence
(decision 3):
- `isHandoff`: the reply is a holding message (`handoff()` or `softHandoff()`).
- `bookingToolSucceeded`: the turn ran a booking tool that booked, moved or
  cancelled a class and succeeded (from `trace.tools` and the tool results; the
  builder names the exact tool list).
- `isMember`: the thread's contact has an active member relationship at the
  thread's studio. Read through `src/lib/contact-studios.js`
  (`studiosOfContact`, kind `member` with status `active`, or
  `membership_status = 'active'`). A failed read counts as not a member, which
  only picks a voice: it never blocks the reply.

`voiceFor(kind, voices)` returns `voices[kind] ?? voices.default ?? null`.
Null means no voice is configured, and the reply goes as text.

### 4. The gate and the send: `src/lib/wa-voice/reply.js`

`maybeSendVoiceReply(db, { conversationId, locationId, recipient, text, kind, connection })`
returns `{ sent: true, messageId } | { sent: false, reason }` and never throws.
The steps:
1. **Trigger:** the newest inbound the turn answers is an `audio` row (the
   caller passes `triggerIsVoiceNote`; it is false for every typed message).
2. **Org mode:** `off` → `disabled`. `test` and the recipient not in
   `voice_reply_test_phones` → `not_in_test_list`. A read failure →
   `settings_unreadable` (fail closed to text).
3. **Cap:** this month's count of meter `elevenlabs_tts_replies` against
   `voice_reply_monthly_cap`. At the cap → `capped`. A failed read fails open,
   as VOICENOTE.1.
4. **Voice:** `voiceFor(kind, studio voices)`. None → `no_voice`.
5. **Speech:** `synthesizeSpeech` on the spoken text (see 5 for what is
   spoken). Not ok → its reason.
6. **Store:** upload the bytes to the `whatsapp-media` bucket under the
   conversation's path, and sign a short-lived URL (1 hour) for Meta to fetch.
7. **Send:** `sendMediaMessage(recipient, 'audio', signedUrl, null, { voice: true, ...replyOpts })`
   through the thread's own number (`waReplyOpts`, so `WhatsAppNumberMissingError`
   behaves as for any send).
8. **Meter** (only when ElevenLabs answered): `recordMeterUsage` with meter
   `elevenlabs_tts_characters` (quantity = characters, cost from the constant)
   and meter `elevenlabs_tts_replies` (quantity 1) for the cap.

Every `sent: false` is logged once with `logWarn('wa-voice-reply', …)`, giving
the reason and the ids, never the text. The caller then sends text exactly as
today.

### 5. What is spoken, and what follows as text

**Writing for speech (decision 9).** When the newest inbound is a voice note,
the turn adds one line to Mia's volatile (uncached) prompt suffix, so the
cached prompt is unchanged for every other turn:
`'## This reply will be spoken\nThe customer sent a voice note, so your reply will be sent as a voice note. Write it as you would say it: short and conversational, no emoji, no lists or bullet points, no bold, and spell times the way you would say them. A booking link or buttons are still fine: they are sent as text after the voice note.'`
The same text is what is stored and what goes as the fallback if voice fails,
so it must read well as text too.

**Tidying (pure, `spokenTextFor(text)`).** Before speech: remove emoji, `*`/`_`
markup, bullet markers and URLs, and collapse blank lines into pauses. It
never adds or rewords words. The stored `body` stays the text Mia wrote.

**Length (decision 10).** If the tidied text is over `MAX_SPOKEN_CHARS = 600`
(about 45 seconds), the reply goes as text, with reason `too_long`.

In `sendAndLog` (WhatsApp, `triggerIsVoiceNote`):
- **Plain reply** (no link, no options): the whole text is spoken. No text
  follows.
- **Reply with a trailing link** (`splitTrailingUrl`): the body is spoken, and
  a short text follows with the link, sent as the existing cta_url button.
- **Reply with options** (`[[OPTIONS]]`): the text is spoken, and the buttons
  follow as an interactive message whose body is a short fixed line ("Tap an
  option:", operator-editable, default in the voice settings).
- **Any other URL** inside the text: URLs are removed from the spoken text
  (never read aloud), and the original text, link included, follows as a text
  message (my call: a link mid-sentence must reach the customer).
- **The holding message** in `handoff()` / `softHandoff()`: spoken in the
  `handoff` voice. No text follows.

If the voice send fails, the reply goes exactly as today (text, buttons or
cta_url).

**Accepted, then failed (my call, the "never lose a customer message" rule).**
Meta accepts a media send at once and fetches the audio afterwards, so a file
it cannot fetch or decode shows up later as a `failed` status in the webhook's
status handler. For an agent voice-reply row (`voice_kind` set), that status
resends the stored text once, as the plain text message it would have been
(the follow-up link or buttons were already sent separately). The resend is
claimed with a compare-and-set on a new `voice_fallback_sent_at` column so a
repeated webhook never sends twice. It is a new caller of the WhatsApp number
resolver and gets its row in `tests/whatsapp-config-callers.test.js`: a
refusal there is logged and staff are pushed, the same as a failed Mia send.
The signed URL lives for 1 hour, far beyond Meta's fetch. A voice note that sent while its follow-up text failed counts as
partly sent: it is logged with `logError`, and the follow-up is NOT retried as
a full text reply (the customer already heard it).

The optional AI notice (decision 6): when `ai_notice` is set and the thread
has no earlier agent voice reply, the notice text is sent as a short text
after the first voice note. It is empty by default, so nothing is sent.

### 6. Staff view

- **Web inbox and phone:** an agent `audio` row renders the player (as today
  for media) with the spoken text under it, reusing the VOICENOTE.1 caption
  area. A short label reads "Mia replied by voice · <kind>". Mia's
  outbound row has `body`, so the thread preview shows the text.
- **`MiaDecisionTrace`:** the decision row's meta records `voice: { sent, kind,
  reason }`, so staff can see why a reply went as text.

### 7. Settings

- **`/settings/usage`** (org admins, beside transcription): a "Voice replies"
  section with mode (Off / Test numbers only / On), the test numbers, the
  monthly limit, and replies sent this month.
- **A "Mia's voices" card** (managers at the studio, new route
  `/api/settings/voice-replies`, gated on the studio role: owner or manager at
  that studio, 404 for a studio the caller is not at):
  - one picker per kind (Leads and trials, Bookings, Member questions,
    Hand-off message, Default), listing ElevenLabs voices from `listVoices`
    with a play-sample button (`preview_url`; if it is not publicly playable,
    the route proxies it);
  - the AI notice text (empty by default) and the buttons line;
  - a "Play sample" button that voices a fixed sentence ("Hi, it's Mia from
    UN1T. Your class is booked for seven tomorrow morning.") in the selected
    voice and plays it in the browser. My call: a WhatsApp test only arrives
    within 24 hours of that number messaging the studio, so the real phone
    test is the Test numbers mode (Go-live step 3). The sample is metered like
    a reply.
- The route validates with Zod, registers in `openapi.js`, and only stores
  voice ids that `listVoices` returned for the account.
- **Mobile parity:** a new `WEB_PERMISSIONS` key is not needed if the card
  gates on role; if one is added, the parity linter forces the mobile choice.

### 8. Data protection

ElevenLabs is already listed as a sub-processor (#2293). The pages gain a line
saying it also produces Mia's voice replies. The data sent is Mia's reply
text, which can contain the customer's first name and booking details.

## Tests

- **Pure:** `voiceKindFor` precedence, `voiceFor` fallback, and the text split
  (spoken part vs follow-up) for plain, trailing-link, mid-text-link, options
  and holding messages.
- **Transport:** `synthesizeSpeech` and `listVoices` with a stubbed fetch, for
  every failure reason, the timeout and the query string.
- **Speech text:** `spokenTextFor` strips emoji, markup, bullets and URLs and
  never changes a word; over 600 characters goes as text.
- **Accepted then failed:** a `failed` status on an agent voice row resends the
  text once; a second `failed` webhook sends nothing.
- **`maybeSendVoiceReply`:** each gate (mode off / test-list miss / cap /
  no voice / synth failure / upload failure / send failure) returns its reason
  and sends nothing to Meta. Success sends `voice: true` once and meters once.
- **Agent:** a typed message never voices. A voice-note turn voices and records
  one audio row plus the follow-up. A voice failure sends today's exact text,
  buttons or cta_url. The holding message after a voice note voices in the
  hand-off voice.
- **Settings:** the manager gate (owner/manager at the studio yes, head
  coach/staff no, other studio 404), validation, and unknown voice ids refused.
- **CI mirror,** including `check:select-columns`, `check:route-guards` and
  `check:location-scoping`.

## Go-live

1. Apply the migration, deploy. Mode stays `off`.
2. Richard sets mode to Test numbers only, adds his number, and picks the five
   voices for each studio.
3. He sends voice notes covering each kind (an enquiry, a booking, a member
   question, something Mia can't answer) and listens to the replies.
4. When happy, mode → On.

## Left to the builder

- The exact booking-tool names that count as "booked, moved or cancelled".
- Placement and wording in the settings card and the staff view, within the
  rules above.
- The Ogg wrapping, only if the live check shows it is needed.
- The migration number (next free after a fresh `origin/main` sync; 808 is the
  latest today).
