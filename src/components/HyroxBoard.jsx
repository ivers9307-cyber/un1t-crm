'use client'
// HYROX-TC — the portrait TV board. A glanceable race scoreboard, not a text
// dump: every board field is a SHORT value (the coaching detail lives in the
// coach's session view, never on the wall). Sized in container-query units so it
// scales to the TV stage (TVDisplay wraps it in a container-type:size box).
//
// The station rows FLEX to fill the space, so a dense loop (9+ stations, runs
// listed between machines) fits without overflowing into the target footer.
// Values never wrap — a scoreboard reads in one glance.
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
  // Dense boards (many stations) shrink type a touch so every row stays on one
  // line without crowding.
  const dense = stations.length > 7

  return (
    <div className="hxb" data-dense={dense ? '1' : '0'} style={{ fontFamily: tvFontFamily }}>
      <style>{`
        .hxb {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          color: #f6f6f4; padding: 5cqh 6cqw 4cqh; box-sizing: border-box;
          background:
            radial-gradient(120% 55% at 50% -8%, rgba(231,194,74,0.10), transparent 60%),
            #0b0b0d;
        }
        .hxb-hd { text-align: center; flex-shrink: 0; }
        .hxb-loc { font-size: 2.1cqh; letter-spacing: 0.55cqw; color: #7c7c84; text-transform: uppercase; }
        .hxb-word { font-size: 10cqh; font-weight: 800; letter-spacing: -0.2cqw; line-height: 0.86; margin-top: 1cqh; }
        .hxb-tc { display: inline-flex; align-items: center; gap: 2cqw; margin-top: 1.2cqh; }
        .hxb-tc span { font-size: 2.2cqh; font-weight: 600; letter-spacing: 0.5cqw; color: ${GOLD}; text-transform: uppercase; }
        .hxb-tc i { display: block; height: 1px; width: 7cqw; }
        .hxb-tc i.l { background: linear-gradient(90deg, transparent, ${GOLD}); }
        .hxb-tc i.r { background: linear-gradient(90deg, ${GOLD}, transparent); }
        .hxb-meta { display: flex; align-items: center; justify-content: space-between; gap: 3cqw; margin-top: 3cqh; flex-shrink: 0; }
        .hxb-wk { font-size: 2.2cqh; font-weight: 700; letter-spacing: 0.25cqw; }
        .hxb-phase { font-size: 1.7cqh; letter-spacing: 0.28cqw; text-transform: uppercase; color: #7c7c84; border: 1px solid #212127; border-radius: 999px; padding: 0.7cqh 2.2cqw; white-space: nowrap; }
        /* Clamp the free-text fields so verbose data (older sessions, or a stray
           long value) can never expand unbounded and crush the station table. */
        .hxb-focus { margin-top: 1.8cqh; font-size: 2.9cqh; font-weight: 700; letter-spacing: -0.03cqw; text-transform: uppercase; flex-shrink: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
        .hxb-fmt { display: flex; align-items: flex-end; justify-content: space-between; gap: 4cqw; margin-top: 2.6cqh; padding-bottom: 2.2cqh; border-bottom: 2px solid #212127; flex-shrink: 0; }
        .hxb-lbl { font-size: 1.6cqh; letter-spacing: 0.3cqw; text-transform: uppercase; color: #52525a; }
        .hxb-fval { font-size: 3.2cqh; font-weight: 800; letter-spacing: -0.05cqw; text-transform: uppercase; line-height: 1.05; margin-top: 0.7cqh; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
        .hxb-clock { text-align: right; flex-shrink: 0; }
        .hxb-time { font-size: 4.2cqh; font-weight: 800; color: ${GOLD}; letter-spacing: 0.1cqw; font-variant-numeric: tabular-nums; line-height: 1; margin-top: 0.7cqh; }

        /* Table fills remaining height; rows share it evenly so any count fits. */
        .hxb-tbl { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; margin-top: 0.4cqh; }
        .hxb-cols { display: grid; grid-template-columns: 4cqw 1.3fr 1fr 1fr; align-items: center; gap: 2cqw; }
        .hxb-thead { flex-shrink: 0; font-size: 1.6cqh; letter-spacing: 0.22cqw; text-transform: uppercase; color: #52525a; padding: 1.8cqh 0 1.2cqh; }
        .hxb-r { text-align: right; }
        .hxb-thead .hxb-perf { color: ${GOLD}; }
        .hxb-rows { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; }
        .hxb-trow { flex: 1 1 0; min-height: 0; border-top: 1px solid #17171b; }
        .hxb-idx { font-size: 1.8cqh; font-weight: 700; color: #52525a; font-variant-numeric: tabular-nums; }
        .hxb-nm, .hxb-v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .hxb-nm { font-size: 2.8cqh; font-weight: 600; letter-spacing: -0.02cqw; }
        .hxb-v { text-align: right; font-size: 2.7cqh; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02cqw; }
        .hxb[data-dense="1"] .hxb-nm { font-size: 2.4cqh; }
        .hxb[data-dense="1"] .hxb-v { font-size: 2.3cqh; }
        .hxb-vperf { color: #f0d689; }
        .hxb-velite { color: #f6f6f4; }

        .hxb-tgt { flex-shrink: 0; margin-top: 1.6cqh; padding-top: 2.2cqh; border-top: 2px solid #212127; display: flex; align-items: center; justify-content: center; gap: 2.5cqw; text-align: center; }
        .hxb-tgtk { font-size: 1.7cqh; letter-spacing: 0.3cqw; text-transform: uppercase; color: #52525a; flex-shrink: 0; }
        .hxb-tgtv { font-size: 2.3cqh; font-weight: 800; letter-spacing: 0.05cqw; text-transform: uppercase; color: ${GOLD}; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
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
        <div className="hxb-cols hxb-thead">
          <div />
          <div>Station</div>
          <div className="hxb-r hxb-perf">Performance</div>
          <div className="hxb-r">Elite</div>
        </div>
        <div className="hxb-rows">
          {stations.map((s, i) => (
            <div key={i} className="hxb-cols hxb-trow">
              <div className="hxb-idx">{String(i + 1).padStart(2, '0')}</div>
              <div className="hxb-nm">{s.name}</div>
              <div className="hxb-v hxb-vperf">{s.performance ?? ''}</div>
              <div className="hxb-v hxb-velite">{s.elite ?? ''}</div>
            </div>
          ))}
        </div>
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
