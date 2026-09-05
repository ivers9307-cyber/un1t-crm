// MAIL-ARCH.2 — mail-display.js is now a BARREL, kept for one release.
//
// The ~870-line pure module the Mail surface grew since MAIL-TRIAL.B mixed
// three concerns, and its archive/needs-reply vocabulary was mirrored by hand
// into mobile/lib/email-tickets.js, where it drifted. It is split three ways,
// beside this file:
//
//   ./mail-vocabulary.js   the VOCABULARY — archive / needs-reply / unread /
//                          spam predicates and the view list (those live in
//                          shared/mail-vocabulary.js, consumed by web AND
//                          mobile), plus the web-only list URL, keyboard
//                          helpers and row / flat-thread labels.
//   ./mail-preferences.js  the PREFERENCES — density, reader mode, compose
//                          mode, the Expand memory (one storage factory), and
//                          the dock-mode rules (Esc ladders, slot yielding,
//                          frame heights).
//   ./reply-drafts.js      the REPLY-DRAFT store.
//
// Every existing `from './mail-display'` / `@/components/mail/mail-display`
// import keeps working through this barrel with zero behaviour change; new
// code should import the split module directly, and the barrel goes next
// release. The export surfaces of the three are disjoint, so `export *` can
// never be ambiguous — mail-display.test.js still imports everything from
// here, and would fail on a collision.
export * from './mail-vocabulary'
export * from './mail-preferences'
export * from './reply-drafts'
