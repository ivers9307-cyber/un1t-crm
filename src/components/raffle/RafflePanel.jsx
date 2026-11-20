'use client'
// RAFFLE.1 — the raffle page for a charity event, built for a tablet at the
// till: Sell (find the buyer, pick tickets, cash or card), Sales (totals and
// void) and Draw (prize by prize, with a full-screen view for the TV).
//
// Every action goes through /api/events/[id]/raffle/*. Nothing here creates or
// changes a contact: a buyer who isn't in the CRM is a guest on the sale.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, UserPlus, Ticket, Trophy, Maximize2, X, Minus, Plus, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { formatTicketNumber, formatTicketRange, formatTicketList, formatEuros, optionLabel, priceForQuantity } from '@/lib/raffle-format'

const INPUT = 'w-full h-11 rounded-lg border border-un1t-border bg-white px-3 text-base text-un1t-text focus:outline-none focus:ring-2 focus:ring-un1t-accent'
const TABS = [
  { key: 'sell', label: 'Sell', icon: Ticket },
  { key: 'sales', label: 'Sales' },
  { key: 'draw', label: 'Draw', icon: Trophy },
]

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  let body = null
  try { body = await res.json() } catch { body = null }
  if (!res.ok || !body?.success) {
    const err = new Error(body?.error || `Something went wrong (${res.status}). Try again.`)
    err.status = res.status
    throw err
  }
  return body.data
}

const newRequestId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

const EMAIL_LABEL = { sent: 'Email sent', suppressed: 'Email blocked (bounced)', failed: 'Email failed', skipped: 'No email' }

export default function RafflePanel({ raceId }) {
  const [state, setState] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState('sell')
  const [editing, setEditing] = useState(false)

  const reload = useCallback(async () => {
    try {
      setState(await api(`/api/events/${raceId}/raffle`))
      setLoadError('')
    } catch (e) {
      setLoadError(e.message)
    }
  }, [raceId])

  useEffect(() => { reload() }, [reload])

  if (loadError && !state) return <p className="text-sm text-red-700">{loadError}</p>
  if (!state) return <p className="text-sm text-un1t-subtle">Loading…</p>

  if (!state.raffle) {
    return state.can_manage
      ? <RaffleSetup raceId={raceId} eventName={state.event?.name} onSaved={reload} />
      : <p className="text-sm text-un1t-subtle">There is no raffle on this event yet. Ask a manager to set one up.</p>
  }

  const { raffle, totals } = state
  if (editing) {
    return (
      <RaffleSetup
        raceId={raceId} raffle={raffle} onlineAvailable={!!state.online_available}
        onSaved={async () => { await reload(); setEditing(false) }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  const optionsLine = (raffle.ticket_options || []).map((o) => optionLabel(o.tickets, o.price_cents)).join(' · ')
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-lg font-semibold text-un1t-text">{raffle.name}</div>
          <div className="text-sm text-un1t-subtle">
            {formatEuros(raffle.ticket_price_cents, raffle.currency)} a ticket{optionsLine ? ` · ${optionsLine}` : ''} · {totals.tickets} sold · {formatEuros(totals.cents, raffle.currency)} raised
          </div>
          {state.can_manage && (
            <Button variant="ghost" size="sm" icon={Settings} className="mt-1 -ml-3" onClick={() => setEditing(true)}>Settings</Button>
          )}
        </div>
        <div className="flex gap-1 rounded-lg border border-un1t-border p-1 bg-un1t-surface" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`h-10 px-4 rounded-md text-sm font-medium ${tab === t.key ? 'bg-white text-un1t-text shadow-sm' : 'text-un1t-subtle'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'sell' && <SellPanel raceId={raceId} raffle={raffle} onSold={reload} />}
      {tab === 'sales' && <SalesPanel raceId={raceId} state={state} onChanged={reload} />}
      {tab === 'draw' && <DrawPanel raceId={raceId} state={state} onChanged={reload} />}
    </div>
  )
}

function RaffleSetup({ raceId, eventName, raffle = null, onlineAvailable = false, onSaved, onCancel }) {
  const [name, setName] = useState(raffle?.name || (eventName ? `${eventName} Raffle` : 'Raffle'))
  const [price, setPrice] = useState(raffle ? String(raffle.ticket_price_cents / 100) : '5')
  const [options, setOptions] = useState(
    (raffle?.ticket_options || []).map((o) => ({ tickets: String(o.tickets), price: String(o.price_cents / 100) })),
  )
  const [online, setOnline] = useState(!!raffle?.online_enabled)
  const [closesDate, setClosesDate] = useState(raffle?.online_closes_local?.date || '')
  const [closesTime, setClosesTime] = useState(raffle?.online_closes_local?.time || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const setOption = (i, patch) => setOptions((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)))

  async function save(e) {
    e.preventDefault()
    const cents = Math.round(Number(price) * 100)
    if (!Number.isFinite(cents) || cents < 1) { setError('Enter a ticket price.'); return }
    const ticketOptions = []
    for (const o of options) {
      if (!o.tickets && !o.price) continue
      const tickets = parseInt(o.tickets, 10)
      const priceCents = Math.round(Number(o.price) * 100)
      if (!Number.isInteger(tickets) || tickets < 2) { setError('Each option needs 2 or more tickets.'); return }
      if (!Number.isFinite(priceCents) || priceCents < 1) { setError(`Enter a price for the ${tickets}-ticket option.`); return }
      ticketOptions.push({ tickets, price_cents: priceCents })
    }
    if (new Set(ticketOptions.map((o) => o.tickets)).size !== ticketOptions.length) {
      setError('Each option needs a different number of tickets.'); return
    }
    if (online && (!closesDate || !closesTime)) { setError('Set when online sales close.'); return }
    setBusy(true)
    setError('')
    try {
      await api(`/api/events/${raceId}/raffle`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), ticket_price_cents: cents, ticket_options: ticketOptions,
          ...(raffle && onlineAvailable ? {
            online_enabled: online,
            online_closes_date: closesDate || null,
            online_closes_time: closesTime || null,
          } : {}),
        }),
      })
      await onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="max-w-lg space-y-4 rounded-xl border border-un1t-border bg-white p-5">
      <div className="text-base font-semibold text-un1t-text">{raffle ? 'Raffle settings' : 'Set up the raffle'}</div>
      <label className="block">
        <span className="block text-sm text-un1t-subtle mb-1">Raffle name</span>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </label>
      <label className="block">
        <span className="block text-sm text-un1t-subtle mb-1">Price for one ticket (€)</span>
        <input className={INPUT} type="number" inputMode="decimal" min="0.01" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required aria-label="Price for one ticket" />
      </label>
      <div>
        <div className="text-sm text-un1t-subtle mb-1">Ticket options</div>
        <div className="space-y-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${INPUT} w-24`} type="number" inputMode="numeric" min="2" max="500" placeholder="Tickets" aria-label={`Option ${i + 1} tickets`} value={o.tickets} onChange={(e) => setOption(i, { tickets: e.target.value })} />
              <span className="text-sm text-un1t-subtle">tickets for €</span>
              <input className={`${INPUT} w-28`} type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="Price" aria-label={`Option ${i + 1} price`} value={o.price} onChange={(e) => setOption(i, { price: e.target.value })} />
              <Button variant="ghost" size="icon" icon={Trash2} aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((list) => list.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setOptions((list) => [...list, { tickets: '', price: '' }])}>Add an option</Button>
        </div>
        <p className="text-xs text-un1t-subtle mt-2">Any other number of tickets is sold at the one-ticket price. Changes apply to new sales only.</p>
      </div>
      {raffle && onlineAvailable && (
        <div className="rounded-lg border border-un1t-border p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-un1t-text">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} aria-label="Sell tickets online" />
            Sell tickets online on the event page
          </label>
          {online && (
            <div>
              <div className="text-sm text-un1t-subtle mb-1">Online sales close</div>
              <div className="flex gap-2">
                <input className={`${INPUT} w-44`} type="date" aria-label="Online sales close date" value={closesDate} onChange={(e) => setClosesDate(e.target.value)} />
                <input className={`${INPUT} w-32`} type="time" aria-label="Online sales close time" value={closesTime} onChange={(e) => setClosesTime(e.target.value)} />
              </div>
              <p className="text-xs text-un1t-subtle mt-1">Online buyers pay by card on the event page and get their numbers by email. Online sales are up to 50 tickets each.</p>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>{raffle ? 'Save' : 'Create raffle'}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}

function SellPanel({ raceId, raffle, onSold }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [buyer, setBuyer] = useState(null) // { contact_id?, name, email }
  const [guest, setGuest] = useState(null) // { name, email } while adding a guest
  const [quantity, setQuantity] = useState(1)
  const [method, setMethod] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const requestId = useRef(newRequestId())

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || buyer) { setResults([]); return }
    let live = true
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const data = await api(`/api/events/${raceId}/raffle/contacts?q=${encodeURIComponent(q)}`)
        if (live) setResults(data.contacts || [])
      } catch {
        if (live) setResults([])
      } finally {
        if (live) setSearching(false)
      }
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [query, raceId, buyer])

  function reset() {
    setQuery(''); setResults([]); setBuyer(null); setGuest(null)
    setQuantity(1); setMethod(null); setError('')
    requestId.current = newRequestId()
  }

  function pickContact(c) {
    setBuyer({ contact_id: c.id, name: c.name || '', email: c.email || '', needsEmail: !c.email })
    setResults([]); setGuest(null); setDone(null)
  }

  function confirmGuest() {
    if (!guest?.name?.trim() || !guest?.email?.trim()) { setError('A guest needs a name and an email.'); return }
    setBuyer({ contact_id: null, name: guest.name.trim(), email: guest.email.trim() })
    setGuest(null); setError('')
  }

  async function sell(e) {
    e.preventDefault()
    if (!buyer) { setError('Choose who is buying first.'); return }
    if (!buyer.email?.trim()) { setError('Enter an email for the tickets.'); return }
    if (!method) { setError('Choose cash or card.'); return }
    setBusy(true); setError('')
    try {
      const data = await api(`/api/events/${raceId}/raffle/sales`, {
        method: 'POST',
        body: JSON.stringify({
          request_id: requestId.current,
          contact_id: buyer.contact_id || null,
          buyer_name: buyer.name,
          buyer_email: buyer.email.trim(),
          quantity,
          payment_method: method,
        }),
      })
      setDone({ ...data.sale, buyer_name: buyer.name })
      reset()
      onSold()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const price = priceForQuantity(raffle, quantity)
  const total = price.cents
  const options = raffle.ticket_options || []

  return (
    <form onSubmit={sell} className="grid gap-4 md:grid-cols-2">
      <section className="rounded-xl border border-un1t-border bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-un1t-text">1. Who is buying?</div>
        {buyer ? (
          <div className="rounded-lg bg-un1t-surface p-3">
            <div className="font-medium text-un1t-text">{buyer.name}{buyer.contact_id ? '' : ' (guest)'}</div>
            {buyer.needsEmail ? (
              <input
                className={`${INPUT} mt-2`} type="email" placeholder="Email for the tickets"
                value={buyer.email} onChange={(e) => setBuyer({ ...buyer, email: e.target.value })}
              />
            ) : (
              <div className="text-sm text-un1t-subtle">{buyer.email}</div>
            )}
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setBuyer(null)}>Change</Button>
          </div>
        ) : guest ? (
          <div className="space-y-2">
            <input className={INPUT} placeholder="Name" value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} autoFocus />
            <input className={INPUT} type="email" placeholder="Email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
            <div className="flex gap-2">
              <Button onClick={confirmGuest}>Use this guest</Button>
              <Button variant="ghost" onClick={() => setGuest(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-un1t-subtle" aria-hidden="true" />
              <input
                className={`${INPUT} pl-9`} placeholder="Search name, email or phone"
                value={query} onChange={(e) => { setQuery(e.target.value); setDone(null) }}
                aria-label="Search name, email or phone"
              />
            </div>
            {searching && <div className="text-xs text-un1t-subtle">Searching…</div>}
            {results.length > 0 && (
              <ul className="divide-y divide-un1t-border rounded-lg border border-un1t-border">
                {results.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => pickContact(c)} className="w-full text-left px-3 py-3 hover:bg-un1t-surface">
                      <div className="font-medium text-un1t-text">{c.name || '(no name)'}</div>
                      <div className="text-xs text-un1t-subtle">{[c.phone, c.email].filter(Boolean).join(' · ') || 'No phone or email'}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query.trim().length >= 2 && !searching && results.length === 0 && (
              <div className="text-xs text-un1t-subtle">No one found.</div>
            )}
            <Button variant="secondary" icon={UserPlus} onClick={() => setGuest({ name: query.includes('@') ? '' : query.trim(), email: query.includes('@') ? query.trim() : '' })}>
              Add as guest
            </Button>
          </>
        )}
      </section>

      <section className="rounded-xl border border-un1t-border bg-white p-4 space-y-4">
        <div className="text-sm font-semibold text-un1t-text">2. Tickets and payment</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[{ tickets: 1, price_cents: raffle.ticket_price_cents }, ...options].map((o) => (
            <button
              key={o.tickets} type="button" aria-pressed={quantity === o.tickets} onClick={() => setQuantity(o.tickets)}
              className={`h-12 rounded-lg border text-sm font-medium ${quantity === o.tickets ? 'border-un1t-accent bg-un1t-accent text-white' : 'border-un1t-border text-un1t-text'}`}
            >
              {o.tickets === 1 ? `1 for ${formatEuros(o.price_cents, raffle.currency)}` : optionLabel(o.tickets, o.price_cents)}
            </button>
          ))}
        </div>
        <div className="text-xs text-un1t-subtle">Or any number:</div>
        <div className="flex items-center gap-3">
          <button type="button" aria-label="One fewer" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="h-12 w-12 rounded-lg border border-un1t-border flex items-center justify-center"><Minus className="h-5 w-5" /></button>
          <input
            className="h-12 w-20 rounded-lg border border-un1t-border text-center text-xl font-semibold"
            type="number" inputMode="numeric" min="1" max="500" aria-label="Number of tickets"
            value={quantity} onChange={(e) => setQuantity(Math.min(500, Math.max(1, parseInt(e.target.value, 10) || 1)))}
          />
          <button type="button" aria-label="One more" onClick={() => setQuantity((q) => Math.min(500, q + 1))} className="h-12 w-12 rounded-lg border border-un1t-border flex items-center justify-center"><Plus className="h-5 w-5" /></button>
          <div className="ml-auto text-right">
            <div className="text-xs text-un1t-subtle">Total</div>
            <div className="text-2xl font-semibold text-un1t-text">{formatEuros(total, raffle.currency)}</div>
            {price.label && <div className="text-xs text-un1t-subtle">{price.label}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {['cash', 'card'].map((m) => (
            <button
              key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
              className={`h-12 rounded-lg border text-base font-medium capitalize ${method === m ? 'border-un1t-accent bg-un1t-accent text-white' : 'border-un1t-border text-un1t-text'}`}
            >
              {m}
            </button>
          ))}
        </div>
        {!raffle.sales_open && <p className="text-sm text-amber-700">Sales are closed for this raffle.</p>}
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!raffle.sales_open}>
          Sell {quantity} ticket{quantity === 1 ? '' : 's'} · {formatEuros(total, raffle.currency)}
        </Button>
        {done && (
          <div className="rounded-lg bg-green-500/10 text-green-700 p-3 text-sm" role="status">
            <div className="font-semibold text-base">{formatTicketList(done.first_ticket, done.last_ticket)}</div>
            <div>{done.buyer_name} · {EMAIL_LABEL[done.email_status] || 'Email pending'}{done.email_status === 'sent' ? '' : ': tell them their numbers.'}</div>
          </div>
        )}
      </section>
    </form>
  )
}

function SalesPanel({ raceId, state, onChanged }) {
  const { raffle, sales, totals, can_manage: canManage } = state
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  async function voidSale(sale) {
    const reason = window.prompt(`Void ${formatTicketRange(sale.first_ticket, sale.last_ticket)} for ${sale.buyer_name}? Give a reason:`)
    if (!reason?.trim()) return
    setBusyId(sale.id); setError('')
    try {
      await api(`/api/events/${raceId}/raffle/sales/${sale.id}/void`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) })
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const f = filter.trim().toLowerCase()
  const shown = f
    ? sales.filter((s) => `${s.buyer_name} ${s.buyer_email}`.toLowerCase().includes(f)
      || (Number(f.replace('#', '')) >= s.first_ticket && Number(f.replace('#', '')) <= s.last_ticket))
    : sales

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-sm text-un1t-text">
        <span><strong>{formatEuros(totals.cents, raffle.currency)}</strong> raised</span>
        <span>{totals.tickets} tickets · {totals.sales} sales</span>
        <span>Cash {formatEuros(totals.cashCents, raffle.currency)}</span>
        <span>Card {formatEuros(totals.cardCents, raffle.currency)}</span>
      </div>
      <input className={INPUT} placeholder="Find a name, email or ticket number" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <ul className="divide-y divide-un1t-border rounded-xl border border-un1t-border bg-white">
        {shown.length === 0 && <li className="p-4 text-sm text-un1t-subtle">No sales yet.</li>}
        {shown.map((s) => (
          <li key={s.id} className={`flex flex-wrap items-center gap-3 p-3 ${s.voided_at ? 'opacity-50' : ''}`}>
            <div className="w-32 font-semibold text-un1t-text">{formatTicketRange(s.first_ticket, s.last_ticket)}</div>
            <div className="flex-1 min-w-[10rem]">
              <div className="text-un1t-text">{s.buyer_name}{s.contact_id ? '' : ' (guest)'}{s.channel === 'online' && <span className="ml-2 rounded bg-blue-500/10 text-blue-700 px-1.5 py-0.5 text-[11px]">Online</span>}</div>
              <div className="text-xs text-un1t-subtle">{s.buyer_email}</div>
            </div>
            <div className="text-xs text-un1t-subtle"><span className="capitalize">{s.payment_method}</span> · {formatEuros(s.total_cents, raffle.currency)}{s.option_label ? ` (${s.option_label})` : ''}</div>
            <div className="text-xs text-un1t-subtle">{new Date(s.created_at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="text-xs">
              {s.voided_at
                ? <span className="rounded bg-red-500/10 text-red-700 px-2 py-0.5">Voided{s.void_reason ? `: ${s.void_reason}` : ''}</span>
                : <span className={`rounded px-2 py-0.5 ${s.email_status === 'sent' ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}`}>{EMAIL_LABEL[s.email_status] || 'Email pending'}</span>}
            </div>
            {canManage && !s.voided_at && (
              <Button variant="ghost" size="sm" loading={busyId === s.id} onClick={() => voidSale(s)}>Void</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function DrawPanel({ raceId, state, onChanged }) {
  const { draws, can_manage: canManage, raffle } = state
  const [prize, setPrize] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [latest, setLatest] = useState(null)
  const [full, setFull] = useState(false)

  async function draw(e) {
    e?.preventDefault?.()
    if (!prize.trim()) { setError('Name the prize first.'); return }
    setBusy(true); setError('')
    try {
      const data = await api(`/api/events/${raceId}/raffle/draws`, { method: 'POST', body: JSON.stringify({ prize_name: prize.trim() }) })
      setLatest(data.draw)
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function unclaimed(d) {
    const note = window.prompt(`Mark ${formatTicketNumber(d.ticket_number)} (${d.prize_name}) as not claimed? Add a note (optional):`)
    if (note === null) return
    try {
      await api(`/api/events/${raceId}/raffle/draws/${d.id}/unclaimed`, { method: 'POST', body: JSON.stringify(note.trim() ? { note: note.trim() } : {}) })
      setPrize(d.prize_name)
      await onChanged()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={draw} className="flex flex-wrap gap-2 rounded-xl border border-un1t-border bg-white p-4">
        <input className={`${INPUT} flex-1 min-w-[12rem]`} placeholder="Prize, e.g. Hamper" value={prize} onChange={(e) => setPrize(e.target.value)} aria-label="Prize" />
        <Button type="submit" size="lg" icon={Trophy} loading={busy}>Draw</Button>
        <Button variant="secondary" size="lg" icon={Maximize2} onClick={() => setFull(true)}>Full screen</Button>
        {error && <p className="w-full text-sm text-red-700" role="alert">{error}</p>}
      </form>

      {latest && <WinnerCard draw={latest} />}

      <div>
        <div className="text-sm font-semibold text-un1t-text mb-2">Winners</div>
        <ol className="divide-y divide-un1t-border rounded-xl border border-un1t-border bg-white">
          {draws.length === 0 && <li className="p-4 text-sm text-un1t-subtle">No draws yet.</li>}
          {draws.map((d, i) => (
            <li key={d.id} className={`flex flex-wrap items-center gap-3 p-3 ${d.unclaimed_at ? 'opacity-60' : ''}`}>
              <span className="w-6 text-un1t-subtle">{i + 1}.</span>
              <span className="flex-1 text-un1t-text">{d.prize_name}</span>
              <span className="font-semibold text-un1t-text">{formatTicketNumber(d.ticket_number)}</span>
              <span className="text-un1t-text">{d.buyer_name}{d.channel === 'online' && d.buyer_email ? <a className="ml-2 text-xs text-un1t-accent underline" href={`mailto:${d.buyer_email}`}>{d.buyer_email}</a> : null}</span>
              {d.unclaimed_at
                ? <span className="text-xs rounded bg-amber-500/10 text-amber-700 px-2 py-0.5">Not claimed{d.unclaimed_note ? `: ${d.unclaimed_note}` : ''}</span>
                : canManage && <Button variant="ghost" size="sm" onClick={() => unclaimed(d)}>Not claimed</Button>}
            </li>
          ))}
        </ol>
      </div>

      {full && (
        <div className="fixed inset-0 z-50 bg-black text-white flex flex-col">
          <div className="flex items-center justify-between p-6">
            <div className="text-2xl font-semibold opacity-80">{raffle.name}</div>
            <button type="button" onClick={() => setFull(false)} aria-label="Close full screen" className="h-12 w-12 flex items-center justify-center rounded-full bg-white/10"><X className="h-6 w-6" /></button>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            {latest ? (
              <>
                <div className="text-3xl md:text-5xl opacity-80 mb-6">{latest.prize_name}</div>
                <div className="text-[22vw] md:text-[16vw] leading-none font-bold tabular-nums">{formatTicketNumber(latest.ticket_number)}</div>
                <div className="text-4xl md:text-6xl mt-6 font-semibold">{latest.winner_display}</div>
              </>
            ) : (
              <div className="text-4xl opacity-60">Ready to draw</div>
            )}
          </div>
          <form onSubmit={draw} className="flex flex-wrap gap-3 p-6 justify-center">
            <input className="h-14 w-80 rounded-lg bg-white/10 px-4 text-xl text-white placeholder-white/50 focus:outline-none" placeholder="Prize" value={prize} onChange={(e) => setPrize(e.target.value)} aria-label="Prize" />
            <button type="submit" disabled={busy} className="h-14 px-10 rounded-lg bg-white text-black text-xl font-semibold disabled:opacity-50">{busy ? 'Drawing…' : 'Draw'}</button>
            {error && <p className="w-full text-center text-red-300">{error}</p>}
          </form>
        </div>
      )}
    </div>
  )
}

function WinnerCard({ draw }) {
  return (
    <div className="rounded-xl border-2 border-un1t-accent bg-white p-6 text-center">
      <div className="text-sm text-un1t-subtle">{draw.prize_name}</div>
      <div className="text-6xl font-bold text-un1t-text tabular-nums my-2">{formatTicketNumber(draw.ticket_number)}</div>
      <div className="text-xl text-un1t-text">{draw.buyer_name}</div>
    </div>
  )
}
