// /communications/templates — combined email + WhatsApp templates.
//
// Single page with a channel filter at the top. Email and WhatsApp
// templates have very different shapes (HTML/JSON vs Meta-approved
// template+variables) so each channel keeps its own editor, at
// /communications/templates/email/* and /communications/templates/
// whatsapp/* — full-screen surfaces in the (editors) route group,
// outside this (hub) chrome.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, Mail, MessageCircle } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import WhatsappTemplatesList from '@/components/WhatsappTemplatesList'

export const dynamic = 'force-dynamic'

export default async function TemplatesListPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  if (!canEmail && !canWhatsapp) redirect('/communications')

  // Filter: 'all' | 'email' | 'whatsapp'. Default 'all' when both
  // perms present, else lock to the one available.
  const requested = searchParams?.channel
  const channel = canEmail && canWhatsapp
    ? (requested === 'email' || requested === 'whatsapp' ? requested : 'all')
    : (canEmail ? 'email' : 'whatsapp')

  const db = createServerClient()
  const locationId = user.activeLocation?.id
  // WATPLROLE.1 — creating, resubmitting and deleting a WhatsApp template
  // decide MANAGER_ROLES at the location (the routes' rule); this list is the
  // active studio's, so that is where it is judged. Nobody else is offered them.
  // GATES-3 (b) — the routes' one rule: MANAGER_ROLES AND `whatsapp` there.
  const canManageWaTemplates = canWhatsapp && canManageWaTemplatesAt(user, locationId)

  const [emailRes] = await Promise.all([
    canEmail && (channel === 'all' || channel === 'email')
      ? db.from('email_templates').select('id, name, subject, updated_at').eq('location_id', locationId).order('updated_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  const filters = [
    canEmail && canWhatsapp && { key: 'all', label: 'All' },
    canEmail && { key: 'email', label: 'Email' },
    canWhatsapp && { key: 'whatsapp', label: 'WhatsApp' },
  ].filter(Boolean)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">Reusable email + WhatsApp content</p>
        </div>
        <div className="flex gap-2">
          {canEmail && (
            <Link
              href="/communications/templates/email/new"
              className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-3 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
            >
              <Plus size={14} /> Email
            </Link>
          )}
          {canManageWaTemplates && (
            <Link
              href="/communications/templates/whatsapp/new"
              className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-3 py-2 rounded-lg hover:bg-un1t-accent transition-colors"
            >
              <Plus size={14} /> WhatsApp
            </Link>
          )}
        </div>
      </div>

      {filters.length > 1 && (
        <div className="flex gap-2 mb-4">
          {filters.map(f => (
            <Link
              key={f.key}
              href={`/communications/templates${f.key !== 'all' ? `?channel=${f.key}` : ''}`}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                channel === f.key
                  ? 'bg-un1t-text text-un1t-bg'
                  : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      )}

      {(channel === 'all' || channel === 'email') && (emailRes.data?.length ?? 0) > 0 && (
        <section className="mb-6">
          {channel === 'all' && (
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 inline-flex items-center gap-2">
              <Mail size={12} /> Email
            </h3>
          )}
          <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
            {emailRes.data.map(t => (
              <Link
                key={`e-${t.id}`}
                href={`/communications/templates/email/${t.id}`}
                className="flex items-center justify-between px-5 py-3 hover:bg-un1t-border/20"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
                    {/* COMMSLAYOUT.5 — -700 on the light `bg-blue-500/15` tile;
                        -400 was the dark-theme ramp and barely showed. */}
                    <Mail size={16} className="text-blue-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <p className="text-xs text-un1t-subtle truncate">{t.subject || 'No subject'}</p>
                  </div>
                </div>
                <span className="text-[11px] text-un1t-muted">{new Date(t.updated_at).toLocaleDateString()}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* EMPTYSTATES.1 — an email channel with no templates said nothing at all
          when WhatsApp templates were also shown. Say what a template is for
          and where to start. */}
      {canEmail && (channel === 'all' || channel === 'email') && !emailRes.error && (emailRes.data?.length ?? 0) === 0 && (
        <section className="mb-6">
          <div className="bg-un1t-surface border border-dashed border-un1t-border rounded-2xl p-8 text-center">
            <Mail size={24} className="mx-auto mb-2 text-un1t-subtle" />
            <h3 className="text-base font-semibold text-un1t-text mb-1">Start your first email template</h3>
            <p className="text-sm text-un1t-subtle max-w-md mx-auto mb-4">
              Design an email once with your studio&apos;s logo and colours, then start any campaign or automation
              email from it instead of a blank page.
            </p>
            <Link href="/communications/templates/email/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-un1t-text text-un1t-bg px-3 py-2 text-sm font-medium hover:bg-un1t-accent">
              New email template
            </Link>
          </div>
        </section>
      )}

      {(channel === 'all' || channel === 'whatsapp') && canWhatsapp && (
        <section className="mb-6">
          {channel === 'all' && (
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 inline-flex items-center gap-2">
              <MessageCircle size={12} /> WhatsApp
            </h3>
          )}
          <div className="bg-un1t-surface border border-un1t-border rounded-2xl">
            <WhatsappTemplatesList locationId={locationId} canManage={canManageWaTemplates} />
          </div>
        </section>
      )}

    </div>
  )
}
