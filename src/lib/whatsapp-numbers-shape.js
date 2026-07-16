// WA-TECHPROV.3 — shared public projection of whatsapp_numbers rows.
// The full access_token (and signup_meta, which carries the 2FA PIN)
// must never reach the browser; every route that returns rows uses this.

export function redactToken(token) {
  if (!token || typeof token !== 'string') return null
  if (token.length <= 8) return '••••'
  return `••••${token.slice(-6)}`
}

export function publicShape(row) {
  return {
    id: row.id,
    location_id: row.location_id,
    label: row.label,
    phone_number_id: row.phone_number_id,
    business_account_id: row.business_account_id,
    app_id: row.app_id,
    display_phone: row.display_phone,
    source: row.source,
    token_type: row.token_type,
    connected_via: row.connected_via,
    is_default: row.is_default,
    is_active: row.is_active,
    access_token_redacted: redactToken(row.access_token),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
