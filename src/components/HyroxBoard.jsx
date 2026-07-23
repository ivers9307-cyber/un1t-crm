'use client'
// HYROX-TC — the portrait TV board. A glanceable race scoreboard, not a text
// dump: every board field is a SHORT value (the coaching detail lives in the
// coach's session view, never on the wall). Sized in container-query units so it
// scales to the TV stage (TVDisplay wraps it in a container-type:size box).
import { tvFontFamily } from './tv-font'

const GOLD = '#e7c24a'

// "WEEK 1 of 12 - BASE PHASE" -> { main: "WEEK 1 / 12", phase: "BASE PHASE" }.
// Falls back to the whole label as `main` when there is no phase suffix.
function splitWeek(weekLabel) {
  const wl = String(weekLabel || '').trim()
  if (!wl) return { main: '', phase: '' }
  const parts = wl.split(/\s[-–—]\s/)
  const main = (parts[0] || '').replace(/\bof\b/i, '/').toUpperCase()
  const phase = parts.slice(1).join(' ').toUpperCase()
  return { main, phase }
}

export default function HyroxBoard({ board }) {
  if (!board) return null
  const stations = Array.isArray(board.stations) ? board.stations : []
  const { main: weekMain, phase } = splitWeek(board.week_label)
  const cap = board.cap_minutes
  const capText = cap ? `${String(cap).padStart(2, '0')}:00` : ''

  return (
    <div className="hxb" style={{ fontFamily: tvFontFamily }}>
      <style>{`
        .hxb {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          color: #f6f6f4; padding: 5.5cqh 6cqw 4.5cqh; box-sizing: border-box;
          background:
            radial-gradient(120% 60% at 50% -8%, rgba(231,194,74,0.10), transparent 60%),
            #0b0b0d;
        }
        .hxb-hd { text-align: center; }
        .hxb-loc { font-size: 2.1cqh; letter-spacing: 0.55cqw; color: #7c7c84; text-transform: uppercase; }
        .hxb-word { font-size: 12cqh; font-weight: 800; letter-spacing: -0.2cqw; line-height: 0.86; margin-top: 1.2cqh; }
        .hxb-tc { display: inline-flex; align-items: center; gap: 2cqw; margin-top: 1.4cqh; }
        .hxb-tc span { font-size: 2.3cqh; font-weight: 600; letter-spacing: 0.5cqw; color: ${GOLD}; text-transform: uppercase; }
        .hxb-tc i { display: block; height: 1px; width: 7cqw; }
        .hxb-tc i.l { background: linear-gradient(90deg, transparent, ${GOLD}); }
        .hxb-tc i.r { background: linear-gradient(90deg, ${GOLD}, transparent); }
        .hxb-meta { display: flex; align-items: center; justify-content: space-between; gap: 3cqw; margin-top: 4cqh; }
        .hxb-wk { font-size: 2.2cqh; font-weight: 700; letter-spacing: 0.25cqw; }
        .hxb-phase { font-size: 1.7cqh; letter-spacing: 0.28cqw; text-transform: uppercase; color: #7c7c84; border: 1px solid #212127; border-radius: 999px; padding: 0.7cqh 2.2cqw; white-space: nowrap; }
        .hxb-focus { margin-top: 2.2cqh; font-size: 3.3cqh; font-weight: 700; letter-spacing: -0.03cqw; text-transform: uppercase; }
        .hxb-fmt { display: flex; align-items: flex-end; justify-content: space-between; gap: 4cqw; margin-top: 3.4cqh; padding-bottom: 2.6cqh; border-bottom: 2px solid #212127; }
        .hxb-lbl { font-size: 1.6cqh; letter-spacing: 0.3cqw; text-transform: uppercase; color: #52525a; }
        .hxb-fval { font-size: 4.2cqh; font-weight: 800; letter-spacing: -0.05cqw; text-transform: uppercase; line-height: 1.02; margin-top: 0.8cqh; }
        .hxb-clock { text-align: right; flex-shrink: 0; }
        .hxb-time { font-size: 4.6cqh; font-weight: 800; color: ${GOLD}; letter-spacing: 0.1cqw; font-variant-numeric: tabular-nums; line-height: 1; margin-top: 0.8cqh; }
        .hxb-tbl { flex: 1; display: flex; flex-direction: column; margin-top: 1cqh; min-height: 0; }
        .hxb-thead, .hxb-trow { display: grid; grid-template-columns: 4cqw 1.9fr 1fr 1fr; align-items: center; gap: 1.5cqw; }
        .hxb-thead { font-size: 1.7cqh; letter-spacing: 0.22cqw; text-transform: uppercase; color: #52525a; padding: 2.2cqh 0 1.6cqh; }
        .hxb-r { text-align: right; }
        .hxb-thead .hxb-perf { color: ${GOLD}; }
        .hxb-trow { padding: 1.9cqh 0; border-top: 1px solid #17171b; }
        .hxb-idx { font-size: 1.9cqh; font-weight: 700; color: #52525a; font-variant-numeric: tabular-nums; }
        .hxb-nm { font-size: 3cqh; font-weight: 600; letter-spacing: -0.02cqw; }
        .hxb-v { text-align: right; font-size: 3cqh; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02cqw; }
        .hxb-vperf { color: #f0d689; }
        .hxb-velite { color: #f6f6f4; }
        .hxb-tgt { margin-top: 2cqh; padding-top: 2.6cqh; border-top: 2px solid #212127; display: flex; align-items: center; justify-content: center; gap: 2.5cqw; text-align: center; }
        .hxb-tgtk { font-size: 1.7cqh; letter-spacing: 0.3cqw; text-transform: uppercase; color: #52525a; flex-shrink: 0; }
        .hxb-tgtv { font-size: 3cqh; font-weight: 800; letter-spacing: 0.05cqw; text-transform: uppercase; color: ${GOLD}; }
      `}</style>

      <div className="hxb-hd">
        {board.location_label ? <div className="hxb-loc">{board.location_label}</div> : null}
        <div className="hxb-word">HYROX</div>
        <div className="hxb-tc"><i className="l" /><span>Training Club</span><i className="r" /></div>
      </div>

      {(weekMain || phase) ? (
        <div className="hxb-meta">
          <div className="hxb-wk">{weekMain}</div>
          {phase ? <div className="hxb-phase">{phase}</div> : null}
        </div>
      ) : null}
      {board.focus ? <div className="hxb-focus">{board.focus}</div> : null}

      <div className="hxb-fmt">
        <div>
          <div className="hxb-lbl">Format</div>
          <div className="hxb-fval">{board.format || ''}</div>
        </div>
        {capText ? (
          <div className="hxb-clock">
            <div className="hxb-lbl">Cap</div>
            <div className="hxb-time">{capText}</div>
          </div>
        ) : null}
      </div>

      <div className="hxb-tbl">
        <div className="hxb-thead">
          <div />
          <div>Station</div>
          <div className="hxb-r hxb-perf">Performance</div>
          <div className="hxb-r">Elite</div>
        </div>
        {stations.map((s, i) => (
          <div key={i} className="hxb-trow">
            <div className="hxb-idx">{String(i + 1).padStart(2, '0')}</div>
            <div className="hxb-nm">{s.name}</div>
            <div className="hxb-v hxb-vperf">{s.performance ?? ''}</div>
            <div className="hxb-v hxb-velite">{s.elite ?? ''}</div>
          </div>
        ))}
      </div>

      {board.target ? (
        <div className="hxb-tgt">
          <span className="hxb-tgtk">Target</span>
          <span className="hxb-tgtv">{board.target}</span>
        </div>
      ) : null}
    </div>
  )
}
