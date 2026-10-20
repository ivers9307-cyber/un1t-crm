// UN1TWRITE.3 — the pure un1t.online write judge, the permission table and the
// error_events row. No fetch, no db: every input is a literal.

import { describe, it, expect } from 'vitest'
import {
  UN1T_WRITE_OPS, REQUIRED_PERMISSIONS, missingPermissions, permissionMissingMessage,
  judgeUn1tWrite, UN1T_REFUSAL_CODES, isCustomerAnswerable, classifyRefusal,
  isKnownBusinessRefusal, scrubMessage, un1tRoutePathLabel, un1tWriteFailureEvent,
  UN1T_REFUSAL_KINDS,
} from './un1t-online-write-judge.js'

const EVENT = '11111111-2222-4333-8444-555555555555'
const USER = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const STUDIO = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const BOOKING = '3f2a0000-1111-4222-8333-444444444444'
const OTHER = '99999999-9999-4999-8999-999999999999'
const bookExpect = { eventId: EVENT, userId: USER, studioId: STUDIO }
const bookingDto = (over = {}) => ({ id: BOOKING, event_id: EVENT, user_id: USER, studio_id: STUDIO, status: 'booked', ...over })
const RESULT_KEYS = ['alreadyBooked', 'code', 'id', 'message', 'verdict']

describe('UN1T_WRITE_OPS', () => {
  it('lists the seven ops (trial_regrant since TRIALREGRANT.1), frozen', () => {
    expect(UN1T_WRITE_OPS).toEqual(['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant'])
    expect(Object.isFrozen(UN1T_WRITE_OPS)).toBe(true)
  })
})

describe('judgeUn1tWrite: trial_regrant (TRIALREGRANT.1, POST /credits/grant)', () => {
  it('done only on a 2xx with success:true; the batch id when one is given', () => {
    expect(judgeUn1tWrite('trial_regrant', { status: 201, body: { success: true, data: { id: 'batch-1', amount: 3 } } })).toMatchObject({ verdict: 'done', id: 'batch-1' })
    expect(judgeUn1tWrite('trial_regrant', { status: 200, body: { success: true } })).toMatchObject({ verdict: 'done', id: null })
  })
  it('a 2xx without success:true is unknown (the credits read decides)', () => {
    for (const body of [{ data: { id: 'b' } }, {}, null, 'ok', { success: 'yes' }]) {
      expect(judgeUn1tWrite('trial_regrant', { status: 201, body }).verdict).toBe('unknown')
    }
    expect(judgeUn1tWrite('trial_regrant', { status: 502, body: {} }).verdict).toBe('unknown')
  })
  it('success:false or a 4xx is refused with un1t.online\'s code', () => {
    expect(judgeUn1tWrite('trial_regrant', { status: 200, body: { success: false, error: { code: 'NOPE', message: 'No' } } })).toMatchObject({ verdict: 'refused', code: 'NOPE' })
    expect(judgeUn1tWrite('trial_regrant', { status: 400, body: { message: ['amount must be an integer'] } })).toMatchObject({ verdict: 'refused', code: 'http_400' })
  })
})

describe('judgeUn1tWrite: book', () => {
  it('book 201 with data.id and matching event, user and studio is done with that id', () => {
    const v = judgeUn1tWrite('book', { status: 201, body: { success: true, data: bookingDto() }, expect: bookExpect })
    expect(v).toEqual({ verdict: 'done', id: BOOKING, code: null, message: null, alreadyBooked: false })
  })

  describe('book 201 whose data.event_id, user_id or studio_id differs from the request is unknown', () => {
    for (const field of ['event_id', 'user_id', 'studio_id']) {
      it(`${field} differs`, () => {
        const v = judgeUn1tWrite('book', { status: 201, body: { success: true, data: bookingDto({ [field]: OTHER }) }, expect: bookExpect })
        expect(v.verdict).toBe('unknown')
        expect(v.id).toBeNull()
        expect(v.alreadyBooked).toBe(false)
      })
    }
    it('a field the request names but the answer leaves out is unknown too', () => {
      const data = bookingDto()
      delete data.studio_id
      expect(judgeUn1tWrite('book', { status: 201, body: { success: true, data }, expect: bookExpect }).verdict).toBe('unknown')
    })
    it('the same uuid in another case is the same booking', () => {
      const v = judgeUn1tWrite('book', { status: 201, body: { success: true, data: bookingDto({ event_id: EVENT.toUpperCase() }) }, expect: bookExpect })
      expect(v.verdict).toBe('done')
    })
  })

  describe('book 201 is done only when data.status is booked', () => {
    it('booked in any case is done', () => {
      expect(judgeUn1tWrite('book', { status: 201, body: { success: true, data: bookingDto({ status: 'BOOKED' }) }, expect: bookExpect }).verdict).toBe('done')
    })
    for (const [label, status] of [['cancelled', 'cancelled'], ['an unknown status', 'waitlisted'], ['a missing status', undefined]]) {
      it(`${label} is unknown with response_mismatch`, () => {
        const data = bookingDto({ status })
        if (status === undefined) delete data.status
        expect(judgeUn1tWrite('book', { status: 201, body: { success: true, data }, expect: bookExpect }))
          .toEqual({ verdict: 'unknown', id: null, code: 'response_mismatch', message: null, alreadyBooked: false })
      })
    }
  })

  it('book with a missing expect is unknown (response_mismatch), never done and never a throw', () => {
    const body = { success: true, data: bookingDto() }
    for (const expectArg of [{}, { eventId: EVENT, userId: USER }, { userId: USER, studioId: STUDIO }, { eventId: EVENT, studioId: STUDIO }, undefined]) {
      expect(judgeUn1tWrite('book', { status: 201, body, expect: expectArg }))
        .toEqual({ verdict: 'unknown', id: null, code: 'response_mismatch', message: null, alreadyBooked: false })
    }
  })

  it('a success:false that still carries the op id is unknown, not refused', () => {
    const contradict = { success: false, data: bookingDto(), error: { code: 'NO_CREDITS', message: 'Not enough credits' } }
    expect(judgeUn1tWrite('book', { status: 201, body: contradict, expect: bookExpect }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('trial', { status: 201, body: { success: false, data: { transactionId: 'txn_1' } }, expect: {} }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('create_client', { status: 201, body: { success: false, data: { id: USER } }, expect: {} }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('checkout', { status: 201, body: { success: false, data: { checkoutUrl: 'https://checkout.example.test/c' } }, expect: {} }).verdict).toBe('unknown')
  })

  it('a refused 4xx with no code is named http_<status>', () => {
    expect(judgeUn1tWrite('book', { status: 404, body: null, expect: bookExpect }))
      .toEqual({ verdict: 'refused', id: null, code: 'http_404', message: null, alreadyBooked: false })
    expect(judgeUn1tWrite('book', { status: 201, body: { success: false }, expect: bookExpect }).code).toBeNull()
  })

  it('2xx with success:false is refused with error.code and error.message', () => {
    const v = judgeUn1tWrite('book', {
      status: 201, body: { success: false, error: { code: 'NO_CREDITS', message: 'Not enough credits' } }, expect: bookExpect,
    })
    expect(v).toEqual({ verdict: 'refused', id: null, code: 'NO_CREDITS', message: 'Not enough credits', alreadyBooked: false })
  })

  it("a 4xx is refused with the body's code and words", () => {
    const v = judgeUn1tWrite('book', {
      status: 422, body: { success: false, error: { code: 'CLASS_FULL', message: 'This class is full' } }, expect: bookExpect,
    })
    expect(v).toEqual({ verdict: 'refused', id: null, code: 'CLASS_FULL', message: 'This class is full', alreadyBooked: false })
    // A framework-shaped 400 (message array, error a word) still gives its words.
    const nest = judgeUn1tWrite('book', { status: 400, body: { statusCode: 400, message: ['eventId must be a UUID', 'userId is required'], error: 'Bad Request' }, expect: bookExpect })
    expect(nest).toMatchObject({ verdict: 'refused', code: 'http_400', message: 'eventId must be a UUID; userId is required' })
  })

  it('2xx with no id is unknown, never refused', () => {
    for (const body of [{ success: true, data: {} }, { success: true }, {}, null, 'OK', { success: true, data: { id: '' } }]) {
      expect(judgeUn1tWrite('book', { status: 201, body, expect: bookExpect }).verdict).toBe('unknown')
    }
    for (const [op, body] of [['create_client', { success: true, data: {} }], ['trial', { success: true, data: {} }], ['checkout', { success: true, data: {} }]]) {
      expect(judgeUn1tWrite(op, { status: 201, body, expect: {} }).verdict).toBe('unknown')
    }
  })

  it('a 5xx, a 3xx or no reply is unknown', () => {
    expect(judgeUn1tWrite('book', { status: 503, body: { success: false, error: { code: 'X' } }, expect: bookExpect }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('book', { status: 302, body: null, expect: bookExpect }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('book', { status: null, body: null, expect: bookExpect }).verdict).toBe('unknown')
  })

  it('already booked from the code table is done with alreadyBooked true and id null', () => {
    const table = Object.freeze({ E_DUP: 'already_booked' })
    const v = judgeUn1tWrite('book', { status: 409, body: { success: false, error: { code: 'E_DUP', message: 'Conflict' } }, expect: bookExpect }, table)
    expect(v).toEqual({ verdict: 'done', id: null, code: 'E_DUP', message: 'Conflict', alreadyBooked: true })
  })

  it('already booked from words alone is unknown with alreadyBooked kept as a hint', () => {
    const byCodeWords = judgeUn1tWrite('book', { status: 409, body: { success: false, error: { code: 'ALREADY_BOOKED', message: 'Conflict' } }, expect: bookExpect })
    expect(byCodeWords).toEqual({ verdict: 'unknown', id: null, code: 'ALREADY_BOOKED', message: 'Conflict', alreadyBooked: true })
    const byMessage = judgeUn1tWrite('book', { status: 201, body: { success: false, error: { code: 'E1001', message: 'You are already booked into this class' } }, expect: bookExpect })
    expect(byMessage).toMatchObject({ verdict: 'unknown', id: null, alreadyBooked: true })
  })

  it('phrases that only look like already booked are never done', () => {
    for (const message of ['This class is already booked up', 'You are already booked into another class at this time']) {
      const v = judgeUn1tWrite('book', { status: 409, body: { success: false, error: { code: 'E409', message } }, expect: bookExpect })
      expect(v.verdict).not.toBe('done')
    }
  })

  it('already booked only means done for a book', () => {
    const table = Object.freeze({ ALREADY_BOOKED: 'already_booked' })
    const v = judgeUn1tWrite('cancel', { status: 409, body: { success: false, error: { code: 'ALREADY_BOOKED' } }, expect: { bookingId: BOOKING } }, table)
    expect(v).toMatchObject({ verdict: 'refused', alreadyBooked: false })
  })
})

describe('judgeUn1tWrite: other ops', () => {
  it('cancel 200 with no body schema is done with id = the requested booking id; success:false is refused', () => {
    const done = { verdict: 'done', id: BOOKING, code: null, message: null, alreadyBooked: false }
    for (const body of [null, undefined, {}, { success: true }, { success: true, data: { id: BOOKING, status: 'Cancelled' } }, { data: { status: 'cancelled' } }, { data: { id: BOOKING.toUpperCase() } }]) {
      expect(judgeUn1tWrite('cancel', { status: 200, body, expect: { bookingId: BOOKING } })).toEqual(done)
    }
    const refused = judgeUn1tWrite('cancel', { status: 200, body: { success: false, error: { code: 'LATE_CANCEL', message: 'Too late to cancel' } }, expect: { bookingId: BOOKING } })
    expect(refused).toEqual({ verdict: 'refused', id: null, code: 'LATE_CANCEL', message: 'Too late to cancel', alreadyBooked: false })
    // Without the requested id there is nothing to name as cancelled.
    expect(judgeUn1tWrite('cancel', { status: 200, body: null, expect: {} }).verdict).toBe('unknown')
  })

  it('cancel 2xx with a string body, another booking or a status other than cancelled is unknown', () => {
    const bodies = [
      '', 'OK', '<html><body>Gateway</body></html>', [],
      { success: true, data: { id: OTHER, status: 'cancelled' } },
      { success: true, data: { id: BOOKING, status: 'booked' } },
      { success: true, data: { status: 'attended' } },
    ]
    for (const body of bodies) {
      expect(judgeUn1tWrite('cancel', { status: 200, body, expect: { bookingId: BOOKING } }))
        .toMatchObject({ verdict: 'unknown', id: null, alreadyBooked: false })
    }
    expect(judgeUn1tWrite('cancel', { status: 200, body: { data: { id: OTHER } }, expect: { bookingId: BOOKING } }).code).toBe('response_mismatch')
  })

  it('create 201 with data.id is done and the id is the only field returned', () => {
    const body = {
      success: true,
      data: { id: USER, email: 'someone@example.test', phone: '+353000000000', reset_password_token: 'RPT-SECRET', first_name: 'Test' },
    }
    const v = judgeUn1tWrite('create_client', { status: 201, body, expect: {} })
    expect(v).toEqual({ verdict: 'done', id: USER, code: null, message: null, alreadyBooked: false })
    expect(Object.keys(v).sort()).toEqual(RESULT_KEYS)
    const text = JSON.stringify(v)
    for (const secret of ['someone@example.test', '+353000000000', 'RPT-SECRET', 'Test']) expect(text).not.toContain(secret)
  })

  it('charge 201 with data.transactionId is done', () => {
    expect(judgeUn1tWrite('trial', { status: 201, body: { success: true, data: { transactionId: 'txn_000123' } }, expect: {} }))
      .toEqual({ verdict: 'done', id: 'txn_000123', code: null, message: null, alreadyBooked: false })
  })

  it('checkout 201 with an https checkoutUrl is done; http, relative or missing is unknown', () => {
    const url = 'https://checkout.example.test/c/pay_000'
    expect(judgeUn1tWrite('checkout', { status: 201, body: { success: true, data: { checkoutUrl: url, free: false } }, expect: {} }))
      .toEqual({ verdict: 'done', id: url, code: null, message: null, alreadyBooked: false })
    for (const bad of ['http://checkout.example.test/c/pay_000', '/c/pay_000', 'checkout.example.test/c', '', undefined, 'javascript:alert(1)']) {
      expect(judgeUn1tWrite('checkout', { status: 201, body: { success: true, data: { checkoutUrl: bad, free: false } }, expect: {} }).verdict).toBe('unknown')
    }
  })

  it('forgot-password 200 success:true is done', () => {
    expect(judgeUn1tWrite('forgot_password', { status: 200, body: { success: true, data: { message: 'If the email exists, a code was sent' } }, expect: {} }))
      .toEqual({ verdict: 'done', id: null, code: null, message: null, alreadyBooked: false })
    // Without success:true there is nothing to judge it on.
    expect(judgeUn1tWrite('forgot_password', { status: 200, body: {}, expect: {} }).verdict).toBe('unknown')
    expect(judgeUn1tWrite('forgot_password', { status: 200, body: { success: false, error: { code: 'X', message: 'no' } }, expect: {} }).verdict).toBe('refused')
  })

  it('an op outside the six is never done', () => {
    expect(judgeUn1tWrite('refund', { status: 201, body: { success: true, data: { id: 'x' } }, expect: {} }).verdict).toBe('unknown')
  })
})

describe('classifyRefusal', () => {
  it('the table starts empty and frozen', () => {
    expect(UN1T_REFUSAL_CODES).toEqual({})
    expect(Object.isFrozen(UN1T_REFUSAL_CODES)).toBe(true)
  })

  it('reads the table first', () => {
    const table = Object.freeze({ E_LIMIT: 'trial_used', E_FULL: 'class_full' })
    expect(classifyRefusal({ code: 'E_LIMIT', message: 'nope' }, table)).toBe('trial_used')
    expect(classifyRefusal({ code: 'E_FULL', message: 'You are already booked' }, table)).toBe('class_full')
    // Prototype keys are not table entries.
    expect(classifyRefusal({ code: 'constructor', message: null })).toBeNull()
  })

  it('matches already booked and email in use by words, in the code or the message', () => {
    expect(classifyRefusal({ code: 'ALREADY_BOOKED', message: null })).toBe('already_booked')
    expect(classifyRefusal({ code: null, message: 'User already  booked for this event' })).toBe('already_booked')
    expect(classifyRefusal({ code: 'EMAIL_IN_USE', message: null })).toBe('email_in_use')
    expect(classifyRefusal({ code: 'E409', message: 'A user with this email already exists' })).toBe('email_in_use')
    expect(classifyRefusal({ code: null, message: 'Email is taken' })).toBe('email_in_use')
  })

  it('a missing account is not email in use', () => {
    for (const message of ['No account with this email exists', 'There is no user with that email', 'Email not found', 'This email does not exist']) {
      expect(classifyRefusal({ code: null, message })).toBeNull()
    }
  })

  it('classifyRefusal never guesses trial_used from words', () => {
    for (const message of ['Trial already used', 'trial_used', 'You have used your free trial', 'Purchase limit reached for this product']) {
      expect(classifyRefusal({ code: 'TRIAL_USED', message })).not.toBe('trial_used')
      expect(classifyRefusal({ code: null, message })).toBeNull()
    }
  })

  it('anything unmapped is null', () => {
    expect(classifyRefusal({ code: 'NO_CREDITS', message: 'Not enough credits' })).toBeNull()
    expect(classifyRefusal({ code: null, message: null })).toBeNull()
    expect(classifyRefusal({})).toBeNull()
  })

  it('isCustomerAnswerable and isKnownBusinessRefusal', () => {
    expect(UN1T_REFUSAL_KINDS).toEqual(['no_credits', 'class_full', 'already_booked', 'trial_used', 'email_in_use', 'late_cancel'])
    expect(Object.isFrozen(UN1T_REFUSAL_KINDS)).toBe(true)
    expect(UN1T_REFUSAL_KINDS.filter(isCustomerAnswerable).sort()).toEqual(['already_booked', 'class_full', 'late_cancel'])
    expect(UN1T_REFUSAL_KINDS.filter(isKnownBusinessRefusal)).toEqual(UN1T_REFUSAL_KINDS)
    for (const k of [null, undefined, '', 'response_mismatch', 'NO_CREDITS', 'constructor']) {
      expect(isCustomerAnswerable(k)).toBe(false)
      expect(isKnownBusinessRefusal(k)).toBe(false)
    }
  })
})

describe('permissions', () => {
  it('missingPermissions per op matches the table; forgot_password needs none', () => {
    expect(REQUIRED_PERMISSIONS).toEqual({
      book: ['bookings:create', 'bookings:read'],
      cancel: ['bookings:update', 'bookings:read'],
      create_client: ['users:create', 'users:read'],
      trial: ['purchases:create', 'products:read', 'credits:read'],
      checkout: ['purchases:create', 'products:read'],
      forgot_password: [],
      trial_regrant: ['credits:create', 'credits:read'],
    })
    expect(Object.keys(REQUIRED_PERMISSIONS).sort()).toEqual([...UN1T_WRITE_OPS].sort())
    expect(Object.isFrozen(REQUIRED_PERMISSIONS)).toBe(true)
    expect(Object.isFrozen(REQUIRED_PERMISSIONS.book)).toBe(true)

    for (const op of UN1T_WRITE_OPS) {
      expect(missingPermissions(op, REQUIRED_PERMISSIONS[op])).toEqual([])
      expect(missingPermissions(op, [])).toEqual(REQUIRED_PERMISSIONS[op])
    }
    expect(missingPermissions('book', ['bookings:read', 'events:read'])).toEqual(['bookings:create'])
    expect(missingPermissions('trial', ['purchases:create'])).toEqual(['products:read', 'credits:read'])
    expect(missingPermissions('forgot_password', [])).toEqual([])
    // Fail closed: an unreadable permissions list is every permission missing.
    expect(missingPermissions('cancel', null)).toEqual(['bookings:update', 'bookings:read'])
    expect(() => missingPermissions('refund', [])).toThrow(TypeError)
  })

  it('permissionMissingMessage is the exact sentence', () => {
    expect(permissionMissingMessage('Hatch Street', 'bookings:create')).toBe(
      "The un1t.online token for Hatch Street is missing the 'bookings:create' permission, so nothing was sent. Add it to the token in the un1t.online owner console, or issue a new token and paste it in Settings, Integrations, un1t.online.",
    )
  })
})

describe('scrubMessage', () => {
  it('scrubMessage removes every secret and caps at 500', () => {
    const pw = 'Zx9_aB-cD3eF4gH5iJ6kL7mN8oP9qR0s'
    const email = 'person@example.test'
    const out = scrubMessage(`bad password ${pw} for ${email}; again ${pw}; ${email.toUpperCase()}`, [pw, email])
    expect(out).not.toContain(pw)
    expect(out.toLowerCase()).not.toContain(email)
    expect(out).toContain('bad password')
    const long = scrubMessage(`${'x'.repeat(600)}${pw}`, [pw])
    expect(long.length).toBe(500)
    // A secret straddling the cut is removed before the cut, so no part of it survives.
    const straddle = scrubMessage(`${'y'.repeat(490)}${pw}`, [pw])
    expect(straddle.length).toBeLessThanOrEqual(500)
    expect(straddle).not.toContain(pw.slice(0, 8))
    // Regex characters in a secret are literal.
    expect(scrubMessage('a+b.c* here', ['a+b.c*'])).not.toContain('a+b.c*')
  })

  it('empty secrets and non-strings are ignored; a missing text is empty', () => {
    expect(scrubMessage('keep this', ['', null, undefined])).toBe('keep this')
    expect(scrubMessage(null, ['x'])).toBe('')
    expect(scrubMessage(undefined)).toBe('')
  })
})

describe('un1tRoutePathLabel', () => {
  it('un1tRoutePathLabel replaces ids and drops the query', () => {
    expect(un1tRoutePathLabel('patch', `/bookings/${BOOKING}/cancel`)).toBe('un1t:PATCH /bookings/:id/cancel')
    expect(un1tRoutePathLabel('GET', `/credits/ledgers/${USER}/${STUDIO}?page=2&email=a@b.test`)).toBe('un1t:GET /credits/ledgers/:id/:id')
    expect(un1tRoutePathLabel('GET', '/users/0123456789abcdef0123/bookings')).toBe('un1t:GET /users/:id/bookings')
    expect(un1tRoutePathLabel('GET', '/bookings/1234567')).toBe('un1t:GET /bookings/:id')
    expect(un1tRoutePathLabel('POST', '/bookings')).toBe('un1t:POST /bookings')
    expect(un1tRoutePathLabel('POST', 'https://api.example.test/purchases/checkout?x=1#frag')).toBe('un1t:POST /purchases/checkout')
    expect(un1tRoutePathLabel('GET', '/events/12345/bookings')).toBe('un1t:GET /events/12345/bookings')
  })
})

describe('un1tWriteFailureEvent', () => {
  it('un1tWriteFailureEvent builds the id-free row for each reason', () => {
    for (const reason of ['5xx', '429', 'no_reply', 'unclear', 'auth', 'refused']) {
      const status = { '5xx': 503, '429': 429, no_reply: null, unclear: 201, auth: 403, refused: 422 }[reason]
      const row = un1tWriteFailureEvent({ method: 'patch', path: `/bookings/${BOOKING}/cancel?u=${USER}`, status, reason, attempts: 2 })
      expect(row).toMatchObject({
        vercel_id: null, digest: null, method: 'PATCH', route_type: 'un1t_write',
        name: `un1t_write_${reason}`, route_path: 'un1t:PATCH /bookings/:id/cancel',
      })
      expect(Object.keys(row).sort()).toEqual(['digest', 'message', 'method', 'name', 'route_path', 'route_type', 'runtime', 'vercel_id'])
      const text = JSON.stringify(row)
      expect(text).not.toContain(BOOKING)
      expect(text).not.toContain(USER)
      expect(row.message).not.toMatch(/—/)
      expect(row.message.length).toBeLessThanOrEqual(500)
      expect(row.message).toMatch(/after 2 attempt/)
      expect(row.message).toMatch(reason === 'no_reply' ? /no reply/ : new RegExp(`HTTP ${status}`))
    }
    expect(() => un1tWriteFailureEvent({ method: 'POST', path: '/bookings', status: 500, reason: 'other', attempts: 1 })).toThrow(TypeError)
  })
})
