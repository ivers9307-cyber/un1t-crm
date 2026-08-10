// COMMS-IA.1 — the ONE header for every send-detail view.
//
// Before the consolidation the three channel detail views exited the Sends
// table into three unrelated chromes: SMS rendered inside the /communications
// shell behind a text back-link, WhatsApp rendered bare outside the shell, and
// email took over the full viewport with its own top bar. Three headers, three
// back-links, three sets of spacing, all drifting independently.
//
// All three now live under /communications/sent/[channel]/[id] and render this
// header, so the shell, the breadcrumb, the back-link and the channel label
// are defined once. What stays per-channel is the BODY below it: a WhatsApp
// drip, an SMS broadcast and an email campaign genuinely report different
// things, and pretending otherwise would cost more than the duplication did.
//
// `title` and `actions` are slots rather than strings because two of the three
// bodies edit the record's name in place — the name field is a control that
// belongs to the body's own form state, not chrome this component can own.

import Link from 'next/link'
import { ArrowLeft, Mail, MessageCircle, MessageSquare } from 'lucide-react'

export const SEND_CHANNELS = {
  sms: { label: 'SMS', Icon: MessageSquare },
  whatsapp: { label: 'WhatsApp', Icon: MessageCircle },
  email: { label: 'Email', Icon: Mail },
}

export default function SendDetailHeader({ channel, title, status = null, meta = null, actions = null }) {
  const { label, Icon } = SEND_CHANNELS[channel] || SEND_CHANNELS.email

  return (
    <div className="border-b border-un1t-border pb-4 mb-5">
      {/* COMMSLAYOUT.4 kept this pointing straight at the list the user came
          from, with no retired-stub hop in between. Still true, now in one
          place instead of four. */}
      <Link
        href="/communications/sent"
        className="inline-flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text"
      >
        <ArrowLeft size={13} /> Back to Sent
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mt-2">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <span className="inline-flex items-center gap-1.5 shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-un1t-border/40 text-un1t-subtle">
            <Icon size={12} /> {label}
          </span>
          <div className="min-w-0">{title}</div>
          {status}
        </div>
        {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
      </div>

      {meta ? <div className="mt-1.5">{meta}</div> : null}
    </div>
  )
}
