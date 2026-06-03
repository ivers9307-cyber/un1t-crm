// UI-FOUND.2 — pure styling/logic helpers for the components/ui primitives.
//
// Why a separate .js module: the codebase's test environment is Node
// (no DOM, no testing-library — see vitest.config.js), and every test
// here is a fast pure-function test. We keep all branch-y logic
// (variant→class maps, aria wiring, table state resolution) in this
// module so it's unit-testable, and leave the .jsx components as thin
// presentational shells that call these helpers. This mirrors the
// existing pattern in the repo (logic in lib/*.js with tests; IO/JSX
// untested by unit). Tested in styles.test.js.

import clsx from 'clsx'

// ─── Button ──────────────────────────────────────────────────────────
export const BUTTON_VARIANTS = Object.freeze({
  primary: 'bg-un1t-accent text-white hover:bg-un1t-text',
  secondary: 'bg-un1t-surface text-un1t-text border border-un1t-border hover:bg-un1t-border/60',
  ghost: 'bg-transparent text-un1t-subtle hover:bg-un1t-surface',
  danger: 'bg-stage-lost text-white hover:opacity-90',
})

export const BUTTON_SIZES = Object.freeze({
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
  // Square footprint for icon-only buttons (the most common button
  // shape in this app — row actions, toolbars). Use with `icon` and no
  // children; pair with variant="ghost" for the typical row-action look.
  icon: 'h-8 w-8 p-0',
})

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-un1t-accent disabled:opacity-50 disabled:pointer-events-none'

/**
 * Resolve the className for a Button. Unknown variant/size fall back to
 * the defaults rather than producing `undefined` in the class string.
 * @param {{variant?:string,size?:string,className?:string}} [opts]
 * @returns {string}
 */
export function buttonClasses({ variant = 'primary', size = 'md', className } = {}) {
  return clsx(
    BUTTON_BASE,
    BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary,
    BUTTON_SIZES[size] || BUTTON_SIZES.md,
    className,
  )
}

// ─── Card ────────────────────────────────────────────────────────────
export const CARD_PADDING = Object.freeze({
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
})

const CARD_BASE = 'rounded-xl border border-un1t-border bg-white'

/**
 * @param {{padding?:string,className?:string}} [opts]
 * @returns {string}
 */
export function cardClasses({ padding = 'md', className } = {}) {
  const pad = CARD_PADDING[padding] ?? CARD_PADDING.md
  return clsx(CARD_BASE, pad, className)
}

// ─── Modal ───────────────────────────────────────────────────────────
export const MODAL_SIZES = Object.freeze({
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
})

/**
 * @param {{size?:string,className?:string}} [opts]
 * @returns {string}
 */
export function modalPanelClasses({ size = 'md', className } = {}) {
  return clsx(
    'w-full rounded-xl bg-white shadow-xl border border-un1t-border',
    MODAL_SIZES[size] || MODAL_SIZES.md,
    className,
  )
}

// ─── Field ───────────────────────────────────────────────────────────
/**
 * Stable id set for a Field's control, error, and hint elements so the
 * control can wire `aria-describedby` / `aria-errormessage` correctly.
 * @param {string} baseId
 */
export function fieldIds(baseId) {
  return {
    control: baseId,
    error: `${baseId}-error`,
    hint: `${baseId}-hint`,
  }
}

/**
 * Build the `aria-describedby` value for a control: the hint id (if a
 * hint is shown) and the error id (if an error is shown), space-joined.
 * Returns undefined when neither applies so the attribute is omitted.
 * @param {{baseId:string, hasError:boolean, hasHint:boolean}} opts
 * @returns {string|undefined}
 */
export function fieldDescribedBy({ baseId, hasError, hasHint }) {
  const ids = fieldIds(baseId)
  const parts = []
  if (hasHint) parts.push(ids.hint)
  if (hasError) parts.push(ids.error)
  return parts.length ? parts.join(' ') : undefined
}

// ─── Table ───────────────────────────────────────────────────────────
/**
 * Resolve which render state a Table is in. `loading` wins over
 * everything; an empty/absent rows array → 'empty'; otherwise 'rows'.
 * @param {{rows?:Array, loading?:boolean}} opts
 * @returns {'loading'|'empty'|'rows'}
 */
export function tableState({ rows, loading = false } = {}) {
  if (loading) return 'loading'
  if (!Array.isArray(rows) || rows.length === 0) return 'empty'
  return 'rows'
}

/**
 * Read a cell value for a column from a row. Supports a string `accessor`
 * (key lookup) or a function `render(row)` — returns the raw value; the
 * component decides how to render it. Defensive against null rows.
 * @param {object} row
 * @param {{accessor?:string, render?:(row:object)=>any}} column
 */
export function cellValue(row, column) {
  if (!column) return undefined
  if (typeof column.render === 'function') return column.render(row)
  if (typeof column.accessor === 'string') return row == null ? undefined : row[column.accessor]
  return undefined
}

// ─── EmptyState ──────────────────────────────────────────────────────
// UI-FOUND.3 — shared empty-state + loading primitives. The biggest
// driver of the visual disjointedness in the audit was every module
// hand-rolling its own "nothing here" and "loading…" blocks. These
// helpers standardise the layout; the .jsx shells stay thin.
const EMPTY_STATE_BASE = 'flex flex-col items-center justify-center text-center gap-2'

export const EMPTY_STATE_PADDING = Object.freeze({
  none: '',
  sm: 'py-6 px-4',
  md: 'py-10 px-6',
  lg: 'py-16 px-6',
})

/**
 * Resolve the className for an EmptyState container. Unknown padding
 * falls back to 'md'.
 * @param {{padding?:string, className?:string}} [opts]
 * @returns {string}
 */
export function emptyStateClasses({ padding = 'md', className } = {}) {
  // `??` not `||` so padding='none' (a legitimate empty-string value)
  // is respected rather than falling through to md — mirrors cardClasses.
  const pad = EMPTY_STATE_PADDING[padding] ?? EMPTY_STATE_PADDING.md
  return clsx(EMPTY_STATE_BASE, pad, className)
}

// ─── Loading ─────────────────────────────────────────────────────────
export const SPINNER_SIZES = Object.freeze({
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
})

/** Tailwind size class for the spinner icon. Unknown size → 'md'. */
export function spinnerSizeClass(size = 'md') {
  return SPINNER_SIZES[size] || SPINNER_SIZES.md
}

/**
 * Resolve the className for a Loading container. `inline` lays the
 * spinner + label out horizontally (for use mid-sentence / in a row);
 * the default is a centred block with vertical padding.
 * @param {{inline?:boolean, className?:string}} [opts]
 * @returns {string}
 */
export function loadingClasses({ inline = false, className } = {}) {
  return clsx(
    'text-un1t-subtle',
    inline
      ? 'inline-flex items-center gap-2'
      : 'flex flex-col items-center justify-center gap-2 py-16',
    className,
  )
}
