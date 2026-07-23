// HYROX-TC.2 — operator-editable Hyrox settings on locations.settings.hyrox,
// resolved with a code default (estate "settings field + default fallback").
import { DEFAULT_CHARTER } from './constants'

export function resolveHyroxSettings(loc) {
  const h = loc?.settings?.hyrox || {}
  const charter = typeof h.charter === 'string' && h.charter.trim() ? h.charter : DEFAULT_CHARTER
  return { charter }
}
