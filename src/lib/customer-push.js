// Expo push fan-out for the champ-app CUSTOMER native app (champ_push_tokens).
// Parallel to src/lib/push.js (staff) but keyed by contact_id with no per-user
// permission gating (a registered token = opted in). Self-contained so it never
// touches the load-bearing staff push path. Prunes DeviceNotRegistered tokens.
//
// Returns { sent, invalidated, failed }: `sent` counts tokens Expo actually
// ticketed 'ok' (NOT just "tokens we tried"), `failed` counts tokens that got
// no ok ticket after retries. Callers with a "was this nudge sent?" ledger
// (send-class-booking-reminders) use `failed` to tell a pipeline failure
// apart from "nothing to send".

import { customerAndroidChannelId } from '@shared/customer-push-channels'

const EXPO_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH = 100

// 2 retries (3 attempts) with modest backoff per batch — Expo blips /
// 429s / 5xxs are usually transient; anything that survives 2.5s of
// backoff is counted as failed and left to the caller's retry story.
const RETRY_DELAYS_MS = [500, 2000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// POST one batch to Expo with retry + backoff. Retries fetch exceptions,
// 429, 5xx, and unparseable 2xx bodies; gives up immediately on other 4xx
// (a malformed request won't get better by retrying). Returns the Expo
// ticket array, or null when the batch ultimately failed.
async function postExpoBatch(chunk) {
  const attempts = RETRY_DELAYS_MS.length + 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2])

    let res
    try {
      res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      })
    } catch (e) {
      console.warn(`[customer-push] expo fetch failed (attempt ${attempt}/${attempts}): ${e?.message || e}`)
      continue
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[customer-push] expo non-2xx ${res.status} (attempt ${attempt}/${attempts}): ${body}`)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return null
      continue
    }

    const json = await res.json().catch(() => null)
    if (!json || !Array.isArray(json.data)) {
      // A 2xx with an unparseable/shapeless body used to be a SILENT
      // no-op — log it and treat it as a retryable failure.
      console.warn(`[customer-push] expo response unparseable (attempt ${attempt}/${attempts})`)
      continue
    }
    return json.data
  }
  return null
}

export async function sendCustomerPush(db, contactIds, payload) {
  const ids = (Array.isArray(contactIds) ? contactIds : [contactIds]).filter(Boolean)
  if (!ids.length) return { sent: 0, invalidated: 0, failed: 0 }

  const { data: rows } = await db
    .from('champ_push_tokens')
    .select('id, expo_push_token')
    .in('contact_id', ids)
  if (!rows || !rows.length) return { sent: 0, invalidated: 0, failed: 0 }

  // Android: per-type channel (created by champ-app's push registrar from
  // the same shared map — customer payloads carry data.type, not category).
  // Unknown types resolve to the legacy 'default' channel. iOS ignores it.
  const channelId = customerAndroidChannelId(payload.data?.type)

  const messages = rows.map((r) => ({
    to: r.expo_push_token,
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    sound: 'default',
    channelId,
  }))

  let sent = 0
  let failed = 0
  const deadTokens = []
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH)
    const tickets = await postExpoBatch(chunk)
    if (!tickets) {
      failed += chunk.length
      continue
    }
    tickets.forEach((t, j) => {
      if (t?.status === 'ok') {
        sent++
      } else if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
        deadTokens.push(chunk[j].to)
      } else {
        // Other per-ticket error (MessageTooBig, rate limits, …) —
        // log, count failed, don't prune.
        console.warn(`[customer-push] ticket error: ${JSON.stringify(t)}`)
        failed++
      }
    })
  }

  let invalidated = 0
  if (deadTokens.length) {
    // supabase-js builders are thenables — destructure and check error
    // explicitly; a swallowed delete failure leaves dead tokens burning
    // Expo quota every send.
    const { error } = await db.from('champ_push_tokens').delete().in('expo_push_token', deadTokens)
    if (error) console.warn(`[customer-push] dead-token prune failed: ${error.message || error}`)
    else invalidated = deadTokens.length
  }
  return { sent, invalidated, failed }
}
