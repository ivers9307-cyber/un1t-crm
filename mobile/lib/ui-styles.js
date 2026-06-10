// MOB-UI.2 — pure styling helpers for the mobile components/ui primitives.
//
// Kept free of any react-native / nativewind import so they run under the
// repo's Node test env (the web vitest picks up mobile/lib/**/*.test.js).
// The .jsx primitives in mobile/components/ui are thin shells that call
// these for their NativeWind className strings. Mirrors the web
// src/components/ui/styles.js pattern. Tokens are the intent-based
// un1t-* names (MOB-UI.1).

export const BUTTON_VARIANTS = Object.freeze({
  primary: 'bg-un1t-accent',
  secondary: 'bg-un1t-surface border border-un1t-border',
  ghost: 'bg-transparent',
  danger: 'bg-red-500',
})

export const BUTTON_SIZES = Object.freeze({
  sm: 'h-9 px-3',
  md: 'h-11 px-4',
  lg: 'h-12 px-5',
  icon: 'h-10 w-10', // square, for icon-only buttons
})

const BUTTON_BASE = 'flex-row items-center justify-center gap-2 rounded-xl'

/** className for the Pressable. Unknown variant/size fall back to defaults. */
export function buttonClasses({ variant = 'primary', size = 'md', disabled = false } = {}) {
  return [
    BUTTON_BASE,
    BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary,
    BUTTON_SIZES[size] || BUTTON_SIZES.md,
    disabled ? 'opacity-50' : '',
  ].filter(Boolean).join(' ')
}

const BUTTON_TEXT_VARIANTS = Object.freeze({
  primary: 'text-white font-semibold',
  secondary: 'text-un1t-text font-semibold',
  ghost: 'text-un1t-subtle font-medium',
  danger: 'text-white font-semibold',
})

const BUTTON_TEXT_SIZES = Object.freeze({ sm: 'text-sm', md: 'text-sm', lg: 'text-base', icon: 'text-sm' })

export function buttonTextClasses({ variant = 'primary', size = 'md' } = {}) {
  return [
    BUTTON_TEXT_VARIANTS[variant] || BUTTON_TEXT_VARIANTS.primary,
    BUTTON_TEXT_SIZES[size] || BUTTON_TEXT_SIZES.md,
  ].join(' ')
}

export const CARD_PADDING = Object.freeze({ none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' })

export function cardClasses({ padding = 'md', className = '' } = {}) {
  return ['rounded-2xl border border-un1t-border bg-white', CARD_PADDING[padding] ?? CARD_PADDING.md, className]
    .filter(Boolean).join(' ')
}

// ── Modal ──────────────────────────────────────────────────────────
// Responsive: bottom-sheet on phone, centered dialog on tablet. The
// shell (components/ui/Modal.jsx) reads useIsTablet() and passes the
// boolean here so the layout decision stays unit-testable.
export function modalOverlayClasses() {
  return 'flex-1 bg-black/50'
}
export function modalContainerClasses({ isTablet = false } = {}) {
  return isTablet ? 'flex-1 items-center justify-center p-6' : 'flex-1 justify-end'
}
export function modalPanelClasses({ isTablet = false } = {}) {
  return isTablet
    ? 'w-full max-w-lg rounded-2xl bg-white p-5'
    : 'w-full rounded-t-2xl bg-white p-5 pb-8'
}
