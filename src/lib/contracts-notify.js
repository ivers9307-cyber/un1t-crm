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
      body: tplRow?.name
        ? `${issuer?.full_name || 'UN1T'} issued you "${tplRow.name}" — tap to review and sign.`
        : `${issuer?.full_name || 'UN1T'} issued you a contract — tap to review and sign.`,
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
