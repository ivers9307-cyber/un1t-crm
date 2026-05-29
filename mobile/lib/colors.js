// MOB-UI — single source of truth for raw colour VALUES used in React
// Native props that can't take a NativeWind class: Ionicons `color=`,
// `ActivityIndicator color=`, `placeholderTextColor=`, and inline
// `style={{ ... }}` objects. For className styling keep using the
// un1t-* / stage-* Tailwind tokens; this module is the hex mirror for
// the prop contexts, so the ~265 scattered hex literals can resolve to
// one place instead of drifting.
//
// `un1t` MUST match mobile/tailwind.config.js — guarded by colors.test.js
// so the JS palette can't silently diverge from the Tailwind tokens.
// `stage` mirrors the web pipeline palette (un1t-crm/tailwind.config.js
// → stage.*) for deal/lead status chips rendered on mobile.
//
// Usage:
//   import { colors } from '../../lib/colors'
//   <Ionicons name="chevron-back" color={colors.text} />
//   <ActivityIndicator color={colors.muted} />
//   <TextInput placeholderTextColor={colors.muted} />

export const un1t = Object.freeze({
  bg: '#FFFFFF',       // page background
  surface: '#F7F8FA',  // cards / raised
  border: '#E2E5E9',   // hairlines
  muted: '#94A3B8',    // secondary text / inactive icons
  subtle: '#64748B',   // tertiary text
  text: '#111827',     // primary text / active icons
  accent: '#1E293B',
})

// Pipeline / lead status palette (mirrors web tailwind stage.*).
export const stage = Object.freeze({
  new: '#3B82F6',
  social: '#8B5CF6',
  trial: '#10B981',
  conversion: '#F59E0B',
  followup: '#EF4444',
  member: '#059669',
  cold: '#9CA3AF',
  lost: '#DC2626',
  returning: '#6366F1',
})

// A few cross-cutting semantic values that recur in props but aren't
// part of either token set (kept here so they're named, not magic hex).
export const semantic = Object.freeze({
  white: '#FFFFFF',
  black: '#000000',
  danger: '#DC2626',
  warning: '#F59E0B',
  success: '#059669',
})

// Flat convenience export: the un1t tokens at top level + the grouped
// palettes. Most call sites only need `colors.text` / `colors.muted`.
export const colors = Object.freeze({ ...un1t, stage, semantic })

export default colors
