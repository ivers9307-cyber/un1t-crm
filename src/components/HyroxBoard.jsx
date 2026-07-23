'use client'
import { tvFontFamily } from './tv-font'

export default function HyroxBoard({ board }) {
  if (!board) return null
  const stations = Array.isArray(board.stations) ? board.stations : []
  const gold = '#d8b24a'
  const col = { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', alignItems: 'center' }
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0d0d0f', color: '#f4f4f5', fontFamily: tvFontFamily, display: 'flex', flexDirection: 'column', padding: '6cqh 5cqw', boxSizing: 'border-box' }}>
      <div style={{ textAlign: 'center', borderBottom: '1px solid #2a2a2e', paddingBottom: '3cqh' }}>
        <div style={{ fontSize: '2.4cqh', letterSpacing: '0.5cqw', color: '#8a8a90' }}>{board.location_label || ''}</div>
        <div style={{ fontSize: '9cqh', fontWeight: 600, letterSpacing: '0.3cqw', lineHeight: 1, marginTop: '1cqh' }}>HYROX</div>
        <div style={{ fontSize: '3cqh', letterSpacing: '1.2cqw', color: gold, marginTop: '0.6cqh' }}>TRAINING CLUB</div>
      </div>
      <div style={{ textAlign: 'center', padding: '3cqh 0', borderBottom: '1px solid #2a2a2e' }}>
        <div style={{ fontSize: '2.6cqh', letterSpacing: '0.5cqw', color: '#8a8a90' }}>{board.week_label || ''}</div>
        {board.focus ? <div style={{ fontSize: '3.4cqh', fontWeight: 500, color: gold, marginTop: '1cqh' }}>{board.focus}</div> : null}
      </div>
      <div style={{ textAlign: 'center', padding: '3cqh 0 2cqh' }}>
        <div style={{ fontSize: '5cqh', fontWeight: 600, letterSpacing: '0.2cqw' }}>{board.format || ''}</div>
        {board.cap_minutes ? <div style={{ fontSize: '2.6cqh', color: '#8a8a90', marginTop: '0.6cqh' }}>{`CAP ${board.cap_minutes}:00`}</div> : null}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ ...col, fontSize: '2.2cqh', letterSpacing: '0.3cqw', color: '#8a8a90', padding: '1.4cqh 0' }}>
          <div style={{ textAlign: 'left' }}>STATION</div>
          <div style={{ textAlign: 'right', color: gold }}>PERFORMANCE</div>
          <div style={{ textAlign: 'right' }}>ELITE</div>
        </div>
        {stations.map((s, i) => (
          <div key={i} style={{ ...col, fontSize: '3cqh', padding: '1.8cqh 0', borderTop: '1px solid #1f1f22' }}>
            <div style={{ textAlign: 'left' }}>{s.name}</div>
            <div style={{ textAlign: 'right', color: '#f4d98a' }}>{s.performance ?? ''}</div>
            <div style={{ textAlign: 'right' }}>{s.elite ?? ''}</div>
          </div>
        ))}
      </div>
      {board.target ? <div style={{ textAlign: 'center', borderTop: '1px solid #2a2a2e', paddingTop: '2.4cqh', fontSize: '2.4cqh', color: '#c8c8cc' }}>{board.target}</div> : null}
    </div>
  )
}
