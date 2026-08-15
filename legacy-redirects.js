// PRUNE.1 — config-level redirects replacing the deleted legacy stub
// pages (the /email, /whatsapp, /segments trees; the /cars, /cars/new,
// /cars/pending indexes; /contacts/duplicates; and the /communications
// legacy stub set). Each rule reproduces the redirect the deleted stub
// page performed, 1:1 — old URLs live on in browser history, bookmarks
// and already-delivered notification emails, so no deleted route may
// 404. 307s on purpose, matching the SIDEBAR-IA.1 convention: the
// browser URL updates to the canonical path so active states light up,
// and the alias stays cheap to re-point as the IA evolves.
//
// Keep this list SHRINKING, never growing sideways: a future route move
// adds entries here ONLY in the same change that deletes the old route
// directory (and adds the route to the deletion list in
// src/lib/legacy-redirects.test.js — that test enforces 1:1 coverage).
// Order matters: literal segments (new, templates) before :id rules on
// the same prefix, and the /email + /whatsapp wildcards LAST.
//
// Fidelity notes vs the deleted stubs:
// - /email/templates/:id and /whatsapp/templates/:id map to the NEW
//   editor homes (the editors moved in PRUNE.1d); ':id' also matches
//   the literal 'new', which lands on the right page anyway.
// - /email/campaigns/:id preserved '?edit=1' via query passthrough
//   (next.config redirects forward unmatched query params by default).
// - /communications/instagram used to append ch=ig when forwarding a
//   ?c= param; a `has` rule now covers that case (matched requests keep
//   both ?c= and ch=ig — Next passes the unmatched query through and
//   merges it with the destination's own query), so the channel
//   pre-filter is preserved whenever ?c= is present. The plain fallback
//   rule below still covers the no-?c= case.
// - /whatsapp/broadcasts used to double-hop via /communications/
//   broadcasts; flattened straight to /communications/sent.
module.exports = [
  // /email tree
  { source: '/email/templates/:id', destination: '/communications/templates/email/:id', permanent: false },
  { source: '/email/templates', destination: '/communications/templates?channel=email', permanent: false },
  { source: '/email/sequences/new', destination: '/automations', permanent: false },
  { source: '/email/sequences/:id', destination: '/automations/:id', permanent: false },
  { source: '/email/sequences', destination: '/automations', permanent: false },
  { source: '/email/campaigns/new', destination: '/communications/send', permanent: false },
  { source: '/email/campaigns/:id', destination: '/communications/sent/email/:id', permanent: false },
  { source: '/email', destination: '/communications', permanent: false },
  // /whatsapp tree
  { source: '/whatsapp/templates/:id', destination: '/communications/templates/whatsapp/:id', permanent: false },
  { source: '/whatsapp/templates', destination: '/communications/templates?channel=whatsapp', permanent: false },
  { source: '/whatsapp/broadcasts/new', destination: '/communications/send', permanent: false },
  { source: '/whatsapp/broadcasts/:id', destination: '/communications/sent/whatsapp/:id', permanent: false },
  { source: '/whatsapp/broadcasts', destination: '/communications/sent', permanent: false },
  { source: '/whatsapp/inbox', destination: '/communications/inbox', permanent: false },
  { source: '/whatsapp', destination: '/communications', permanent: false },
  // singles
  { source: '/segments', destination: '/communications/segments', permanent: false },
  { source: '/cars', destination: '/cars/active', permanent: false },
  { source: '/cars/new', destination: '/cars/active', permanent: false },
  { source: '/cars/pending', destination: '/cars/active', permanent: false },
  { source: '/contacts/duplicates', destination: '/contacts?tab=duplicates', permanent: false },
  // HUBS.2b — Hyrox planner moved out of /admin into the Members hub.
  { source: '/admin/hyrox', destination: '/hyrox', permanent: false },
  // /communications legacy stub set
  { source: '/communications/broadcasts', destination: '/communications/sent', permanent: false },
  { source: '/communications/campaigns', destination: '/communications/sent', permanent: false },
  { source: '/communications/instagram', has: [{ type: 'query', key: 'c' }], destination: '/communications/inbox?ch=ig', permanent: false },
  { source: '/communications/instagram', destination: '/communications/inbox', permanent: false },
  { source: '/communications/sequences/templates', destination: '/automations/templates', permanent: false },
  { source: '/communications/sequences/:id', destination: '/automations/:id', permanent: false },
  { source: '/communications/sequences', destination: '/automations', permanent: false },
  { source: '/communications/sms/broadcasts/new', destination: '/communications/send', permanent: false },
  { source: '/communications/sms/broadcasts/:id', destination: '/communications/sent/sms/:id', permanent: false },
  { source: '/communications/sms/broadcasts', destination: '/communications/sent', permanent: false },
  // catch-alls for anything unenumerated under the retired trees — LAST
  { source: '/email/:path*', destination: '/communications', permanent: false },
  { source: '/whatsapp/:path*', destination: '/communications', permanent: false },
]
