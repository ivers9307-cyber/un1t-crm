// SHELLY-UI.2 — the Zod vocabulary for every /api/shelly/* route.
//
// WHY THIS MODULE IS IMPORT-LIGHT. It has two very different consumers: the
// routes (Node runtime, service-role Supabase) AND src/lib/openapi.js, which
// is rendered by /api/openapi.json and /api-docs. So it imports zod, the
// shared window vocabulary and uuidLike — and NOTHING that reaches Supabase,
// next/server, the Shelly client or an env var. A server-only import here
// would drag the whole backend into the docs bundle and make an OpenAPI
// render able to fail on a missing env var, on a page whose only job is to
// describe shapes. Keep it that way when adding to this file.
//
// WINDOWS ARE THE SONOS ONES. ShellyWindow is WindowBase from
// @/lib/schedule/windows with the same-boundary rule refined on — not a
// re-typed copy. Sonos .extend()s that base (volume + favorite_id); Shelly
// uses it bare, so it refines directly. Two hand-written window shapes is how
// the two surfaces would eventually disagree about what an empty window is,
// and an on === off window is read by the engine as a 24-hour always-on span
// (the trap the Tapo build hit).
//
// WHY set_at IS REQUIRED ON ShellyOverride. overrideKey() in
// src/lib/shelly/plan.js is 'ov:' + (set_at || `${until}:${state}`) — set_at
// IS the exactly-once key, and the fallback when it is missing COLLIDES: two
// overrides with the same until and state mint the same key, so the second
// one reads as already applied and NEVER FIRES. The planner cannot tell a
// re-issued override from a repeat of the old one without it. Same reason
// `state` is a strict 'on'|'off' enum and not a coerced boolean:
// isLiveOverride treats anything else as "not live", so a jsonb `true` —
// which plainly means ON — would leave the device on its schedule instead.
// This schema is CONSTRUCTED and parsed by the toggle route before the write
// (it never validates raw request input), which is what makes an unwritable
// bad shape a guarantee rather than a hope.
//
// WHY device_id IS LOWERCASED HERE. mig 562's CHECK is
// `device_id = lower(device_id) AND device_id ~ '^[0-9a-z_-]{4,64}$'`, and
// (device_id, channel) is UNIQUE across the estate — so an upper-case id
// would 23514 at insert AND, worse, would dodge the uniqueness check that
// stops one relay being adopted at two locations. Normalising at the edge
// makes the DB constraint a backstop rather than the first line of defence.

import { z } from 'zod'
import { WindowBase, NOT_SAME_BOUNDARY, windowsOverlapIssue } from '@/lib/schedule/windows'
import { uuidLike } from '@/lib/schemas'

// A Shelly Cloud device id is the device's MAC as lowercase hex. Deliberately
// NARROWER than mig 562's column CHECK (`^[0-9a-z_-]{4,64}$`): the DB shape is
// permissive enough to survive a future Shelly id format, while everything the
// cloud API has ever handed us is hex. The `i` flag is what lets a pasted
// upper-case MAC through to the .transform() below rather than 400-ing on it.
export const SHELLY_DEVICE_ID = /^[0-9a-f]{6,32}$/i

// Per-device schedule cap. Matches the Sonos schedules route's own 16, and the
// whole array is re-validated on every PATCH, so this bounds the stored row.
export const MAX_FIXED_WINDOWS = 16

// Applied by the ADOPT route (count the location's rows before inserting), not
// by a schema — nothing in a single request body can express it. It exists to
// keep one location's reconcile tick inside its budget.
export const MAX_DEVICES_PER_LOCATION = 100

// Applied by the TOGGLE route to `until`: an override further out than this is
// a schedule, not a manual nudge, and a year-long "off" is indistinguishable
// from a broken plug. Not a schema bound because it is relative to the
// request's own clock, which a static schema cannot see.
export const MAX_OVERRIDE_HOURS = 48

// Applied by the CONNECTION route, and ONLY when a key is actually supplied
// (see ShellyConnectionPut — a blank key on re-paste keeps the stored one, so
// a .min() here would make "change only the server" impossible). mig 562's
// key_hint CHECK needs >= 4 characters; 16 is the realistic floor for a real
// Shelly Cloud auth key, and it is what stops a typo being stored as a
// credential that then fails forever with an unreadable cloud error.
export const MIN_AUTH_KEY_LENGTH = 16

// Bound on class-mode lead/lag. Three hours either side of a class is already
// well past "warm the room up"; beyond it a plug is effectively always on.
export const MAX_CLASS_LEAD_LAG_MIN = 180

// The engine's own fallbacks, from src/lib/schedule/desired-state.js
// (DEFAULT_LEAD_MIN / DEFAULT_LAG_MIN) and mig 562's class_rule column comment
// ("defaults 15/10"). They are RE-TYPED, not imported, because this module must
// stay import-light (see the header) — desired-state.js does not export them
// and pulls in the timezone helpers. schemas.test.js pins the mirror by running
// the real resolveDayWindows over both an absent class_rule and a
// default-parsed one and asserting identical windows, so a drift in either file
// fails the suite instead of silently shifting every class-mode plug by 15
// minutes.
export const DEFAULT_LEAD_MIN = 15
export const DEFAULT_LAG_MIN = 10

// One recurring on/off window. The refine is LAST and applies to the whole
// object, so the result cannot be .extend()ed afterwards — Shelly never needs
// to, which is exactly why WindowBase carries no refine of its own.
export const ShellyWindow = WindowBase.refine(NOT_SAME_BOUNDARY.check, {
  message: NOT_SAME_BOUNDARY.message,
})

// schedule_mode 'class' follows the LOCATION-WIDE timetable: on `lead_min`
// before the day's first class starts, off `lag_min` after the last one ends
// (resolveDayWindows). Those two field names are the only thing the engine
// reads out of class_rule — anything else stored here is inert.
//
// The defaults MATCH THE ENGINE rather than being 0: mig 562 defaults the
// column to '{}', so a device switched to class mode without anyone opening
// the rule already runs 15/10. Defaulting to 0 here would mean a PATCH that
// merely touched class_rule silently deleted the pre-heat — no error, nothing
// in the UI to explain why the room went cold. That is the "silent wrong
// value" shape. An operator who genuinely wants no lead sends 0 and gets 0.
export const ShellyClassRule = z.object({
  lead_min: z.number().int().min(0).max(MAX_CLASS_LEAD_LAG_MIN).default(DEFAULT_LEAD_MIN),
  lag_min: z.number().int().min(0).max(MAX_CLASS_LEAD_LAG_MIN).default(DEFAULT_LAG_MIN),
})

// Connect / re-paste. `auth_key` is OPTIONAL and has NO minimum: an operator
// re-pasting the server host of an already-connected studio must not have to
// re-type a credential the UI never shows them (it renders "••••abcd" from
// key_hint). Absent or blank => the route keeps the stored key; supplied =>
// the route applies MIN_AUTH_KEY_LENGTH. The 512 cap is a body-size guard, not
// a format claim — the key is never parsed, only sent.
export const ShellyConnectionPut = z.object({
  server: z.string().trim().min(1).max(200),
  auth_key: z.string().max(512).optional(),
})

// Adopt one relay CHANNEL (a Pro 4PM adopts as up to four rows sharing a
// device_id). channel is bounded 0..7 — tighter than mig 562's CHECK (0..15)
// on purpose: nothing Shelly ships today has more than eight relays, and the
// narrower bound turns a fat-fingered channel into a 400 instead of a row that
// can never match a real switch. `name` is optional because discovery supplies
// the cloud account's own name when the operator doesn't override it.
export const ShellyAdoptBody = z.object({
  device_id: z.string().trim().regex(SHELLY_DEVICE_ID).transform((s) => s.toLowerCase()),
  channel: z.number().int().min(0).max(7).default(0),
  name: z.string().trim().min(1).max(80).optional(),
})

// PATCH one adopted device. Every field optional, `.strict()` so a typo'd key
// is a 400 rather than a silently-ignored setting, and the closing refine turns
// an empty body into 'Nothing to update' instead of a no-op UPDATE that reports
// success.
//
// `fixed_windows` carries the cross-item overlap check as well as the
// per-window one: planDeviceAction resolves an overlap earliest-wins, so the
// later window in a clashing pair is silently NEVER applied — no error, no log
// line, no way for an operator to tell why a window does nothing. Refusing the
// save is the only place that can surface.
export const ShellyDevicePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  schedule_mode: z.enum(['none', 'fixed', 'class']).optional(),
  fixed_windows: z.array(ShellyWindow).max(MAX_FIXED_WINDOWS).superRefine(windowsOverlapIssue).optional(),
  class_rule: ShellyClassRule.optional(),
  // Cosmetic room label in v1 — class mode follows the location-wide timetable
  // (class_occurrences has no zone column).
  zone: z.string().trim().min(1).max(40).optional(),
})
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

// Manual toggle. 'auto' means "clear the override and re-run the schedule
// now", which is why `until` is optional — it is meaningless without a state
// to hold. The route bounds `until` by MAX_OVERRIDE_HOURS.
export const ShellyToggleBody = z.object({
  state: z.enum(['on', 'off', 'auto']),
  until: z.string().datetime().optional(),
})

// GET .../energy?days=N. Read PER DEVICE (<= 31 rows at 30 days) — a
// location-wide 30-day read is ~1,500 rows and blows the PostgREST 1k cap.
//
// ROUTE OBLIGATION: URLSearchParams.get() returns null for an absent param and
// z.coerce.number() turns null into 0, which fails min(1). Pass
// `{ days: searchParams.get('days') ?? undefined }` so an absent param takes
// the default instead of 400-ing.
export const ShellyEnergyQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

// The shape written to shelly_devices.override. CONSTRUCTED by the toggle route
// and parsed before the write — it never validates request input, so `state`
// outside 'on'|'off' and a missing `set_at` are unwritable. See the header for
// why both of those are load-bearing rather than tidy.
export const ShellyOverride = z.object({
  state: z.enum(['on', 'off']),
  until: z.string().datetime(),
  set_by: uuidLike,
  set_at: z.string().datetime(),
})
