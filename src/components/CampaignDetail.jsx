'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Mail, Eye, MousePointerClick, AlertTriangle,
  Ban, Send, CheckCircle2, XCircle, Users
} from 'lucide-react'

const recipientStatusConfig = {
  sent:      { label: 'Sent',       icon: Send,            color: 'text-blue-400' },
  delivered: { label: 'Delivered',  icon: CheckCircle2,    color: 'text-green-400' },
  opened:    { label: 'Opened',     icon: Eye,             color: 'text-emerald-400' },
  clicked:   { label: 'Clicked',    icon: MousePointerClick, color: 'text-cyan-400' },
  bounced:   { label: 'Bounced',    icon: XCircle,         color: 'text-red-400' },
  failed:    { label: 'Failed',     icon: AlertTriangle,   color: 'text-red-400' },
  complained:{ label: 'Complained', icon: Ban,             color: 'text-orange-400' },
}

function StatCard({ icon: Icon, label, value, subValue, color }) {
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={color || 'text-un1t-light'} />
        <span className="text-xs text-un1t-light uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subValue && <p className="text-xs text-un1t-mid mt-0.5">{subValue}</p>}
    </div>
  )
}

export default function CampaignDetail({ campaign, recipients = [], locationId: _locationId, userId: _userId }) {
  const router = useRouter()
  const [tab, setTab] = useState('overview')  // overview, recipients, preview
  const isDraft = campaign.status === 'draft'

  // If draft, redirect to editor
  if (isDraft) {
    // Dynamic import — rendered from the page, just redirect
    router.replace(`/email/campaigns/${campaign.id}?edit=1`)
    return null
  }

  const totalSent = campaign.total_sent || campaign.total_recipients || 0
  const totalOpened = campaign.total_opened || 0
  const totalClicked = campaign.total_clicked || 0
  const totalBounced = campaign.total_bounced || 0
  const openRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0'
  const clickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : '0'
  const bounceRate = totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : '0'

  const sentDate = campaign.sent_at
    ? new Date(campaign.sent_at).toLocaleDateString('en-IE', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : 'Not sent yet'

  const tabs = [
    { key: 'overview',   label: 'Overview' },
    { key: 'recipients', label: `Recipients (${totalSent})` },
    { key: 'preview',    label: 'Preview' },
  ]

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray bg-un1t-dark shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/email" className="text-un1t-light hover:text-un1t-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-lg font-semibold">{campaign.name}</h2>
            <p className="text-xs text-un1t-light">{campaign.subject || 'No subject'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-un1t-light">{sentDate}</span>
          <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">
            Sent
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-un1t-gray bg-un1t-dark shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'text-un1t-white border-un1t-white'
                : 'text-un1t-light border-transparent hover:text-un1t-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'overview' && (
          <div className="p-6 space-y-6">
            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Send}              label="Sent"       value={totalSent} />
              <StatCard icon={Eye}               label="Opened"     value={totalOpened}  subValue={`${openRate}% open rate`}   color="text-emerald-400" />
              <StatCard icon={MousePointerClick} label="Clicked"    value={totalClicked} subValue={`${clickRate}% click rate`} color="text-cyan-400" />
              <StatCard icon={AlertTriangle}     label="Bounced"    value={totalBounced} subValue={`${bounceRate}% bounce rate`} color="text-red-400" />
            </div>

            {/* Campaign details */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">Campaign Details</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-un1t-mid">From</span>
                  <p>{campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email || '—'}</p>
                </div>
                <div>
                  <span className="text-un1t-mid">Reply To</span>
                  <p>{campaign.reply_to || 'Same as From'}</p>
                </div>
                <div>
                  <span className="text-un1t-mid">Preview Text</span>
                  <p>{campaign.preview_text || '—'}</p>
                </div>
                <div>
                  <span className="text-un1t-mid">Total Recipients</span>
                  <p>{campaign.total_recipients || totalSent}</p>
                </div>
              </div>
            </div>

            {/* Audience filter summary */}
            {campaign.audience_filter?.filters?.length > 0 && (
              <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
                <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider mb-3">Audience Filters</h3>
                <div className="space-y-1.5">
                  {campaign.audience_filter.filters.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {i > 0 && (
                        <span className="text-xs text-un1t-mid font-medium uppercase">
                          {campaign.audience_filter.logic || 'and'}
                        </span>
                      )}
                      <span className="text-un1t-white">{f.field.replace(/_/g, ' ')}</span>
                      <span className="text-un1t-mid">{f.op.replace(/_/g, ' ')}</span>
                      {!['is_null', 'not_null'].includes(f.op) && (
                        <span className="text-blue-400">{f.value}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'recipients' && (
          <div className="p-6">
            {recipients.length === 0 ? (
              <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
                <Users size={32} className="mx-auto mb-3 text-un1t-light" />
                <p className="text-sm text-un1t-light">No recipient data available yet</p>
              </div>
            ) : (
              <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-un1t-gray text-left text-xs text-un1t-light uppercase tracking-wider">
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Sent</th>
                      <th className="px-4 py-3">Opened</th>
                      <th className="px-4 py-3">Clicked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-un1t-gray">
                    {recipients.map(r => {
                      const config = recipientStatusConfig[r.status] || recipientStatusConfig.sent
                      const StatusIcon = config.icon
                      const contact = r.contacts

                      return (
                        <tr key={r.id} className="hover:bg-un1t-gray/20 transition-colors">
                          <td className="px-4 py-3">
                            <div>
                              <Link
                                href={`/contacts/${r.contact_id}`}
                                className="text-un1t-white hover:underline"
                              >
                                {contact?.name || 'Unknown'}
                              </Link>
                              <p className="text-xs text-un1t-mid">{contact?.email || r.contact_id}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`flex items-center gap-1.5 text-xs ${config.color}`}>
                              <StatusIcon size={12} />
                              {config.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-light">
                            {r.sent_at ? new Date(r.sent_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-light">
                            {r.opened_at ? new Date(r.opened_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-light">
                            {r.clicked_at ? new Date(r.clicked_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'preview' && (
          <div className="p-6">
            <div className="max-w-3xl mx-auto">
              <div className="bg-white rounded-lg overflow-hidden shadow-lg">
                {/* Email header bar */}
                <div className="bg-gray-100 px-4 py-3 border-b text-xs text-gray-600 space-y-1">
                  <p><strong>From:</strong> {campaign.from_name || 'UN1T'} &lt;{campaign.from_email || '...'}&gt;</p>
                  <p><strong>Subject:</strong> {campaign.subject || '(no subject)'}</p>
                  {campaign.preview_text && <p><strong>Preview:</strong> {campaign.preview_text}</p>}
                </div>
                {/* Email body */}
                {campaign.html_content ? (
                  <iframe
                    srcDoc={campaign.html_content}
                    title="Email preview"
                    className="w-full border-0"
                    style={{ minHeight: '600px' }}
                    sandbox="allow-same-origin"
                  />
                ) : (
                  <div className="p-12 text-center text-gray-400">
                    <Mail size={40} className="mx-auto mb-3" />
                    <p>No email content</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
