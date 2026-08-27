// MAILBOX-OAUTH.4 — where a mailbox sign-in comes back.
//
// GET /api/email/oauth/callback?code=…&state=…
//   → 302 back to Settings → Locations → studio → Email, with a message.
//
// ── 🔴 WHY THIS IS NOT UNDER /api/locations/[id]/… WITH ITS SIBLINGS ──────
// Because a redirect URI must match a value registered on the app
// registration BYTE FOR BYTE. The natural home —
// `…/locations/<id>/email/mailboxes/<mailboxId>/oauth/callback` — carries the
// tenant in the path, so every location and every mailbox in the estate would
// need its own registered URI. Microsoft (and Google, and everyone else) will
// not do that.
//
// So this path is fixed for the whole deployment and the location, the mailbox
// and the provider ride INSIDE the signed state. That is exactly the shape
// /api/xero/callback uses (XERO_REDIRECT_URI is one static value; the location
// lives in `state`), and it is the ONLY reason this file is not next to
// ../start.
//
// ── HOW A ROUTE NOBODY AUTHENTICATED IS NEVERTHELESS GUARDED ──────────────
// This is the tricky one, so it is written out. The request arrives as a
// top-level browser navigation that a third party caused. Three independent
// things have to agree before a single row is written, and each covers a
// different failure:
//
//   1. THE SESSION. `getCurrentUser()` + `guardMailboxAdmin(user, locationId)`.
//      A callback IS an ordinary same-site top-level GET, so the session cookie
//      rides along (SameSite=Lax permits exactly this) — /api/xero/callback has
//      depended on that in production since mig 029. So the caller is a real,
//      signed-in, master-or-owner-at-this-location user, and this route needs
//      no `EXEMPT` entry in check:route-guards: it is guarded the ordinary way.
//      What the session CANNOT tell us is which mailbox the flow was for, which
//      is why it is not sufficient on its own.
//   2. THE SIGNATURE. HMAC over the state, keyed on CRON_SECRET. Proves the
//      round trip started at ../start and that the location/mailbox/provider it
//      names were chosen there, not here. This is what stops a signed-in
//      manager— or an owner of ANOTHER studio — hand-crafting a callback URL
//      that binds a mailbox they picked.
//   3. THE COOKIE. The httpOnly value ../start set, compared to the returned
//      state. Redundant with (2) by design: (2) fails if the signing key ever
//      leaks, (3) fails if the browser is not the one that started the flow.
//      Cheap, and neither is a superset of the other.
//
// Then, and only then, guardMailboxAdmin runs AGAIN against the location the
// state names — because a signature proves where a flow started, never that
// the person finishing it is still allowed to.
//
// ── AND THE IDENTITY THAT CAME BACK IS PROVEN, NOT TRUSTED ────────────────
// A consent screen lets the operator sign in as ANY account, including one
// that has nothing to do with this mailbox. Nothing in the token tells us
// which mailbox it opens. So the flow is finished the same way the password
// flow is: VERIFY BEFORE PERSIST — a live IMAP login (and SMTP, since the
// consent covered it) before a single row is written. A token that authenticates
// against the wrong mailbox still connects "successfully" — the address it
// serves is the one the operator picked, and the settings card names it — but a
// token that authenticates against NOTHING is refused while they are still
// looking at the screen rather than five minutes later on a poll.
//
// ── NOTHING HERE LOGS OR REDIRECTS WITH A TOKEN ───────────────────────────
// The `code` is not logged. The tokens are never logged, never put in a query
// parameter and never returned. Every operator-facing sentence is a constant
// from oauth-tokens.js / oauth-providers.js, because these strings land in a
// URL, in browser history, and in `email_mailbox_ingress.last_error`.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'
import { logAuditEvent } from '@/lib/audit'
import { logError, logWarn } from '@/lib/log'
import { isConfigured } from '@/lib/mail/secret-box'
import { resolveAuth } from '@/lib/mail/auth-strategy'
import { verifyConnection } from '@/lib/mail/imap-connection'
import { verifySmtpConnection } from '@/lib/mail/smtp-send'
import {
  resolveOAuthProvider, callbackUrl, verifyState, STATE_COOKIE,
} from '@/lib/mail/oauth-providers'
import {
  exchangeCodeForTokens, oauthTokenColumns,
  OAUTH_DENIED_MESSAGE, OAUTH_ENCRYPTION_MESSAGE,
} from '@/lib/mail/oauth-tokens'
import {
  guardMailboxAdmin, loadMailboxOr404,
} from '../../../locations/[id]/email/mailboxes/_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'email-mailbox-oauth-callback'

/**
 * Where the browser ends up.
 *
 * `?section=email` is the Email tab of the per-location settings page (the
 * page resolves `section` against its own tab list and falls back to Details
 * for anything it does not recognise, so a bad location id degrades to a page
 * rather than to a crash).
 *
 * When the state never verified there is no trustworthy location id, so it
 * falls back to /settings — deliberately NOT to a location id read out of an
 * unverified state, which is the same open-redirect-adjacent mistake as
 * trusting an unverified `return_to`.
 */
function settingsUrl(request, locationId, params = {}) {
  const base = locationId
    ? new URL(`/settings/locations/${locationId}?section=email`, request.url)
    : new URL('/settings', request.url)
  for (const [k, v] of Object.entries(params)) base.searchParams.set(k, v)
  return base
}

/**
 * The same, plus the mailbox id.
 *
 * The Email settings card renders one collapsed connection panel per account.
 * Without the id, an operator coming back from consent lands on a page with six
 * identical closed rows and a message that does not say which of them it is
 * about — and the panel that holds the answer is the one they have to guess.
 * With it, the right panel opens itself and shows the outcome.
 *
 * It is a mailbox id in a URL, which is fine: the page behind it is already
 * gated by guardMailboxAdmin, and the id was already proven to belong to this
 * location before this function is ever reached.
 */
function mailboxSettingsUrl(request, locationId, mailboxId, params = {}) {
  return settingsUrl(request, locationId, { ...params, email_oauth_mailbox: mailboxId })
}

/** Clear the flow cookie whatever happens — a spent state must not be replayable. */
function clearCookie(res) {
  res.cookies.set(STATE_COOKIE, '', { maxAge: 0, path: '/' })
  return res
}

export async function GET(request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const providerError = url.searchParams.get('error')
  const cookieState = request.cookies.get(STATE_COOKIE)?.value

  const user = await getCurrentUser()
  if (!user) {
    // A browser that lost its session mid-flow. Send them to sign in; the
    // consent grant they may have just issued is left standing at the provider
    // and is harmless — nothing here refers to it, and it is revocable from
    // their own account page.
    return clearCookie(NextResponse.redirect(new URL('/login', request.url)))
  }

  const signingSecret = process.env.CRON_SECRET
  if (!signingSecret) {
    logError(MODULE, 'CRON_SECRET is not set — cannot verify an OAuth state')
    return clearCookie(NextResponse.redirect(settingsUrl(request, null, {
      email_oauth_error: 'Mailbox sign-in is not available on this deployment. Nothing has been changed.',
    })))
  }

  // ── (2) THE SIGNATURE, and (3) THE COOKIE. Both, before anything else is
  //    read out of the request. ─────────────────────────────────────────────
  //
  // verifyState returns null for a bad signature, a malformed payload and an
  // expired one alike — deliberately one answer, because a callback that
  // reports "signature fine, payload stale" separately is an oracle and there
  // is nothing an honest caller does differently between the two.
  const state = verifyState(stateParam, signingSecret)
  if (!state || !cookieState || cookieState !== stateParam) {
    logWarn(MODULE, 'oauth callback rejected before any work', {
      signatureOk: !!state, cookiePresent: !!cookieState,
    })
    return clearCookie(NextResponse.redirect(settingsUrl(request, null, {
      email_oauth_error:
        'That mailbox sign-in could not be completed — the link had expired or did not come from this browser. ' +
        'Nothing has been changed. Start again from Settings → Email.',
    })))
  }

  const { locationId, mailboxId, provider: providerKey, profileId } = state

  // ── (1) THE SESSION, re-checked against the location the STATE names ────
  // Not the location in a query parameter, and not "whatever location the
  // caller is currently on". A signature proves where a flow started; it never
  // proves the person finishing it is still permitted. An owner demoted
  // between the redirect and the callback must be refused here.
  const guard = guardMailboxAdmin(user, locationId)
  if (guard) return clearCookie(guard)

  // A DIFFERENT signed-in user finishing somebody else's flow. Both are
  // elevated at this location, so it is not an escalation — but binding a
  // mailbox on the second person's authority while the audit row would name
  // them for a decision the first one made is a state worth refusing rather
  // than recording wrongly.
  if (profileId && profileId !== user.id) {
    logWarn(MODULE, 'oauth callback finished by a different user than started it', { locationId })
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error:
        'That mailbox sign-in was started by a different person signed in to this browser. ' +
        'Nothing has been changed. Start again from Settings → Email.',
    })))
  }

  // The operator (or their admin) declined at the consent screen. Not an
  // error worth logging at error level and not something to retry — it is a
  // person saying no.
  if (providerError) {
    logWarn(MODULE, 'consent was declined at the provider', { locationId, provider: providerKey, code: providerError })
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: OAUTH_DENIED_MESSAGE,
    })))
  }
  if (!code) {
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: OAUTH_DENIED_MESSAGE,
    })))
  }

  // Re-resolved rather than carried in the state: the state says WHICH
  // provider, this says whether this build can still run it and with what
  // client id. A deployment that lost its env var between the redirect and the
  // callback must not proceed on a stale copy.
  const provider = resolveOAuthProvider(providerKey)
  if (!provider.ok) {
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: provider.error,
    })))
  }

  // Checked again here even though ../start checked it, because the two are
  // separate requests and the thing being protected is a customer credential.
  // The cost of asking twice is a string comparison.
  if (!isConfigured()) {
    logError(MODULE, 'MAILBOX_SECRET_KEY is not configured', { locationId })
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: OAUTH_ENCRYPTION_MESSAGE,
    })))
  }

  let appUrl
  try {
    appUrl = getAppUrl()
  } catch {
    logError(MODULE, 'NEXT_PUBLIC_APP_URL is not set — cannot rebuild the redirect URI', { locationId })
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: 'Mailbox sign-in is not available on this deployment. Nothing has been changed.',
    })))
  }

  const db = createServerClient()
  const found = await loadMailboxOr404(db, locationId, mailboxId)
  if (found.response) {
    // 404 as JSON would be an odd thing for a browser navigation to land on,
    // so it becomes a redirect with the same non-committal message. The
    // mailbox was deleted or the state names one at another location — both
    // read as "not there" and neither confirms which.
    return clearCookie(NextResponse.redirect(settingsUrl(request, locationId, {
      email_oauth_error: 'That email account no longer exists. Nothing has been changed.',
    })))
  }
  const mailbox = found.mailbox

  if (!mailbox.active) {
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error:
        'This account is deactivated, so mail sent to it does not route anywhere. Reactivate it first, then connect the mailbox.',
    })))
  }

  // ── The exchange ─────────────────────────────────────────────────────────
  // `redirect_uri` is rebuilt from the same helper ../start used, because the
  // provider compares them and a mismatch surfaces as `invalid_grant` — which
  // reads exactly like a revoked consent and would send an operator chasing
  // their IT department over our configuration.
  const exchanged = await exchangeCodeForTokens({
    config: provider.config,
    code,
    redirectUri: callbackUrl(appUrl),
  })
  if (!exchanged.ok) {
    // The verdict's sentence is already written for an operator and already
    // distinguishes "sign in again" from "we could not reach them". Carried
    // verbatim; never the provider's own body, which on a token endpoint can
    // echo request parameters back.
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error: exchanged.error,
    })))
  }

  // ── VERIFY BEFORE PERSIST ────────────────────────────────────────────────
  // Same order, same reason, and the same two dials as the password route: an
  // inbox that cannot authenticate is worse than no inbox, because it sits
  // there failing every five minutes while the operator believes their mail is
  // arriving.
  //
  // The auth object is built by resolveAuth from a SYNTHETIC row rather than by
  // hand, so the thing verified is byte-identical to the thing the poller will
  // later resolve. Sealing and immediately unsealing looks wasteful and is the
  // point: if the seal/open round trip is broken on this deployment, the
  // failure happens here, in front of a person, and not on a cron at 3am.
  let sealedColumns
  try {
    sealedColumns = oauthTokenColumns(exchanged.tokens)
  } catch {
    logError(MODULE, 'tokens could not be sealed', { locationId, mailboxId })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error: OAUTH_ENCRYPTION_MESSAGE,
    })))
  }

  // The mailbox address is the username. For Microsoft that is what the
  // XOAUTH2 SASL exchange wants — `user=<address>` — and for a SHARED mailbox
  // it is deliberately the shared address rather than the delegate who signed
  // in, which is Microsoft's own documented behaviour for delegated access.
  const username = mailbox.address
  const verdict = resolveAuth({ ...sealedColumns, username })
  if (!verdict.ok) {
    logError(MODULE, 'a freshly-sealed token would not resolve', { locationId, mailboxId, reason: verdict.reason })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error: OAUTH_ENCRYPTION_MESSAGE,
    })))
  }

  const imapVerify = await verifyConnection({
    host: provider.config.imap_host,
    port: provider.config.imap_port,
    secure: provider.config.imap_secure,
    auth: verdict.auth,
  }, 'INBOX')
  if (!imapVerify.ok) {
    // The remote end's own bytes are LOGGED, never returned — the same split
    // the password route makes (MAILBOX-CONNECT.8). Here the host is ours, not
    // the caller's, so it is not an SSRF oracle; it is still a mail server's
    // multi-kilobyte response and it still has no business in a URL an
    // operator can screenshot.
    logWarn(MODULE, 'imap verify failed after consent', {
      locationId, mailboxId, provider: providerKey, error: imapVerify.error,
    })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error:
        `Signing in worked, but ${mailbox.address} could not be opened with it. Check that the account you ` +
        'signed in as owns this address, and that IMAP is switched on for the mailbox — a Microsoft ' +
        'administrator may have to enable it. Nothing has been saved.',
    })))
  }

  // 🔴 SMTP IS VERIFIED, AND ITS FAILURE IS NOT FATAL. Both halves matter.
  //
  // Verified, because the consent already covered SMTP.Send and Phase 7's
  // transport is live — an unverified SMTP leg stored here would sit quietly
  // until the first reply and then fail in front of a member.
  //
  // Not fatal, because receive-over-IMAP-while-replying-through-Postmark is a
  // supported release state (mig 572's `egress` comment), and refusing the
  // whole connection because a tenant's admin has left SMTP AUTH disabled
  // would cost the operator the receiving half they came for. The password
  // route can refuse instead, because there the operator TYPED an SMTP host
  // and can clear the field; here there is no field to clear, so the honest
  // answer is to connect for receiving and say why replies still leave the old
  // way. `egress` follows what was actually proven, exactly as it follows the
  // outgoing-server field on the password path.
  const smtpVerify = await verifySmtpConnection({
    host: provider.config.smtp_host,
    port: provider.config.smtp_port,
    secure: provider.config.smtp_secure,
    auth: verdict.auth,
  })
  if (!smtpVerify.ok) {
    logWarn(MODULE, 'smtp verify failed after consent — connecting for receiving only', {
      locationId, mailboxId, provider: providerKey, error: smtpVerify.error,
    })
  }

  const nowIso = new Date().toISOString()
  const settings = {
    provider: provider.config.key,
    username,
    imap_host: provider.config.imap_host,
    imap_port: provider.config.imap_port,
    imap_secure: provider.config.imap_secure,
    smtp_host: smtpVerify.ok ? provider.config.smtp_host : null,
    smtp_port: smtpVerify.ok ? provider.config.smtp_port : null,
    smtp_secure: provider.config.smtp_secure,
    sent_folder: provider.config.sent_folder,
    updated_at: nowIso,
  }

  // Read for two things and two things only: whether this is a first connect
  // (which action to audit) and whether the ACCOUNT changed (whether to drop
  // the poll cursor). State columns only — a query that does not name a secret
  // cannot leak one, and there is nothing to carry forward here anyway because
  // consent always produces a complete token set.
  const { data: existing, error: existingErr } = await db.from('email_mailbox_credentials')
    .select('mailbox_id, provider, auth_type, username, imap_host, created_at')
    .eq('mailbox_id', mailboxId)
    .maybeSingle()
  if (existingErr) {
    logError(MODULE, 'existing credential read failed', { locationId, mailboxId, error: existingErr.message })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error: 'Could not read this account’s current connection. Nothing has been changed.',
    })))
  }

  // Identity, not settings — the same predicate the password route computes,
  // and computed BEFORE the write for the same reason: the update below
  // overwrites exactly the columns it compares. A watermark belongs to ONE
  // account; keeping it across a change of login silently skips every message
  // at or below it. `auth_type` joins the comparison here because switching a
  // mailbox from an app password to a Microsoft sign-in can change which
  // account is actually being read even when the address is spelled the same.
  const identityChanged =
    !existing ||
    existing.auth_type !== 'oauth' ||
    (existing.username || '') !== username ||
    String(existing.imap_host || '').toLowerCase() !== String(settings.imap_host).toLowerCase()

  // CREDENTIAL FIRST, THEN THE ingress FLIP — the same ordering and the same
  // reasoning as the password route. With the flip first, a failed credential
  // write leaves the poller told to read a mailbox it has no login for.
  if (existing) {
    const { error } = await db.from('email_mailbox_credentials')
      .update({ ...settings, ...sealedColumns })
      .eq('mailbox_id', mailboxId)
    if (error) {
      logError(MODULE, 'credential update failed', { locationId, mailboxId, code: error.code, error: error.message })
      return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
        email_oauth_error: 'Could not save the connection. Nothing has been changed.',
      })))
    }
  } else {
    const { error } = await db.from('email_mailbox_credentials')
      .insert({
        mailbox_id: mailboxId,
        ...settings,
        ...sealedColumns,
        created_by: user.id,
        created_at: nowIso,
      })
    if (error) {
      logError(MODULE, 'credential insert failed', { locationId, mailboxId, code: error.code, error: error.message })
      return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
        email_oauth_error: 'Could not save the connection. Nothing has been changed.',
      })))
    }
  }

  // Audited the moment the credential is on disk, not at the end — the lesson
  // the password route already learned: an audit log that records only the
  // fully-successful path is not an audit log for the cases anyone opens it
  // for. NOTHING SECRET IN `details`; audit_events is read by more people and
  // kept for longer than any other table this feature touches, and it does not
  // even carry a boolean about the token beyond the fact one was issued.
  await logAuditEvent({
    category: 'mutation',
    action: existing
      ? 'email_mailbox_connection.credential_changed'
      : 'email_mailbox_connection.connected',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: `${mailbox.label} <${mailbox.address}>`, resource: `email_mailbox/${mailbox.id}` },
    locationId,
    details: {
      address: mailbox.address,
      provider: settings.provider,
      auth_type: 'oauth',
      username: settings.username,
      imap_host: settings.imap_host,
      smtp_host: settings.smtp_host,
      sent_folder: settings.sent_folder,
      password_changed: true,
      verified: true,
      smtp_verified: smtpVerify.ok,
      cursor_reset: identityChanged,
    },
    request,
  })

  const { error: flipErr } = await db.from('email_mailboxes')
    .update({
      ingress: 'imap',
      egress: smtpVerify.ok ? 'smtp' : 'postmark',
      updated_at: nowIso,
    })
    .eq('id', mailboxId)
    .eq('location_id', locationId)
  if (flipErr) {
    // Loud, and NOT a claim that nothing happened: the sign-in IS stored and IS
    // verified. Telling the operator "could not save" here would send them
    // round the consent loop again for a credential they already banked.
    logError(MODULE, 'ingress flip failed', { locationId, mailboxId, error: flipErr.message })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error:
        'The sign-in was saved and checked, but this account is not receiving over it yet. Sign in once more.',
    })))
  }

  // A VERIFIED SIGN-IN MUST ACTUALLY RESUME POLLING (MAILBOX-CONNECT.8's
  // lesson, and it applies here twice over): the AUTH backoff curve parks a
  // repeatedly-failing mailbox up to 24 hours out, and a revoked grant is
  // precisely what puts it there. Storing a working token while `paused_until`
  // sits a day in the future is a fix the operator cannot see for a day.
  // `last_error` goes with it — a stale reason beside a fresh success is the
  // contradiction that makes an operator distrust the panel; if the account is
  // still broken the very next tick writes it back.
  const resume = {
    consecutive_failures: 0,
    paused_until: null,
    last_error: null,
    updated_at: nowIso,
  }
  if (identityChanged) {
    resume.uidvalidity = null
    resume.last_uid = null
  }
  const { error: resumeErr } = await db.from('email_mailbox_ingress')
    .update(resume)
    .eq('mailbox_id', mailboxId)
  if (resumeErr) {
    logError(MODULE, 'poll resume failed', { locationId, mailboxId, error: resumeErr.message })
    return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
      email_oauth_error:
        'The sign-in was saved and checked, but checking has not been restarted for this account yet. Sign in once more.',
    })))
  }

  return clearCookie(NextResponse.redirect(mailboxSettingsUrl(request, locationId, mailboxId, {
    email_oauth_connected: smtpVerify.ok
      ? `${mailbox.address} is connected. Mail will start arriving within a few minutes, and replies will leave from this address.`
      : `${mailbox.address} is connected for receiving. Sending as this address is not switched on — the mail ` +
        'provider refused the outgoing (SMTP) sign-in, which usually means an administrator has SMTP ' +
        'authentication turned off for the mailbox. Replies keep leaving the standard way until that changes.',
  })))
}
