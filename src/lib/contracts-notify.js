// CONTRACTS-DRAFT.1 — shared "tell the recipient a contract is
// ready to sign" notification. Extracted from /api/contracts POST's
// inline notify block (template-name lookup + sendContractIssuedEmail
// + the push try/catch) so the new /api/contracts/[id]/send route
// (draft -> issued) can fire the exact same first-notification a
// brand-new issue does, without duplicating the logic. Behavior is
// IDENTICAL to what both routes did inline before this extraction:
// best-effort, never throws — the caller decides what to do with
// emailResult.ok (surfaced as a `warning` in the response).
//
// @param {object} args
// @param {object} args.db       — service-role Supabase client.
// @param {object} args.contract — must include id, profile_id,
//                                 template_id, location_id, and a
//                                 `profile: { full_name, email }`
//                                 shape for the recipient (insert()
//                                 doesn't return embeds, so callers
//                                 attach this manually — see the
//                                 issue route; the send route fetches
//                                 it with a profiles embed like the
//                                 resend route does).
// @param {object} args.issuer   — { full_name } for the email body /
//                                 push copy.
// @returns {Promise<{ emailResult: { ok: boolean, error?: string } }>}

import { sendContractIssuedEmail } from './contracts-email.js'
import { sendPush } from './push.js'
import { getLocationBranding } from './location-branding.js'

/**
 * W1.S1a — who the contract push says it is from: the person's name, else
 * the configured brand of the contract's location, else nobody (the copy
 * then reads without a sender). Never a fixed gym's name; never throws
 * (getLocationBranding swallows its own errors).
 * @param {object|null} db
 * @param {string|null} fullName
 * @param {string|null} locationId
 * @returns {Promise<string>}
 */
export async function contractPushSender(db, fullName, locationId) {
  const name = String(fullName || '').trim()
  if (name) return name
  const { companyName } = await getLocationBranding(db, locationId)
  return String(companyName || '').trim()
}

/**
 * W1.S1a — the push body for a contract waiting on a signature. `kind`
 * 'issued' (first notification) or 'reminder' (resend). No em-dashes.
 * @param {{ sender: string, templateName?: string|null, kind: 'issued'|'reminder' }} args
 * @returns {string}
 */
export function contractPushBody({ sender, templateName, kind }) {
  const what = templateName ? `"${templateName}"` : null
  if (kind === 'reminder') {
    const target = what || 'your contract'
    return sender
      ? `${sender} sent you a reminder to sign ${target}.`
      : `A reminder to sign ${target}.`
  }
  const target = what || 'a contract'
  return sender
    ? `${sender} issued you ${target}. Tap to review and sign.`
    : `You have been issued ${target}. Tap to review and sign.`
}

export async function notifyContractIssued({ db, contract, issuer }) {
  // Template name for the email subject + push body. Best-effort —
  // a lookup miss just means a slightly less specific subject/body,
  // never a blocked notification.
  const { data: tplRow } = await db
    .from('contract_templates')
    .select('name')
    .eq('id', contract.template_id)
    .maybeSingle()

  const emailResult = await sendContractIssuedEmail({
    contract,
    recipient: { full_name: contract.profile?.full_name, email: contract.profile?.email },
    issuer,
    templateName: tplRow?.name,
  })

  // Push notification (best effort, never blocks). sendPush honours
  // the recipient's permissions.mobile.push_notifications master
  // switch + their notify_contract_issued category toggle. If the
  // mobile app isn't installed (no device tokens) it's a quiet
  // no-op. Tap deep-links to /contracts/<id> via expo-router so
  // the recipient lands directly on the sign screen.
  try {
    await sendPush([contract.profile_id], {
      title: 'Contract awaiting signature',
      body: contractPushBody({
        sender: await contractPushSender(db, issuer?.full_name, contract.location_id),
        templateName: tplRow?.name,
        kind: 'issued',
      }),
      category: 'contract_issued',
      data: {
        type: 'contract_issued',
        contract_id: contract.id,
        path: `/contracts/${contract.id}`,
      },
    })
  } catch {
    // Push is non-blocking; intentionally swallow.
  }

  return { emailResult }
}
