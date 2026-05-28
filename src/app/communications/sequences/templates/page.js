// /communications/sequences/templates — flow templates gallery.
//
// Operator-facing browse-and-install surface for the pre-built
// sequence recipes in src/lib/sequence-templates.js. Server-
// rendered list of cards grouped by category; each card has an
// "Install" button that clones the template into a fresh draft
// sequence and lands the operator in the editor.
//
// The older SequenceTemplatePicker modal on the sequences list
// still works for muscle-memory; this page is the discoverable
// home for templates so operators can scan + compare without
// being inside the modal.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft, Zap, Mail, MessageSquare, Phone, Clock, GitBranch, Tag, ClipboardList, Webhook, ArrowRightCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { SEQUENCE_TEMPLATES, TEMPLATE_CATEGORIES } from '@/lib/sequence-templates'
import InstallTemplateButton from '@/components/InstallTemplateButton'

export const dynamic = 'force-dynamic'

// Pretty-print the snake_case trigger_type values used internally
// into something readable. Mirrors the labels in
// /communications/sequences/page.js — keep these in sync when new
// triggers are added.
const triggerLabels = {
  manual: 'Manually enrolled',
  booking_created: 'Any booking made',
  first_booking: 'First-ever booking',
  status_change: 'Contact status changes',
  event_reminder: 'Before a booked event',
  tag_added: 'Tag is added',
  race_registered: 'Race signup',
  race_finished: 'Race finished',
  order_completed: 'Order completed',
  order_failed: 'Order payment failed',
  order_abandoned: 'Order abandoned',
  anniversary: 'Yearly anniversary',
  inactivity: 'Member goes quiet',
  achievement_unlocked: 'Heart-rate achievement',
  // FLOW2 (mig 131) — inbound webhook trigger.
  webhook: 'External webhook POST',
}

// Map step_type → { icon, label } for the per-template steps
// summary. Kept inline (not on the step object) so adding a new
// step type to sequences/steps.js doesn't force a schema change
// here; unknown types fall through to a generic chip.
const stepMeta = {
  email:         { icon: Mail,          label: 'Email' },
  sms:           { icon: Phone,         label: 'SMS' },
  whatsapp:      { icon: MessageSquare, label: 'WhatsApp' },
  wait:          { icon: Clock,         label: 'Wait' },
  branch:        { icon: GitBranch,     label: 'Branch' },
  apply_tag:     { icon: Tag,           label: 'Tag' },
  update_field:  { icon: Tag,           label: 'Set field' },
  internal_task: { icon: ClipboardList, label: 'Task' },
  webhook:       { icon: Webhook,       label: 'Webhook' },
  // GLOFOX4.3 — move the contact's open deal to a target pipeline
  // stage. Templates use this to "graduate" trial members on signal.
  move_pipeline_stage: { icon: ArrowRightCircle, label: 'Move pipeline' },
}

export default async function FlowTemplatesGallery() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Same permission gate as the sequences list page — operators
  // who can manage email sequences can install templates.
  if (!hasPermission(user, 'email')) redirect('/communications')

  // Group templates by category, preserving the order declared in
  // TEMPLATE_CATEGORIES. Anything with a category not in the list
  // ends up in a trailing "Other" bucket so it's still visible.
  const groups = new Map()
  for (const cat of TEMPLATE_CATEGORIES) groups.set(cat, [])
  for (const t of SEQUENCE_TEMPLATES) {
    const cat = TEMPLATE_CATEGORIES.includes(t.category) ? t.category : 'Other'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(t)
  }
  // Drop empty categories so we don't render headers with no cards.
  const visibleGroups = [...groups.entries()].filter(([, list]) => list.length > 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link
            href="/communications/sequences"
            className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text mb-2"
          >
            <ChevronLeft size={12} /> Back to sequences
          </Link>
          <h2 className="text-lg font-semibold">Flow templates</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">
            Pre-built automation recipes. Install one, then edit it like any other sequence — triggers, steps, copy, timing all yours to change.
          </p>
        </div>
      </div>

      <div className="space-y-8">
        {visibleGroups.map(([cat, items]) => (
          <section key={cat}>
            <div className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-3">{cat}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {items.map((t) => (
                <TemplateCard key={t.id} template={t} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function TemplateCard({ template }) {
  // Build a compact summary of the steps as a row of chips.
  const stepChips = (template.steps || []).map((s, i) => {
    const meta = stepMeta[s.step_type] || { icon: Zap, label: s.step_type }
    const Icon = meta.icon
    return (
      <span
        key={i}
        className="inline-flex items-center gap-1 bg-un1t-bg border border-un1t-border rounded px-1.5 py-0.5 text-[10px] text-un1t-subtle"
        title={`Step ${i + 1}: ${meta.label}${(s.delay_days || s.delay_hours) ? ` after ${formatDelay(s)}` : ''}`}
      >
        <Icon size={10} /> {meta.label}
      </span>
    )
  })

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-xl p-4 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-un1t-text leading-snug">{template.name}</h3>
          <p className="text-[11px] text-un1t-muted mt-0.5">
            Fires: {triggerLabels[template.trigger_type] || template.trigger_type.replace(/_/g, ' ')}
          </p>
        </div>
      </div>

      <p className="text-xs text-un1t-subtle leading-relaxed mb-3 flex-1">
        {template.description}
      </p>

      <div className="flex flex-wrap gap-1 mb-3">
        {stepChips}
      </div>

      <div className="flex items-center justify-between gap-2 mt-auto pt-3 border-t border-un1t-border">
        <span className="text-[11px] text-un1t-muted">
          {(template.steps || []).length} step{(template.steps || []).length === 1 ? '' : 's'}
        </span>
        <InstallTemplateButton templateId={template.id} templateName={template.name} />
      </div>
    </div>
  )
}

function formatDelay(step) {
  const parts = []
  if (step.delay_days) parts.push(`${step.delay_days}d`)
  if (step.delay_hours) parts.push(`${step.delay_hours}h`)
  if (step.delay_minutes) parts.push(`${step.delay_minutes}m`)
  return parts.join(' ') || 'immediately'
}
