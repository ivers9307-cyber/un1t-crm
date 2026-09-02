// /account — self-service account preferences.
//
// Currently exposes:
//   - Default landing page (permissions.landing_preference)
//   - Email signature (profiles.email_signature, EMAIL-TICKET.5) —
//     only for people who work an email queue somewhere
//
// Linked to from the user block at the bottom of the sidebar.
// Visible to every authenticated user — no permission gate beyond
// "logged in". Sub-pages (e.g. /account/access-history) hang off
// this route segment.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight, History, FileSignature } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { resolveLandingPreference } from '@shared/permissions'
import { createServerClient } from '@/lib/supabase'
import AccountForm from '@/components/AccountForm'
import EmailSignatureForm from '@/components/EmailSignatureForm'
import PasswordChangeForm from '@/components/PasswordChangeForm'
import StudioPinSettings from '@/components/StudioPinSettings'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Compute which landing options are reachable for this user at
  // their active location. Disabled options still render so users
  // can see what exists, but they can't pick something they have no
  // permission for.
  const allowed = {
    auto: true, // always available
    personal: hasPermission(user, 'dashboard_personal'),
    studio:   hasPermission(user, 'dashboard_studio'),
    business: hasPermission(user, 'dashboard_business'),
  }

  const currentPreference = resolveLandingPreference(user)

  // EMAIL-TICKET.5 — the signature card is only useful to someone who
  // answers a ticket queue, so it shows for anyone holding email_inbox
  // at ANY of their locations. Resolved per location rather than via
  // plain hasPermission() on purpose: a manager at one studio who is
  // staff at another would otherwise lose the editor for their own
  // signature whenever their session happened to be pointed at the
  // second one — the same active-vs-requested mix-up EMAIL-TICKET.5
  // fixed on /api/email/tickets.
  const worksAQueue = (user.locations || []).some(
    (l) => hasPermissionForLocation(user, l.id, 'email_inbox')
  )

  // STUDIO-PIN.3 — pull PIN state + home_screen_path for the studio-
  // device settings card. Single targeted read; the rest of the user
  // object is already loaded by getCurrentUser.
  const db = createServerClient()
  const { data: pinInfo } = await db
    .from('profiles')
    .select('pin_hash, pin_set_at, home_screen_path')
    .eq('id', user.id)
    .single()

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Account</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Personal preferences for {user.email}.
        </p>
      </div>

      <AccountForm
        initialPreference={currentPreference}
        allowed={allowed}
      />

      {worksAQueue && (
        <div className="mt-8">
          {/* getCurrentUser() spreads the whole profiles row, so both the
              plain column and the MAIL-SIG.1 rich JSONB are already loaded —
              no extra read. */}
          <EmailSignatureForm
            initialSignature={user.email_signature || ''}
            initialRich={user.email_signature_rich || null}
          />
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-un1t-border">
        <PasswordChangeForm email={user.email} />
      </div>

      <div className="mt-8">
        <StudioPinSettings
          hasPinSet={Boolean(pinInfo?.pin_hash)}
          pinSetAt={pinInfo?.pin_set_at || null}
          homeScreenPath={pinInfo?.home_screen_path || '/dashboard'}
        />
      </div>

      <div className="mt-8 pt-6 border-t border-un1t-border">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">
          More
        </h2>
        <div className="space-y-2">
          <Link
            href="/account/contracts"
            className="flex items-center justify-between p-4 rounded-xl bg-un1t-surface border border-un1t-border hover:border-un1t-subtle transition-colors"
          >
            <div className="flex items-center gap-3">
              <FileSignature size={18} className="text-un1t-subtle" />
              <div>
                <div className="text-sm font-medium text-un1t-text">Your contracts</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  Review and sign documents UN1T has issued you
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle" />
          </Link>
          <Link
            href="/account/access-history"
            className="flex items-center justify-between p-4 rounded-xl bg-un1t-surface border border-un1t-border hover:border-un1t-subtle transition-colors"
          >
            <div className="flex items-center gap-3">
              <History size={18} className="text-un1t-subtle" />
              <div>
                <div className="text-sm font-medium text-un1t-text">Access history</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  See if anyone has impersonated your account
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle" />
          </Link>
        </div>
      </div>
    </div>
  )
}
