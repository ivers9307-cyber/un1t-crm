// Boards panel — friends UN1T Points leaderboard. A Week / Month toggle picks
// the window: Week ranks the current Dublin-week (resets Monday), the fresher
// retention hook; Month is the calendar-month-to-date board.

import { useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../../lib/member/api'
import Card from './ui/Card'
import ErrorRetry from './ErrorRetry'
import { PEARL } from '../../lib/member/brand'

const METAL = ['#e8b931', '#c2c8ce', '#c77b3a']

const WINDOWS = [
  { key: 'week', label: 'Week', header: 'Friends · this week', caption: 'This week · resets Monday' },
  { key: 'month', label: 'Month', header: 'Friends · this month', caption: 'This calendar month' },
]

function Avatar({ name, size = 32 }) {
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <View
      style={{
        width: size, height: size,
        borderRadius: size / 2,
        backgroundColor: '#24242A',
        borderWidth: 1,
        borderColor: '#2A2A31',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#F1EEE7', fontSize: 11, fontFamily: 'Figtree_600SemiBold' }}>{initials}</Text>
    </View>
  )
}

function BoardRow({ row }) {
  const podiumColor = row.rank <= 3 ? METAL[row.rank - 1] : null
  const isMe = row.isMe
  const rankColor = podiumColor || (isMe ? PEARL : '#727170')

  return (
    <View
      className={`flex-row items-center gap-3 rounded-lg px-3 py-2 ${
        isMe ? 'border border-pearl/30' : 'border border-transparent'
      }`}
      style={isMe ? { backgroundColor: 'rgba(214,210,201,0.08)' } : undefined}
    >
      <Text
        className="w-5 text-center text-sm font-mono"
        style={{ color: rankColor }}
      >
        {row.rank}
      </Text>
      <Avatar name={row.name} />
      <Text
        className="flex-1 text-sm font-body-medium"
        style={{ color: isMe ? PEARL : '#F1EEE7' }}
        numberOfLines={1}
      >
        {row.name}
        {isMe && (
          <Text className="text-xs font-body" style={{ color: 'rgba(214,210,201,0.7)' }}> (you)</Text>
        )}
      </Text>
      <View className="shrink-0 flex-row items-baseline">
        <Text
          className="text-sm font-display-bold"
          style={{ color: isMe ? PEARL : '#B3B2AC' }}
        >
          {Math.round(row.value).toLocaleString()}
        </Text>
        <Text className="ml-1 font-mono text-[9px] text-chalk-3" style={{ letterSpacing: 1 }}>PTS</Text>
      </View>
    </View>
  )
}

// Small Week / Month segmented toggle — mirrors the Compete tab's control,
// scaled down and scoped to the Boards window.
function WindowToggle({ value, onChange }) {
  return (
    <View
      className="flex-row rounded-lg bg-iron-surface p-0.5 gap-0.5"
      style={{ borderWidth: 1, borderColor: '#2A2A31' }}
    >
      {WINDOWS.map((w) => {
        const active = value === w.key
        return (
          <Pressable
            key={w.key}
            onPress={() => onChange(w.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={{
              borderRadius: 6,
              paddingVertical: 5,
              paddingHorizontal: 12,
              alignItems: 'center',
              backgroundColor: active ? PEARL : 'transparent',
            }}
          >
            <Text style={{ fontSize: 12, fontFamily: 'Figtree_600SemiBold', color: active ? '#131316' : '#B3B2AC' }}>
              {w.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function BoardsPanel() {
  const [window, setWindow] = useState('week')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [me, setMe] = useState(null)
  const [error, setError] = useState(false)
  // Sequences concurrent loads: a fast Week→Month toggle fires two requests;
  // only the response for the window still selected may touch state, else a
  // late Week payload could clobber the Month board (or vice-versa).
  const reqWindowRef = useRef('week')

  const load = useCallback(async (win) => {
    reqWindowRef.current = win
    setLoading(true)
    setError(false)
    try {
      const d = await api(`/api/social/leaderboard?window=${win}`)
      if (reqWindowRef.current !== win) return // superseded by a newer toggle
      if (d?.success === false) {
        setError(true)
      } else if (d?.ok && d.board) {
        setRows(d.board.rows || [])
        setMe(d.board.me || null)
      }
    } catch {
      if (reqWindowRef.current === win) setError(true)
    } finally {
      if (reqWindowRef.current === win) setLoading(false)
    }
  }, [])

  useFocusEffect(useCallback(() => { load(window) }, [load, window]))

  const meta = WINDOWS.find((w) => w.key === window) || WINDOWS[0]

  // The Week / Month toggle stays pinned above the content in every state so
  // members can switch windows even while a board is loading or errored.
  const toggle = (
    <View className="flex-row justify-end mb-3">
      <WindowToggle value={window} onChange={setWindow} />
    </View>
  )

  return (
    <View>
      {toggle}
      {loading ? (
        <View className="items-center justify-center py-16">
          <ActivityIndicator color="#F1EEE7" />
        </View>
      ) : error && rows.length === 0 ? (
        <ErrorRetry onPress={() => load(window)} />
      ) : (
        <Card>
          {/* Header */}
          <View className="flex-row items-center justify-between gap-3 mb-1">
            <View className="flex-row items-center gap-2 flex-1">
              <Ionicons name="trophy-outline" size={20} color="#B3B2AC" />
              <View className="flex-1">
                <Text className="text-base font-display text-chalk" numberOfLines={1}>
                  {meta.header}
                </Text>
                <Text className="text-xs font-body text-chalk-2">UN1T Points</Text>
              </View>
            </View>
            {me?.rank && (
              <Text className="text-sm font-display-bold shrink-0" style={{ color: PEARL }}>
                You're #{me.rank}
              </Text>
            )}
          </View>

          {/* Window caption */}
          <Text className="text-xs font-body text-chalk-2 mb-4 ml-7">{meta.caption}</Text>

          {/* Rows */}
          {rows.length === 0 ? (
            <View className="items-center py-8 gap-2">
              <Ionicons name="people-outline" size={24} color="#727170" />
              <Text className="text-sm font-body-semibold text-chalk">No entries yet</Text>
              <Text className="text-xs font-body text-chalk-2 text-center max-w-xs">
                {window === 'week'
                  ? 'Add friends to see how you stack up this week.'
                  : 'Add friends to see how you stack up this month.'}
              </Text>
            </View>
          ) : (
            <View className="gap-1">
              {rows.map((row) => (
                <BoardRow key={`${row.rank}-${row.name}`} row={row} />
              ))}
            </View>
          )}
        </Card>
      )}
    </View>
  )
}
