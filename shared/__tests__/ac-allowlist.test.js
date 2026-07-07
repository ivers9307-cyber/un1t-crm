import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AC_ACCESS_BY_ROLE,
  resolveAcAllowlist,
  isAcDeviceAllowed,
  filterAcDevices,
} from '../permissions.js'

describe('resolveAcAllowlist', () => {
  it('master always resolves to ALL', () => {
    expect(resolveAcAllowlist({ role: 'master', userList: [], templateList: [] })).toBe('ALL')
  })
  it('per-user array wins over template and default (incl explicit none)', () => {
    expect(resolveAcAllowlist({ role: 'manager', userList: ['d1'], templateList: ['d2'] })).toEqual(['d1'])
    expect(resolveAcAllowlist({ role: 'manager', userList: [], templateList: ['d2'] })).toEqual([])
  })
  it('template used when per-user is null (inherit)', () => {
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: ['d3'] })).toEqual(['d3'])
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: [] })).toEqual([])
  })
  it('code default used when both null: manager/owner=ALL, others=none', () => {
    expect(resolveAcAllowlist({ role: 'manager', userList: null, templateList: null })).toBe('ALL')
    expect(resolveAcAllowlist({ role: 'owner', userList: null, templateList: null })).toBe('ALL')
    expect(resolveAcAllowlist({ role: 'staff', userList: null, templateList: null })).toEqual([])
    expect(resolveAcAllowlist({ role: 'head_coach', userList: null, templateList: null })).toEqual([])
    expect(resolveAcAllowlist({ role: 'reception', userList: null, templateList: null })).toEqual([])
  })
  it('isAcDeviceAllowed honours ALL and membership', () => {
    expect(isAcDeviceAllowed('ALL', 'x')).toBe(true)
    expect(isAcDeviceAllowed(['a', 'b'], 'b')).toBe(true)
    expect(isAcDeviceAllowed(['a', 'b'], 'z')).toBe(false)
    expect(isAcDeviceAllowed([], 'z')).toBe(false)
  })
  it('filterAcDevices returns all for ALL, else the subset', () => {
    const devices = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(filterAcDevices('ALL', devices)).toEqual(devices)
    expect(filterAcDevices(['b', 'c'], devices)).toEqual([{ id: 'b' }, { id: 'c' }])
    expect(filterAcDevices([], devices)).toEqual([])
  })
})
