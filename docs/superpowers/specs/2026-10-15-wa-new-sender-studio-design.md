# WASTUDIOPICK — which studio a new WhatsApp sender belongs to

**Date:** 2026-10-15 · **Status:** design approved in chat, spec awaiting review
**Phase 2 of 3** of "Mia at organisation level". Phase 1 (WAHOMESTUDIO.1, #2063,
live 15 Oct) files a known contact's thread at their own studio; this phase
covers a sender we do not know.

## 1. Problem and honest scale

UN1T Group has one WhatsApp number (Stillorgan). A sender with no matched
contact files at the receiving studio (Stillorgan), whatever studio they are
really asking about. **Live data (15 Oct 2026): 0 unknown-sender threads in the
last 90 days (386 threads, all from known contacts) and 0 click-to-WhatsApp
threads.** This is a safety net for when Hatch publishes the number, runs
click-to-WhatsApp ads, or Mia goes on at Stillorgan. Richard chose the full
design knowing that.

## 2. Goal

For an unknown sender's first message, decide the studio from the strongest
available signal, ask once with tap buttons when nothing decides, and move the
thread there (Phase 1's `move_whatsapp_conversation`). Record how it was
decided. Everything ships OFF until switched on at the number's studio.

Success:
1. A first message from an unknown sender that came from a Hatch
   click-to-WhatsApp ad lands in the Hatch inbox without a question.
2. "Is the Hatch St studio open Sunday?" from an unknown sender is moved to
   Hatch without a question (classifier).
3. "Hi, do you do trial classes?" gets the picker; tapping "Hatch Street"
   moves the thread; tapping "Stillorgan" leaves it.
4. Each thread is decided at most once; nobody is asked twice.
5. Mia never answers a thread whose studio is still being asked.
6. Known contacts, studios without the switch, and other organisations behave
   exactly as today.

## 3. Rules

**R1 — eligibility.** The resolver runs for an inbound message when ALL hold:
- no contact matched the sender (the webhook's `contact` is null);
- the thread's studio is the receiving number's studio and has
  `settings.wa_studio_picker.enabled === true`;
- the thread has no final `studio_resolution` (see R6);
- at least two studios in the organisation are opted in (`listed`), so
  there is a choice to make.
Otherwise nothing changes.

**R2 — signals, in order; the first that decides wins.**
1. **Ad.** `message.referral` with `source_type === 'ad'` and a `source_id`:
   `ad_entities` rows with `level = 'ad'`, `external_id = source_id`, at
   opted-in studios of this organisation. Exactly one distinct studio →
   decided (`by: 'ad'`). Zero or several → no decision.
2. **Reply context.** `message.context.id`: the `whatsapp_messages` row with
   that `wa_message_id`, in this organisation, at an opted-in studio → that
   row's studio (`by: 'reply'`).
3. **Classifier.** Only for a message with text (`text`, an interactive
   title, a caption). One Anthropic Messages call through the repo's
   `anthropicMessages` helper (metered per studio to the receiving studio,
   `source: 'wa_studio_pick'`), model `AGENT_MODEL` (Mia's), adaptive
   thinking, `output_config.effort: 'low'`, structured JSON output
   `{ studio: <listed id> | null, confident: boolean }`. Input: the message
   text plus each opted-in studio's name, label and keywords. Decided only when
   `confident === true` and `studio` is one of the listed ids
   (`by: 'ai'`). Skipped, as "unsure", when the receiving studio's AI cap is
   reached (`getAiCapStatus`), when the call fails, times out (8 s), refuses,
   or returns anything else. The classifier never sees the conversation
   history or anything but this one message.
4. **Picker.** Otherwise, send the picker (R4) and mark the thread `asked`.

**R3 — outcome.** A decision for a studio other than the thread's →
`move_whatsapp_conversation(thread, studio)`; the Phase 1 sticky lookup keeps
later messages there. A decision for the thread's own studio → no move. Either
way the resolution is recorded (R6) and the message carries on (Mia, push, …)
at the thread's (possibly new) studio.

**R4 — the picker.** One WhatsApp interactive reply-button message, sent
through the thread (`replyInConversation`): body = the number's studio's
`question` (default "Thanks for getting in touch. Which studio is this
about?"), one button per opted-in studio, title = its `label` (default: the
studio's name, cut to WhatsApp's 20-character button limit), id =
`studio:<location_id>`. At most 3 buttons (WhatsApp's limit); with more than 3
opted-in studios a list message is used instead. Logged in `whatsapp_messages`
like any automated send (`source` = the agent message source). If the send
fails, the resolution is recorded `unresolved` (`reason: 'ask_failed'`), logged,
and the message carries on at the receiving studio.

**R5 — after the picker.** The next inbound message on an `asked` thread:
- an interactive `button_reply` / `list_reply` whose id is `studio:<id>` of an
  opted-in studio of this organisation → decided (`by: 'picker'`), R3;
- otherwise, if it has text, the classifier runs once (R2.3) → decided
  (`by: 'ai'`) or final `unresolved` (`reason: 'no_answer'`);
- either way, the thread is now final; nothing asks again.
A button tap on a FINAL thread is ignored by the resolver (the message is
stored as usual).

**R6 — record.** `whatsapp_conversations.studio_resolution jsonb` (new,
nullable): `{ status: 'asked' | 'decided' | 'unresolved', by?: 'ad' | 'reply' |
'ai' | 'picker' | 'staff', location_id?, reason?, at }`. `asked` is the only
non-final status. A staff "Move to studio" (Phase 1 route) writes
`{ status: 'decided', by: 'staff', … }` too. `request_welcome` (a chat opened
with no message) from an eligible sender sends the picker instead of the
welcome greeting and marks `asked`.

**R7 — Mia waits.** While a thread is `asked`, and on the message that sent
the picker, `maybeAutoReply` and the welcome greeting are not called. On the
message that resolves the thread (R5), they are called as usual at the thread's
studio, so Mia (where on) answers with the whole conversation in view.

**R8 — settings (operator-editable).** `locations.settings.wa_studio_picker`:
- on every studio: `listed` (boolean, default false), `label` (≤ 20 chars,
  default the studio's name), `keywords` (array of short strings, optional,
  classifier hints only);
- on a studio that owns a number: `enabled` (boolean, default false),
  `question` (≤ 1024 chars, WhatsApp's body limit; default above).
Edited by an owner of that studio or a master (same rule as Mia's settings,
`canEditMiaSettings`), on a "Studio picker" card in the WhatsApp settings.
Written through `mergeLocationSettings` (SETTINGSWIPE.1). No em-dashes in the
default copy; operator text passes through `stripEmDashes` at send.

**R9 — inbox.** The thread header shows a small "Filed by: ad / reply / AI /
picker / staff" note from `studio_resolution` when it is `decided`, and
"Asked which studio" while `asked`.

## 4. Out of scope
- Known contacts (Phase 1 covers them), Instagram, coexistence (phone-app)
  messages, email.
- Creating or moving CONTACT records (Add to contacts already uses the thread's
  studio, which is now the right one).
- Template quick-reply taps (`type: 'button'`): a separate bug (spawned task);
  this phase reads `interactive` replies only.
- Mobile UI (the note shows on web only).

## 5. Rollout
1. Migration 725: `whatsapp_conversations.studio_resolution jsonb` (nullable,
   no default; `whatsapp_conversations` has table-level SELECT for
   `authenticated`, so the column is readable by the inbox realtime as the
   rest of the row is). Apply before merge (inert).
2. Merge. Nothing changes: every studio's `enabled`/`listed` is false.
3. Richard sets Stillorgan + Hatch `listed`, labels, optional keywords, and
   Stillorgan `enabled` when he wants it live.

## 6. Testing
- Unit (`src/lib/wa-studio-pick.js`): eligibility; each signal; order (ad
  beats text); ambiguous ad → next signal; classifier confident / unsure /
  wrong id / failure / refusal / cap reached → picker; picker payload (ids,
  labels, 20-char cut, >3 → list); tap of listed id / unlisted id / other org
  id; typed reply → classifier once → decided or unresolved; final threads
  untouched.
- Webhook: Mia not called while asked; called after the resolving message at
  the new studio; picker failure → carries on; known contact unchanged;
  request_welcome → picker instead of greeting.
- Settings route + card: owner/master only; validation (label length,
  question length, keywords).
- Migration 725 static/behaviour test (PGlite), as for 723.

## 7. Risks
- **A wrong AI decision** files a customer at the wrong studio silently.
  Mitigation: only `confident: true`; staff can Move to studio; the note says
  "AI" so staff know to check.
- **Picker as the first thing a customer sees** may feel robotic. Mitigation:
  editable wording; off by default.
- **Latency:** the classifier adds about 1-3 s before the reply; the webhook
  already runs Mia inline, and the call has an 8 s cap.
- **Phase 3 overlap:** org-level settings will later hold the question; R8
  keeps it on the number's studio for now.

## 8. Amendments made during implementation (15 Oct 2026)
Rulings taken in review, now part of the behaviour:
- **R4 claim before send.** The picker is claimed with a compare-and-set
  (`studio_resolution IS NULL` → `asked`) before it is sent, so a burst of
  messages sends one picker; the losing message is treated as `asked`.
- **R5 refined.** On an `asked` thread: a message sent at or before the
  question went out (Meta timestamp ≤ `at` + 5 s) is not an answer; a first
  non-answer (reaction, sticker, voice note, other non-text) keeps the thread
  `asked` and counts `nonanswers: 1`; a second ends it `unresolved/no_answer`.
  A tap on a listed studio is always an answer.
- **R2.** Template quick-reply taps (`type: 'button'`, WABUTTONTAP.1 #2064) are
  read as text. A move error `same_studio` counts as success; final writes only
  land while the thread is not already final.
- **R8.** Only the receiving studio and listed studios WITHOUT their own
  WhatsApp number are offered (a thread moved to a numbered studio could not
  reply through this number).
- **R6.** The record may carry `nonanswers`.
