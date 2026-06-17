// Pure-JS tappable month range picker — NO native module, so it ships
// over-the-air (the +/- date stepper it replaces was a bad UX for dates
// far out; tapping a month header jumps there in one go).
//
// Controlled component: the SELECTED range comes from props
// (startDate/endDate, ISO YYYY-MM-DD); only the VISIBLE month anchor is
// internal state. onChange({ start, end }) fires ISO strings — a single-day
// leave is start === end.
//
// The 7-col grid is built by reusing shared/roster-month.js (the same
// matrix the Today dashboard month view uses) so day/week/in-month/past
// logic can't drift. We pass [] for shifts — we only need the day cells.
// Mobile CANNOT use the web `@shared` alias; relative import is required.

import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { monthBounds, buildMonthMatrix } from '../../shared/roster-month'

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// "Mon 5 May 2026" — anchor on midday local so the label can't slip a day.
function pretty(iso) {
  if (!iso) return '—'
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

// "May 2026" header.
function monthLabel(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'long', year: 'numeric',
  })
}

// First day of the month N months away from the anchor's month.
function shiftMonth(anchorIso, delta) {
  const d = new Date(anchorIso + 'T12:00:00')
  const next = new Date(d.getFullYear(), d.getMonth() + delta, 1, 12)
  const y = next.getFullYear()
  const m = String(next.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

export default function MonthCalendar({ startDate, endDate, minDate, onChange }) {
  // Visible month anchors on the current selection start, else today.
  const todayIso = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const [anchor, setAnchor] = useState(startDate || minDate || todayIso)

  const { monthStartIso, monthEndIso } = monthBounds(anchor)
  const weeks = buildMonthMatrix(monthStartIso, monthEndIso, [], todayIso)

  // Don't allow paging to a month entirely before minDate's month.
  const canGoPrev = !minDate || monthStartIso > minDate

  function goPrev() {
    if (!canGoPrev) return
    setAnchor(shiftMonth(anchor, -1))
  }
  function goNext() {
    setAnchor(shiftMonth(anchor, 1))
  }

  function tap(iso) {
    // Disabled days never reach here (Pressable disabled), but guard anyway.
    if (minDate && iso < minDate) return
    // No start yet, or a full range already chosen → start fresh.
    if (!startDate || (startDate && endDate)) {
      onChange({ start: iso, end: null })
      return
    }
    // start set, no end: extend forward, or restart if before start.
    if (iso >= startDate) {
      onChange({ start: startDate, end: iso })
    } else {
      onChange({ start: iso, end: null })
    }
  }

  function cellState(iso, inMonth) {
    const disabled = !inMonth || (minDate && iso < minDate)
    const isStart = startDate && iso === startDate
    const isEnd = endDate && iso === endDate
    const inRange =
      startDate && endDate && iso > startDate && iso < endDate
    return { disabled, isStart, isEnd, inRange, selected: isStart || isEnd }
  }

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-xl overflow-hidden">
      {/* Month header — ‹  Month YYYY  › */}
      <View className="flex-row items-center justify-between px-3 py-3 border-b border-un1t-border">
        <Pressable
          onPress={goPrev}
          disabled={!canGoPrev}
          hitSlop={10}
          className="p-1"
        >
          <Ionicons
            name="chevron-back"
            size={22}
            color={canGoPrev ? '#111827' : '#CBD5E1'}
          />
        </Pressable>
        <Text className="text-base font-semibold text-un1t-text">
          {monthLabel(monthStartIso)}
        </Text>
        <Pressable onPress={goNext} hitSlop={10} className="p-1">
          <Ionicons name="chevron-forward" size={22} color="#111827" />
        </Pressable>
      </View>

      {/* Weekday header (Mon-start) */}
      <View className="flex-row px-2 pt-2">
        {WEEKDAY_LABELS.map((d, i) => (
          <View key={i} className="flex-1 items-center py-1">
            <Text className="text-xs font-medium text-un1t-muted">{d}</Text>
          </View>
        ))}
      </View>

      {/* Day grid */}
      <View className="px-2 pb-2">
        {weeks.map((week, wIdx) => (
          <View key={wIdx} className="flex-row">
            {week.map(day => {
              const { disabled, isStart, isEnd, inRange, selected } =
                cellState(day.iso, day.inMonth)
              return (
                <Pressable
                  key={day.iso}
                  onPress={() => tap(day.iso)}
                  disabled={disabled}
                  className="flex-1 items-center py-1"
                >
                  <View
                    className={`w-9 h-9 items-center justify-center rounded-full ${
                      selected
                        ? 'bg-blue-500'
                        : inRange
                        ? 'bg-blue-500/15'
                        : ''
                    }`}
                  >
                    <Text
                      className={`text-sm ${
                        selected
                          ? 'text-white font-semibold'
                          : !day.inMonth || disabled
                          ? 'text-un1t-muted/50'
                          : inRange
                          ? 'text-blue-700 font-medium'
                          : day.isToday
                          ? 'text-blue-600 font-semibold'
                          : 'text-un1t-text'
                      }`}
                    >
                      {day.dayNum}
                    </Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        ))}
      </View>

      {/* Footer — From … · To … */}
      <View className="px-4 py-3 border-t border-un1t-border">
        <Text className="text-sm text-un1t-subtle">
          From <Text className="text-un1t-text font-medium">{pretty(startDate)}</Text>
          {'  ·  '}
          To <Text className="text-un1t-text font-medium">{pretty(endDate || startDate)}</Text>
        </Text>
      </View>
    </View>
  )
}
