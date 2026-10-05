import { expect, test } from 'claude-code/testing'

import { compact, guideOf, guideSections, markdownGuide, statusLine } from '../hooks/card'

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

test('the guide splits before each level-2 heading, without carriage returns', () => {
  const sections = guideSections('# Guide\r\n\r\nIntro.\r\n\r\n## Commands\r\n\r\n| a | b |\r\n\r\n### Detail\r\n\r\nText.\r\n\r\n## Setup\r\n\r\n1. One\r\n')
  expect(sections).toEqual(['# Guide\n\nIntro.', '## Commands\n\n| a | b |\n\n### Detail\n\nText.', '## Setup\n\n1. One'])
  expect(markdownGuide({ type: 'guide', title: 'Guide', sections }, '7').endsWith('[//]: # (usage-dollars:report:7)')).toBe(true)
})

test('a guide takes its title from the level-1 heading, and keeps the lead under it', () => {
  const guide = guideOf('# usage-dollars quick start\r\n\r\nSee what is left.\r\n\r\n## Set up once\r\n\r\n1. Load one copy.\r\n')
  expect(guide).toEqual({ type: 'guide', title: 'usage-dollars quick start', sections: ['See what is left.', '## Set up once\n\n1. Load one copy.'] })
  expect(markdownGuide(guide, '3').startsWith('# usage-dollars quick start\n\nSee what is left.')).toBe(true)
  expect(guideOf('## Only\n\nText.').title).toBe('usage-dollars')
})

test('a guide section longer than one Markdown element is split between paragraphs', () => {
  const paragraph = 'x'.repeat(4000)
  const sections = guideSections(`## Long\n\n${[paragraph, paragraph, paragraph].join('\n\n')}`)
  expect(sections.length).toBe(2)
  for (const s of sections) expect(s.length).toBeLessThanOrEqual(10000)
  expect(sections.join('\n\n')).toBe(`## Long\n\n${[paragraph, paragraph, paragraph].join('\n\n')}`)
})

test('compact figures', () => {
  expect(compact(4.2)).toBe('$4.20')
  expect(compact(913)).toBe('$913')
  expect(compact(2812)).toBe('$2.8k')
  expect(compact(28400)).toBe('$28k')
})
