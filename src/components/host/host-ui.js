// HOSTTHEME.1 — the host portal's class kit. Plain strings built only from the
// `host-*` colour tokens (globals.css, both themes) and layout utilities, so a
// screen is right in light and dark and a recipe changes in one place.
//
// No imports: server pages and client components both use it. Every string is a
// literal so Tailwind can find the classes. Tokens are complete colours — never
// add an opacity modifier to a `host-*` colour.

// Type
export const HOST_H1 = 'text-2xl font-semibold text-host-text'
export const HOST_SECTION = 'text-[17px] font-semibold text-host-text'
export const HOST_SECTION_DESC = 'mt-1 text-[13.5px] text-host-hint'
export const HOST_EYEBROW = 'text-[13px] font-medium text-host-label'
export const HOST_LABEL = 'block text-[13.5px] font-medium text-host-label'
export const HOST_HINT = 'text-[13px] text-host-hint'
export const HOST_META = 'text-[12.5px] text-host-hint'

// Surfaces
export const HOST_PANEL = 'rounded-xl border border-host-border bg-host-panel p-5'
export const HOST_WELL = 'rounded-lg border border-host-border bg-host-well p-4'
export const HOST_LIST = 'divide-y divide-host-border rounded-xl border border-host-border bg-host-panel'
export const HOST_ROW = 'px-4 py-3'

// Controls
export const HOST_INPUT =
  'h-11 w-full rounded-lg border border-host-edge bg-host-input px-3 text-[15px] text-host-text placeholder:text-host-faint focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-host-accent disabled:opacity-60'
export const HOST_BTN =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-host-edge bg-host-panel px-4 py-2 text-sm font-medium text-host-text hover:bg-host-well disabled:opacity-50 disabled:cursor-not-allowed'
export const HOST_BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-host-accent px-4 py-2 text-sm font-semibold text-host-on-accent hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed'
export const HOST_BTN_DANGER =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-host-danger px-4 py-2 text-sm font-semibold text-host-on-danger hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed'
export const HOST_LINK = 'text-host-text underline underline-offset-2 hover:text-host-label'

// Status
export const HOST_CHIP = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium'
export const HOST_CHIP_TONE = {
  neutral: 'bg-host-well text-host-hint',
  ok: 'bg-host-ok-bg text-host-ok',
  warn: 'bg-host-warn-bg text-host-warn',
  bad: 'bg-host-bad-bg text-host-bad',
  info: 'bg-host-info-bg text-host-info',
}
export const HOST_NOTICE = 'rounded-lg border px-4 py-3 text-sm'
export const HOST_NOTICE_TONE = {
  neutral: 'border-host-border bg-host-well text-host-label',
  ok: 'border-host-ok-edge bg-host-ok-bg text-host-ok',
  warn: 'border-host-warn-edge bg-host-warn-bg text-host-warn',
  bad: 'border-host-bad-edge bg-host-bad-bg text-host-bad',
}
