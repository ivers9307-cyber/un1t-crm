// UI-FOUND.2 — Table primitive.
//
// Column-driven table with built-in loading / empty states. Replaces
// bespoke *Table.jsx markup (OrdersTable, AuditLogTable,
// AchievementsAdminTable). State resolution + cell access are
// unit-tested in styles.js (tableState / cellValue).
//
// columns: [{ key, header, accessor?|render?, className?, align? }]
import { tableState, cellValue } from './styles.js'

function alignClass(align) {
  if (align === 'right') return 'text-right'
  if (align === 'center') return 'text-center'
  return 'text-left'
}

/**
 * @param {object} props
 * @param {Array<{key:string, header:React.ReactNode, accessor?:string, render?:Function, className?:string, align?:'left'|'center'|'right'}>} props.columns
 * @param {Array<object>} props.rows
 * @param {boolean} [props.loading]
 * @param {React.ReactNode} [props.empty]  shown when there are no rows
 * @param {(row:object)=>void} [props.onRowClick]
 * @param {(row:object,i:number)=>string} [props.rowKey]  defaults to row.id ?? index
 */
export default function Table({
  columns = [],
  rows = [],
  loading = false,
  empty = 'Nothing to show.',
  onRowClick,
  rowKey,
  className,
}) {
  const state = tableState({ rows, loading })
  const colSpan = columns.length || 1

  return (
    <div className={className}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
            {columns.map((col) => (
              <th key={col.key} className={`py-2 px-3 font-medium ${alignClass(col.align)}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state === 'loading' && (
            <tr>
              <td colSpan={colSpan} className="py-8 text-center text-un1t-subtle">Loading…</td>
            </tr>
          )}
          {state === 'empty' && (
            <tr>
              <td colSpan={colSpan} className="py-8 text-center text-un1t-subtle">{empty}</td>
            </tr>
          )}
          {state === 'rows' && rows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : (row?.id ?? i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={
                'border-b border-un1t-border/60 ' +
                (onRowClick ? 'cursor-pointer hover:bg-un1t-surface' : '')
              }
            >
              {columns.map((col) => (
                <td key={col.key} className={`py-2 px-3 text-un1t-text ${alignClass(col.align)} ${col.className || ''}`}>
                  {cellValue(row, col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
