// C21 PUSHDONE.1 — one reading of a push result for every caller that records
// "done" (a stamp, a claim, a ledger row) around a send.
//
// Three outcomes, and only one of them may be retried:
//   'delivered' — something reached somebody (a push ticket, or notifyUsers'
//                 fallback email). Record it done. A partial send is
//                 delivered: sending again would repeat it to the people who
//                 already have it.
//   'failed'    — nothing reached anybody AND something broke: Expo after its
//                 retries, a read inside sendPush (C16 `read_failed`), the
//                 role-recipients read (C1 `recipients_failed`), a failed
//                 fallback email, or the send threw (`result` is null). Do NOT
//                 record it done; the caller's next run retries.
//   'settled'   — nothing reached anybody and nothing broke: nobody opted in,
//                 nobody has a device, nobody holds the role. Record it done;
//                 there is nothing to retry against.
//
// Works on every shape in the estate: sendPush / sendPushToRolesAtLocation /
// the *Once dedup wrappers ({ sent, skipped, invalidated, failed, deduped,
// read_failed?, recipients_failed? }), notifyUsers (+ emailed, email_failed)
// and sendCustomerPush ({ sent, invalidated, failed, skipped, read_failed? }).
// Pure, no imports: route tests that mock '@/lib/push' whole still get it.

/**
 * @param {object|null|undefined} result  a push sender's result; null/undefined = it threw
 * @returns {'delivered'|'failed'|'settled'}
 */
export function pushOutcome(result) {
  if (!result) return 'failed'
  if ((result.sent || 0) + (result.emailed || 0) > 0) return 'delivered'
  if ((result.failed || 0) > 0 || (result.email_failed || 0) > 0 || result.recipients_failed) return 'failed'
  return 'settled'
}
