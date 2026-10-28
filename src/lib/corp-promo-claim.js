// CORPPROMO.1 — fulfil one /corp claim at a un1t.online studio.
//
// The corp_promo_claims row is already inserted (processing, with the terms
// acceptance ensureUn1tAccount reads). This module finds or creates the
// person's un1t.online account, judges eligibility again with that account's
// history in view, grants the promo's credits (grantPromoCredits, the ONLY
// caller: tests/un1t-online-write-guard.test.js), stamps the row and tells the
// person:
//   - granted → row granted (un1t user, ledger id, credits, expires_at), the
//     confirmation email (for an account the CRM just created it rides the
//     set-password step, so the person gets one email before un1t.online's code);
//   - not eligible (a history only the account showed, or credits already on
//     it) → row ineligible with the reason;
//   - a refusal or an answer in doubt → row help_requested and the ops alert
//     (an approvals card);
//   - a retry (budget, throttle, unreadable settings or reads) → row failed,
//     the page says try again.
// Logs carry ids and codes only, never the email or phone.
import { ensureUn1tAccount, runSetPasswordStep } from '@/lib/un1t-online-account'
import { grantPromoCredits, UN1T_PROMO_ORIGIN } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError, readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { corpPromoEligibility } from '@/lib/corp-promo-eligibility'
import { sendCorpPromoEmail } from '@/lib/corp-promo-emails'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { escapeHtml } from '@/lib/html-escape'
import { logError, logWarn } from '@/lib/log'

const LOG = 'corp-promo'

/**
 * @param {object} db service-role client
 * @param {{ claim: object, location: { id: string, name: string|null, organization_id: string|null },
 *   contact: { id: string, email: string, first_name?: string|null, last_name?: string|null, name?: string|null,
 *   phone?: string|null, un1t_user_id?: string|null }, promo: import('./corp-promos').CorpPromo,
 *   copy: object, zone: string, trialProductId: string|null }} args
 * @param {object} [deps] test seams
 * @returns {Promise<{ kind: 'granted', expiresAt: string, credits: number }
 *   | { kind: 'ineligible', reason: string } | { kind: 'help_filed' } | { kind: 'unavailable' }>}
 */
export async function fulfilCorpPromoClaim(db, { claim, location, contact, promo, copy, zone, trialProductId }, deps = {}) {
  const d = {
    ensureUn1tAccount, runSetPasswordStep, grantPromoCredits, corpPromoEligibility, sendCorpPromoEmail, sendOpsAlert,
    now: () => new Date(), ...deps,
  }
  const locationId = claim.location_id
  const ids = { claimId: claim.id, locationId }

  const stamp = async (patch) => {
    const { error } = await db.from('corp_promo_claims').update(patch).eq('id', claim.id).eq('location_id', locationId)
    if (error) logError(LOG, 'claim not stamped', { ...ids, status: patch.status ?? null, code: error.code ?? null })
    return error || null
  }
  const failed = async (reason) => {
    await stamp({ status: 'failed', reason })
    return { kind: 'unavailable' }
  }
  const ineligible = async (reason) => {
    await stamp({ status: 'ineligible', reason })
    return { kind: 'ineligible', reason }
  }
  const help = async (reason, extra = {}) => {
    await stamp({ status: 'help_requested', reason, ...extra })
    try {
      if (location.organization_id) {
        await d.sendOpsAlert({
          organizationId: location.organization_id,
          locationId,
          subject: `Corporate promo needs a hand: ${claim.first_name || ''} ${claim.last_name || ''} (${location.name || 'studio'})`.replace(/\s+/g, ' '),
          htmlBody:
            `<p>Someone claimed the ${escapeHtml(promo.key)} promo on /corp, but their free classes could not be put on their un1t.online account automatically. Nothing was charged.</p>` +
            `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` +
            `<p><strong>Person:</strong> ${escapeHtml(`${claim.first_name || ''} ${claim.last_name || ''}`.trim())} &lt;${escapeHtml(claim.customer_email)}&gt; ${escapeHtml(claim.customer_phone || '')}<br/>` +
            `<strong>Claim id:</strong> ${escapeHtml(claim.id)}</p>` +
            `<p>Check their un1t.online account, add ${promo.credits} credits for ${promo.expiresInDays} days by hand if they qualify, then mark the card handled on the Approvals page.</p>`,
        })
      }
    } catch (e) {
      logWarn(LOG, 'staff alert failed', { ...ids, errClass: e?.name })
    }
    return { kind: 'help_filed' }
  }

  // ── 1. The un1t.online account ──
  let account
  try {
    account = await d.ensureUn1tAccount(db, {
      locationId, organizationId: location.organization_id ?? null, contact,
      request: claim, origin: UN1T_PROMO_ORIGIN, originRef: claim.id, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return failed(err.code || 'un1t_settings_unreadable')
    if (err instanceof Un1tWriteRefused) return err.result?.retryable ? failed(err.code) : help(`un1t_account_refused: ${err.code}`)
    logError(LOG, 'account step threw', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return failed('un1t_account_unreadable')
  }
  if (account.kind === 'retry') return failed(account.code)
  if (account.kind === 'card') return help(`un1t_account_refused: ${account.reason}`)
  const un1tUserId = account.un1tUserId
  await stamp({ un1t_user_id: un1tUserId })

  // ── 2. Eligibility again, with the account's own history in view ──
  const elig = await d.corpPromoEligibility(db, {
    locationId, organizationId: location.organization_id ?? null, contactId: account.executingContactId ?? contact.id,
    email: claim.customer_email, phone: claim.customer_phone, trialProductId, promoKey: promo.key,
  })
  if (!elig.ok) return failed('eligibility_unreadable')
  if (!elig.eligible) return ineligible(elig.reason)

  // ── 3. The grant ──
  let grant
  try {
    grant = await d.grantPromoCredits(db, {
      locationId, un1tUserId, contactId: contact.id, promoKey: promo.key,
      amount: promo.credits, expiresInDays: promo.expiresInDays, originRef: claim.id,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return failed(err.code || 'un1t_settings_unreadable')
    logError(LOG, 'grant threw', { ...ids, code: err?.code ?? null, errClass: err?.name })
    return failed('grant_error')
  }
  if (grant.outcome === 'retry') return failed(grant.code)
  if (grant.outcome === 'ineligible') return ineligible(grant.reason)
  if (grant.outcome === 'needs_staff') return help(grant.reason, grant.ledgerId ? { un1t_ledger_id: grant.ledgerId } : {})

  const expiresAt = grant.expiresAt ?? new Date(d.now().getTime() + promo.expiresInDays * 24 * 3600 * 1000).toISOString()
  const grantedRow = { ...claim, status: 'granted', un1t_user_id: un1tUserId, un1t_ledger_id: grant.ledgerId, credits: promo.credits, expires_at: expiresAt }
  const stampErr = await stamp({ status: 'granted', reason: null, un1t_user_id: un1tUserId, un1t_ledger_id: grant.ledgerId, credits: promo.credits, expires_at: expiresAt })
  // The credits are on the account whatever the row says: the person is told.
  if (stampErr?.code === '23505') {
    logWarn(LOG, 'a granted claim for this person already exists', { ...ids })
    await stamp({ status: 'ineligible', reason: 'already_claimed', un1t_user_id: un1tUserId })
    return { kind: 'ineligible', reason: 'already_claimed' }
  }

  // ── 4. Tell them (best-effort: the credits are already on the account) ──
  const sendEmail = () => d.sendCorpPromoEmail(db, { claim: grantedRow, copy, studioName: location.name || '', zone })
  try {
    if (account.kind === 'created') {
      const { settings } = await readUn1tWriteSettings(db, locationId)
      const res = await d.runSetPasswordStep(db, {
        locationId, contact, un1tUserId, request: claim, settings, origin: UN1T_PROMO_ORIGIN, writer: null,
      }, { sendUn1tAccountEmail: sendEmail })
      // The step skipped our email (un1t.online's own welcome sets the login): send it ourselves.
      if (res?.explanation !== 'sent') await sendEmail()
    } else {
      await sendEmail()
    }
  } catch (e) {
    logWarn(LOG, 'confirmation email or set-password step failed after the grant', { ...ids, code: e?.code ?? null, errClass: e?.name })
  }
  return { kind: 'granted', expiresAt, credits: promo.credits }
}
