'use client'
// HYROX-TC — the portrait TV board. A glanceable race scoreboard, not a text
// dump: every board field is a SHORT value (the coaching detail lives in the
// coach's session view, never on the wall). Sized in container-query units so it
// scales to the TV stage (TVDisplay wraps it in a container-type:size box).
//
// One TARGET per station (no Performance/Elite split on the wall — tier scaling
// is coached / lives in the session view). The station rows FLEX to fill the
// space so any count fits; the target column is wide and wraps to 2 lines, and
// the free-text fields clamp, so no data is ever hidden or overflows.
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

// The single board value: the dedicated `target`, falling back to the old
// `performance` field so sessions generated before the single-target change
// still render (and never show blank).
function stationTarget(s) {
  return s?.target ?? s?.performance ?? s?.elite ?? ''
}

export default function HyroxBoard({ board }) {
  if (!board) return null
  const stations = Array.isArray(board.stations) ? board.stations : []
  const { main: weekMain, phase } = splitWeek(board.week_label)
  const cap = board.cap_minutes
  const capText = cap ? `${String(cap).padStart(2, '0')}:00` : ''
  const dense = stations.length > 8

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
        /* Clamp free-text fields so verbose (older) data can never crush the table. */
        .hxb-focus { margin-top: 1.8cqh; font-size: 2.9cqh; font-weight: 700; letter-spacing: -0.03cqw; text-transform: uppercase; flex-shrink: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
        .hxb-fmt { display: flex; align-items: flex-end; justify-content: space-between; gap: 4cqw; margin-top: 2.6cqh; padding-bottom: 2.2cqh; border-bottom: 2px solid #212127; flex-shrink: 0; }
        .hxb-lbl { font-size: 1.6cqh; letter-spacing: 0.3cqw; text-transform: uppercase; color: #52525a; }
        .hxb-fval { font-size: 3.2cqh; font-weight: 800; letter-spacing: -0.05cqw; text-transform: uppercase; line-height: 1.05; margin-top: 0.7cqh; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
        .hxb-clock { text-align: right; flex-shrink: 0; }
        .hxb-time { font-size: 4.2cqh; font-weight: 800; color: ${GOLD}; letter-spacing: 0.1cqw; font-variant-numeric: tabular-nums; line-height: 1; margin-top: 0.7cqh; }

        /* Station table: two columns (station | target). Rows flex to fill so any
           count fits; the target is wide and may wrap to 2 lines. */
        .hxb-tbl { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; margin-top: 0.4cqh; }
        .hxb-cols { display: grid; grid-template-columns: 4cqw 1.15fr 1.45fr; align-items: center; gap: 2.5cqw; }
        .hxb-thead { flex-shrink: 0; font-size: 1.6cqh; letter-spacing: 0.22cqw; text-transform: uppercase; color: #52525a; padding: 1.8cqh 0 1.2cqh; }
        .hxb-r { text-align: right; }
        .hxb-thead .hxb-tgtcol { color: ${GOLD}; }
        .hxb-rows { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; }
        .hxb-trow { flex: 1 1 0; min-height: 0; border-top: 1px solid #17171b; }
        .hxb-idx { font-size: 1.8cqh; font-weight: 700; color: #52525a; font-variant-numeric: tabular-nums; }
        .hxb-nm { font-size: 2.4cqh; font-weight: 600; letter-spacing: -0.02cqw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .hxb-val { text-align: right; font-size: 2.5cqh; font-weight: 700; color: #f0d689; font-variant-numeric: tabular-nums; letter-spacing: -0.02cqw; line-height: 1.12; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
        .hxb[data-dense="1"] .hxb-nm { font-size: 2.1cqh; }
        .hxb[data-dense="1"] .hxb-val { font-size: 2.2cqh; }

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
          <div className="hxb-r hxb-tgtcol">Target</div>
        </div>
        <div className="hxb-rows">
          {stations.map((s, i) => (
            <div key={i} className="hxb-cols hxb-trow">
              <div className="hxb-idx">{String(i + 1).padStart(2, '0')}</div>
              <div className="hxb-nm">{s.name}</div>
              <div className="hxb-val">{stationTarget(s)}</div>
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
