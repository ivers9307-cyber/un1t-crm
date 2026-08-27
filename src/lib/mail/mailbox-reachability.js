// MAILBOX-UNREACHABLE.1 — can mail addressed to this account actually reach
// the platform?
//
// THE LIVE PROBLEM THIS FILE EXISTS FOR
// `stillorgan@un1t.com` has sat in `email_mailboxes` since mig 485 as
// `active=true, is_default=true, ingress='postmark'`. It has never received a
// message and it never can: `un1t.com` is the franchisor's Google Workspace and
// its MX will never point at Postmark. Because it is the location's DEFAULT,
// every campaign and every sequence email from that studio stamps it as
// Reply-To — measured on 2026-08-26: 20,356 broadcast sends since the row was
// created. A member who hits reply is answered by nobody, in a mailbox the CRM
// cannot see. That is not data loss; it is the platform CLAIMING to handle
// correspondence it cannot handle, which is worse, because nobody goes looking.
//
// The standing audit finding says it plainly: "Adding a mailbox is a DB row
// only but the card asserts receiving works — a dead mailbox looks healthy
// forever (Stillorgan reproduces it live)."
//
// ── WHY THE SIGNAL IS DNS AND NOT SILENCE ───────────────────────────────────
// The obvious check — "nothing has arrived in N days" — is the WRONG one, and
// emailInboundStatus already learned it the hard way: a studio address that
// simply had no mail this week must not look broken, or the warning gets
// ignored and stops working on the day it matters. So this module never grades
// on volume at all. It asks a structural question with a yes/no answer:
//
//   Does this address's DOMAIN deliver mail to Postmark?
//
// Verified 2026-08-26 against the live estate:
//   un1t.com                → aspmx.l.google.com + 4 Google MX  (NOT us)
//   hatchstreetfitness.com  → inbound.postmarkapp.com           (us)
//   un1tdublin.com          → Google (the marketing apex keeps its own mail)
//   mail.un1tdublin.com     → inbound.postmarkapp.com           (us — invoices)
//
// A brand-new, bone-quiet mailbox on hatchstreetfitness.com therefore reads
// perfectly healthy, and stillorgan@un1t.com reads broken from the moment the
// row exists. That is the whole design.
//
// ── THE ONE THING MX ALONE CANNOT SEE, AND HOW IT IS ANSWERED ───────────────
// Postmark also accepts mail FORWARDED to a server's inbound hash address, so
// a foreign-MX domain CAN reach us if somebody set up a forward at the mail
// host. Spec §2 rejected forwarding as this estate's approach (Richard: a
// franchisor admin can disable it silently, org-wide, as a DLP control) — but
// "we don't do it" is not "nobody could", and asserting "this address cannot
// receive" at a mailbox that demonstrably does receive would be a false
// warning on the one screen whose whole job is to be believed. MAILBOX-COEXIST.1
// deleted a warning for exactly that reason rather than soften it.
//
// So evidence outranks inference, and only in the direction of quieting down:
//
//   MX is ours                        → 'ok'          (say nothing)
//   MX is not ours, nothing arrived   → 'unreachable' (say it, loudly)
//   MX is not ours, mail HAS arrived  → 'indirect'    (state the fact, calmly)
//   MX unreadable                     → 'unknown'     (say NOTHING)
//
// 'unknown' is silent on purpose. A DNS blip must never invent a fault, and it
// loses nothing when it stays quiet — the next page load asks again.
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
// It changes no send behaviour. `getDefaultMailboxAddress` still stamps the
// default address as Reply-To exactly as before, unreachable or not: a
// Reply-To that silently vanishes is its own surprise, and the fix an operator
// needs is a decision (connect the login, or point the default somewhere that
// works), not a behaviour change made on their behalf. This module only makes
// the platform say what is true.

import { resolveMx } from 'node:dns/promises'
import { escapeLikePattern } from '@/lib/like-escape'

/**
 * Postmark's inbound MX host. A domain whose MX points here (or at any
 * postmarkapp.com host — Postmark has used more than one name over the years)
 * delivers to the inbound webhook; anything else does not.
 */
export const POSTMARK_INBOUND_MX = 'inbound.postmarkapp.com'
const POSTMARK_MX_SUFFIX = '.postmarkapp.com'

/** How long a resolved MX answer is trusted inside one warm process. */
export const MX_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * DNS is a network call on a settings page render, so it gets a deadline.
 * Two seconds is far past a healthy resolver and far short of anything a
 * person would sit through; a miss degrades to 'unknown', which renders as
 * nothing at all.
 */
export const MX_TIMEOUT_MS = 2000

/** domain → { at: epochMs, hosts: string[]|null }. Per-process, best-effort. */
const mxCache = new Map()

/** Test seam — drops the memo so a case cannot inherit the previous one's DNS. */
export function _resetMxCache() { mxCache.clear() }

/**
 * The domain half of an address, lowercased. Null for anything that is not a
 * single `local@domain`.
 *
 * Deliberately stricter than a parser: the DB's own
 * `email_mailboxes_address_shape` CHECK already forbids whitespace, and an
 * address this cannot split is one we should say nothing about rather than
 * guess at.
 */
export function mailboxDomain(address) {
  if (typeof address !== 'string') return null
  // Whitespace ANYWHERE disqualifies the whole address, matching the DB CHECK
  // rather than only guarding the half this function reads. An address the
  // constraint would have refused is not one to publish a verdict about.
  if (/\s/.test(address)) return null
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.includes('@') || /\s/.test(domain)) return null
  return domain
}

/** Does this MX exchange belong to Postmark? Trailing dot and case tolerated. */
export function isPostmarkMx(host) {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  return h === POSTMARK_INBOUND_MX || h.endsWith(POSTMARK_MX_SUFFIX)
}

/**
 * Resolve a domain's MX exchanges, lowest-preference first.
 *
 * Returns `string[]` (possibly EMPTY — a domain with no MX at all is a real,
 * answerable state: mail to it does not come here either) or `null` when the
 * lookup could not be completed, which is the only "we don't know" case.
 *
 * NXDOMAIN and NODATA are ANSWERS, not failures: both mean "no MX exchange
 * exists for this name", so both resolve to []. Everything else — SERVFAIL,
 * a timeout, a refused query — is null, and null is silent downstream.
 *
 * NOT LOGGED on failure, deliberately. This runs on every render of the
 * settings card and the integration-health pane, so a broken resolver would
 * emit a line per page view for a probe whose failure loses nothing and
 * retries by itself. The estate's "log loudly" rule is about lost WORK.
 */
export async function resolveDeliveryMx(domain, { now = Date.now() } = {}) {
  if (!domain) return null
  const hit = mxCache.get(domain)
  if (hit && now - hit.at < MX_CACHE_TTL_MS) return hit.hosts

  let hosts = null
  let timer = null
  try {
    // node:dns/promises takes no AbortSignal, so the deadline is a race. The
    // losing lookup is left to settle on its own; it holds no resources we
    // care about and its result is simply dropped.
    const records = await Promise.race([
      resolveMx(domain),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('mx_timeout')), MX_TIMEOUT_MS)
      }),
    ])
    hosts = (Array.isArray(records) ? records : [])
      .slice()
      .sort((a, b) => (a?.priority ?? 0) - (b?.priority ?? 0))
      .map(r => String(r?.exchange || '').trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean)
  } catch (e) {
    const code = e?.code
    hosts = (code === 'ENOTFOUND' || code === 'ENODATA') ? [] : null
  } finally {
    if (timer) clearTimeout(timer)
  }

  // A null (couldn't-tell) answer is cached too, and on purpose: without it a
  // resolver outage turns every card render into another 2s wait for the same
  // non-answer. Ten minutes of silence costs nothing here.
  mxCache.set(domain, { at: now, hosts })
  return hosts
}

/**
 * The verdict for ONE mailbox. Pure — no DNS, no DB — so the four states are
 * tested directly rather than through a mock resolver.
 *
 * @param {object} args
 * @param {string} args.address       the mailbox address
 * @param {string} args.ingress       'postmark' | 'imap'
 * @param {string[]|null} args.mxHosts  resolveDeliveryMx output for its domain
 * @param {boolean} args.hasReceived  has inbound mail ever been filed here
 * @returns {{state:string, domain:string|null, mxHosts:string[], deliversTo:string|null}}
 */
export function classifyMailboxReachability({ address, ingress, mxHosts, hasReceived } = {}) {
  const domain = mailboxDomain(address)

  // A connected account is read over IMAP with its own login. Where the domain
  // points is irrelevant — that is the entire point of the connector — so this
  // must never grade an imap mailbox, or every successfully-connected franchise
  // address would light up the moment it started working.
  if (ingress === 'imap') {
    return { state: 'connected', domain, mxHosts: [], deliversTo: null }
  }

  if (!domain) return { state: 'unknown', domain: null, mxHosts: [], deliversTo: null }
  if (mxHosts === null || mxHosts === undefined) {
    return { state: 'unknown', domain, mxHosts: [], deliversTo: null }
  }

  const hosts = Array.isArray(mxHosts) ? mxHosts : []
  if (hosts.some(isPostmarkMx)) {
    return { state: 'ok', domain, mxHosts: hosts, deliversTo: hosts[0] || null }
  }

  return {
    // Evidence outranks inference — see the header. Mail that has demonstrably
    // arrived proves a route exists, whatever DNS says about the domain.
    state: hasReceived ? 'indirect' : 'unreachable',
    domain,
    mxHosts: hosts,
    deliversTo: hosts[0] || null,
  }
}

/**
 * Has inbound mail ever been filed at this address?
 *
 * Flat query on purpose: `email_inbox_messages` carries no `mailbox_id`, and
 * the join through `email_tickets` would need an embedded filter — which this
 * repo's route test double does not model, and which is one `head:true` away
 * from the PostgREST count trap. `to_email` is what the inbound pipeline
 * writes for a delivered message (30/30 of Hatch Street's live inbound rows
 * carry the mailbox address there), so it answers the question directly.
 *
 * `.ilike` + escapeLikePattern rather than `.eq`: addresses are stored as the
 * sender typed them, and an unescaped `_` in a real address is a wildcard
 * (`no-unescaped-ilike-pattern` enforces the pairing).
 *
 * BLIND SPOT, stated rather than hidden: a message that reached us only as a
 * Cc records the primary recipient in `to_email`, so a mailbox that has ONLY
 * ever been Cc'd reads as never-received. The UI copy is written to exactly
 * what this measures — "nothing addressed to this account has ever arrived" —
 * so the claim stays true even in that corner.
 *
 * Any error → `true`. Failing towards SILENCE is the right default for a
 * warning: an unreadable probe must not manufacture "this address cannot
 * receive" out of a transient database fault.
 */
async function hasEverReceived(db, locationId, address) {
  try {
    const { data, error } = await db.from('email_inbox_messages')
      .select('id')
      .eq('location_id', locationId)
      .eq('direction', 'inbound')
      .ilike('to_email', escapeLikePattern(address))
      .limit(1)
    if (error) return true
    return (data || []).length > 0
  } catch {
    return true
  }
}

/**
 * Assess every mailbox at a location. One DNS lookup per DISTINCT domain
 * (memoised across calls for MX_CACHE_TTL_MS), and an arrival probe ONLY for
 * the mailboxes DNS has already put in doubt — which at a correctly-configured
 * studio is none, so the healthy path costs zero extra queries.
 *
 * @param {object} db          service-role client (the caller already holds one)
 * @param {string} locationId
 * @param {Array<{id:string,address:string,ingress?:string}>} mailboxes
 * @returns {Promise<Record<string, object>>} mailbox id → classification
 */
export async function assessMailboxReachability(db, locationId, mailboxes) {
  const rows = Array.isArray(mailboxes) ? mailboxes : []
  if (rows.length === 0) return {}

  // Distinct domains only: a studio running studio@, sales@ and accounts@ on
  // one domain asks DNS once.
  const domains = [...new Set(
    rows.filter(m => m?.ingress !== 'imap').map(m => mailboxDomain(m?.address)).filter(Boolean)
  )]
  const resolved = new Map()
  await Promise.all(domains.map(async (d) => {
    resolved.set(d, await resolveDeliveryMx(d))
  }))

  // First pass with hasReceived assumed false, to find which rows the arrival
  // probe could actually change. Only 'unreachable' is downgradeable, so only
  // those cost a query.
  const provisional = rows.map(m => ({
    mailbox: m,
    verdict: classifyMailboxReachability({
      address: m?.address,
      ingress: m?.ingress,
      mxHosts: resolved.get(mailboxDomain(m?.address)) ?? null,
      hasReceived: false,
    }),
  }))

  const doubted = provisional.filter(p => p.verdict.state === 'unreachable')
  const received = new Map()
  await Promise.all(doubted.map(async (p) => {
    received.set(p.mailbox.id, await hasEverReceived(db, locationId, p.mailbox.address))
  }))

  const out = {}
  for (const p of provisional) {
    const verdict = received.get(p.mailbox.id)
      ? { ...p.verdict, state: 'indirect' }
      : p.verdict
    // The sentences ride along rather than being rebuilt on the client. This
    // module imports node:dns, so a 'use client' component CANNOT import it —
    // shipping the copy with the verdict is what keeps the settings card free
    // of a server-only dependency, and it guarantees the card and the health
    // pane describe the same mailbox the same way.
    out[p.mailbox.id] = { ...verdict, notice: reachabilityNotice(verdict, p.mailbox) }
  }
  return out
}

/**
 * The sentences an operator reads, derived from a verdict.
 *
 * Pure and exported so the copy is asserted by tests rather than scraped out
 * of JSX, and so the settings card and the health pane cannot drift into
 * describing the same mailbox two different ways.
 *
 * Returns null for every state that must render NOTHING — 'ok', 'connected'
 * and 'unknown'. A component can therefore do `notice && <Banner/>` and
 * silence is structural rather than remembered.
 *
 * @param {object} verdict            classifyMailboxReachability output
 * @param {object} mailbox            { address, is_default }
 * @returns {{tone:string, chip:string|null, headline:string, detail:string, remedy:string|null}|null}
 */
export function reachabilityNotice(verdict, mailbox = {}) {
  if (!verdict) return null
  const { state, domain, deliversTo } = verdict
  if (state === 'ok' || state === 'connected' || state === 'unknown') return null

  // Naming the exchange is what makes this checkable rather than something the
  // operator has to take on faith — they can paste the domain into any MX
  // lookup and see the same answer.
  const route = deliversTo
    ? `${domain} delivers its mail to ${deliversTo}, not to this platform.`
    : `${domain} publishes no mail exchanger, so mail sent to it does not reach this platform.`

  if (state === 'indirect') {
    return {
      tone: 'info',
      chip: null,
      headline: 'Mail reaches this account by a route outside the platform',
      detail:
        `${route} Mail has arrived here all the same, so something at the mail host is ` +
        'forwarding it. That forward is not something this platform can see or keep working — ' +
        'if it is ever switched off, mail will stop arriving and nothing here will say so.',
      remedy:
        'Connecting this account\'s mailbox login below removes the dependency: the platform ' +
        'then reads the mailbox directly.',
    }
  }

  // state === 'unreachable'
  const isDefault = !!mailbox.is_default
  return {
    tone: 'error',
    chip: 'Cannot receive',
    headline: 'This address cannot receive mail into the CRM',
    detail:
      `${route} Nothing addressed to this account has ever arrived here, and nothing will: ` +
      'the mail is delivered to whoever runs that domain, in a mailbox this platform has no ' +
      'access to.' +
      (isDefault
        ? ' It is also this studio\'s DEFAULT account, so every campaign and marketing email ' +
          'from here tells members to reply to it. Those replies are being answered by nobody.'
        : ''),
    remedy:
      'Two things fix it. Connect this account\'s mailbox login below and the platform reads it ' +
      'directly, whoever owns the domain' +
      (isDefault
        ? '; or add an address this studio does receive at and make that the default instead.'
        : '; or remove this account if nobody is meant to write to it.'),
  }
}
