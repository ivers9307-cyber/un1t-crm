// landing-page-blocks — shared definitions for the block-based
// landing page (Phase 3b, mig 128).
//
// Blocks are the operator-orderable sections rendered between the
// top nav and the footer. Each block: { id, type, ...content }.
//
// SOURCE OF TRUTH for:
//   - Block type registry (BLOCK_TYPES) — list of types the
//     renderer + form know about.
//   - Per-type defaults — used to seed a new block when the
//     operator clicks "+ Add section", and to seed the whole
//     blocks array when no row has been saved yet.
//   - blocksOrDefault() — the function the welcome page uses to
//     decide whether to render the saved blocks or the default
//     starter blocks.
//
// The form, the API route, and the welcome page all import from
// here so adding a new block type is a single-file change.

import { z } from 'zod'

// Stable id helper — a uuid string. We keep ids in the saved JSON
// because @dnd-kit needs stable per-item keys for smooth drag
// animations across re-orders. Crypto.randomUUID() is browser-
// available and Node 16+; both surfaces (form + API + page) have it.
export function newBlockId() {
  // Prefer crypto.randomUUID where available (browser, modern Node).
  // Fallback for environments without it (older Node test runners).
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // Non-cryptographic fallback — only used if crypto is unavailable,
  // which today's runtimes don't hit but tests have historically been
  // patchy about polyfilling.
  return 'b_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ─────────────────────────────────────────────────────────────
// Per-type defaults — what a NEW block of each type starts with
// when the operator adds one from the "+ Add section" library.
// ─────────────────────────────────────────────────────────────

const HERO_DEFAULT = () => ({
  id:        newBlockId(),
  type:      'hero',
  eyebrow:   'Stillorgan, Dublin',
  headline:  'Train with intent.',
  subhead:   'Race with proof.',
  subtext:   'Coach-led strength & conditioning, built for racing. Beginners welcome — book a free 30-minute consultation below.',
  image_url: null,
  video_url: null,
})

const BOOKING_DEFAULT = () => ({
  id:   newBlockId(),
  type: 'booking',
  slug: 'consultation',
})

const PILLARS_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'pillars',
  items: [
    { number: '01', title: 'Coach-led, every session', body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught.", photo_url: null },
    { number: '02', title: 'Race-ready conditioning', body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes.", photo_url: null },
    { number: '03', title: 'A room that shows up',     body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.', photo_url: null },
  ],
})

const GALLERY_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'gallery',
  title: 'Inside the studio',
  items: [],
})

const EMBED_DEFAULT = () => ({
  id:      newBlockId(),
  type:    'embed',
  title:   'See it in motion',
  url:     '',
  caption: '',
})

const EVENT_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'event',
  slug:  '',
  title: 'Sign up',
})

const LEAD_FORM_DEFAULT = () => ({
  id:              newBlockId(),
  type:            'lead_form',
  heading:         'Join the founding members',
  subtext:         'Be first through the doors at UN1T Hatch Street. Leave your details and we’ll be in touch with founding-member offers before we open.',
  button_label:    'Join the waitlist',
  success_message: "You're on the list — we'll be in touch soon.",
  consent_label:   'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.',
  tag:             'hatch-founding-member',
  lead_source:     'hatch_launch',
})

const CLASS_FUNNEL_DEFAULT = () => ({
  id:                newBlockId(),
  type:              'class_funnel',
  heading:           'Your first 3 classes are free',
  subhead:           'Book your first class now — pop in your details to start.',
  consent_label:     "I'd like to hear from UN1T by email, SMS and WhatsApp.",
  class_done_title:  "You're being booked in 🎉",
  class_done_body:   "That's the first of your 3 free classes — watch for a WhatsApp confirming it. See you soon!",
  consult_done_title:"You're booked 🎉",
  consult_done_body: "You'll get a WhatsApp confirming your consultation if we have your number. See you soon!",
  consult_slug:      '', // operator picks a booking type; empty ⇒ no consult upsell
})

const STATS_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'stats',
  items: [
    { number: '200+', label: 'Members training every week' },
    { number: '6',    label: 'Race events hosted in 2025' },
    { number: '4.9',  label: 'Average member rating' },
  ],
})

const TESTIMONIAL_DEFAULT = () => ({
  id:     newBlockId(),
  type:   'testimonial',
  quote:  "The coaching is what separates UN1T from any gym I've trained at. I came in for a Hyrox PB. I stayed for the room.",
  author: 'Member, joined 2024',
})

const REVIEWS_DEFAULT = () => ({
  id:         newBlockId(),
  type:       'reviews',
  title:      'What our members say',
  min_rating: 4,        // 1–5; reviews below this are hidden
  speed:      'normal', // 'slow' | 'normal' | 'fast' marquee speed
  // `show_aggregate` (the "4.9 ★ · N Google reviews" header) was removed
  // with the Google Business Profile sync (mig 410); saved blocks may
  // still carry the key harmlessly (BlockBaseSchema is passthrough).
})

const VIDEO_TESTIMONIALS_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'video_testimonials',
  title: 'Hear from our members',
  // up to 3 × { video_url, poster_url, name } — added by the editor on upload
  items: [],
})

// Registry — single source of truth for "what types exist". Used by:
//   - Form's "+ Add section" picker
//   - Renderer's type-dispatch
//   - API schema validator
export const BLOCK_TYPES = [
  { type: 'hero',        label: 'Hero',         description: 'Headline + booking copy. Image or video background.', factory: HERO_DEFAULT },
  { type: 'booking',     label: 'Booking form', description: 'Embed the booking form for a chosen booking type.',    factory: BOOKING_DEFAULT },
  { type: 'event',       label: 'Event signup', description: 'Embed the full signup form for a chosen event.',        factory: EVENT_DEFAULT },
  { type: 'lead_form',   label: 'Lead form',    description: 'Waitlist / interest capture — name, email, phone + consent.',  factory: LEAD_FORM_DEFAULT },
  { type: 'class_funnel', label: 'Glofox Class Booking Funnel', description: 'Capture details, pick a live Glofox class, book. Optional free-consult upsell.', factory: CLASS_FUNNEL_DEFAULT },
  { type: 'pillars',     label: 'Pillars',      description: '3 value-prop tiles. Each can have a photo.',           factory: PILLARS_DEFAULT },
  { type: 'gallery',     label: 'Photo gallery',description: 'Grid of photos with optional captions.',                factory: GALLERY_DEFAULT },
  { type: 'embed',       label: 'Video embed',  description: 'YouTube or Instagram video embed.',                    factory: EMBED_DEFAULT },
  { type: 'stats',       label: 'Stats',        description: '3 big-number tiles for social proof.',                 factory: STATS_DEFAULT },
  { type: 'testimonial', label: 'Testimonial',  description: 'Single member quote + attribution.',                   factory: TESTIMONIAL_DEFAULT },
  { type: 'reviews',     label: 'Google reviews', description: 'Auto-scrolling marquee of your Google reviews.',       factory: REVIEWS_DEFAULT },
  { type: 'video_testimonials', label: 'Video testimonials', description: 'Up to 3 portrait member videos. Poster image, tap to play.', factory: VIDEO_TESTIMONIALS_DEFAULT },
]

const TYPE_BY_NAME = new Map(BLOCK_TYPES.map((t) => [t.type, t]))

export function newBlockOfType(type) {
  const meta = TYPE_BY_NAME.get(type)
  if (!meta) throw new Error(`Unknown block type: ${type}`)
  return meta.factory()
}

// Default starter set — what an operator sees the FIRST time they
// open the settings form, AND what the welcome page renders if no
// row exists yet. Matches the Phase 3a fixed render order so the
// public surface is identical to today's default.
export function defaultBlocks() {
  return [
    HERO_DEFAULT(),
    BOOKING_DEFAULT(),
    PILLARS_DEFAULT(),
    STATS_DEFAULT(),
    TESTIMONIAL_DEFAULT(),
  ]
}

// Welcome page consumer — pick the saved blocks if present and
// non-empty, else seed from defaults. Defensive against bad shapes
// (non-array, non-object items) so a corrupted row never 500s the
// public marketing page — we'd rather render the default than
// crash the funnel.
export function blocksOrDefault(savedBlocks) {
  if (!Array.isArray(savedBlocks) || savedBlocks.length === 0) return defaultBlocks()
  const cleaned = savedBlocks.filter(
    (b) => b && typeof b === 'object' && typeof b.type === 'string' && TYPE_BY_NAME.has(b.type)
  )
  return cleaned.length > 0 ? cleaned : defaultBlocks()
}

// ─────────────────────────────────────────────────────────────
// Validation — Zod schema used by the API PUT route to validate
// the incoming blocks payload. Strict-mode disabled here because
// each block has type-specific fields and a discriminated union
// would balloon the payload size in the route. We trust the form
// to send sane shapes; the renderer's blocksOrDefault() filter is
// the last line of defence.
// ─────────────────────────────────────────────────────────────

const BlockBaseSchema = z.object({
  id:   z.string().min(1).max(64),
  type: z.enum(BLOCK_TYPES.map((t) => t.type)),
}).passthrough() // allow any per-type fields, validated at render

export const BlocksArraySchema = z.array(BlockBaseSchema).max(40)

// ─────────────────────────────────────────────────────────────
// Primary conversion target — derived from a page's own blocks.
// Priority: explicit lead capture > booking > event signup.
// Returns { href, label } or null when the page has no funnel
// block (the header/hero then render no CTA rather than a dead
// anchor). Used by the public studio page + the dev preview.
// ─────────────────────────────────────────────────────────────
export function primaryCta(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const leadForm = list.find((b) => b && b.type === 'lead_form')
  if (leadForm) {
    return {
      href: '#waitlist',
      label: (leadForm.button_label && leadForm.button_label.trim()) || 'Join the waitlist',
    }
  }
  if (list.some((b) => b && b.type === 'class_funnel')) {
    return { href: '#start', label: 'Claim 3 free classes' }
  }
  if (list.some((b) => b && b.type === 'booking')) {
    return { href: '#book', label: 'Book a free consult' }
  }
  const event = list.find((b) => b && b.type === 'event')
  if (event) {
    return {
      href: `#event-${event.slug || 'signup'}`,
      label: (event.title && event.title.trim()) || 'Sign up',
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Path-based immutable update — used by the LP3c.2 inline editor
// to apply edits like ['items', 2, 'title'] to a block.
//
// Path = array of string keys (object) or number indices (array).
// Empty path = replace the whole obj with value. Returns a new
// tree, never mutates the input.
// ─────────────────────────────────────────────────────────────
export function setByPath(obj, path, value) {
  if (!Array.isArray(path) || path.length === 0) return value
  const [head, ...rest] = path
  if (typeof head === 'number') {
    const arr = Array.isArray(obj) ? obj.slice() : []
    arr[head] = setByPath(arr[head], rest, value)
    return arr
  }
  return { ...(obj || {}), [head]: setByPath(obj?.[head], rest, value) }
}
