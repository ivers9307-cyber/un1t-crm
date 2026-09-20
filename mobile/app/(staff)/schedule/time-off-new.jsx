// Modal: Request time off.
//
// iOS-feeling form: large title, grouped settings rows. The type menu is
// gated by employment type (shared/time-off catalogue); dates are picked
// with a pure-JS tappable month calendar (components/MonthCalendar) — no
// native picker dependency, so the whole screen ships over-the-air.
//
// On submit, we hit POST /api/schedule/time-off and the server fans
// out a push notification to managers/owners at the location (see
// src/app/api/schedule/time-off/route.js).
//
// LEAVEPHONE.1 — before submitting, the coach sees the days the request will
// be charged (COUNTED BY THE SERVER, GET ?preview=1 — this screen does no day
// arithmetic), their holiday balance (employees only) and their own published
// shifts inside the range; after submitting, a confirmation. Every decision
// and every word of that is in lib/leave-form.js; this file renders it.

import { useState, useEffect, useRef } from 'react'
import { useRouter, Stack } from 'expo-router'
import {
  View, Text, Pressable, ScrollView, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useAuth } from '../../../lib/auth-context'
import { createTimeOffRequest, getMyAllowance, getMyTimeOff, getLeavePreview } from '../../../lib/schedule-api'
import {
  leavePreviewFrom, leaveDaysLabel, leaveDaysHint, leaveBalanceView, leaveBalanceLines, leaveClashSummary,
  submittedDays, leaveSubmittedMessage,
} from '../../../lib/leave-form'
import { createInFlightGuard } from '../../../lib/in-flight-guard'
import { dublinTodayIso } from '../../../lib/dates'
import { timeOffTypesFor, defaultTimeOffTypeFor, isRestrictedEmployment } from 'shared/time-off'
import MonthCalendar from '../../../components/MonthCalendar'

export default function TimeOffNew() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const headerHeight = useHeaderHeight()
  // ROSTER-FIX.7 — the studio's day, not the phone's. This is both the
  // calendar's minDate and the default range, so a device an hour behind
  // Dublin used to refuse to book leave for a day that had not started yet.
  const today = dublinTodayIso()
  // Type menu is gated by employment type — contractors + casual staff
  // only get "Unavailable"; everyone else gets the four leave types.
  const types = timeOffTypesFor(profile?.employment_type)
  const [type, setType] = useState(defaultTimeOffTypeFor(profile?.employment_type))
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // A double tap on Submit must POST once. `submitting` is render state, so a
  // second tap inside the same frame still reads false; the latch is
  // synchronous. `sent` stays true after a success so nothing can be filed
  // twice from behind the confirmation.
  const submitGuard = useRef(null)
  if (submitGuard.current === null) submitGuard.current = createInFlightGuard()
  const sent = useRef(false)

  // LEAVEPHONE.1 — what the coach needs BEFORE they submit. All of it is
  // advisory: a failed read shows less, it never blocks the request (the
  // server still enforces balance and overlap on submit).
  const [allowance, setAllowance] = useState(null)
  const [myRequests, setMyRequests] = useState([])
  // false until the coach's own request list has really been read. A failed
  // read is "pending unknown", not "nothing pending": no balance card then.
  const [requestsKnown, setRequestsKnown] = useState(false)
  // The SERVER's answer for the current type + range: the days it would charge
  // and the coach's own published shifts inside it. The phone counts nothing.
  const [preview, setPreview] = useState(() => leavePreviewFrom(null))
  const [previewLoading, setPreviewLoading] = useState(true)
  const hasAllowance = !isRestrictedEmployment(profile?.employment_type)
  const allowanceYear = Number(String(start || today).slice(0, 4))

  // Balance: the allowance for the year the leave STARTS in, plus the coach's
  // own requests (the pending-days deduction the server applies). Contractors
  // and casual staff have no allowance, so nothing is fetched for them.
  useEffect(() => {
    if (!hasAllowance || !profile?.id) return undefined
    let live = true
    Promise.all([
      getMyAllowance({ year: allowanceYear, locationId: activeLocation?.id }),
      getMyTimeOff({ profileId: profile.id }),
    ]).then(([a, t]) => {
      if (!live) return
      const known = !!t?.success && Array.isArray(t.data)
      setAllowance(a?.success && a.data ? a.data : null)
      setMyRequests(known ? t.data : [])
      setRequestsKnown(known)
    }).catch(() => {
      if (live) { setAllowance(null); setMyRequests([]); setRequestsKnown(false) }
    })
    return () => { live = false }
  }, [hasAllowance, profile?.id, activeLocation?.id, allowanceYear])

  // Preview: refetched whenever the type or the range changes (the type
  // matters — holiday skips weekends, bank holidays and closures; the others
  // count calendar days). `live` drops a slow answer for a choice the coach
  // has already moved on from (and one that lands after the screen closed).
  // Same locationId the submit below files at. A server that does not know
  // preview=1 yet answers with the request list; leavePreviewFrom reads that
  // as "unknown" and the form still submits.
  useEffect(() => {
    let live = true
    setPreviewLoading(true)
    getLeavePreview({ type, startDate: start, endDate: end || start, locationId: activeLocation?.id })
      .then((res) => leavePreviewFrom(res), () => leavePreviewFrom(null))
      .then((next) => {
        if (!live) return
        setPreview(next)
        setPreviewLoading(false)
      })
    return () => { live = false }
  }, [type, start, end, activeLocation?.id])

  const balance = leaveBalanceLines(leaveBalanceView({
    employmentType: profile?.employment_type, allowance, requests: myRequests, requestsKnown, type,
    days: previewLoading ? null : preview.days, year: allowanceYear, profileId: profile?.id,
  }), type)
  const clashes = previewLoading ? null : leaveClashSummary(preview)
  const daysHint = leaveDaysHint(type)

  function submit() {
    if (sent.current) return undefined
    return submitGuard.current.run(sendRequest)
  }

  async function sendRequest() {
    // The calendar leaves `end` null after the first tap of a range (and for a
    // single-day pick); coalesce to start so a one-tap pick still submits and a
    // two-tap pick submits the full From–To range.
    const endDate = end || start
    if (start > endDate) {
      Alert.alert('Invalid dates', 'End date must be on or after start date.')
      return
    }
    setSubmitting(true)
    let res
    try {
      res = await createTimeOffRequest({
        type,
        startDate: start,
        endDate,
        reason,
        locationId: activeLocation?.id,
      })
    } catch (err) {
      // api() answers with an envelope rather than throwing; this is the belt.
      res = { success: false, error: `Network error: ${err?.message || err}` }
    } finally {
      setSubmitting(false)
    }
    if (!res?.success) {
      Alert.alert('Couldn’t submit', res?.error || 'Unknown error')
      return
    }
    sent.current = true
    // LEAVEPHONE.1 — say it worked. The form used to just close, which on a
    // slow link was indistinguishable from the tap not registering. The days
    // are the ones the POST actually charged (its own response), not a recount.
    const done = leaveSubmittedMessage({
      type, startIso: start, endIso: endDate, days: submittedDays(res), clashCount: clashes?.count || 0,
    })
    Alert.alert(done.title, done.message, [{ text: 'OK', onPress: () => router.back() }])
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: 'Request time off',
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={10}>
              <Text className="text-base text-un1t-text">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={submit} disabled={submitting} hitSlop={10}>
              {submitting ? (
                <ActivityIndicator />
              ) : (
                <Text className="text-base font-semibold text-un1t-text">Submit</Text>
              )}
            </Pressable>
          ),
        }}
      />

      <ScrollView contentContainerClassName="p-4 pb-10" keyboardShouldPersistTaps="handled">
        {/* Type — segmented control when several are allowed; a single
            static row when employment restricts to one (contractor/casual
            → "Unavailable"), since a one-option control is pointless. */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Type</Text>
        {types.length > 1 ? (
          <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-5">
            {types.map(t => (
              <Pressable
                key={t.value}
                onPress={() => setType(t.value)}
                className={`flex-1 py-2 rounded-lg ${type === t.value ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-center text-sm ${type === t.value ? 'text-un1t-bg font-semibold' : 'text-un1t-subtle'}`}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 mb-5">
            <Text className="text-base text-un1t-text">
              {types[0]?.label}
            </Text>
          </View>
        )}

        {/* Dates — tappable month calendar (range select). Pure JS so it
            ships over-the-air; jump months from the header instead of
            stepping a day at a time. */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Dates</Text>
        <View className="mb-5">
          <MonthCalendar
            startDate={start}
            endDate={end}
            minDate={today}
            onChange={({ start: s, end: e }) => { setStart(s); setEnd(e) }}
          />
        </View>

        {/* LEAVEPHONE.1 — the days this request is charged, COUNTED BY THE
            SERVER (preview=1). Never computed here: bank holidays and studio
            closures are free and only the server knows them. */}
        <View className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 mb-3">
          <Text className="text-base text-un1t-text">{leaveDaysLabel({ loading: previewLoading, preview })}</Text>
          {daysHint ? <Text className="text-xs text-un1t-subtle mt-1">{daysHint}</Text> : null}
        </View>

        {/* Holiday balance — employees only; null for contractors (LEAVE.3). */}
        {balance && (
          <View className={`rounded-xl px-4 py-3 mb-3 border ${balance.short ? 'bg-red-500/10 border-red-500/30' : 'bg-un1t-surface border-un1t-border'}`}>
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">{balance.heading}</Text>
            <Text className={`text-base font-semibold ${balance.short ? 'text-red-700' : 'text-un1t-text'}`}>{balance.available}</Text>
            <Text className="text-xs text-un1t-subtle mt-1">{balance.breakdown}</Text>
            {balance.request ? (
              <Text className={`text-sm mt-2 ${balance.short ? 'text-red-700' : 'text-un1t-text'}`}>{balance.request}</Text>
            ) : null}
            {balance.otherYear ? (
              <Text className="text-xs text-un1t-subtle mt-1">{balance.otherYear}</Text>
            ) : null}
          </View>
        )}

        {/* Own published shifts inside the range. leaveClashSummary is null
            unless the preview is KNOWN and non-empty: unknown must not read
            as "none". */}
        {clashes && (
          <View className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-3">
            <Text className="text-sm font-semibold text-amber-700">{clashes.heading}</Text>
            {clashes.lines.map((c) => (
              <Text key={c.id} className="text-sm text-amber-700 mt-1">{c.text}</Text>
            ))}
            {clashes.more ? <Text className="text-sm text-amber-700 mt-1">{clashes.more}</Text> : null}
            <Text className="text-xs text-amber-700 mt-2">{clashes.footer}</Text>
          </View>
        )}

        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2 mt-2">Reason (optional)</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-xl mb-5">
          <TextInput
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={4}
            placeholder="A short note for your manager…"
            placeholderTextColor="#94A3B8"
            className="px-4 py-3 text-base text-un1t-text min-h-[100px]"
            textAlignVertical="top"
          />
        </View>

        <Text className="text-xs text-un1t-subtle px-2 mt-2">
          Your manager will be notified. You can follow the request, see their reply and withdraw it
          while it is still pending under My leave on the Schedule tab.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
