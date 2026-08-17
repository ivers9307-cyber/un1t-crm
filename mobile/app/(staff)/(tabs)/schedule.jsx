// Schedule tab — week strip + shifts list + floating Request Time Off.
//
// Architecture:
//   - useEffect loads the week's shifts whenever `weekAnchor` (the first
//     day of the visible week) or activeLocation changes.
//   - The week strip lets the user pick which day's shifts to view.
//   - Pull-to-refresh re-fetches.
//   - "Request Time Off" pushes the modal route.
//   - Long-pressing a shift row offers "Request Swap" (a swap modal).
//
// Performance: shifts are cheap (<= ~14 per week per user). No
// virtualisation needed — the FlatList is overkill for this size.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert, Modal, TextInput, KeyboardAvoidingView,
  Platform, Image,
} from 'react-native'
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import {
  weekStart, addDays, daysOfWeek, isoDate, parseIsoDate, DAY_LABELS,
  shortDate, timeRange, hoursBetween,
} from '../../../lib/dates'
import {
  getMyShifts, getTeamShifts, getMyTimeOff, createSwapRequest, adjustShiftAssignment,
} from '../../../lib/schedule-api'
import { canMobile } from '../../../lib/permissions'
import { useIsTablet } from '../../../lib/use-is-tablet'
import { effShiftStart, effShiftEnd, teamRosterForDay, initials } from '../../../lib/schedule-team'
import ManageMode from '../../../components/schedule/ManageMode'

// Manager roles, mirrored from src/lib/schemas.js MANAGER_ROLES. Defined
// locally because the mobile bundle can't import that web-side module, and
// shared/permissions.js does NOT export MANAGER_ROLES — importing it from
// there resolved to `undefined`, so isManagerRole() threw "Cannot read
// property 'includes' of undefined" on every Schedule render once the Manage
// segment (PR #375) started calling it unconditionally. (HOTFIX.)
const MANAGER_ROLES = ['master', 'owner', 'manager', 'head_coach']
const isManagerRole = (role) => MANAGER_ROLES.includes(role)

function WeekStrip({ anchor, selected, onSelect, byDate }) {
  const days = daysOfWeek(anchor)
  return (
    <View className="flex-row justify-between px-1">
      {days.map((d, i) => {
        const iso = isoDate(d)
        const isSel = iso === isoDate(selected)
        const count = (byDate[iso] || []).length
        return (
          <Pressable
            key={iso}
            onPress={() => onSelect(d)}
            className={`flex-1 mx-0.5 items-center py-2 rounded-xl ${isSel ? 'bg-un1t-text' : 'bg-un1t-surface border border-un1t-border'}`}
          >
            <Text className={`text-[11px] uppercase font-medium ${isSel ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
              {DAY_LABELS[i]}
            </Text>
            <Text className={`text-lg font-semibold ${isSel ? 'text-un1t-bg' : 'text-un1t-text'}`}>
              {d.getDate()}
            </Text>
            {count > 0 && (
              <View className={`mt-0.5 w-1.5 h-1.5 rounded-full ${isSel ? 'bg-un1t-bg' : 'bg-un1t-text'}`} />
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

// STUDIO-IPAD.2 — compact shift card used by the iPad WeekGridView.
// Same shift, same actions, just squeezed into a column-width card
// instead of a full-width row. The iPhone ShiftRow below stays
// untouched so phone users see no change.
// effShiftStart / effShiftEnd now live in ../../lib/schedule-team (imported
// above) — single definition shared with the Team sort helper.

function ShiftCard({ shift, onPress, onLongPress, teamMode, selfId }) {
  const tpl = shift.shift_templates
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const adjusted = !!(shift.start_time_override || shift.end_time_override)
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      className="bg-un1t-surface border border-un1t-border rounded-xl p-2.5 mb-2 active:opacity-70"
    >
      {teamMode && (
        <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>
          {shift.profiles?.full_name?.split(' ')[0] || 'Unknown'}
          {shift.profile_id === selfId ? ' (You)' : ''}
        </Text>
      )}
      <Text
        className={teamMode
          ? 'text-[11px] text-un1t-subtle mt-0.5'
          : 'text-sm font-semibold text-un1t-text'}
        numberOfLines={1}
      >
        {tpl?.name || 'Shift'}
      </Text>
      <Text className="text-[11px] text-un1t-subtle mt-0.5">
        {timeRange(effStart, effEnd)}
      </Text>
      <View className="flex-row gap-1 mt-1.5">
        {adjusted && (
          <View className="px-1.5 py-0.5 rounded-full bg-amber-400">
            <Text className="text-[9px] uppercase text-amber-950 font-bold">Adj</Text>
          </View>
        )}
        {shift.published === false && (
          <View className="px-1.5 py-0.5 rounded-full bg-amber-500/20">
            <Text className="text-[9px] uppercase text-amber-700 font-medium">Draft</Text>
          </View>
        )}
        {shift.status === 'swapped' && (
          <View className="px-1.5 py-0.5 rounded-full bg-blue-500/20">
            <Text className="text-[9px] uppercase text-blue-700 font-medium">Swap</Text>
          </View>
        )}
      </View>
    </Pressable>
  )
}

// STUDIO-IPAD.2 — 7-column week grid for iPad. Replaces the phone's
// WeekStrip + single-day list with a glanceable whole-week view so
// the coach doesn't have to tap through each day. Each column owns
// its own day's shifts + any active leave marker; today's column is
// highlighted.
//
// Per-column shift cards reuse the same onPress / onLongPress
// handlers as the phone's ShiftRow, so adjust + swap flows work
// identically.
function WeekGridView({ anchor, shiftsByDate, timeOff, todayIso, canAdjust, openAdjust, requestSwap, teamMode, selfId }) {
  const days = daysOfWeek(anchor)
  return (
    <View className="flex-row gap-2">
      {days.map((d, i) => {
        const iso = isoDate(d)
        const dayShifts = (shiftsByDate[iso] || []).slice().sort((a, b) =>
          (effShiftStart(a) || '').localeCompare(effShiftStart(b) || ''))
        const dayLeave = timeOff.filter(t =>
          t.start_date <= iso && t.end_date >= iso &&
          (t.status === 'approved' || t.status === 'pending'))
        const isToday = iso === todayIso
        return (
          <View key={iso} className="flex-1 min-w-0">
            <View className={`items-center py-2 mb-2 rounded-xl ${isToday ? 'bg-un1t-text' : 'bg-un1t-surface border border-un1t-border'}`}>
              <Text className={`text-[10px] uppercase font-medium ${isToday ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                {DAY_LABELS[i]}
              </Text>
              <Text className={`text-lg font-semibold ${isToday ? 'text-un1t-bg' : 'text-un1t-text'}`}>
                {d.getDate()}
              </Text>
            </View>
            {dayLeave.map(t => (
              <View key={t.id} className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-2 mb-2">
                <Text className="text-[11px] font-semibold text-amber-700" numberOfLines={1}>
                  {t.type === 'holiday' ? 'Holiday' : t.type === 'sick' ? 'Sick' : 'Time off'}
                </Text>
                {t.status === 'pending' && (
                  <Text className="text-[10px] text-amber-700/80 mt-0.5">Pending</Text>
                )}
              </View>
            ))}
            {dayShifts.length === 0 && dayLeave.length === 0 ? (
              <Text className="text-[11px] text-un1t-muted italic text-center py-3">—</Text>
            ) : null}
            {dayShifts.map(s => (
              <ShiftCard
                key={s.id}
                shift={s}
                teamMode={teamMode}
                selfId={selfId}
                onPress={teamMode ? undefined : (canAdjust(s) ? () => openAdjust(s) : undefined)}
                onLongPress={teamMode ? undefined : () => requestSwap(s)}
              />
            ))}
          </View>
        )
      })}
    </View>
  )
}

// Team mode — one rostered colleague's shift for the selected day.
// Read-only (no adjust / swap). Avatar with initials fallback, name with a
// "You" chip for the signed-in user, shift name + time, role chip.
function TeamShiftRow({ shift }) {
  const tpl = shift.shift_templates
  const p = shift.profiles || {}
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const hours = hoursBetween(effStart, effEnd)
  const role = (p.role || '').replace(/_/g, ' ')
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 flex-row items-center">
      <View className="w-10 h-10 rounded-full bg-un1t-border items-center justify-center mr-3 overflow-hidden">
        {p.avatar_url
          ? <Image source={{ uri: p.avatar_url }} style={{ width: 40, height: 40 }} />
          : <Text className="text-sm font-semibold text-un1t-text">{initials(p.full_name)}</Text>}
      </View>
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>
            {p.full_name || 'Unknown'}
          </Text>
          {shift.isSelf && (
            <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-text">
              <Text className="text-[10px] uppercase font-bold text-un1t-bg">You</Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center mt-0.5">
          <Ionicons name="time-outline" size={13} color="#64748B" />
          <Text className="text-sm text-un1t-subtle ml-1" numberOfLines={1}>
            {tpl?.name ? `${tpl.name} · ` : ''}{timeRange(effStart, effEnd)} · {hours}h
          </Text>
        </View>
      </View>
      {role ? (
        <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-border">
          <Text className="text-[10px] uppercase font-medium text-un1t-subtle">{role}</Text>
        </View>
      ) : null}
    </View>
  )
}

function ShiftRow({ shift, onPress, onLongPress }) {
  const tpl = shift.shift_templates
  // Override-aware effective times. mig 099/100 mirror trigger
  // pushes assignment-level overrides into the legacy shifts row,
  // so this works for the partial-shift case automatically.
  const effStart = effShiftStart(shift)
  const effEnd = effShiftEnd(shift)
  const hours = hoursBetween(effStart, effEnd)
  const adjusted = !!(shift.start_time_override || shift.end_time_override)
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-base font-semibold text-un1t-text">
          {tpl?.name || 'Shift'}
        </Text>
        <View className="flex-row gap-1.5">
          {adjusted && (
            <View className="px-2 py-0.5 rounded-full bg-amber-400">
              <Text className="text-[10px] uppercase text-amber-950 font-bold">Adjusted</Text>
            </View>
          )}
          {shift.published === false && (
            <View className="px-2 py-0.5 rounded-full bg-amber-500/20">
              <Text className="text-[10px] uppercase text-amber-700 font-medium">Draft</Text>
            </View>
          )}
          {shift.status === 'swapped' && (
            <View className="px-2 py-0.5 rounded-full bg-blue-500/20">
              <Text className="text-[10px] uppercase text-blue-700 font-medium">Swapped</Text>
            </View>
          )}
        </View>
      </View>
      <View className="flex-row items-center">
        <Ionicons name="time-outline" size={14} color="#64748B" />
        <Text className="text-sm text-un1t-subtle ml-1">
          {timeRange(effStart, effEnd)} · {hours}h
        </Text>
      </View>
      {adjusted && (
        <Text className="text-[11px] text-un1t-subtle mt-0.5 italic">
          Block default {timeRange(shift.start_time || tpl?.start_time, shift.end_time || tpl?.end_time)}
          {shift.partial_reason ? ` · ${shift.partial_reason}` : ''}
        </Text>
      )}
      {shift.notes && (
        <Text className="text-xs text-un1t-subtle mt-1.5">{shift.notes}</Text>
      )}
    </Pressable>
  )
}

export default function Schedule() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const isTablet = useIsTablet()
  // NOTIF.4 — optional `?date=YYYY-MM-DD` deep-link param (set by
  // lib/notification-nav.js for schedule_published / schedule_updated /
  // shift_adjusted pushes) preselects the affected week + day instead of
  // landing on the current week. Absent/malformed values are ignored
  // (parseIsoDate returns null → today). Normalised to a string so the
  // sync effect below can key on a stable primitive.
  const params = useLocalSearchParams()
  const dateParam = typeof params.date === 'string' ? params.date : ''
  const [anchor, setAnchor] = useState(() => weekStart(parseIsoDate(dateParam) || new Date()))
  const [selected, setSelected] = useState(() => parseIsoDate(dateParam) || new Date())
  const [shifts, setShifts] = useState([])
  const [timeOff, setTimeOff] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [view, setView] = useState('me') // 'me' | 'team' | 'manage'
  const [manageRefreshKey, setManageRefreshKey] = useState(0)

  // A push tap can re-target an already-mounted tab (router.push just
  // updates the search params), so jump the visible week/day whenever the
  // param changes — the initialisers above only cover first mount.
  useEffect(() => {
    const d = parseIsoDate(dateParam)
    if (!d) return
    setAnchor(weekStart(d))
    setSelected(d)
  }, [dateParam])

  const start = useMemo(() => isoDate(anchor), [anchor])
  const end = useMemo(() => isoDate(addDays(anchor, 6)), [anchor])

  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    if (view === 'manage') return // ManageMode self-fetches the roster + approvals
    if (view === 'team') {
      // Team: the whole location's roster for the week (no profile_id). No
      // time-off in Team mode — it shows who's working, not who's off.
      const shiftsRes = await getTeamShifts({
        locationId: activeLocation.id,
        startDate: start,
        endDate: end,
      })
      if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load roster')
      setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
      setTimeOff([])
      return
    }
    const [shiftsRes, timeOffRes] = await Promise.all([
      getMyShifts({
        locationId: activeLocation.id,
        profileId: profile.id,
        startDate: start,
        endDate: end,
      }),
      getMyTimeOff({
        locationId: activeLocation.id,
        profileId: profile.id,
      }),
    ])
    if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load shifts')
    setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
    setTimeOff(timeOffRes.success ? timeOffRes.data || [] : [])
  }, [profile, activeLocation, start, end, view])

  useEffect(() => {
    setLoading(true)
    fetchWeek().finally(() => setLoading(false))
  }, [fetchWeek])

  // Re-fetch on tab focus so the week reflects changes made elsewhere (a
  // manager adjusting your shift on web, or a "View as user" switch) without
  // needing a manual pull-to-refresh. Silent — no loading spinner.
  useFocusEffect(useCallback(() => { fetchWeek() }, [fetchWeek]))

  // If the effective role loses manager rights while in Manage mode (e.g. a
  // master starts "View as user" on a staff member), drop back to Me so the
  // manager-only UI/calls never render for a non-manager identity.
  useEffect(() => {
    if (view === 'manage' && !isManagerRole(profile?.role)) setView('me')
  }, [profile?.role, view])

  async function onRefresh() {
    setRefreshing(true)
    await fetchWeek()
    setRefreshing(false)
  }

  // Index shifts by ISO date for quick day selection.
  const shiftsByDate = useMemo(() => {
    const idx = {}
    for (const s of shifts) {
      const d = s.shift_date
      if (!idx[d]) idx[d] = []
      idx[d].push(s)
    }
    return idx
  }, [shifts])

  const selectedIso = isoDate(selected)
  const todays = (shiftsByDate[selectedIso] || []).slice().sort((a, b) =>
    (a.start_time || '').localeCompare(b.start_time || '')
  )

  // Team mode: everyone rostered on the selected day (sorted + self-marked).
  const teamToday = useMemo(
    () => (view === 'team' ? teamRosterForDay(shifts, selectedIso, profile?.id) : []),
    [view, shifts, selectedIso, profile?.id]
  )

  // Time-off rows that touch the selected day. Useful in-context cue
  // for staff: "your week off, no shifts because you requested leave".
  const todaysLeave = timeOff.filter(t =>
    t.start_date <= selectedIso && t.end_date >= selectedIso &&
    (t.status === 'approved' || t.status === 'pending')
  )

  // Adjust modal state — open via ShiftRow onPress.
  const [adjustingShift, setAdjustingShift] = useState(null)

  // Self can adjust their own; managers can adjust anyone's.
  function canAdjust(shift) {
    if (!shift?.shift_assignment_id) return false
    if (shift.profile_id === profile.id) return true
    return isManagerRole(profile.role)
  }

  function requestSwapForShift(shift) {
    // RETIRE-SHIFTS-MIRROR.5c — swaps now key off the shift_assignment id
    // (stitched into the GET /shifts row), not the legacy shifts.id.
    if (!shift.shift_assignment_id) {
      Alert.alert('Can’t post', 'This shift can’t be swapped.')
      return
    }
    Alert.alert(
      'Request swap?',
      `Post ${shift.shift_templates?.name || 'this shift'} on ${shift.shift_date} for someone else to take?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Post for swap',
          onPress: async () => {
            const res = await createSwapRequest({
              requesterShiftId: shift.shift_assignment_id,
              locationId: activeLocation.id,
            })
            if (res.success) {
              Alert.alert('Posted', 'Managers have been notified.')
              fetchWeek()
            } else {
              Alert.alert('Couldn’t post', res.error || 'Unknown error')
            }
          },
        },
      ]
    )
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <ScrollView
        contentContainerClassName="px-4 pt-4 pb-32"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {/* Me / Team [/ Manage] segmented control */}
        <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-4">
          {(isManagerRole(profile?.role)
            ? [['me', 'Me'], ['team', 'Team'], ['manage', 'Manage']]
            : [['me', 'Me'], ['team', 'Team']]
          ).map(([val, label]) => {
            const active = view === val
            return (
              <Pressable
                key={val}
                onPress={() => setView(val)}
                className={`flex-1 items-center py-2 rounded-lg ${active ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-sm font-semibold ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {label}
                </Text>
              </Pressable>
            )
          })}
        </View>

        {/* Week header */}
        <View className="flex-row items-center justify-between mb-3">
          <Pressable onPress={() => setAnchor(addDays(anchor, -7))} className="p-2 -ml-2">
            <Ionicons name="chevron-back" size={22} color="#111827" />
          </Pressable>
          <Pressable
            onPress={() => {
              const today = new Date()
              setAnchor(weekStart(today))
              setSelected(today)
            }}
            className="px-3 py-1 rounded-full bg-un1t-surface border border-un1t-border"
          >
            <Text className="text-sm font-medium text-un1t-text">
              {shortDate(anchor)} – {shortDate(addDays(anchor, 6))}
            </Text>
          </Pressable>
          <Pressable onPress={() => setAnchor(addDays(anchor, 7))} className="p-2 -mr-2">
            <Ionicons name="chevron-forward" size={22} color="#111827" />
          </Pressable>
        </View>

        {/* STUDIO-IPAD.2 — iPad shows the whole week as a 7-column grid
            so the coach doesn't have to tap through each day. iPhone
            keeps the WeekStrip + single-day list (it'd be unreadably
            cramped at 7 narrow columns on a 390pt iPhone screen). */}
        {!isTablet && (
          <WeekStrip anchor={anchor} selected={selected} onSelect={setSelected} byDate={shiftsByDate} />
        )}

        {!isTablet && (
          <Text className="text-xs uppercase tracking-wider text-un1t-subtle mt-6 mb-2 px-1">
            {selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
        )}

        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {view === 'manage' ? (
          <ManageMode
            activeLocation={activeLocation}
            weekStart={start}
            weekEnd={end}
            selectedIso={selectedIso}
            selectedLabel={selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            refreshKey={manageRefreshKey}
            onAdjust={setAdjustingShift}
          />
        ) : loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : isTablet ? (
          <View className="mt-2">
            <WeekGridView
              anchor={anchor}
              shiftsByDate={shiftsByDate}
              timeOff={view === 'team' ? [] : timeOff}
              todayIso={isoDate(new Date())}
              canAdjust={canAdjust}
              openAdjust={setAdjustingShift}
              requestSwap={requestSwapForShift}
              teamMode={view === 'team'}
              selfId={profile?.id}
            />
          </View>
        ) : view === 'team' ? (
          <>
            {teamToday.length === 0 ? (
              <View className="py-10 items-center">
                <Ionicons name="people-outline" size={28} color="#94A3B8" />
                <Text className="text-sm text-un1t-subtle mt-2">
                  No one’s rostered on {selected.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric' })}.
                </Text>
              </View>
            ) : (
              teamToday.map(s => <TeamShiftRow key={s.id} shift={s} />)
            )}
          </>
        ) : (
          <>
            {todaysLeave.map(t => (
              <View key={t.id} className="bg-amber-500/10 border border-amber-500/40 rounded-2xl p-4 mb-2">
                <Text className="text-sm font-semibold text-amber-700">
                  {t.type === 'holiday' ? 'Holiday' : t.type === 'sick' ? 'Sick leave' : 'Time off'}
                  {t.status === 'pending' ? ' — pending' : ''}
                </Text>
                {t.reason && <Text className="text-xs text-amber-700/80 mt-1">{t.reason}</Text>}
              </View>
            ))}

            {todays.length === 0 && todaysLeave.length === 0 && (
              <View className="py-10 items-center">
                <Ionicons name="cafe-outline" size={28} color="#94A3B8" />
                <Text className="text-sm text-un1t-subtle mt-2">No shifts today.</Text>
              </View>
            )}

            {todays.map(s => (
              <ShiftRow
                key={s.id}
                shift={s}
                onPress={canAdjust(s) ? () => setAdjustingShift(s) : undefined}
                onLongPress={() => requestSwapForShift(s)}
              />
            ))}
            {todays.length > 0 && (
              <Text className="text-[11px] text-un1t-muted text-center mt-1">
                Tap to adjust times · long-press to request a swap.
              </Text>
            )}
          </>
        )}
      </ScrollView>

      {/* Floating Request Time Off button — MOBILE-PERMS: gated on the
          `time_off` mobile toggle (distinct from `schedule`, which only
          shows the roster). Default on for every role, so this stays
          visible unless an admin turns time-off off for the user. */}
      {canMobile(profile, 'time_off', activeLocation) && (
        <Pressable
          onPress={() => router.push('/schedule/time-off-new')}
          className="absolute bottom-6 right-6 bg-un1t-text rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
        >
          <Ionicons name="add" size={20} color="#FFFFFF" />
          <Text className="text-un1t-bg font-semibold ml-1.5">Request time off</Text>
        </Pressable>
      )}

      {/* Adjust modal — partial-shift override editor (mig 099/100). */}
      <AdjustSheet
        shift={adjustingShift}
        onClose={() => setAdjustingShift(null)}
        onSaved={() => { setAdjustingShift(null); fetchWeek(); setManageRefreshKey((k) => k + 1) }}
        locationId={activeLocation?.id}
      />
    </View>
  )
}

// AdjustSheet — modal time-override editor for a single shift.
// Uses the shift's shift_assignment_id (stitched in by the
// /api/schedule/shifts route) to PUT to the assignments endpoint.
// Server emits a push to the coach if a manager (not self) changed
// the override.
function AdjustSheet({ shift, onClose, onSaved, locationId }) {
  const blockStart = (shift?.start_time || shift?.shift_templates?.start_time || '').slice(0, 5)
  const blockEnd = (shift?.end_time || shift?.shift_templates?.end_time || '').slice(0, 5)
  const initialStart = (shift?.start_time_override || '').slice(0, 5) || blockStart
  const initialEnd = (shift?.end_time_override || '').slice(0, 5) || blockEnd

  const [start, setStart] = useState(initialStart)
  const [end, setEnd] = useState(initialEnd)
  const [reason, setReason] = useState(shift?.partial_reason || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Reset fields whenever a new shift is opened.
  useEffect(() => {
    if (!shift) return
    setStart((shift.start_time_override || '').slice(0, 5) || (shift.start_time || shift.shift_templates?.start_time || '').slice(0, 5))
    setEnd((shift.end_time_override || '').slice(0, 5) || (shift.end_time || shift.shift_templates?.end_time || '').slice(0, 5))
    setReason(shift.partial_reason || '')
    setError(null)
  }, [shift])

  if (!shift) return null
  const hasOverride = !!(shift.start_time_override || shift.end_time_override)

  async function save() {
    setError(null)
    if (start === end) {
      setError('Start and end cannot be identical.')
      return
    }
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      setError('Use HH:MM format (24-hour).')
      return
    }
    setSaving(true)
    const r = await adjustShiftAssignment(shift.shift_assignment_id, {
      // Pass null to inherit the block default — saves a roundtrip
      // on payroll mid-run if someone walked back from an override.
      startTime: start === blockStart ? null : start,
      endTime: end === blockEnd ? null : end,
      reason: reason.trim() || null,
      locationId,
    })
    setSaving(false)
    if (r.success) onSaved?.()
    else setError(r.error || 'Save failed')
  }

  async function clearOverride() {
    setError(null); setSaving(true)
    const r = await adjustShiftAssignment(shift.shift_assignment_id, {
      startTime: null, endTime: null, reason: null, locationId,
    })
    setSaving(false)
    if (r.success) onSaved?.()
    else setError(r.error || 'Clear failed')
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-end bg-black/50"
      >
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-lg font-bold text-un1t-text">Adjust shift times</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color="#94A3B8" />
            </Pressable>
          </View>

          <Text className="text-xs text-un1t-subtle mb-4">
            {shift.shift_templates?.name || 'Shift'} · {shift.shift_date}{'\n'}
            Block default: <Text className="font-mono text-un1t-text">{blockStart}–{blockEnd}</Text>.
            {' '}Leave equal to inherit.
          </Text>

          <View className="flex-row gap-3 mb-4">
            <View className="flex-1">
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Start (HH:MM)</Text>
              <TextInput
                value={start}
                onChangeText={setStart}
                placeholder={blockStart}
                placeholderTextColor="#64748B"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text font-mono"
              />
            </View>
            <View className="flex-1">
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">End (HH:MM)</Text>
              <TextInput
                value={end}
                onChangeText={setEnd}
                placeholder={blockEnd}
                placeholderTextColor="#64748B"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text font-mono"
              />
            </View>
          </View>

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Reason (optional)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. left early — sick, covered until 1pm for Mike"
            placeholderTextColor="#64748B"
            maxLength={200}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text mb-4"
          />

          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3 flex-row items-start">
              <Ionicons name="alert-circle" size={16} color="#DC2626" />
              <Text className="text-sm text-red-700 ml-2 flex-1">{error}</Text>
            </View>
          )}

          <Pressable
            onPress={save}
            disabled={saving}
            className="bg-amber-600 active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl items-center flex-row justify-center"
          >
            {saving
              ? <ActivityIndicator color="#FFFFFF" />
              : <Ionicons name="checkmark" size={18} color="#FFFFFF" />}
            <Text className="text-base font-semibold text-white ml-2">
              {saving ? 'Saving…' : 'Save adjustment'}
            </Text>
          </Pressable>

          {hasOverride && (
            <Pressable
              onPress={clearOverride}
              disabled={saving}
              className="mt-2 active:opacity-70 px-4 py-3 rounded-xl items-center"
            >
              <Text className="text-sm font-medium text-un1t-subtle">Clear override (use block default)</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
