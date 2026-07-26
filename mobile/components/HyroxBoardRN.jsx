// HYROX-MOBILE — the TV board rendered natively for the phone preview. The web
// HyroxBoard uses container-query CSS + a <style> block, neither of which exist
// in React Native, so this is a parallel View/Text implementation of the same
// single-target scoreboard (fixed type sizes — it's a preview card, not a TV).
import { View, Text } from 'react-native'

const GOLD = '#e7c24a'
const GOLD_LITE = '#f0d689'
const MUTED = '#52525a'

// "WEEK 1 of 12 - BASE PHASE" -> { main: "WEEK 1 / 12", phase: "BASE PHASE" }.
function splitWeek(weekLabel) {
  const wl = String(weekLabel || '').trim()
  if (!wl) return { main: '', phase: '' }
  const parts = wl.split(/\s[-–—]\s/)
  return { main: (parts[0] || '').replace(/\bof\b/i, '/').toUpperCase(), phase: parts.slice(1).join(' ').toUpperCase() }
}
const stationTarget = (s) => s?.target ?? s?.performance ?? s?.elite ?? ''

export default function HyroxBoardRN({ board }) {
  if (!board) return null
  const stations = Array.isArray(board.stations) ? board.stations : []
  const { main: weekMain, phase } = splitWeek(board.week_label)
  const capText = board.cap_minutes ? `${String(board.cap_minutes).padStart(2, '0')}:00` : ''

  return (
    <View style={{ backgroundColor: '#0b0b0d', borderRadius: 16, padding: 18, overflow: 'hidden' }}>
      <View style={{ alignItems: 'center' }}>
        {board.location_label ? (
          <Text style={{ color: '#7c7c84', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>{board.location_label}</Text>
        ) : null}
        <Text style={{ color: '#f6f6f4', fontSize: 46, fontWeight: '800', letterSpacing: -1, marginTop: 4 }}>HYROX</Text>
        <Text style={{ color: GOLD, fontSize: 12, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase', marginTop: 2 }}>Training Club</Text>
      </View>

      {(weekMain || phase) ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <Text style={{ color: '#f6f6f4', fontSize: 13, fontWeight: '700', letterSpacing: 1 }}>{weekMain}</Text>
          {phase ? (
            <Text style={{ color: '#7c7c84', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', borderColor: '#212127', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>{phase}</Text>
          ) : null}
        </View>
      ) : null}
      {board.focus ? (
        <Text style={{ color: '#f6f6f4', fontSize: 16, fontWeight: '700', textTransform: 'uppercase', marginTop: 8 }} numberOfLines={2}>{board.focus}</Text>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: '#212127' }}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={{ color: MUTED, fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' }}>Format</Text>
          <Text style={{ color: '#f6f6f4', fontSize: 17, fontWeight: '800', textTransform: 'uppercase', marginTop: 3 }} numberOfLines={2}>{board.format || ''}</Text>
        </View>
        {capText ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: MUTED, fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase' }}>Cap</Text>
            <Text style={{ color: GOLD, fontSize: 22, fontWeight: '800', marginTop: 3 }}>{capText}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', paddingVertical: 8 }}>
        <Text style={{ width: 26 }} />
        <Text style={{ flex: 1.1, color: MUTED, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>Station</Text>
        <Text style={{ flex: 1.3, color: GOLD, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', textAlign: 'right' }}>Target</Text>
      </View>
      {stations.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#17171b' }}>
          <Text style={{ width: 26, color: MUTED, fontSize: 12, fontWeight: '700' }}>{String(i + 1).padStart(2, '0')}</Text>
          <Text style={{ flex: 1.1, color: '#f6f6f4', fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{s.name}</Text>
          <Text style={{ flex: 1.3, color: GOLD_LITE, fontSize: 15, fontWeight: '700', textAlign: 'right' }} numberOfLines={2}>{stationTarget(s)}</Text>
        </View>
      ))}

      {board.target ? (
        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 2, borderTopColor: '#212127', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: MUTED, fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase', marginRight: 8 }}>Target</Text>
          <Text style={{ color: GOLD, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', flexShrink: 1 }} numberOfLines={2}>{board.target}</Text>
        </View>
      ) : null}
    </View>
  )
}
