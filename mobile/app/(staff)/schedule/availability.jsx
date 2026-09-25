// Modal: My availability (AVAIL.2).
//
// When the coach CANNOT work: weekly (a day, all day or a window) and by date
// (one day or a range, all day or a window), each with an optional note their
// managers see. One PUT /api/schedule/availability saves the lot and REPLACES
// what was stored (AVAIL.1a); the managers at each of their studios are told
// once per save, inside 07:00-22:00. No approval.
//
// Every decision and every word is in lib/availability-form.js (there is no
// RN component test runner); this file renders. Dates use the pure-JS
// MonthCalendar and times a typed field (the AdjustSheet pattern on the
// Schedule tab): no native picker, so the screen ships over the air.

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useNavigation, Stack } from 'expo-router'
import { useHeaderHeight, usePreventRemove } from 'expo-router/react-navigation'
import {
  View, Text, Pressable, ScrollView, TextInput, Switch, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, AccessibilityInfo,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { getMyAvailability, saveMyAvailability } from '../../../lib/availability-api'
import {
  AVAILABILITY_COPY as COPY, AVAILABILITY_TITLE, AVAILABILITY_INTRO, AVAILABILITY_NO_OVERNIGHT, WEEKDAY_CHIPS,
  createRowKeys, rowsFromServer, newRow, timeOnBlur, datesLabel, calendarRange, rangeFromCalendar,
  hasEnded, isStarted, startedRules, formProblems, duplicateKeys, canAdd, startedNote, rowSummary,
  buildSaveBody, isDirty, loadOutcome, saveOutcome, closeAction, saveButtonState, impersonationLine, cardsEditable,
} from '../../../lib/availability-form'
import { createInFlightGuard } from '../../../lib/in-flight-guard'
import { dublinTodayIso } from '../../../lib/dates'
import { AVAILABILITY_LIMITS } from 'shared/availability'
import MonthCalendar from '../../../components/MonthCalendar'
import TabletConstrained from '../../../components/TabletConstrained'

// Whole literal class names: NativeWind only compiles classes it can see.
const TONE_BOX = {
  ok: 'bg-green-500/10 border-green-500/30',
  warn: 'bg-amber-500/10 border-amber-500/40',
  error: 'bg-red-500/10 border-red-500/30',
}
const TONE_TEXT = { ok: 'text-green-700', warn: 'text-amber-700', error: 'text-red-700' }

export default function MyAvailability() {
  const { profile, impersonatingFrom } = useAuth()
  const router = useRouter()
  const navigation = useNavigation()
  const headerHeight = useHeaderHeight()
  const scrollRef = useRef(null)
  const nextKey = useRef(null)
  if (nextKey.current === null) nextKey.current = createRowKeys()
  // A double tap on Save must PUT once: `saving` is render state and a second
  // tap in the same frame still reads false; the latch is synchronous.
  const saveGuard = useRef(null)
  if (saveGuard.current === null) saveGuard.current = createInFlightGuard()

  // baseline: the cards as last loaded or saved; null until a load SUCCEEDS.
  // Nothing can be saved before then: a replace over a failed load would wipe
  // every rule the coach has.
  const [baseline, setBaseline] = useState(null)
  const [rows, setRows] = useState([])
  const [loadState, setLoadState] = useState({ loading: true, message: null, canRetry: false })
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [serverErrors, setServerErrors] = useState({})
  const [message, setMessage] = useState(null) // { tone, text }
  const [openCalendar, setOpenCalendar] = useState(null) // the card whose calendar is open

  // The studio's day, not the phone's (ROSTER-FIX.7). Render-time: calendar
  // minDate and the card flags. A save reads it again at the moment of saving.
  const today = dublinTodayIso()
  const loaded = baseline !== null
  const dirty = loaded && isDirty(baseline, rows, { todayIso: today })

  const say = useCallback((next) => {
    setMessage(next)
    scrollRef.current?.scrollTo({ y: 0, animated: true })
    if (next?.text) AccessibilityInfo.announceForAccessibility(next.text)
  }, [])

  const loadRules = useCallback(async () => {
    setLoadState({ loading: true, message: null, canRetry: false })
    let res = null
    try {
      res = await getMyAvailability()
    } catch {
      // api() answers with an envelope rather than throwing; this is the belt.
    }
    const out = loadOutcome(res)
    if (!out.ok) {
      setLoadState({ loading: false, message: out.message, canRetry: out.canRetry })
      return
    }
    const fresh = rowsFromServer(out.data, nextKey.current)
    setRows(fresh)
    setBaseline(fresh)
    setServerErrors({})
    setLoadState({ loading: false, message: null, canRetry: false })
  }, [])

  // Once, on open. Never on focus: a refetch would overwrite edits in progress.
  useEffect(() => { loadRules() }, [loadRules])

  // Unsaved edits: Cancel, the Android back button and the iOS swipe-down all
  // ask first (gestureEnabled below is the belt for the swipe). Mid-save
  // nothing leaves.
  usePreventRemove(dirty || saving, ({ data }) => {
    const action = closeAction({ saving, dirty })
    if (action === 'block') return
    if (action === 'close') {
      navigation.dispatch(data.action)
      return
    }
    Alert.alert(COPY.discardTitle, COPY.discardBody, [
      { text: COPY.discardKeep, style: 'cancel' },
      { text: COPY.discardConfirm, style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ])
  })

  // Opened cold there is nothing to pop back to (time-off-new's guard).
  function leave() {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/schedule')
  }

  // A save in flight owns the cards: its answer replaces them, so an edit
  // made meanwhile would vanish. The inputs are disabled (cardsEditable);
  // the latch is the belt for a tap that lands in the same frame.
  function update(key, patch) {
    if (saveGuard.current.busy) return
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setServerErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setMessage(null)
  }

  function add(kind) {
    if (saveGuard.current.busy) return
    const row = newRow(kind, { nextKey: nextKey.current })
    setRows((prev) => [...prev, row])
    if (kind === 'dated') setOpenCalendar(row.key)
    setMessage(null)
  }

  function remove(key) {
    if (saveGuard.current.busy) return
    setRows((prev) => prev.filter((r) => r.key !== key))
    setOpenCalendar((open) => (open === key ? null : open))
    setMessage(null)
  }

  function save() {
    return saveGuard.current.run(sendSave)
  }

  async function sendSave() {
    // "Today" at the moment of saving: a screen left open over midnight must
    // judge dates the way the server will.
    const todayIso = dublinTodayIso()
    // The loaded rules that started before today: the route's `stored` set
    // for carryStartedRules, so the phone judges a started rule its way.
    const started = startedRules(baseline, todayIso)
    setShowProblems(true)
    setServerErrors({})
    const problems = formProblems(rows, { todayIso, started })
    if (!problems.ok) {
      say({ tone: 'error', text: [COPY.invalid, problems.banner].filter(Boolean).join(' ') })
      return
    }
    if (!isDirty(baseline, rows, { todayIso })) {
      say({ tone: 'ok', text: COPY.nothingToSave })
      return
    }
    const { body, keysByPath } = buildSaveBody(rows, { todayIso })
    setSaving(true)
    let res
    try {
      res = await saveMyAvailability(body)
    } catch (err) {
      res = { success: false, transport: true, error: String(err?.message || err) }
    } finally {
      setSaving(false)
    }
    const out = saveOutcome(res, { keysByPath })
    if (out.tone === 'ok') {
      setShowProblems(false)
      setOpenCalendar(null)
      if (out.saved) {
        const fresh = rowsFromServer(out.saved, nextKey.current)
        setRows(fresh)
        setBaseline(fresh)
      } else {
        // Saved, but the answer could not be read: read the rules back.
        await loadRules()
      }
    } else {
      setServerErrors(out.rowErrors)
    }
    say({ tone: out.tone, text: out.message })
  }

  const problems = formProblems(rows, { todayIso: today, started: startedRules(baseline, today) })
  const dups = duplicateKeys(rows, { todayIso: today })
  const button = saveButtonState({ loaded, saving, dirty })
  const editable = cardsEditable({ loaded, saving })
  const viewingAs = impersonationLine(impersonatingFrom, profile)
  const problemFor = (row) => serverErrors[row.key] || (showProblems ? problems.byKey[row.key] : null) || null

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: AVAILABILITY_TITLE,
          gestureEnabled: !dirty && !saving,
          headerLeft: () => (
            <Pressable onPress={leave} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel, close without saving">
              <Text className="text-base text-un1t-text">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={button.disabled}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Save availability"
              accessibilityState={{ disabled: button.disabled, busy: button.busy }}
            >
              {button.busy ? (
                <ActivityIndicator />
              ) : (
                <Text className={`text-base font-semibold ${button.disabled ? 'text-un1t-muted' : 'text-un1t-text'}`}>Save</Text>
              )}
            </Pressable>
          ),
        }}
      />

      <TabletConstrained className="flex-1">
        <ScrollView
          ref={scrollRef}
          contentContainerClassName="p-4 pb-16"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          <Text className="text-sm text-un1t-subtle mb-1">{AVAILABILITY_INTRO}</Text>
          <Text className="text-xs text-un1t-subtle mb-4">{AVAILABILITY_NO_OVERNIGHT}</Text>

          {viewingAs ? (
            <View className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 mb-4">
              <Text className="text-sm text-amber-700">{viewingAs}</Text>
            </View>
          ) : null}

          {message ? (
            <View accessibilityLiveRegion="polite" className={`border rounded-xl p-3 mb-4 ${TONE_BOX[message.tone]}`}>
              <Text className={`text-sm ${TONE_TEXT[message.tone]}`}>{message.text}</Text>
            </View>
          ) : null}

          {loadState.loading ? (
            <View className="py-12 items-center">
              <ActivityIndicator />
              <Text className="text-sm text-un1t-subtle mt-2">{COPY.loading}</Text>
            </View>
          ) : !loaded ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <Text className="text-sm text-red-700">{loadState.message}</Text>
              {loadState.canRetry ? (
                <Pressable
                  onPress={loadRules}
                  accessibilityRole="button"
                  className="self-start mt-3 px-4 py-2 rounded-full bg-un1t-surface border border-red-500/30 active:opacity-70"
                >
                  <Text className="text-sm font-semibold text-red-700">{COPY.retry}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            ['weekly', 'dated'].map((kind) => {
              const cards = rows.filter((r) => r.kind === kind)
              return (
                <View key={kind} className="mb-6">
                  <SectionHeader kind={kind} canAddMore={canAdd(rows, kind, { todayIso: today })} disabled={!editable} onAdd={() => add(kind)} />
                  {cards.length === 0 ? (
                    <Text className="text-sm text-un1t-subtle px-1">{kind === 'weekly' ? COPY.weeklyEmpty : COPY.datedEmpty}</Text>
                  ) : cards.map((row) => (
                    <RuleCard
                      key={row.key}
                      row={row}
                      today={today}
                      problem={problemFor(row)}
                      duplicate={dups.has(row.key)}
                      frozen={!editable}
                      calendarOpen={openCalendar === row.key}
                      onToggleCalendar={() => setOpenCalendar((open) => (open === row.key ? null : row.key))}
                      onChange={(patch) => update(row.key, patch)}
                      onRemove={() => remove(row.key)}
                    />
                  ))}
                </View>
              )
            })
          )}
        </ScrollView>
      </TabletConstrained>
    </KeyboardAvoidingView>
  )
}

function SectionHeader({ kind, canAddMore, disabled, onAdd }) {
  const heading = kind === 'weekly' ? COPY.weeklyHeading : COPY.datedHeading
  const label = kind === 'weekly' ? COPY.addWeekly : COPY.addDated
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 mb-2 px-1">
      <Text accessibilityRole="header" className="text-xs uppercase tracking-wider text-un1t-subtle">{heading}</Text>
      {canAddMore ? (
        <Pressable
          onPress={onAdd}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !!disabled }}
          className={`${disabled ? 'opacity-50 ' : ''}flex-row items-center px-3 py-1.5 rounded-full bg-un1t-surface border border-un1t-border active:opacity-70`}
        >
          <Ionicons name="add" size={16} color="#111827" />
          <Text className="text-sm font-semibold text-un1t-text ml-1">{label}</Text>
        </Pressable>
      ) : (
        <Text className="text-xs text-un1t-subtle">{kind === 'weekly' ? COPY.weeklyFull : COPY.datedFull}</Text>
      )}
    </View>
  )
}

// `frozen`: a save is in flight; nothing on the card takes input.
function RuleCard({ row, today, problem, duplicate, frozen, calendarOpen, onToggleCalendar, onChange, onRemove }) {
  const summary = rowSummary(row, { todayIso: today })

  // Ended while the screen was open: history, shown but not editable, not sent.
  if (hasEnded(row, today)) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3 opacity-60">
        <Text className="text-sm font-semibold text-un1t-text">{summary}</Text>
        <Text className="text-xs text-un1t-subtle mt-1">{COPY.ended}</Text>
      </View>
    )
  }

  // A dated entry that started before today (AVAIL.1a's started-rule
  // contract, as the web editor): its start and window are locked; the
  // calendar moves only its last day, and the note can change.
  const started = startedNote(row, { todayIso: today })
  // Judged now, from today (not at load): a screen left open past midnight
  // locks a rule that started yesterday.
  const locked = isStarted(row, today)
  const range = calendarRange(row, { todayIso: today })
  const dates = datesLabel(row)

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
      <View className="flex-row items-start justify-between mb-3">
        <Text className="text-sm font-semibold text-un1t-text flex-1 mr-3">{summary}</Text>
        <Pressable
          onPress={onRemove}
          disabled={frozen}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${summary}`}
          accessibilityState={{ disabled: !!frozen }}
          className="p-1 active:opacity-60"
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </Pressable>
      </View>

      {row.kind === 'weekly' ? (
        <View accessibilityRole="radiogroup" accessibilityLabel="Day of the week" className="flex-row gap-1 mb-3">
          {WEEKDAY_CHIPS.map((d) => {
            const on = row.weekday === d.code
            return (
              <Pressable
                key={d.code}
                onPress={() => onChange({ weekday: d.code })}
                disabled={frozen}
                accessibilityRole="radio"
                accessibilityLabel={d.label}
                accessibilityState={{ checked: on, disabled: !!frozen }}
                className={`flex-1 items-center py-2 rounded-lg border ${on ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
              >
                <Text numberOfLines={1} adjustsFontSizeToFit className={`text-xs font-semibold ${on ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {d.short}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : (
        <View className="mb-3">
          <Pressable
            onPress={onToggleCalendar}
            disabled={frozen}
            accessibilityRole="button"
            accessibilityLabel={`Dates, ${dates}`}
            accessibilityHint={calendarOpen ? 'Closes the calendar' : locked ? 'Opens a calendar to choose a new last day' : 'Opens a calendar to choose the first and last day'}
            accessibilityState={{ expanded: calendarOpen, disabled: !!frozen }}
            className="flex-row items-center justify-between bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 active:opacity-70"
          >
            <Text className="text-base text-un1t-text flex-1 mr-2">{dates}</Text>
            <Ionicons name={calendarOpen ? 'chevron-up' : 'chevron-down'} size={18} color="#64748B" />
          </Pressable>
          {calendarOpen && !frozen ? (
            <View className="mt-2">
              <MonthCalendar
                startDate={range.startDate}
                endDate={range.endDate}
                initialMonth={range.initialMonth}
                minDate={today}
                onChange={(picked) => onChange(rangeFromCalendar(picked, row, { todayIso: today }))}
              />
              <Text className="text-xs text-un1t-subtle mt-1 px-1">{locked ? COPY.calendarHintStarted : COPY.calendarHint}</Text>
            </View>
          ) : null}
          {started ? <Text className="text-xs text-un1t-subtle mt-2">{started}</Text> : null}
        </View>
      )}

      <View className="flex-row items-center justify-between mb-2">
        <Text className={`text-base ${locked ? 'text-un1t-subtle' : 'text-un1t-text'}`}>All day</Text>
        <Switch
          value={row.all_day}
          onValueChange={(v) => onChange({ all_day: v })}
          disabled={locked || frozen}
          accessibilityLabel="All day"
          accessibilityState={{ disabled: locked || !!frozen }}
        />
      </View>
      {!row.all_day ? (
        <View className="flex-row gap-3 mb-3">
          <TimeField label="From" value={row.start_time} locked={locked || frozen} onChange={(t) => onChange({ start_time: t })} />
          <TimeField label="To" value={row.end_time} locked={locked || frozen} onChange={(t) => onChange({ end_time: t })} />
        </View>
      ) : null}

      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5 mt-1">Note (optional)</Text>
      <TextInput
        value={row.note}
        onChangeText={(t) => onChange({ note: t })}
        editable={!frozen}
        maxLength={AVAILABILITY_LIMITS.noteChars}
        placeholder="e.g. college on Tuesdays"
        placeholderTextColor="#64748B"
        returnKeyType="done"
        accessibilityLabel="Note, optional. Your managers can see it."
        className="bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
      />

      {duplicate && !problem ? <Text className="text-xs text-amber-700 mt-2">{COPY.duplicate}</Text> : null}
      {problem ? <Text accessibilityRole="alert" className="text-sm text-red-700 mt-2">{problem}</Text> : null}
    </View>
  )
}

// A typed time. The keyboard is numbers-and-punctuation on iOS (the default
// keyboard on Android); timeOnBlur tidies '930' to '09:30' on the way out.
function TimeField({ label, value, locked, onChange }) {
  return (
    <View className="flex-1">
      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!locked}
        onEndEditing={(e) => {
          const tidy = timeOnBlur(e?.nativeEvent?.text ?? value)
          if (tidy !== value) onChange(tidy)
        }}
        placeholder="09:30"
        placeholderTextColor="#64748B"
        keyboardType="numbers-and-punctuation"
        maxLength={7}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="done"
        accessibilityLabel={`${label}, a time like 09:30 or 5:30pm`}
        className={`bg-un1t-bg border border-un1t-border rounded-xl px-3 py-3 text-base font-mono ${locked ? 'text-un1t-subtle' : 'text-un1t-text'}`}
      />
    </View>
  )
}
