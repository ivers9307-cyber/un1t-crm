// Brand tokens for JS color values (SVG stroke/fill, Ionicons `color`,
// inline `style` props) where a NativeWind class string can't be used.
// Keep in sync with mobile/tailwind.config.js.
//
// P4b (Repset reskin, 2026-08-17): names stay Afterglow vocabulary,
// values are Repset — see the token comment block in tailwind.config.js.

import { accentFromSessions as afterglowAccentFromSessions, hardestZone } from 'shared/accent'

export const IRON_BG = '#131316'
export const IRON_SURFACE = '#1C1C21'
export const IRON_RAISED = '#24242A'
export const IRON_HAIRLINE = '#2A2A31'
export const CHALK = '#F1EEE7'
export const CHALK_2 = '#B3B2AC'
export const CHALK_3 = '#727170'

// Resting (unlit) accent — Repset bone at the same ~89% per-channel
// emphasis the Afterglow pearl (#D9D5CC) had to its chalk (#F4F1EA).
// Quiet states rest here; they NEVER take volt and are never error-tinted.
export const PEARL = '#D6D2C9'

// THE earned accent — the volt-green of the app mark
// (public/repset-mark.svg). Lit ONLY when earned.
export const VOLT = '#D6FF3D'

export { hardestZone }

// P4b member-layer override of the Afterglow earned-accent rule.
// shared/accent.js still speaks Afterglow (lit = zone-hued, resting =
// Afterglow pearl) and shared/ is mirror-locked with champ-app
// (CLAUDE.md sync rule), so the Repset collapse lives HERE, not there:
// every LIT state becomes volt; quiet weeks rest on the Repset pearl.
// `zone` still reports WHICH zone earned it — zone DATA colours
// (charts, bars, strips) keep shared/zone-colors untouched.
export function accentFromSessions(sessions, nowMs) {
  const a = afterglowAccentFromSessions(sessions, nowMs)
  return { ...a, color: a.lit ? VOLT : PEARL }
}
