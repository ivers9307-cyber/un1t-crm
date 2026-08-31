// MAIL-REFINE.1 §01 — one conversation row of the Mail surface, the approved
// 31 Aug mockup's two-line subject-first row (was MOBILE-MAIL-REDESIGN.B's
// sender+preview row):
//
//   line 1 — sender (semibold) · small muted account tag · time (right).
//   line 2 — SUBJECT in semibold, truncating, then the snippet in subtle
//            grey; the ✓ (our word was last) and 📎 (real stored files) ride
//            in front of it.
//
// Unread = darker ink + the blue dot (a real mail client's signal — the
// weight-only monochrome rule made way for the mockup). Needs reply = the
// AMBER left rail ONLY; its chip is REMOVED (the rail already said it), and
// the mailbox chip row is gone too — the account shrinks to the line-1 tag,
// which ticketToInboxRow already nulls unless the caller can see 2+
// mailboxes. The one chip left is ARCHIVED (search results and the Archived
// view wear it). All of that is one lib verdict — mailRowDisplay in
// mobile/lib/email-tickets.js — so the rail, dot, chip and tag can never
// disagree about one row.
//
// DELIBERATELY BARE: no Swipeable in here. The inbox screen wraps this with
// the archive/read gestures; the search screen renders it as-is (a swipe
// surface inside a results list would fight the keyboard dismissal). That is
// the cross-agent contract — keep the gesture OUT of this file.
//
// `onArchiveToggle`/`archiving` stay on the signature for the callers that
// have no gesture around the row: the verb is exposed as an ACCESSIBILITY
// action ("gestures are an accelerator, never the only door"), and
// `archiving` dims the row while the write is in flight.

import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { requesterLabel, mailRowTime, mailRowMarks, mailRowDisplay } from '../lib/email-tickets'
import { splitHighlight } from '../lib/mail-search'

export default function MailRow({ row, onPress, onArchiveToggle, archiving = false, highlight }) {
  const name = requesterLabel(row)
  const time = mailRowTime(row?.last_message_at)
  const { showCheck, showClip } = mailRowMarks(row)
  const { rail, unread, chip, accountTag } = mailRowDisplay(row)
  const hasHighlight = typeof highlight === 'string' && !!highlight.trim()

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
      {/* Needs reply — the amber rail, same inset geometry as the old ink
          rail, recoloured. The ONLY needs-reply signal on the row now. */}
      {rail ? (
        <View className="absolute left-1.5 top-2.5 bottom-2.5 w-[3px] rounded-full bg-amber-500" />
      ) : null}

      {/* Line 1 — who · which account · when. */}
      <View className="flex-row items-center">
        {unread ? (
          <View className="w-[7px] h-[7px] rounded-full bg-blue-600 mr-1.5" />
        ) : null}
        <Text
          className={`text-[15px] ${unread ? 'font-extrabold text-black' : 'font-semibold text-un1t-text'}`}
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {name}
        </Text>
        {accountTag ? (
          <Text
            className="text-[10px] text-un1t-muted ml-1.5"
            numberOfLines={1}
            // Audit A3 — RN Text defaults flexShrink:0, and the tag falls
            // back to the FULL address when no short label exists: uncapped
            // it collapses the spacer and clips the time on narrow phones.
            style={{ flexShrink: 1, maxWidth: '35%' }}
          >
            {accountTag}
          </Text>
        ) : null}
        <View className="flex-1" />
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

      {/* Line 2 — the SUBJECT leads in bold (the line email has and chat does
          not), the snippet trails in grey. ✓ = our word was last; 📎 = a real
          stored file rode along. On the search screen the matched terms wear
          the ink mark via splitHighlight (mail-search.js, tested there). */}
      <View className="flex-row items-center mt-0.5">
        {showCheck ? (
          <Ionicons name="checkmark" size={12} color="#94A3B8" style={{ marginRight: 4 }} />
        ) : null}
        {showClip ? (
          <Ionicons name="attach-outline" size={12} color="#64748B" style={{ marginRight: 4 }} />
        ) : null}
        {row?.subject ? (
          <Text
            className={`text-[13px] font-semibold ${unread ? 'text-black' : 'text-un1t-text'}`}
            numberOfLines={1}
            style={{ flexShrink: 1, maxWidth: '62%' }}
          >
            {hasHighlight
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
        <Text
          className="text-xs text-un1t-muted flex-1"
          numberOfLines={1}
          style={row?.subject ? { marginLeft: 6 } : undefined}
        >
          {row?.last_message_preview || '—'}
        </Text>
        {/* The one chip left standing: Archived (mailRowDisplay returns it
            for archived rows only — live rows carry no chip at all). */}
        {chip ? (
          <View className={`px-1.5 py-0.5 rounded ml-2 ${chip.cls}`}>
            <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}
