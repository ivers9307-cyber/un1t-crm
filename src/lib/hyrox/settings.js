// HYROX-TC.2 — operator-editable Hyrox settings on locations.settings.hyrox,
// resolved with a code default (estate "settings field + default fallback").
import { DEFAULT_CHARTER } from './constants'

export function resolveHyroxSettings(loc) {
  const h = loc?.settings?.hyrox || {}
  const charter = typeof h.charter === 'string' && h.charter.trim() ? h.charter : DEFAULT_CHARTER
  const houseStyle = typeof h.house_style === 'string' ? h.house_style.trim() : ''
  const styleExamples = Array.isArray(h.style_examples)
    ? h.style_examples.filter((e) => e && typeof e.text === 'string' && e.text.trim())
    : []
  return { charter, houseStyle, styleExamples }
}
