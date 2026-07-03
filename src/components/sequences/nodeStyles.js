// FLOW-GRAPH Phase 2 — shared per-type presentation for the builder. Icons +
// light-theme tint chips (literal class strings so Tailwind keeps them) + the
// palette of types an operator can add. The pure one-line summaries live in
// src/lib/sequences/graph/view.js (describeNode); this is the visual half.
import {
  Mail, MessageCircle, MessageSquare, Hourglass, Tag, PencilLine,
  ClipboardList, Webhook, GitBranch, ArrowRightCircle, CircleDot, UserPlus,
} from 'lucide-react'

export const NODE_STYLES = {
  email: { icon: Mail, chip: 'bg-blue-500/10 text-blue-700', label: 'Email' },
  whatsapp: { icon: MessageCircle, chip: 'bg-green-500/10 text-green-700', label: 'WhatsApp' },
  sms: { icon: MessageSquare, chip: 'bg-cyan-500/10 text-cyan-700', label: 'SMS' },
  wait: { icon: Hourglass, chip: 'bg-un1t-border/50 text-un1t-subtle', label: 'Wait' },
  apply_tag: { icon: Tag, chip: 'bg-amber-500/10 text-amber-700', label: 'Apply tag' },
  update_field: { icon: PencilLine, chip: 'bg-indigo-500/10 text-indigo-700', label: 'Update field' },
  internal_task: { icon: ClipboardList, chip: 'bg-sky-500/10 text-sky-700', label: 'Internal task' },
  webhook: { icon: Webhook, chip: 'bg-fuchsia-500/10 text-fuchsia-700', label: 'Webhook' },
  branch: { icon: GitBranch, chip: 'bg-purple-500/10 text-purple-700', label: 'Branch' },
  // RETIRED (FUNNEL.1) — not addable (see ADDABLE_TYPES); style kept so
  // legacy drafts containing the node still render a labelled card.
  move_pipeline_stage: { icon: ArrowRightCircle, chip: 'bg-un1t-border/50 text-un1t-subtle', label: 'Move pipeline (retired)' },
  glofox_provision: { icon: UserPlus, chip: 'bg-teal-500/10 text-teal-700', label: 'Create in Glofox' },
}

export function styleForType(type) {
  return NODE_STYLES[type] || { icon: CircleDot, chip: 'bg-un1t-border/40 text-un1t-subtle', label: type }
}

// Types an operator can add in the linear builder. `branch` is excluded here —
// branch authoring (two-lane wiring) lands in the next PR; existing branchy
// graphs render read-only until then. `move_pipeline_stage` was retired in
// FUNNEL.1 (stage is classifier-derived; the executor no-ops).
export const ADDABLE_TYPES = [
  'email', 'whatsapp', 'sms', 'wait',
  'apply_tag', 'update_field', 'internal_task', 'glofox_provision', 'webhook',
]
