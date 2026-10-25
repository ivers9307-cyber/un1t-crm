// WACONFIGFALLBACK.1 — every caller of a WhatsApp config resolver, and what
// it does when the location has no WhatsApp number of its own.
//
// The defect this pins: getWhatsAppConfig(locationId) fell back to the global
// WHATSAPP_* env number when a location had no active whatsapp_numbers row
// (5 of 6 active locations on 30 Sep 2026), and four template routes named no
// location at all, so they ALWAYS used it. A send, a template write, a block
// or a media fetch "for" such a location acted on another studio's number,
// and a customer's reply routed to that studio's inbox and Mia. The env tier
// is retired: the resolvers throw WhatsAppNumberMissingError
// (src/lib/whatsapp-number-missing.js) and each caller decides what that
// means for it. This table is that decision, one row per calling file.
//
// WAORGNUMBER.1 changed what "has a number" means: a number belongs to an
// organisation (whatsapp_numbers.organization_id; location_id is only its home
// studio) and a studio HAS one when it is switched on there, i.e. a
// location_whatsapp_numbers link row to an ACTIVE whatsapp_numbers row. The
// resolvers read the link table, the studio's default link first, so the env
// tier stays retired and "no number" now means "none switched on at this
// studio", whoever owns the number. The refusal semantics below are unchanged;
// each row's `why` says what that caller does with it.
//
// What is scanned: every .js/.jsx/.mjs file under src/, shared/ and scripts/
// except tests and test helpers. A file is a CALLER when it imports one of
// the resolving names below from src/lib/whatsapp.js,
// src/lib/whatsapp-config.js or src/lib/whatsapp-own-number.js (a static
// import, or `const { … } = await import(…)`), and the row counts its CALLS of
// each imported name (aliases followed). The table is EXACT: a new caller, a
// removed one or a changed count fails until a row says what the caller does
// with a refusal, and why.
//
// The resolving names are not hand-kept only: every exported function in
// whatsapp.js whose body calls resolveConfig( or getWhatsAppConfig( must be
// in RESOLVING, so a new Meta helper cannot slip past the table.
//
// How calls are found: each file is parsed with the TypeScript parser; import
// bindings come from the AST; calls are counted in the text with comments
// (stripComments, copied from tests/staff-profile-to-client.test.js, JSX text
// positions excluded) and the contents of string / template / regex literals
// blanked (as tests/whatsapp-config-route-gates.test.js does), so a name in a
// comment or a string never counts. A namespace import (`import * as wa`) or
// an `import()` of these modules in any other shape fails its own test, and
// so does a re-export of one (`export { … } from`, `export * from`), which
// would let a barrel hide its callers. A destructured `process.env` read of a
// retired var counts as a read.
//
// A FLOOR, NOT A PROOF. Not detected: a call through a variable
// (`const f = sendTextMessage; f()`), a caller that passes the wrong location,
// and what a WRAPPER's callers do (a wrapper's row covers them: e.g.
// maybeSendBookingWhatsappConfirm never throws, so every booking path that
// calls it inherits "quiet sent:false"). The per-caller tests named in each
// row are the proof.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'scripts'].map((d) => path.join(ROOT, d))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

// Module (repo path without extension) → the names that resolve a config.
const RESOLVING = {
  'src/lib/whatsapp': [
    'sendTextMessage', 'sendInteractiveOptions', 'sendFlowMessage', 'sendCtaUrlMessage', 'sendMediaCarousel',
    'sendTemplateMessage', 'sendMediaMessage', 'sendReaction', 'markAsRead', 'sendTypingIndicator',
    'setWhatsAppUserBlockState', 'setConversationalAutomation', 'uploadMediaForTemplate', 'createTemplate',
    'getTemplates', 'getTemplate', 'deleteTemplate', 'editTemplate', 'sendBroadcast', 'sendDripChunk',
  ],
  'src/lib/whatsapp-config': [
    'getWhatsAppConfig', 'getLocationWhatsAppNumberConfig', 'getWhatsAppConfigById', 'resolveWhatsAppNumberByPhoneNumberId',
    'getConversationReplyConfig', 'getConversationNumberConfig',
    // WAORGNUMBER.1 (R2, R5) — S's switched-on number on one WABA (template sends).
    'getLocationNumberForWaba',
    // WAORGNUMBER.2 (R5) — every number switched on at S (the template sync's WABAs).
    'listLocationNumberConfigs',
  ],
  // WAORGNUMBER.2 (R5) — templateNumberOrRefusal: the template studio's number on the template's WABA.
  'src/lib/whatsapp-own-number': ['ownNumberOrRefusal', 'templateNumberOrRefusal'],
}

// Decisions:
//   refuse-409     staff route: a refusal is a 409 with the resolver's message
//                  (whatsappErrorStatus / ownNumberOrRefusal), nothing written
//   own-number     acts AT META for one location: resolves THAT location's own
//                  number first (ownNumberOrRefusal / getLocationWhatsAppNumberConfig)
//   refuse-quiet   automated, best-effort: the existing try/catch turns the
//                  refusal into { sent:false } / a skip, logged, never thrown
//   refuse-skip    automated with a runner: a recorded skip or a pause, never
//                  a throw that could kill other work
//   inbound-owner  replies to inbound; the webhook only routes inbound to a
//                  location that owns the receiving number, so a refusal means
//                  the number was removed mid-flight (then refuse-quiet)
//   resolver       the resolution layer itself
const CALLERS = {
  'src/lib/whatsapp.js': {
    calls: { getWhatsAppConfig: 1, getConversationReplyConfig: 1, getLocationWhatsAppNumberConfig: 1, getLocationNumberForWaba: 1 },
    decision: 'resolver',
    why: 'WAORGNUMBER.4 (R7): sendBroadcast / sendDripChunk budget per NUMBER (getSendBudget { numberId: config.id }, counted over every studio with it switched on), and an unsigned broadcast inside the studio’s blast sign-off window is refused before any status flip (blast: BlastSignoffRequiredError → route 409 / cron pushes managers) or paused (drip: needs_signoff), before either resolves a number; no resolver call count changed. whatsapp-blast-signoff-engine.test.js. WAORGNUMBER.2 (R5): opts.businessAccountId (the template row’s WABA) resolves the studio’s number on that WABA (getLocationNumberForWaba; none → WhatsAppNumberMissingError), and with opts.replyInConversation the thread number when it is on that WABA (getConversationReplyConfig); sendBroadcast / sendDripChunk resolve through resolveConfig with their template’s WABA, so their refusal paths are unchanged (blast: throw before the flip; drip: pause no_whatsapp_number); a row with no WABA keeps the old rules. whatsapp-reply-number.test.js, whatsapp-no-number-senders.test.js. WAORGNUMBER.1: getOrCreateConversation’s sendingNumberId is the number switched on at the sending studio (link default first); a throwing lookup is logged and files the thread unstamped, never thrown (whatsapp-get-or-create-conversation.test.js). WAORGNUMBER.5 (R3): the same lookup now also stamps a new thread at the sending studio and an existing one there with no stamp or a stamp no longer switched on (or active) there (a stamped thread is checked with one link read; the resolver runs only when the stamp must change); a failed stamp check keeps the stamp, logged. resolveConfig (every Meta helper; getWhatsAppConfig reads the studio’s switched-on numbers, none → WhatsAppNumberMissingError; opts.replyInConversation → getConversationReplyConfig, which falls back to getWhatsAppConfig and so refuses a studio with nothing switched on the same way; WAORGNUMBER.6 removed WAHOMESTUDIO.1’s same-organisation sibling clause, so a studio with nothing switched on never replies through a sibling’s stamp, whatsapp-reply-number.test.js). WAORGNUMBER.6: getOrCreateConversation files a new thread at the SENDING studio only (the number-less home-studio branch is gone), whatsapp-get-or-create-conversation.test.js. sendBroadcast (blast: throws BEFORE the status flip → route 409 / cron pushes managers), sendDripChunk (pauses the drip). src/lib/whatsapp-no-number-senders.test.js, whatsapp-no-number-broadcasts.test.js.',
  },
  'src/app/api/whatsapp/spend/route.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'refuse-quiet',
    why: 'WAORGNUMBER.1: Meta pricing_analytics for the WABA + token of the studio’s default switched-on number (link table; it read whatsapp_numbers by the studio’s home id, so a shared number was invisible to the studios using it). Optional enrichment inside its try/catch: no number or a failed lookup → meta null, the local rollup still served, logged. route.test.js.',
  },
  'src/app/communications/(hub)/wa-hub-health.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'refuse-quiet',
    why: 'WAORGNUMBER.1: the hub’s health card reads the studio’s default switched-on number (link table; it read whatsapp_numbers by home studio, so a studio using an organisation number saw no card). Decorative: no number or a failed lookup → null, the card hidden, logged, never thrown into the page. wa-hub-health.test.js.',
  },
  'src/lib/meta-capi.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'refuse-quiet',
    why: 'WAORGNUMBER.1: (one helper, two sites) the CAPI token + WABA of the studio’s default switched-on number (link table, not the number’s home studio) (CTWA conversion; website conversion when the dataset has no token of its own). Best-effort, never throws: no number or a failed lookup → { sent:false, reason:\'no_token\' }, logged. meta-capi.test.js, meta-capi-website.test.js.',
  },
  'src/lib/whatsapp-own-number.js': {
    calls: { getLocationWhatsAppNumberConfig: 1, getLocationNumberForWaba: 1 },
    decision: 'resolver',
    why: 'WAORGNUMBER.2 (R5): templateNumberOrRefusal resolves the template studio’s number on the template’s WABA (409 “The number this template lives on is switched off at this studio.” / 500 lookup failed; a row with no WABA falls back to ownNumberOrRefusal). WAORGNUMBER.1: ownNumberOrRefusal; “own” now means switched on at the studio (a link row to an active number, whoever owns it), not a number whose home is the studio. 409 none switched on / 500 lookup failed. whatsapp-own-number.test.js.',
  },
  'src/lib/whatsapp-media-server.js': {
    calls: { getLocationWhatsAppNumberConfig: 1, getConversationNumberConfig: 1 },
    decision: 'own-number',
    why: 'WAORGNUMBER.1: inbound media fetched with the token of the thread’s number while it is switched on at the message’s studio (getConversationNumberConfig), else the studio’s default; WAORGNUMBER.6 removed the sibling clause. None → null (the inbox’s graceful gap). whatsapp-media-server.test.js.',
  },
  'src/app/api/webhooks/whatsapp/route.js': {
    calls: { resolveWhatsAppNumberByPhoneNumberId: 3 },
    decision: 'resolver',
    why: 'inbound routing: only an active row owns inbound (classifyInboundOwner); the env branch is gone (it could only produce a location-less config, which was dropped anyway). WAORGNUMBER.1: account_update events reach every studio the number is switched on at (link rows). WAORGNUMBER.5 (R4): the thread’s studio is routeInboundThread’s (quoted message, CTWA ad, latest outbound in 7 days, home studio, else the number’s home), reading the link table itself, so the per-thread getLocationWhatsAppNumberConfig lookup is gone; the receiving number is stamped when it is switched on at the routed studio; WAORGNUMBER.6 removed the transitional numberless_home step, so a studio with nothing switched on never receives a message, and the CTWA Lead and Flow completions act at the routed studio. A failed read inside the router falls through, never thrown, so the webhook still 200s. ORGCONTACTS.3: the phone matches’ contact_studios rows are read once (studiosOfContacts) and feed pickInboundContact (an active relationship at a candidate studio first) and the router’s step 4 (the candidate studio with an active relationship, by last activity, before the home studio); the candidate studios come from one studiosUsingNumbers read (not a resolver; a failed read keeps the number’s home as the only candidate), and a failed rows read passes null to both. route.reply-number.test.js, route.inbound-route.test.js, src/lib/whatsapp-inbound-route.test.js, src/lib/whatsapp.pick-inbound-contact.test.js, WAORGNUMBER.3 (R6): the user_preferences handler resolves the receiving number’s home studio (the third resolver call) to scope Meta’s marketing opt-out to that studio’s organisation; an unroutable or failed lookup passes no studio and applies nothing (logged); route.user-preferences.test.js.',
  },
  'src/app/api/whatsapp/conversational-automation/route.js': {
    calls: { setConversationalAutomation: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'WAORGNUMBER.4 (R8): the openers are the number’s, shared by every studio using it, so after the own-number check (no extra resolver call) a studio that is not the number’s home answers 403 unless the caller is an organisation admin (master passes); Meta is not called. route.test.js. chat openers on the location’s own number (C33 WAROLE.1), 409 / 500 before Meta.',
  },
  'src/app/api/whatsapp/templates/route.js': {
    calls: { createTemplate: 1, getTemplates: 1, ownNumberOrRefusal: 1, listLocationNumberConfigs: 1 },
    decision: 'own-number',
    why: 'WAORGNUMBER.2 (R5): create goes on the WABA of the studio’s default switched-on number (ownNumberOrRefusal, 409 / 500 before Meta), refuses a name another studio uses on that WABA (409 naming the owner) and stores business_account_id; sync walks the distinct WABAs of the numbers switched on at the studio (listLocationNumberConfigs: none → sync_error, a failed read → sync_error, Meta not called, cache served), reads every page, updates its own rows, skips other studios’ and adopts unowned ones only at the number’s home studio. route.own-number.test.js, route.sync-error.test.js. Before: create: 409 / 500 before Meta (it named no location, so it always used the env WABA). Sync: sync_error, Meta not called, cache served (it copied the env WABA’s templates into a number-less location). route.own-number.test.js. ?conversation_id= serves the thread’s studio’s cached rows (ORGCONTACTS.0: read off the conversation row; templateLocationIdFor, an identity kept only for this count, is deleted), no sync.',
  },
  'src/app/api/whatsapp/templates/[id]/route.js': {
    calls: { deleteTemplate: 1, templateNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'WAORGNUMBER.2 (R5): Meta delete-by-name on the template’s OWN WABA (templateNumberOrRefusal); its WABA has no number switched on at the studio → 409, row kept; a row with no WABA keeps the rule below. route.own-number.test.js. Before: Meta delete-by-name on the template location’s own WABA (it always deleted on the env WABA). No number → Meta skipped, local row deleted; lookup failed → 500, row kept. route.own-number.test.js.',
  },
  'src/app/api/whatsapp/templates/[id]/resubmit/route.js': {
    calls: { editTemplate: 1, templateNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'WAORGNUMBER.2 (R5): edit on the template’s OWN WABA (templateNumberOrRefusal: 409 “switched off at this studio” / 500 before Meta). Before: edit with the template location’s own number (it always used the env token); 409 / 500 before Meta. route.own-number.test.js.',
  },
  'src/app/api/whatsapp/templates/upload-media/route.js': {
    calls: { uploadMediaForTemplate: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'header upload with the location’s own app + token (it always used the env app). Soft contract kept: URL returned, handle null, meta_error says why. route.own-number.test.js.',
  },
  'src/app/api/contacts/[id]/whatsapp/route.js': {
    calls: { sendTextMessage: 1, sendTemplateMessage: 1, ownNumberOrRefusal: 1, getConversationNumberConfig: 1 },
    decision: 'refuse-409',
    why: 'WAORGNUMBER.4 (R3): the thread files at the contact’s HOME studio through getOrCreateConversation(db, contact, contact.location_id) (getOrCreateContactConversation, which took the most recent thread at any studio, is gone); same resolver calls, same 409 when home has nothing switched on. contact composer: own number checked BEFORE a thread is opened (no empty thread); the send carries that checked { config } (one lookup, no check-then-send gap), or the thread\'s own number while it is active here (WAREPLYNUMBER.1: getConversationNumberConfig never throws, null → the checked default; a template only within the default\'s WABA). WAORGNUMBER.2 (R5): a template goes from the thread number or the checked default only when it is on the template\'s WABA (pickTemplateConfig); when neither is, the send resolves by location + WABA (sendTemplateMessage { locationId, businessAccountId }) and can refuse: WhatsAppNumberMissingError → 409 (whatsappErrorStatus), nothing logged. route.test.js.',
  },
  'src/app/api/contacts/[id]/cancellation-form/route.js': {
    calls: { sendCtaUrlMessage: 1, sendTemplateMessage: 1, ownNumberOrRefusal: 1 },
    decision: 'refuse-409',
    why: 'WAORGNUMBER.4 (R3): the composer’s thread, at the contact’s HOME studio (getOrCreateConversation at contact.location_id); same resolver calls. WhatsApp channel only: own number checked before a thread or a link, and the send carries that checked { config }; email unaffected. WAORGNUMBER.2 (R5): a template goes from the checked default only when it is on the template\'s WABA (pickTemplateConfig); otherwise the send resolves by location + WABA (sendTemplateMessage { locationId, businessAccountId }) and can refuse: WhatsAppNumberMissingError → the minted link is revoked and the route answers 409 (whatsappErrorStatus). route.test.js.',
  },
  'src/app/api/churn-radar/action/route.js': {
    calls: { sendTextMessage: 1 },
    decision: 'refuse-409',
    why: 'WAORGNUMBER.4 (R8): the 409 now names the radar’s studio, “No WhatsApp number is switched on at {studio}.” (locations.name; a failed read refuses without the name); same resolver path. win-back: 409 with the resolver message (the copy blamed the member’s message window); outreach via sendRadarOutreach: 409. route.no-number.test.js.',
  },
  'src/app/api/whatsapp/broadcasts/[id]/send/route.js': {
    calls: { sendBroadcast: 1 },
    decision: 'refuse-409',
    why: 'WAORGNUMBER.4 (R7): inside the studio’s blast sign-off window an unsigned broadcast is a 403 for anyone but an organisation admin (whose send stamps it) before sendBroadcast runs; the engine’s own sign-off refusal is a 409. route.test.js. blast refused before any status flip → 409. route.test.js.',
  },
  'src/app/api/cron/run-whatsapp-broadcasts/route.js': {
    calls: { sendDripChunk: 2, sendBroadcast: 3 },
    decision: 'refuse-skip',
    why: 'WAORGNUMBER.4 (R7): an unsigned scheduled blast at a studio inside its sign-off window is a refused start like any other (draft, managers pushed with the sign-off copy); an unsigned drip pauses inside sendDripChunk. route.signoff.test.js. scheduled blast or (C138 b) scheduled drip start refusal: row stays draft, managers pushed; drip: paused by sendDripChunk (no error loop); a resumed chunked blast logs per tick (existing path).',
  },
  'src/app/api/whatsapp/conversations/[id]/send/route.js': {
    calls: { sendTemplateMessage: 1, sendMediaMessage: 1, sendTextMessage: 1 },
    decision: 'refuse-409',
    why: 'inbox reply: 409, nothing logged (it replied from another studio’s number, so the answer went to that studio). route.test.js. Template rows read at the thread’s studio (ORGCONTACTS.0: off the conversation row; the templateLocationIdFor identity seam and its cross-studio Flow refusal are gone).',
  },
  'src/app/api/whatsapp/conversations/[id]/react/route.js': {
    calls: { sendReaction: 1 },
    decision: 'refuse-409',
    why: '409, no thread row. conversations/[id]/no-number.test.js.',
  },
  'src/app/api/whatsapp/conversations/[id]/block/route.js': {
    calls: { setWhatsAppUserBlockState: 1 },
    decision: 'refuse-409',
    why: '409, nothing mirrored (the env Block API blocked the sender on ANOTHER studio’s number). no-number.test.js. Through the thread (replyInConversation): its stamp while switched on at the studio, else the studio’s default.',
  },
  'src/app/api/whatsapp/conversations/[id]/send-flow/route.js': {
    calls: { sendFlowMessage: 1 },
    decision: 'refuse-409',
    why: '409, no thread row. no-number.test.js.',
  },
  'src/lib/whatsapp-carousel-send.js': {
    calls: { sendMediaCarousel: 1 },
    decision: 'refuse-409',
    why: 'wrapper: throws before the thread row. Staff send-carousel route → 409 (no-number.test.js); Mia’s send_card_set tool → its tool-error path (inbound-owner).',
  },
  'src/lib/agent/auto-reply.js': {
    calls: { sendTypingIndicator: 1, sendCtaUrlMessage: 1, sendTextMessage: 1, sendInteractiveOptions: 1 },
    decision: 'inbound-owner',
    why: 'Mia replies to inbound, which only reaches a location that owns the receiving number. A refusal = number removed mid-flight → the agent’s existing send-failure path.',
  },
  'src/lib/agent/welcome-greeting.js': {
    calls: { sendTextMessage: 1 },
    decision: 'inbound-owner',
    why: 'never throws → { sent:false }. welcome-greeting.test.js.',
  },
  'src/lib/whatsapp-consent.js': {
    calls: { sendTextMessage: 1 },
    decision: 'inbound-owner',
    why: 'STOP/START ack only; the consent change is written first and stands (louder-failure rule). WAORGNUMBER.3 per-studio consent: STOP/START write the thread studio\'s contact_location_preferences row only; a contact-wide opt-out (Meta preference, or a keyword with no studio) also sets every studio row false; the ack goes through the thread (replyInConversation, WAREPLYNUMBER.1). WAORGNUMBER.3b: the keyword is the thread contact\'s, and a studio STOP also closes that studio\'s existing row for every same-phone contact in the organisation (no Meta call; the ack still waits on the thread contact\'s row). whatsapp-consent.test.js.',
  },
  'src/lib/agent/notify.js': {
    calls: { sendTextMessage: 1 },
    decision: 'refuse-quiet',
    why: 'Mia confirmations into an EXISTING thread at its location; caught → { sent:false, reason }. Unreachable at a location that never had a number (no threads there).',
  },
  'src/lib/agent/booking-flow.js': {
    calls: { sendFlowMessage: 1 },
    decision: 'refuse-quiet',
    why: 'MIAFLOW.1 — Mia’s send_booking_flow tool, in-session into the thread she is answering (replyInConversation). A refusal (or any send failure) is caught → { sent:false, reason: send_failed } with the booking link, logged structurally, no thread row; the model is told it was NOT sent and sends the link instead. booking-flow.test.js, auto-reply-booking-flow.test.js.',
  },
  'src/lib/agent/followups.js': {
    calls: { sendTextMessage: 2, sendTemplateMessage: 2 },
    decision: 'refuse-skip',
    why: 'Mia nudges / first-class check-ins: only at locations with the agent enabled. WAORGNUMBER.1: a studio with a number switched on (locationsWithWhatsApp: a location_whatsapp_numbers link to an active number, one read per studio per tick; a failed read counts as having one, logged) sends exactly as before: { locationId }, its own templates. WAORGNUMBER.6: a studio with nothing switched on is skipped for the tick before any candidate read or compose (follow-ups: a followup-skip no_number log; check-ins: reasons.no_number), and MIAORG.1 Task 6’s send-through-a-sibling’s-thread path (getConversationNumberConfig, templateLocationIdFor) is gone. A refusal at send time (the number switched off mid-tick, or the unreadable read above) is a recorded skip (no_number; a check-in claim is released), never a throw through the runner. followups-studio-number.test.js.',
  },
  'src/lib/agent/trial-done-runner.js': {
    calls: { sendTemplateMessage: 1, sendTextMessage: 1 },
    decision: 'refuse-skip',
    why: 'TRIALDONE.4/.5 — the trial-done opener and its one follow-up (agent-followups cron), only at un1t.online studios with customer_agent.trial_done.enabled and Mia on. One template send site serves the opener and the follow-up template; the Mia-written in-window nudge is the one sendTextMessage, { locationId: studio }, on the studio thread. The same refusal rules hold for all three sends, on their own claim columns. A studio with nothing switched on (studioOwnsWhatsAppNumber, the check-in runner’s read; a failed read counts as having one, logged) is skipped for the tick before any candidate read (reasons.no_number). A refusal at send time (the number switched off mid-tick, or that unreadable read) is a recorded skip (reasons.no_number), the opener claim released, never a throw through the runner; any other throw or a send with no message id is reasons.send_failed with the claim released. Sends { locationId: studio, businessAccountId: the template’s WABA }. trial-done-runner.test.js.',
  },
  'src/lib/automations/booking-whatsapp-confirm.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'booking + event confirmations (class, consult, EVENTCONFIRM-WA): never throws → send_failed, logged; needs a location-owned APPROVED template first. booking-whatsapp-confirm.test.js.',
  },
  'src/lib/automations/meta-ad-whatsapp-welcome.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'paid-ad lead welcome: never throws → send_failed, logged; needs a location-owned template first.',
  },
  'src/lib/cancellation-form/confirm.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'membership outcome template fallback: caught → { sent:false, reason:"send_error" }; needs an existing thread + a location-owned template.',
  },
  'src/lib/radar-availability.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'refuse-quiet',
    why: 'UN1TRADAR.3: read only, never sends. The radar GETs say whether a number is switched on at the studio (outreachAvailable), so the outreach button shows "No WhatsApp number at this studio yet" instead of a template picker; null is false; a failed read is null (unknown: caught, never thrown, and the picker stays so the send route answers for itself). radar-availability.test.js.',
  },
  'src/lib/radar-outreach.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-409',
    why: 'wrapper: rethrows; the churn / lead radar routes answer 409 (route.no-number.test.js).',
  },
  'src/lib/sequences/steps.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-skip',
    why: 'recorded skip + structured warning, never a throw (a throw can auto-pause the enrolment and kill its email steps). wa-no-number-step.test.js.',
  },
  'src/lib/wa-studio-pick/resolve.js': {
    calls: { sendInteractiveOptions: 1 },
    decision: 'refuse-quiet',
    why: 'WASTUDIOPICK.1 studio picker, sent through the thread (replyInConversation); a refusal or send failure is caught, recorded unresolved (ask_failed) and the message carries on at the thread’s studio. resolve.test.js.',
  },
}

const DECISIONS = new Set(['refuse-409', 'own-number', 'refuse-quiet', 'refuse-skip', 'inbound-owner', 'resolver'])

const parse = (text) => ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)

const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
])

// Comments (stripComments of tests/staff-profile-to-client.test.js: TypeScript
// comment ranges, none taken where JSX text begins) plus every literal's text,
// blanked to spaces with newlines kept.
export function blankNonCode(text, sf = parse(text)) {
  const jsxTextAt = new Set()
  const findJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxTextAt.add(node.pos)
    for (const child of node.getChildren(sf)) findJsxText(child)
  }
  findJsxText(sf)
  const ranges = []
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.push([r.pos, r.end])
    }
    if (LITERALS.has(node.kind)) ranges.push([node.getStart(sf), node.end])
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  const chars = text.split('')
  for (const [pos, end] of ranges) for (let i = pos; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '
  return chars.join('')
}

// '@/lib/x', './x', '../x.js' → repo path without extension, or null.
function resolveSpecifier(fromFile, spec) {
  let abs
  if (spec.startsWith('@/')) abs = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) abs = path.resolve(path.dirname(fromFile), spec)
  else return null
  return rel(abs).replace(/\.(m?js|jsx)$/, '')
}

const isDynamicImport = (node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword

// → { bindings: Map(localName → exportedName), problems: [] }
export function importBindings(file, text, sf = parse(text)) {
  const bindings = new Map()
  const problems = []
  const target = (spec) => {
    const mod = resolveSpecifier(file, spec)
    return mod && RESOLVING[mod] ? mod : null
  }
  const take = (mod, exported, local) => {
    if (RESOLVING[mod].includes(exported)) bindings.set(local, exported)
  }
  const handledDynamic = new Set()
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = target(node.moduleSpecifier.text)
      const nb = node.importClause?.namedBindings
      if (mod && nb) {
        if (ts.isNamespaceImport(nb)) problems.push(`namespace import of ${mod}: import the names`)
        else for (const el of nb.elements) take(mod, (el.propertyName || el.name).text, el.name.text)
      }
    }
    // A re-export (`export { x as y } from …`, `export * from …`) would let a
    // barrel's callers reach a resolver under a name this table never binds.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = target(node.moduleSpecifier.text)
      if (mod) problems.push(`re-export of ${mod}: import the names where they are called`)
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer)
      && isDynamicImport(node.initializer.expression)) {
      const call = node.initializer.expression
      const arg = call.arguments[0]
      const mod = arg && ts.isStringLiteral(arg) ? target(arg.text) : null
      if (mod) {
        handledDynamic.add(call)
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) take(mod, (el.propertyName || el.name).text, el.name.text)
        } else problems.push(`dynamic import of ${mod} not destructured`)
      }
    }
    if (isDynamicImport(node) && !handledDynamic.has(node)) {
      const arg = node.arguments[0]
      const mod = arg && ts.isStringLiteral(arg) ? target(arg.text) : null
      if (mod) problems.push(`dynamic import of ${mod} in an unsupported shape`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { bindings, problems }
}

export function countCalls(text, bindings, sf = parse(text)) {
  if (bindings.size === 0) return {}
  const code = blankNonCode(text, sf)
  const out = {}
  for (const [local, exported] of bindings) {
    const n = [...code.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))].length
    if (n) out[exported] = (out[exported] || 0) + n
  }
  return out
}

function sourceFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '.next'].includes(entry.name)) continue
      out.push(...sourceFiles(full))
    } else if (/\.(m?js|jsx)$/.test(entry.name) && !/\.test\.|\.test-helpers?\./.test(entry.name)) out.push(full)
  }
  return out
}

// Every scanned file is read and parsed ONCE per run and shared by both
// whole-repo tests: a TypeScript parse of the whole tree per `it` is what
// timed another guard out at vitest's 5 s default on the CI runner, so the
// whole-repo describes below also carry their own timeout.
const WHOLE_REPO_TIMEOUT_MS = 120_000
let cachedSources = null
function sources() {
  if (!cachedSources) {
    cachedSources = SCAN_DIRS.flatMap(sourceFiles).map((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return { file, text, sf: parse(text) }
    })
  }
  return cachedSources
}

let cachedScan = null
function scan() {
  if (cachedScan) return cachedScan
  const found = {}
  const problems = []
  for (const { file, text, sf } of sources()) {
    const { bindings, problems: p } = importBindings(file, text, sf)
    for (const msg of p) problems.push(`${rel(file)}: ${msg}`)
    // whatsapp.js resolves through its own import of getWhatsAppConfig.
    const calls = countCalls(text, bindings, sf)
    if (Object.keys(calls).length) found[rel(file)] = calls
  }
  cachedScan = { found, problems }
  return cachedScan
}

describe('WACONFIGFALLBACK.1 — every config-resolver caller has a decision', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  it('no namespace or unsupported dynamic import of the resolver modules', () => {
    expect(scan().problems).toEqual([])
  })

  it('the caller table is exact (files and call counts)', () => {
    const { found } = scan()
    const table = Object.fromEntries(Object.entries(CALLERS).map(([f, r]) => [f, r.calls]))
    expect(found).toEqual(table)
  })

  it('every row names a known decision and a reason', () => {
    for (const [file, row] of Object.entries(CALLERS)) {
      expect([file, DECISIONS.has(row.decision)]).toEqual([file, true])
      expect([file, row.why.length > 20]).toEqual([file, true])
    }
  })

  it('RESOLVING covers every exported whatsapp.js function that resolves a config', () => {
    const file = path.join(ROOT, 'src/lib/whatsapp.js')
    const text = fs.readFileSync(file, 'utf8')
    const sf = parse(text)
    const resolving = []
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const body = blankNonCode(text, sf).slice(st.getStart(sf), st.end)
        if (/(?<![\w$.])(resolveConfig|getWhatsAppConfig)\s*\(/.test(body)) resolving.push(st.name.text)
      }
    }
    expect(resolving.sort()).toEqual([...RESOLVING['src/lib/whatsapp']].sort())
  })
})

describe('WACONFIGFALLBACK.1 — the env tier is retired', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const RETIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID']

  // process.env.X or process.env['X'] — read from the AST, so a comment or an
  // error message naming the variable does not count.
  function envReads(text, sf = parse(text)) {
    const out = []
    const isProcessEnv = (e) => ts.isPropertyAccessExpression(e) && e.name.text === 'env'
      && ts.isIdentifier(e.expression) && e.expression.text === 'process'
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) out.push(node.name.text)
      if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) out.push(node.argumentExpression.text)
      // const { WHATSAPP_ACCESS_TOKEN } = process.env (renamed or not)
      if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName || el.name
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) out.push(key.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  it('no scanned source reads the global WhatsApp number env vars', () => {
    const readers = []
    for (const { file, text, sf } of sources()) {
      const names = envReads(text, sf).filter((n) => RETIRED.includes(n))
      if (names.length) readers.push(`${rel(file)}: ${names.join(', ')}`)
    }
    expect(readers).toEqual([])
  })

  it('the scanner sees both env read shapes (canary)', () => {
    expect(envReads("const a = process.env.WHATSAPP_ACCESS_TOKEN; const b = process.env['WHATSAPP_PHONE_NUMBER_ID']"))
      .toEqual(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'])
    expect(envReads('// process.env.WHATSAPP_ACCESS_TOKEN\nconst s = "process.env.WHATSAPP_ACCESS_TOKEN"')).toEqual([])
  })

  it('the scanner sees a destructured env read, renamed or not (canary)', () => {
    expect(envReads('const { WHATSAPP_ACCESS_TOKEN } = process.env')).toEqual(['WHATSAPP_ACCESS_TOKEN'])
    expect(envReads('const { WHATSAPP_PHONE_NUMBER_ID: pni, OTHER } = process.env')).toEqual(['WHATSAPP_PHONE_NUMBER_ID', 'OTHER'])
  })
})

describe('the scanner itself (canaries)', () => {
  const F = path.join(ROOT, 'src/app/api/x/route.js')

  it('follows aliases and counts calls, not mentions in comments or strings', () => {
    const text = [
      "import { sendTextMessage as sendWa, isWindowOpen } from '@/lib/whatsapp'",
      '// sendWa(to, t) in a comment',
      "const s = 'sendWa(x)'",
      'await sendWa(to, text, { locationId })',
      'const t = `${sendWa(a)}`',
    ].join('\n')
    const { bindings } = importBindings(F, text)
    expect([...bindings]).toEqual([['sendWa', 'sendTextMessage']])
    expect(countCalls(text, bindings)).toEqual({ sendTextMessage: 2 })
  })

  it('reads destructured dynamic imports and relative paths', () => {
    const text = "const { sendTemplateMessage } = await import('../../../lib/whatsapp.js')\nawait sendTemplateMessage(a)"
    const { bindings } = importBindings(path.join(ROOT, 'src/app/api/x/route.js'), text)
    expect(countCalls(text, bindings)).toEqual({ sendTemplateMessage: 1 })
  })

  it('fails a namespace import and an undestructured dynamic import', () => {
    expect(importBindings(F, "import * as wa from '@/lib/whatsapp'").problems).toHaveLength(1)
    expect(importBindings(F, "const wa = await import('@/lib/whatsapp')").problems).toHaveLength(1)
    expect(importBindings(F, "(await import('@/lib/whatsapp-config')).getWhatsAppConfig(x)").problems).toHaveLength(1)
  })

  it('fails a re-export of a resolver module (a barrel would hide its callers)', () => {
    expect(importBindings(F, "export { sendTextMessage as sendWa } from '@/lib/whatsapp'").problems).toHaveLength(1)
    expect(importBindings(F, "export * from '@/lib/whatsapp-config'").problems).toHaveLength(1)
    expect(importBindings(F, "export { thing } from '@/lib/other'").problems).toEqual([])
  })

  it('a method of the same name on another object is not a call of the import', () => {
    const text = "import { getTemplate } from '@/lib/whatsapp'\nawait checklists.getTemplate(db, id)"
    const { bindings } = importBindings(F, text)
    expect(countCalls(text, bindings)).toEqual({})
  })

  it('a JSX text that looks like a comment opener does not hide the call after it', () => {
    const text = "import { sendReaction } from '@/lib/whatsapp'\nconst el = <p>// note</p>\nsendReaction(a)"
    const { bindings } = importBindings(F, text)
    expect(countCalls(text, bindings)).toEqual({ sendReaction: 1 })
  })
})
