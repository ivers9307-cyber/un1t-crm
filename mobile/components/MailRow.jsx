// MOBILE-MAIL-REDESIGN.B — one conversation row of the Mail surface, the
// approved mockup's §01 row verbatim: flat and edge-to-edge, no avatar, a
// 3px inset ink rail + full-weight black when unread (the brand is
// monochrome, so WEIGHT is the signal — no dots, no counter pills), the ✓
// before the preview when our word was last, the paperclip when a real file
// rode along, then the metaline chips (Needs reply / Archived via
// mailStatusChip — the amber chip is the ONE colour on the screen — and the
// account chip when the caller can see more than one).
//
// DELIBERATELY BARE: no Swipeable in here. The inbox screen wraps this with
// the archive/read gestures; the search screen renders it as-is (a swipe
// surface inside a results list would fight the keyboard dismissal). That is
// the cross-agent contract — keep the gesture OUT of this file.
//
// `onArchiveToggle`/`archiving` stay on the signature for the callers that
// have no gesture around the row: the verb is exposed as an ACCESSIBILITY
// action ("gestures are an accelerator, never the only door" — mockup §02),
// and `archiving` dims the row while the write is in flight. There is no
// visible per-row archive button any more; that is the redesign.
//
// Every branchable decision here (time granularity, which glyphs show, which
// chip) lives in mobile/lib/email-tickets.js where vitest reaches it — this
// file only lays the verdicts out.

import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  requesterLabel, mailStatusChip, mailRowTime, mailRowMarks,
} from '../lib/email-tickets'
import { splitHighlight } from '../lib/mail-search'

export default function MailRow({ row, onPress, onArchiveToggle, archiving = false, highlight }) {
  const name = requesterLabel(row)
  const time = mailRowTime(row?.last_message_at)
  const { showCheck, showClip } = mailRowMarks(row)
  const chip = mailStatusChip(row)
  const unread = row?.unread === true
  // Boolean on purpose: a bare '' leaking into JSX is a hard RN crash
  // ("Text strings must be rendered within a <Text> component").
  const showChips = !!(row?.mailbox_label || chip)

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The archive verb without the gesture: VoiceOver/TalkBack users get it
      // off the rotor even though the visible button is gone.
      accessibilityActions={onArchiveToggle
        ? [{ name: 'archive', label: row?.archived ? 'Move to inbox' : 'Archive' }]
        : undefined}
      onAccessibilityAction={onArchiveToggle
        ? (e) => { if (e.nativeEvent.actionName === 'archive') onArchiveToggle() }
        : undefined}
      className={`bg-un1t-bg border-b border-un1t-border pl-4 pr-3.5 py-3 active:opacity-70 ${archiving ? 'opacity-50' : ''}`}
    >
      {/* The unread rail — 3px of ink, inset from the edge like the mockup. */}
      {unread ? (
        <View className="absolute left-1.5 top-2.5 bottom-2.5 w-[3px] rounded-full bg-un1t-text" />
      ) : null}

      <View className="flex-row items-baseline">
        <Text
          className={`flex-1 text-[15px] text-un1t-text ${unread ? 'font-extrabold' : 'font-medium'}`}
          numberOfLines={1}
        >
          {name}
        </Text>
        {archiving ? (
          <ActivityIndicator size="small" style={{ marginLeft: 8 }} />
        ) : (
          <Text
            className={`ml-2 text-[11px] ${unread ? 'text-un1t-text font-bold' : 'text-un1t-muted'}`}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {time}
          </Text>
        )}
      </View>

      {/* The subject — what the enquiry is ABOUT, above what was last said
          about it. The line email has and chat does not. On the search
          screen the matched terms wear the mockup's ink mark: `highlight`
          is a non-empty query string, and splitHighlight (mail-search.js,
          tested there) hands back segments to nest as styled <Text>. */}
      {row?.subject ? (
        <Text
          className={`text-[13px] mt-0.5 ${unread ? 'font-bold text-un1t-text' : 'text-un1t-subtle'}`}
          numberOfLines={1}
        >
          {typeof highlight === 'string' && highlight.trim()
            ? splitHighlight(row.subject, highlight).map((seg, i) => (
                <Text
                  key={i}
                  className={seg.match ? 'bg-un1t-text text-white rounded-sm px-0.5' : undefined}
                >
                  {seg.text}
                </Text>
              ))
            : row.subject}
        </Text>
      ) : null}

      <View className="flex-row items-center mt-0.5">
        {/* ✓ = "our word was last" — answered mail visibly rests. */}
        {showCheck ? (
          <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
        ) : null}
        {showClip ? (
          <Ionicons name="attach-outline" size={12} color="#64748B" style={{ marginRight: 4 }} />
        ) : null}
        <Text className="text-xs text-un1t-muted flex-1" numberOfLines={1}>
          {row?.last_message_preview || '—'}
        </Text>
      </View>

      {/* Which account it arrived at, and Archived / Needs reply. Own row
          rather than crowding the preview: the mailbox name is the difference
          between a billing query and a sales enquiry, so it must not be the
          thing that truncates. */}
      {showChips && (
        <View className="flex-row items-center mt-1">
          {row?.mailbox_label ? (
            <View className="px-1.5 py-0.5 rounded bg-un1t-border/40 mr-1.5 flex-row items-center">
              <Ionicons name="at-outline" size={10} color="#64748B" style={{ marginRight: 3 }} />
              <Text className="text-[10px] text-un1t-subtle font-medium" numberOfLines={1}>
                {row.mailbox_label}
              </Text>
            </View>
          ) : null}
          {chip ? (
            <View className={`px-1.5 py-0.5 rounded ${chip.cls}`}>
              <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}
