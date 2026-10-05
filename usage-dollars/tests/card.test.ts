import { expect, test } from 'claude-code/testing'

import { compact, statusLine } from '../hooks/card'

const range = (value: number) => ({ value, low: value * 0.9, high: value * 1.1 })

test('two estimated windows read as what is left of each allowance', () => {
  const line = statusLine(
    [
      { short: '5h', usedUsd: 63, allowance: range(913), left: range(850) },
      { short: 'Week', usedUsd: 63, allowance: range(2812), left: range(2749) },
    ],
    false,
  )
  expect(line).toBe('5h ~$850 left of $913 · Week ~$2.7k left of $2.8k')
})

test('a window without an estimate shows what is used', () => {
  expect(statusLine([{ short: '5h', usedUsd: 40 }], false)).toBe('5h $40 used, estimating')
})

test('nothing left reads as at limit', () => {
  expect(statusLine([{ short: '5h', usedUsd: 700, allowance: range(650), left: range(-50) }], false)).toBe('5h at limit')
  expect(statusLine([{ short: '5h', usedUsd: 650, allowance: range(650), left: range(0) }], false)).toBe('5h at limit')
})

test('an unseen plan change leads the line', () => {
  expect(statusLine([{ short: '5h', usedUsd: 40 }], true)).toBe('⚠ Plan changed · 5h $40 used, estimating')
})

test('compact figures', () => {
  expect(compact(4.2)).toBe('$4.20')
  expect(compact(913)).toBe('$913')
  expect(compact(2812)).toBe('$2.8k')
  expect(compact(28400)).toBe('$28k')
})
