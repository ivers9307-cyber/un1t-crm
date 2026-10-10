// W1.E2 — where a location's customers' replies go. Extracted from
// src/lib/postmark.js so src/lib/tenant-email.js (which postmark.js imports)
// can read it without a cycle; postmark.js re-exports both helpers.
//
// Resolve order:
//   1. the location's DEFAULT email account (email_mailboxes.is_default, active)
//   2. locations.email_inbox_reply_to (mig 394, DEPRECATED by mig 485; still
//      holds a live value for studios configured before the accounts model)
//   3. locations.email — the location's own public address (W1.E2). Before a
//      verified sending domain every tenant email leaves from the PLATFORM
//      address, so without this tier a reply from a customer of a studio with
//      no inbox account would land in the platform mailbox, not the gym's.
// Null when none is set, or on ANY error: a Reply-To lookup is best-effort
// and must never stop a send.

/**
 * EMAIL-MAILBOX-ADMIN.1 — the address of a location's DEFAULT email account
 * (email_mailboxes, mig 485), or null.
 *
 * `is_default` was documented from the start as "the address stamped as
 * Reply-To on campaign + marketing sends" (mig 485's own COMMENT), but until
 * the account editor shipped nothing could set it, so the send paths still
 * read the column it replaced. Now that an operator can choose the default,
 * the default is what they get.
 *
 * Active only: a deactivated account stops accepting inbound, so stamping it
 * as Reply-To would invite customers to write to an address whose mail
 * dead-letters.
 *
 * Takes the caller's client rather than making one — the send paths already
 * hold a service-role client, and this runs per campaign tick.
 */
export async function getDefaultMailboxAddress(db, locationId) {
  if (!db || !locationId) return null
  try {
    const { data } = await db.from('email_mailboxes')
      .select('address')
      .eq('location_id', locationId)
      .eq('is_default', true)
      .eq('active', true)
      .limit(1)
      .maybeSingle()
    return data?.address || null
  } catch {
    return null
  }
}

/**
 * The location's reply-to address by the order in the header, or null.
 * @param {object} db - a supabase-js client (service role on the send paths)
 * @param {string|null|undefined} locationId
 * @returns {Promise<string|null>}
 */
export async function getLocationInboxReplyTo(db, locationId) {
  if (!db || !locationId) return null
  try {
    const fromMailbox = await getDefaultMailboxAddress(db, locationId)
    if (fromMailbox) return fromMailbox
    const { data } = await db.from('locations')
      .select('email_inbox_reply_to, email')
      .eq('id', locationId)
      .maybeSingle()
    return data?.email_inbox_reply_to || data?.email || null
  } catch {
    return null
  }
}
