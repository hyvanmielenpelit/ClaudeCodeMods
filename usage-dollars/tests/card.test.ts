import { expect, test } from 'claude-code/testing'

import {
  compact,
  fableBasis,
  guideOf,
  guideSections,
  markdownCalibration,
  markdownGuide,
  markdownModels,
  markdownWaiting,
  markdownWindows,
  statusLine,
} from '../hooks/card'
import { FABLE_CAP_TEXT } from '../hooks/measure'
import type { CalibrationWindow, FableReport, ModelsFit, ModelsReport, ModelsTransfer, UsageReport } from '../types'

const range = (value: number) => ({ value, low: value * 0.9, high: value * 1.1 })

const UNCHECKED: ModelsTransfer = { isChecked: false, isRejected: false, days: 0, delta: 0, se: 0, weeks: 0 }

const M0_FIT: ModelsFit = { model: 'M0', reference: 'all', referenceLabel: 'all models', groups: [], omega: 0.35, windows: 14, segments: 120, df: 9 }

const M1_FIT: ModelsFit = {
  model: 'M1',
  reference: 'claude-opus-5-5',
  referenceLabel: 'Opus 5.5',
  groups: [{ key: 'claude-fable-5-1', label: 'Fable 5.1', weight: { value: 1.8, low: 1.5, high: 2.2 }, information: 37.4 }],
  omega: 0.31,
  windows: 14,
  segments: 120,
  df: 13,
}

const M2_FIT: ModelsFit = {
  model: 'M2',
  reference: 'claude-opus-5-5/other',
  referenceLabel: 'Opus 5.5 except cache reads',
  groups: [
    { key: 'claude-opus-5-5/read', label: 'Opus 5.5 cache reads', weight: { value: 0.4, low: 0.32, high: 0.5 }, information: 52 },
    { key: 'claude-fable-5-1/other', label: 'Fable 5.1 except cache reads', weight: { value: 1.1, low: 0.9, high: 1.3 }, information: 21 },
  ],
  omega: 0.24,
  windows: 14,
  segments: 120,
  df: 13,
}

function modelsOf(over: Partial<ModelsReport>): ModelsReport {
  return {
    type: 'models',
    isFitted: true,
    qualifying: 14,
    needed: 4,
    windows: { used: 14, excluded: [] },
    segments: 120,
    excludedSegments: 0,
    fits: [M0_FIT, M1_FIT],
    comparisons: [],
    selected: 'M0',
    rounding: 'round',
    transfer: UNCHECKED,
    omegas: [
      { title: '5-hour windows', M0: { omega: 0.35, windows: 14, isAssumed: false }, selected: { omega: 0.28, windows: 14, isAssumed: false } },
      { title: 'Weeks', M0: { omega: 0.5, windows: 1, isAssumed: true }, selected: { omega: 0.5, windows: 1, isAssumed: true } },
    ],
    prospective: [
      { title: '5-hour windows', n: 0, sum: 0, se: 0 },
      { title: 'Weeks', n: 0, sum: 0, se: 0 },
    ],
    ...over,
  }
}

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

test('the first-reading card says all is well, what to do, and names the command to run again', () => {
  const text = markdownWaiting({ type: 'waiting', command: '/usage-dollars calibrate', canSend: true }, '5')
  expect(text.startsWith('### Waiting for the first usage reading\n\n✓ Everything is in order.')).toBe(true)
  expect(text).toContain('2. When the reply has finished, run /usage-dollars calibrate again.')
  expect(text).toContain('3. The card then shows what each window’s estimate rests on.')
  expect(text).not.toContain('A check message was sent.')
  expect(text.endsWith('[//]: # (usage-dollars:report:5)')).toBe(true)
})

test('after the check message is sent, the first-reading card says to run the command once its reply has finished', () => {
  const text = markdownWaiting({ type: 'waiting', command: '/usage-dollars', canSend: false }, '6')
  expect(text.startsWith('### Waiting for the first usage reading\n\n✓ Everything is in order.')).toBe(true)
  expect(text).toContain('A check message was sent. When its reply has finished, run /usage-dollars again.')
  expect(text).toContain('**What to do**')
})

test('without a subscription the first-reading card replaces the steps, and the check stays green', () => {
  const text = markdownWaiting({ type: 'waiting', command: '/usage-dollars', canSend: false, isUnsubscribed: true }, '7')
  expect(text.startsWith('### Waiting for the first usage reading\n\n✓ Everything is in order.')).toBe(true)
  expect(text).toContain('This sign-in has no subscription usage limits, so there is nothing to show; spending reports still work.')
  expect(text).not.toContain('**What to do**')
  expect(text).not.toContain('**How it works from here**')
  expect(text).not.toContain('A check message was sent.')
})

const MODELS_HEAD = "### Models · usage-dollars\n\n_How each model's API dollars count against the limit, as seen from this machine_\n\n"

test('before 4 qualifying 5-hour windows the models card says how many there are, and the week keeps the API ratio', () => {
  const text = markdownModels(
    modelsOf({
      isFitted: false,
      qualifying: 2,
      windows: { used: 2, excluded: [{ reason: 'dollars per model not stored yet', count: 3 }] },
      segments: 9,
      fits: [],
      rounding: 'union',
    }),
    '11',
  )
  expect(
    text.startsWith(`${MODELS_HEAD}**Not fitted yet: 2 of 4 5-hour windows with readings per model**\n\n- Week: uses the API ratio, as the 5-hour windows do\n`),
  ).toBe(true)
  expect(text).toContain('- 5-hour windows: 2 used\n  - 3 left out: dollars per model not stored yet\n- Segments: 9 used\n')
  expect(text).toContain('- Rounding rule: not known yet; the fit allows both')
  expect(text).not.toContain('**Fits**')
  expect(text).not.toContain('**Comparisons**')
  expect(text).toContain('- 5-hour windows: ω 0.35 (from 14 windows)\n- Weeks: ω 0.50 (assumed)\n')
  expect(text).toContain('- 5-hour windows: none yet\n- Weeks: none yet\n')
  expect(text.endsWith('[//]: # (usage-dollars:report:11)')).toBe(true)
})

test('when neither richer model wins, the models card says the API ratio holds, with each comparison', () => {
  const text = markdownModels(
    modelsOf({
      excludedSegments: 4,
      fits: [M0_FIT, M1_FIT, M2_FIT],
      comparisons: [
        { from: 'M0', to: 'M1', delta: 0.8, se: 1.9, folds: 10, isSelected: false },
        { from: 'M0', to: 'M2', delta: -0.4, se: 1.1, folds: 10, isSelected: false },
      ],
    }),
    '12',
  )
  expect(
    text.startsWith(
      `${MODELS_HEAD}**API ratio holds (M1 not supported: Δ 0.8 ± 1.9 nats; M2 not supported: Δ −0.4 ± 1.1 nats)**\n\n` +
        '- Week: uses the API ratio, as the 5-hour windows do\n',
    ),
  ).toBe(true)
  expect(text).toContain('- Segments: 120 used, 4 left out as outliers\n- Rounding rule: the API rounds\n')
  expect(text).toContain(
    '- M0, the API ratio: ω 0.35, 120 segments\n' +
      '- M1, a weight per model: ω 0.31, 120 segments, against Opus 5.5\n' +
      '  - Fable 5.1: 1.8x (90%: 1.5x–2.2x), information 37\n',
  )
  expect(text).toContain('- M1 over M0: Δ 0.8 ± 1.9 nats in 10 folds, not selected\n- M2 over M0: Δ −0.4 ± 1.1 nats in 10 folds, not selected\n')
  expect(text).toContain('- 5-hour windows: ω 0.35 (from 14 windows)\n')
  expect(text).not.toContain('under the selected weights')
})

test('a selected M1 leads with each model’s weight, and the week uses it unchecked until enough days', () => {
  const text = markdownModels(
    modelsOf({
      comparisons: [
        { from: 'M0', to: 'M1', delta: 6.2, se: 2.1, folds: 10, isSelected: true },
        { from: 'M1', to: 'M2', delta: 0.5, se: 1.4, folds: 10, isSelected: false },
      ],
      selected: 'M1',
      transfer: { ...UNCHECKED, days: 3, weeks: 1 },
      prospective: [
        { title: '5-hour windows', n: 6, sum: 3.1, se: 1.2 },
        { title: 'Weeks', n: 0, sum: 0, se: 0 },
      ],
    }),
    '13',
  )
  expect(
    text.startsWith(
      `${MODELS_HEAD}**M1 selected: a weight per model (Δ 6.2 ± 2.1 nats over M0)**\n\n` +
        '- Fable 5.1: 1.8x its API price against the limit (90%: 1.5x–2.2x), from 14 5-hour windows\n' +
        '- Measured against Opus 5.5, held at 1x its API price\n' +
        '- Week: uses the 5-hour weights; not yet checked on weeks (3 days so far)\n',
    ),
  ).toBe(true)
  expect(text).toContain('- M1 over M0: Δ 6.2 ± 2.1 nats in 10 folds, selected\n- M2 over M1: Δ 0.5 ± 1.4 nats in 10 folds, not selected\n')
  expect(text).toContain('- 5-hour windows: ω 0.35 (from 14 windows) under the API ratio, 0.28 (from 14 windows) under the selected weights\n')
  expect(text).toContain('- 5-hour windows: 6 new windows scored, Σ d 3.1 ± 1.2 nats\n- Weeks: none yet\n')
  expect(text).toContain('- Closed weeks that qualify: 1\n')
})

test('a week checked on enough days that agrees keeps the 5-hour weights, beside the weekly-only fit', () => {
  const weeklyFit: ModelsFit = {
    ...M1_FIT,
    omega: 0.4,
    windows: 4,
    segments: 30,
    df: 3,
    groups: [{ key: 'claude-fable-5-1', label: 'Fable 5.1', weight: { value: 1.6, low: 1.1, high: 2.3 }, information: 9 }],
  }
  const text = markdownModels(
    modelsOf({
      comparisons: [
        { from: 'M0', to: 'M1', delta: 6.2, se: 2.1, folds: 10, isSelected: true },
        { from: 'M1', to: 'M2', delta: 0.5, se: 1.4, folds: 10, isSelected: false },
      ],
      selected: 'M1',
      transfer: { isChecked: true, isRejected: false, days: 9, delta: 1.2, se: 3, weeks: 4, weeklyFit },
    }),
    '14',
  )
  expect(text).toContain('- Week: uses the 5-hour weights; checked on 9 days, consistent (Δ 1.2 ± 3.0)\n')
  expect(text).toContain(
    '- Closed weeks that qualify: 4\n' +
      '- Weekly-only M1, for comparison only, from 4 weeks: ω 0.40, 30 segments, against Opus 5.5\n' +
      '  - Fable 5.1: 1.6x (90%: 1.1x–2.3x), information 9\n',
  )
})

test('a selected M2 shows cache reads apart, and a rejected week falls back to the API ratio', () => {
  const text = markdownModels(
    modelsOf({
      fits: [M0_FIT, M1_FIT, M2_FIT],
      comparisons: [
        { from: 'M0', to: 'M1', delta: 1, se: 1.5, folds: 10, isSelected: false },
        { from: 'M0', to: 'M2', delta: 9.3, se: 3.2, folds: 10, isSelected: true },
      ],
      selected: 'M2',
      transfer: { isChecked: true, isRejected: true, days: 7, delta: -8.4, se: 2.5, weeks: 3 },
    }),
    '15',
  )
  expect(
    text.startsWith(
      `${MODELS_HEAD}**M2 selected: a weight per model for cache reads and for the rest (Δ 9.3 ± 3.2 nats over M0)**\n\n` +
        '- Opus 5.5 cache reads: 0.40x its API price against the limit (90%: 0.32x–0.50x), from 14 5-hour windows\n' +
        '- Fable 5.1 except cache reads: 1.1x its API price against the limit (90%: 0.90x–1.3x), from 14 5-hour windows\n' +
        '- Measured against Opus 5.5 except cache reads, held at 1x its API price\n' +
        '- Week: falls back to the API ratio; the 5-hour weights fit the weeks worse on 7 days (Δ −8.4 ± 2.5)\n',
    ),
  ).toBe(true)
  expect(text).toContain('- M2 over M0: Δ 9.3 ± 3.2 nats in 10 folds, selected\n')
  expect(text).not.toContain('Weekly-only')
})

const FABLE: FableReport = {
  title: 'Fable this week',
  share: 0.5,
  usedUsd: 412,
  requests: 230,
  allowance: { value: 1400, low: 1100, high: 1800 },
  left: { value: 988, low: 688, high: 1388 },
  usedShare: 0.29,
  isCapLikely: false,
  weightSource: 'assumed',
  mix: { value: 1, low: 1, high: 1 },
  resetLong: 'Mon 16 Nov, 02:00',
  resetIn: '5 d 14 h',
}

const usageOf = (over: Partial<UsageReport>): UsageReport => ({
  type: 'windows',
  plan: { label: 'Ultra', isStale: false, isUnknown: false },
  notices: [],
  windows: [
    {
      title: 'This week',
      short: 'Week',
      usedUsd: 900,
      requests: 500,
      resetLong: 'Mon 16 Nov, 02:00',
      resetIn: '5 d 14 h',
      allowance: { value: 2800, low: 2200, high: 3600 },
      left: { value: 1900, low: 1300, high: 2700 },
      confidence: 'fair',
      basis: '3 percent levels read',
    },
  ],
  byModel: [],
  byModelTitle: 'By model · this week',
  notes: [],
  files: 1,
  ms: 1,
  ...over,
})

test('the Fable row and section are drawn after the week, derived, with its basis line', () => {
  const text = markdownWindows(usageOf({ fable: FABLE }), 'r1')
  expect(text).toContain('| Fable this week (derived) | ~$1,400 | $1,100 – $1,800 | |')
  expect(text).toContain('**Fable this week** (derived) · resets Mon 16 Nov, 02:00 (in 5 d 14 h)')
  expect(text).toContain('| Used | $412 | 230 requests |')
  expect(text).toContain('| Left | ~$988 | $688 – $1,388 |')
  expect(text).toContain("29% of Fable's half used")
  expect(text).toContain('_Derived: half the weekly allowance. Fable assumed to count at its API price ratio: not measured yet._')
  expect(text.indexOf('**This week**')).toBeLessThan(text.indexOf('**Fable this week**'))
  expect(markdownWindows(usageOf({}), 'r2')).not.toContain('Fable')
})

test("Fable's basis line says where its weight comes from", () => {
  const measured = { ...FABLE, mix: { value: 0.82, low: 0.7, high: 0.95 } }
  expect(fableBasis({ ...FABLE, weightSource: 'five-hour' })).toBe(
    'Derived: half the weekly allowance. The model study found that the API price ratio holds.',
  )
  expect(fableBasis({ ...FABLE, weightSource: 'weekly', weeks: 4 })).toBe(
    'Derived: half the weekly allowance. The weekly fit (4 weeks) found that the API price ratio holds.',
  )
  expect(fableBasis({ ...measured, weightSource: 'five-hour', relativeTo: 'Fable 5.2', isReference: true })).toBe(
    'Derived: half the weekly allowance in meter units. Fable 5.2 is the model the others are measured against, from the model study.',
  )
  expect(fableBasis({ ...measured, weightSource: 'five-hour', relativeTo: 'Opus 5.5', isReference: false })).toBe(
    'Derived: half the weekly allowance in meter units, with Fable counted at ×0.82 (0.70–0.95) relative to Opus 5.5, from the model study.',
  )
  expect(fableBasis({ ...measured, weightSource: 'weekly', weeks: 4, relativeTo: 'Opus 5.5', isReference: false })).toBe(
    'Derived: half the weekly allowance in meter units, with Fable counted at ×0.82 (0.70–0.95) relative to Opus 5.5, from the weekly fit (4 weeks).',
  )
  expect(fableBasis({ ...FABLE, isSinceFall: true })).toMatch(/^Counted since the reported percent fell\. Derived: /)
})

test('the status line adds Fable once it is used this week', () => {
  const week = [{ short: 'Week', usedUsd: 900, allowance: range(2800), left: range(1900) }]
  expect(statusLine(week, false, { usedUsd: 0, left: range(1400), isCapLikely: false })).toBe('Week ~$1.9k left of $2.8k')
  expect(statusLine(week, false, { usedUsd: 412, left: range(988), isCapLikely: false })).toBe('Week ~$1.9k left of $2.8k · Fable ~$988 left')
  expect(statusLine(week, false, { usedUsd: 1500, left: range(0), isCapLikely: true })).toBe('Week ~$1.9k left of $2.8k · Fable at cap')
  expect(statusLine(week, false, { usedUsd: 40, isCapLikely: false })).toBe('Week ~$1.9k left of $2.8k · Fable $40 used')
})

test('the Fable cap notice and a fallen window are drawn as the report gives them', () => {
  const fell = '3 percent levels read · the reported percent fell in this window: left follows the percent'
  const report = usageOf({ notices: [FABLE_CAP_TEXT], fable: { ...FABLE, isCapLikely: true } })
  report.windows[0] = { ...report.windows[0]!, basis: fell, isFallen: true }
  const text = markdownWindows(report, 'r3')
  expect(text).toContain(`- ${FABLE_CAP_TEXT}`)
  expect(text).toContain(`_${fell}_`)
})

test('a subscription with no 5-hour limit is told why the models study is not fitted, and Fable-capped windows are counted', () => {
  const text = markdownModels(
    modelsOf({
      isFitted: false,
      qualifying: 0,
      fits: [],
      isFiveHourAbsent: true,
      cappedWeeks: 2,
      windows: { used: 0, excluded: [{ reason: 'Fable at or past its weekly cap', count: 3 }] },
    }),
    'm9',
  )
  expect(text).toContain('**Not fitted: this subscription reports no 5-hour limit, and the study fits on 5-hour windows**')
  expect(text).toContain('- Week: uses the API ratio, as the 5-hour windows do')
  expect(text).toContain('  - 3 left out: Fable at or past its weekly cap')
  expect(text).toContain('  - 2 left out: Fable at or past its weekly cap')
  expect(markdownModels(modelsOf({ isFitted: false, qualifying: 0, fits: [] }), 'm10')).toContain('**Not fitted yet: 0 of 4 5-hour windows')
})

test('calibration counts the closed windows left out for Fable', () => {
  const w: CalibrationWindow = {
    title: 'This week',
    levels: 3,
    ticks: 1,
    closedWindows: 2,
    closedForWithin: 1,
    isWithinMeasured: false,
    pastPoints: 2,
    pastWeight: 1.4,
    isBetweenMeasured: false,
    closedForRounding: 2,
    roundingNeeded: 5,
    isRoundingKnown: false,
    rounding: 'union',
    measured: 0,
    isCalibrated: false,
    fableCapped: 1,
  }
  expect(markdownCalibration({ type: 'calibration', windows: [w] }, 'c1')).toContain('- 1 closed window left out: Fable at or past its weekly cap')
  expect(markdownCalibration({ type: 'calibration', windows: [{ ...w, fableCapped: 0 }] }, 'c2')).not.toContain('Fable')
})