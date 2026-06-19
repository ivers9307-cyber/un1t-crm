// Expo push fan-out for the champ-app CUSTOMER native app (champ_push_tokens).
// Parallel to src/lib/push.js (staff) but keyed by contact_id with no per-user
// permission gating (a registered token = opted in). Self-contained so it never
// touches the load-bearing staff push path. Prunes DeviceNotRegistered tokens.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH = 100

export async function sendCustomerPush(db, contactIds, payload) {
  const ids = (Array.isArray(contactIds) ? contactIds : [contactIds]).filter(Boolean)
  if (!ids.length) return { sent: 0, invalidated: 0 }

  const { data: rows } = await db
    .from('champ_push_tokens')
    .select('id, expo_push_token')
    .in('contact_id', ids)
  if (!rows || !rows.length) return { sent: 0, invalidated: 0 }

  const messages = rows.map((r) => ({
    to: r.expo_push_token,
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    sound: 'default',
  }))

  const tickets = []
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH)
    try {
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      })
      const json = await res.json()
      if (Array.isArray(json?.data)) {
        json.data.forEach((t, j) => tickets.push({ t, token: chunk[j].to }))
      }
    } catch (e) {
      console.warn(`[customer-push] send failed: ${e?.message || e}`)
    }
  }

  const dead = tickets
    .filter(({ t }) => t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered')
    .map(({ token }) => token)
  let invalidated = 0
  if (dead.length) {
    const { error } = await db.from('champ_push_tokens').delete().in('expo_push_token', dead)
    if (!error) invalidated = dead.length
  }
  return { sent: rows.length - invalidated, invalidated }
}
