// MAIL-ARCH.2 — the Mail surface's PERSISTED PREFERENCES and the dock-mode
// rules, split out of mail-display.js. Pure and DOM-free apart from
// `window.localStorage` / `window.matchMedia`, every access of which is
// guarded the same way.
//
// 🔴 EVERY STORAGE ACCESS IS WRAPPED. localStorage is not merely absent during
// SSR — it THROWS on access in a private window and under a "block site data"
// policy, so an unguarded read takes the whole surface down over a display
// preference. The two factories below are the ONE place that posture is
// written; density, reader mode, compose mode and the Expand memory are minted
// from them rather than each re-typing the try/catch. Each preference keeps
// its OWN key and its OWN option list (never shared between two prefs, so one
// can never overwrite another), which is why they are separate instances of
// one factory rather than one store.

/**
 * A persisted choice from a fixed option list: `read()` returns the stored
 * value when it is one of `options`, else `fallback` — SSR-safe, throw-safe,
 * and a hand-planted or corrupt value fails safe to the default rather than to
 * a state the surface cannot render. `write()` REFUSES anything outside
 * `options` (so a transient state like the dock's `min` cannot reach disk even
 * through a future caller that forgets the rule) and swallows a storage that
 * cannot save: a preference that could not be saved resets next visit, and is
 * never worth an error on screen.
 */
function choicePreference(key, options, fallback) {
  return {
    read() {
      try {
        if (typeof window === 'undefined') return fallback
        const stored = window.localStorage.getItem(key)
        return options.includes(stored) ? stored : fallback
      } catch {
        return fallback
      }
    },
    write(value) {
      if (!options.includes(value)) return
      try {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(key, value)
      } catch {
        // A preference that could not be saved is a preference that resets next
        // visit. Never worth an error on screen.
      }
    },
  }
}

/**
 * A persisted boolean, stored as '1'/'0'. Same storage posture as the choice
 * factory — try/caught BOTH directions, garbage reads as `false`.
 */
function flagPreference(key) {
  return {
    read() {
      try {
        if (typeof window === 'undefined') return false
        return window.localStorage.getItem(key) === '1'
      } catch {
        return false
      }
    },
    write(value) {
      try {
        if (typeof window === 'undefined') return
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch {
        // Same posture as choicePreference's write.
      }
    },
  }
}

/* ─────────────────────────── row density ─────────────────────────── */

/**
 * MAIL-DENSITY.1 — how much of a conversation one row shows.
 *
 * `compact` is one line: sender, subject, preview and date, ~31px. `comfortable`
 * is the same line with the preview given room to breathe. The toggle exists
 * because the right answer differs between triaging a morning's mail and
 * reading one thread, and it is two lines of state to keep.
 */
export const DENSITIES = ['compact', 'comfortable']
// MAIL-REFINE.1 — the approved subject-first two-line row is the
// 'comfortable' layout, and it is what Richard approved as THE row, so it is
// the default; 'compact' survives as the one-line toggle for dense triage.
export const DEFAULT_DENSITY = 'comfortable'
export const MAIL_DENSITY_KEY = 'un1t.mail.density'

const density = choicePreference(MAIL_DENSITY_KEY, DENSITIES, DEFAULT_DENSITY)

/** The stored density, or the default. */
export const readDensity = density.read
/** Persist a density. Silently ignores anything that is not one. */
export const writeDensity = density.write

/* ── MAIL-DOCK.1 — the docked reader ───────────────────────────────── */
//
// The split pane is gone: a selected conversation opens as a CARD over the
// full-width list. The card has three modes and this module owns every
// branchable decision about them, so the components stay thin and the rules
// stay unit-tested:
//
//   dock — the default: a Gmail-compose-shaped card, bottom-right.
//   full — the SAME card at near-fullscreen (the takeover), via ⤢.
//   min  — only the title bar remains. A transient state of an OPEN card:
//          it is NEVER persisted, and a close from min hands the next open
//          back to the real mode underneath it.
//
// 🔴 MODE PERSISTS PER USER ('dock'|'full' only), validated on read exactly
// like density: an operator who reads full-screen gets full-screen next time,
// and a hand-planted or corrupt value fails safe to 'dock' rather than to a
// mode the surface cannot render. The write REFUSES anything that is not one
// of the two persistable modes, so 'min' cannot reach disk even through a
// future caller that forgets the rule.

/** The two persistable modes. `min` is deliberately not in this list. */
export const READER_MODES = ['dock', 'full']
export const READER_MODE_MIN = 'min'
export const DEFAULT_READER_MODE = 'dock'
export const READER_MODE_KEY = 'un1t.mail.reader-mode'

const readerMode = choicePreference(READER_MODE_KEY, READER_MODES, DEFAULT_READER_MODE)

/** The stored mode, or the default — validated, SSR-safe, throw-safe. */
export const readReaderMode = readerMode.read
/** Persist a mode. Silently refuses `min` and anything else unrecognised. */
export const writeReaderMode = readerMode.write

/**
 * The Esc ladder: `full → dock`, `dock → close`, `min → close`.
 *
 * Returns the mode Esc steps DOWN to, or null when Esc means close
 * (clearSelection). Anything unrecognised closes too — Esc is a dismissal
 * gesture, and an unknown mode must dismiss rather than dead-end.
 */
export function escTarget(mode) {
  return mode === 'full' ? 'dock' : null
}

/**
 * Where a minimised card restores to, and what a close from `min` resets the
 * next open to. Only a persistable mode is a legitimate answer — `min`
 * restoring to `min` would be a card that can never come back.
 */
export function restoreTarget(prevMode) {
  return READER_MODES.includes(prevMode) ? prevMode : DEFAULT_READER_MODE
}

/* ── MAIL-DOCK.1 — message-frame heights & the Expand memory ───────── */
//
// The sandboxed email iframe cannot report its own height (no scripts — see
// TicketThread's EmailFrame header), so it gets a fixed box. That box used to
// be one size for one layout; the dock gives the thread two very different
// windows, so the height is now CONTEXT-SIZED via a `frameSize` prop threaded
// MailSurface → MailThread → TicketThread → EmailFrame. The defaults preserve
// the pre-dock values for any render without the prop — the ticket surface's
// tests pin those, and a caller that never heard of the dock must not move.
const FRAME_HEIGHTS = {
  dock: { collapsed: 'h-[38vh]', expanded: 'h-[52vh]' },
  full: { collapsed: 'h-[65vh]', expanded: 'h-[80vh]' },
}
const DEFAULT_FRAME_HEIGHTS = { collapsed: 'h-[420px]', expanded: 'h-[70vh]' }

/** The frame's Tailwind height class. Unknown/absent frameSize → the defaults. */
export function frameHeightClass(frameSize, expanded) {
  const sizes = FRAME_HEIGHTS[frameSize] || DEFAULT_FRAME_HEIGHTS
  return expanded ? sizes.expanded : sizes.collapsed
}

// The operator's Expand choice persists ('1'/'0'): somebody who always wants
// the taller frame should not re-click it on every message.
export const BODY_EXPANDED_KEY = 'un1t.mail.body-expanded'

const bodyExpanded = flagPreference(BODY_EXPANDED_KEY)

export const readBodyExpanded = bodyExpanded.read
export const writeBodyExpanded = bodyExpanded.write

/* ── MAIL-DOCK.2 — compose joins the dock ──────────────────────────── */
//
// The new-email composer takes the SAME three shapes as the reader — dock,
// full, min — in MAIL-DOCK.1's exact vocabulary, and this block owns every
// branchable decision about them so ComposeDock stays as thin as MailDock.
//
// TWO RULES SET IT APART FROM THE READER, both because a compose card holds
// words nobody else has a copy of:
//   • 🔴 THE ESC LADDER IS DIRTY-AWARE. Esc on a dirty compose MINIMISES,
//     never discards (full → dock → min, and min is the floor); only ✕ —
//     with TicketCompose's own confirm — can throw a typed draft away. A
//     pristine compose closes on Esc from any shape, exactly like the reader.
//   • ONE BOTTOM-RIGHT SLOT. Compose and the reader share the corner: at
//     most one of them is a CARD at a time. Opening/restoring one card
//     auto-minimises the other (its bar survives; state stays mounted);
//     closing either restores nothing automatically.
//
// Mode persists per user under its OWN key ('dock'|'full' only, min never
// stored) — a second instance of the same factory as readReaderMode, never
// the same instance, so the two preferences can never overwrite each other.

/** The two persistable compose modes. `min` is deliberately not in this list. */
export const COMPOSE_MODES = ['dock', 'full']
export const COMPOSE_MODE_MIN = 'min'
export const DEFAULT_COMPOSE_MODE = 'dock'
export const COMPOSE_MODE_KEY = 'un1t.mail.compose-mode'

const composeMode = choicePreference(COMPOSE_MODE_KEY, COMPOSE_MODES, DEFAULT_COMPOSE_MODE)

/** The stored compose mode, or the default — validated, SSR-safe, throw-safe. */
export const readComposeMode = composeMode.read
/** Persist a compose mode. Silently refuses `min` and anything unrecognised. */
export const writeComposeMode = composeMode.write

/**
 * Where a minimised compose restores to, and what a close resets the next
 * open to. Only a persistable mode is a legitimate answer — min restoring to
 * min would be a card that can never come back.
 */
export function composeRestoreTarget(prevMode) {
  return COMPOSE_MODES.includes(prevMode) ? prevMode : DEFAULT_COMPOSE_MODE
}

/**
 * The compose Esc ladder — dirty-aware, which is the whole point.
 *
 * Dirty: `full → dock → min`, and min answers ITSELF (the bar is the floor —
 * the caller compares and does nothing). Pristine: null from every shape,
 * meaning requestClose — which closes silently, because the same dirty flag
 * that routed here is the one TicketCompose's confirm checks.
 *
 * An UNKNOWN mode fails toward the draft: dirty parks at min rather than
 * closing, because the cost of being wrong is somebody's typed email.
 */
export function composeEscTarget(mode, dirty) {
  if (!dirty) return null
  if (mode === 'full') return 'dock'
  return COMPOSE_MODE_MIN
}

/**
 * 🔴 Does the compose window own the keyboard? True while the CARD is open
 * (dock or full — a stray `j` must not archive under a composer, unchanged
 * posture from the modal days); false while it is MINIMISED, which is what
 * lets j/k/e flow to the reader again while the draft waits in the bar.
 * The Modal variant (below md) never reaches `min`, so this answers true
 * for it exactly as the old bare `composeOpen` guard did.
 */
export function composeBlocksKeys(composeOpen, composeMode) {
  return !!composeOpen && composeMode !== COMPOSE_MODE_MIN
}

/**
 * One bottom-right slot: the mode the OTHER occupant should step to when a
 * card opens or restores — `min` when it is currently a card (dock or full),
 * null when nothing need change (absent, or already a bar). Used in BOTH
 * directions: opening compose minimises the reader, restoring the reader
 * minimises compose.
 */
export function slotYieldTarget(otherOpen, otherMode) {
  if (!otherOpen) return null
  if (otherMode === COMPOSE_MODE_MIN) return null
  return COMPOSE_MODE_MIN
}

/**
 * What one occupant currently shows as at md+, so the other can offset its
 * own bar around it: 'none' (closed — or FULL, which is an inset-4 overlay
 * and holds no bottom-right ground), 'bar' (minimised), 'card' (docked).
 */
export function slotOccupancy(open, mode) {
  if (!open) return 'none'
  if (mode === COMPOSE_MODE_MIN) return 'bar'
  if (mode === 'full') return 'none'
  return 'card'
}

/** The compose title bar's text: the typed subject, live, else "New email". */
export function composeCardTitle(subject) {
  const s = typeof subject === 'string' ? subject.trim() : ''
  return s || 'New email'
}

/**
 * Which composer shell a FRESH open gets: the dock machinery at md+ (768px,
 * Tailwind's md — the same breakpoint every md: class in MailDock answers
 * to), the full-screen Modal below it, byte-for-byte today's mobile
 * behaviour. Decided AT OPEN and frozen for that compose session (see
 * MailSurface), so a mid-compose window resize can never remount the form
 * and lose the draft. Fails safe to the Modal: jsdom, SSR and a hostile
 * matchMedia all answer false, which is the path that existed before.
 */
export function isMdUp() {
  try {
    if (typeof window === 'undefined') return false
    return !!window.matchMedia?.('(min-width: 768px)')?.matches
  } catch {
    return false
  }
}
