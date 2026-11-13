// MCPEMAIL.1 — /communications/campaigns/approve/[token]: the page a Claude
// test email links to. A press of its one button is the only way a campaign
// an agent prepared is released (POST /api/communications/campaigns/approve/
// [token]).
//
// Signed in only, and deliberately on NO public allowlist: the proxy sends a
// signed-out visitor to /login?redirect=<this path>, and this page does the
// same itself. It sits under /communications, whose layout gates the segment.
// It shows the facts the person tested and the timing the approval carries
// (the page cannot change either). A refusal is one plain sentence; a
// not_found shows nothing about any campaign.
//
// Server component: the client form gets only plain strings (never a function
// prop, which crashes a server→client boundary at render in production).

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  loadApprovalView, approvalRefusalMessage, APPROVABLE_STATUSES, actingAsSomeoneElse, OWN_SESSION_MESSAGE,
} from '@/lib/campaign-approval-view'
import { zoneOfLocation, formatInZone } from '@/lib/location-time'
import { Card } from '@/components/ui'
import CampaignApproveForm from '@/components/CampaignApproveForm'

export const dynamic = 'force-dynamic'

const CAMPAIGNS_HREF = '/communications/sent'
const campaignHref = (id) => `/communications/sent/email/${id}`

function whenIn(at, zone) {
  return formatInZone(at, zone, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
}

function Shell({ children }) {
  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-un1t-text mb-4">Approve an email campaign</h1>
      <Card className="p-6 space-y-4">{children}</Card>
    </div>
  )
}

function Refusal({ text, href, linkLabel }) {
  return (
    <Shell>
      <p className="text-un1t-text">{text}</p>
      <Link href={href} className="text-sm underline text-un1t-text">{linkLabel}</Link>
    </Shell>
  )
}

function Fact({ label, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-4">
      <dt className="text-sm text-un1t-subtle sm:w-44 shrink-0">{label}</dt>
      <dd className="text-un1t-text">{children}</dd>
    </div>
  )
}

export default async function CampaignApprovePage({ params }) {
  const { token } = await params
  const user = await getCurrentUser()
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(`/communications/campaigns/approve/${token}`)}`)
  }

  // Under "View as" the session is the target's: show nothing about the campaign.
  if (actingAsSomeoneElse(user)) {
    return <Refusal text={OWN_SESSION_MESSAGE} href={CAMPAIGNS_HREF} linkLabel="Go to campaigns" />
  }

  let view
  try {
    view = await loadApprovalView(createServerClient(), user, token, Date.now())
  } catch {
    return <Refusal text="This approval could not be checked just now. Reload the page to try again." href={CAMPAIGNS_HREF} linkLabel="Go to campaigns" />
  }

  if (!view.ok) {
    const id = view.reason !== 'not_found' && view.reason !== 'no_permission' ? view.campaign?.id : null
    return (
      <Refusal
        text={approvalRefusalMessage(view)}
        href={id ? campaignHref(id) : CAMPAIGNS_HREF}
        linkLabel={id ? 'Open the campaign in the CRM' : 'Go to campaigns'}
      />
    )
  }

  const { approval, campaign, studio, counts, sendsAs } = view
  const zone = zoneOfLocation(studio)
  const when = approval.send_at ? whenIn(approval.send_at, zone) : null
  const whenLabel = when ? `${when} (${zone})` : null
  const people = counts.eligible === 1 ? '1 person' : `${counts.eligible} people`
  const label = when ? `Schedule for ${when}` : `Send to ${people} now`
  // APPROVECOPY.1 — opening this page releases nothing, and the page did not
  // say so: twice the person opened it and took the send for done.
  const notice = when
    ? 'Nothing has been scheduled yet. Press the button below to schedule it.'
    : 'Nothing has been sent yet. Press the button below to send it.'
  // The stored subject keeps its merge tags; say so, or it reads as broken.
  const subjectHasTags = /\{\{[^{}]+\}\}/.test(campaign.subject || '')
  const releasable = APPROVABLE_STATUSES.includes(campaign.status)

  return (
    <Shell>
      <dl className="space-y-2">
        <Fact label="Campaign">{campaign.name || 'Untitled campaign'}</Fact>
        <Fact label="Subject">
          {campaign.subject}
          {subjectHasTags && (
            <span className="block text-sm text-un1t-subtle">Text in double curly brackets is filled in for each person when it sends.</span>
          )}
        </Fact>
        <Fact label="Studio">{studio.name}</Fact>
        <Fact label="Sends as">{sendsAs || 'The studio\'s default address'}</Fact>
        <Fact label="Timing">{whenLabel || 'As soon as you approve'}</Fact>
        <Fact label="Head count at test">{approval.audience_eligible}</Fact>
        <Fact label="Head count now">{counts.eligible}</Fact>
      </dl>
      {releasable ? (
        <CampaignApproveForm token={token} label={label} whenLabel={whenLabel} notice={notice} />
      ) : (
        <p className="text-un1t-text">This campaign is {campaign.status}, so it can no longer be released from an approval.</p>
      )}
      <Link href={campaignHref(campaign.id)} className="text-sm underline text-un1t-text">Open the campaign in the CRM</Link>
    </Shell>
  )
}
