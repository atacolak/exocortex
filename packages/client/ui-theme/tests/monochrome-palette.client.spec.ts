/** The monochrome re-theme keeps every chrome accent architectural gray in both themes. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRules, varReferences } from './stylesheet-scan.ts'

const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/styles/design-platform.css'), 'utf8')
const rules = parseRules(stylesheet)

type Rgb = [number, number, number]

function palette(dark: boolean): Map<string, string> {
  const selector = dark ? 'body[data-ds-dark-theme]' : 'body'
  return new Map(rules.filter(rule => rule.selectors.includes(selector)).flatMap(rule => rule.declarations))
}

function resolveColor(tokens: Map<string, string>, name: string): Rgb {
  const seen = new Set<string>()
  let current = name
  while (tokens.has(current) && !seen.has(current)) {
    seen.add(current)
    const value = tokens.get(current)!
    const [reference] = varReferences(value)
    if (reference !== undefined) {
      expect(value, current).toMatch(/^var\(\s*--[\w-]+\s*\)$/)
      current = reference
      continue
    }
    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value)
    expect(rgb, `${name}: ${current} = ${value}`).not.toBeNull()
    return [Number(rgb![1]), Number(rgb![2]), Number(rgb![3])]
  }
  throw new Error(`Unresolved color ${name}: ${current}`)
}

function luminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (lighter! + 0.05) / (darker! + 0.05)
}

const CHROME = {
  light: {
    '--dsw-alias-button-info-fill': [42, 43, 46],
    '--dsw-alias-button-info-hover': [64, 66, 70],
    '--dsw-alias-state-business-primary': [45, 47, 51],
    '--dsw-alias-state-business-tertiary': [232, 234, 237],
    '--dsw-alias-link': [52, 55, 60],
    '--dsw-alias-label-deep-diving': [110, 114, 120],
    '--dsw-alias-label-deep-diving-shimmer': [35, 36, 39],
    '--dsw-alias-penrose-light': [24, 25, 28],
    '--dsw-alias-penrose-mid': [75, 80, 89],
    '--dsw-alias-penrose-deep': [133, 139, 150],
  },
  dark: {
    '--dsw-alias-button-info-fill': [218, 220, 224],
    '--dsw-alias-button-info-hover': [238, 240, 243],
    '--dsw-alias-state-business-primary': [212, 215, 220],
    '--dsw-alias-state-business-tertiary': [53, 54, 58],
    '--dsw-alias-link': [208, 212, 218],
    '--dsw-alias-label-deep-diving': [162, 166, 173],
    '--dsw-alias-label-deep-diving-shimmer': [230, 232, 236],
    '--dsw-alias-penrose-light': [240, 242, 245],
    '--dsw-alias-penrose-mid': [168, 174, 184],
    '--dsw-alias-penrose-deep': [99, 105, 115],
  },
} as const satisfies Record<'light' | 'dark', Record<string, readonly [number, number, number]>>

describe.each(['light', 'dark'] as const)('%s chrome is architectural gray', (theme) => {
  const tokens = palette(theme === 'dark')

  it.each(Object.entries(CHROME[theme]))('%s resolves to its exact gray', (name, [r, g, b]) => {
    expect(resolveColor(tokens, name)).toEqual([r, g, b])
  })

  it('leaves no blue accent alias in the chrome set', () => {
    for (const [name, value] of tokens) {
      if (/^--dsw-alias-(button-info|state-business|link|label-deep-diving|penrose)/.test(name)) {
        expect(value, name).not.toMatch(/deepseek|--dsw-static-blue-/)
      }
    }
  })

  it('keeps chrome text and the send arrow at AAA contrast', () => {
    const background = resolveColor(tokens, '--dsw-alias-bg-base')
    for (const name of ['--dsw-alias-state-business-primary', '--dsw-alias-label-deep-diving', '--dsw-alias-link']) {
      expect(contrast(resolveColor(tokens, name), background), name).toBeGreaterThan(4.5)
    }
    const fill = resolveColor(tokens, '--dsw-alias-button-info-fill')
    const ink = theme === 'dark' ? [21, 21, 23] as Rgb : [255, 255, 255] as Rgb
    expect(contrast(ink, fill)).toBeGreaterThan(7)
  })

  it('keeps the three Penrose faces strictly ordered by depth', () => {
    const light = luminance(resolveColor(tokens, '--dsw-alias-penrose-light'))
    const mid = luminance(resolveColor(tokens, '--dsw-alias-penrose-mid'))
    const deep = luminance(resolveColor(tokens, '--dsw-alias-penrose-deep'))
    if (theme === 'dark') expect(light).toBeGreaterThan(mid)
    else expect(light).toBeLessThan(mid)
    expect(theme === 'dark' ? mid > deep : mid < deep).toBe(true)
  })
})

describe('bubble and surface chrome', () => {
  const light = palette(false)
  const dark = palette(true)

  it('drops the bluish bubble fill in light mode while keeping the dark neutral', () => {
    expect(light.get('--dsw-specific-bubble')).toBe('var(--dsw-static-neutral-100)')
    expect(dark.get('--dsw-specific-bubble')).toBe('var(--dsw-static-neutral-bluish-850)')
    expect(light.get('--dsw-specific-bubble-highlight')).toBe('var(--dsw-static-neutral-200)')
    expect(dark.get('--dsw-specific-bubble-highlight')).toBe('var(--dsw-static-neutral-700)')
    expect(light.get('--dsw-specific-sidebar-nav-item-active-accent')).toBe('var(--dsw-static-neutral-200)')
  })

  it('selects documents with a neutral wash in both themes', () => {
    expect(light.get('--dsw-alias-bg-document-selection')).toBe('rgba(160, 164, 172, 0.28)')
    expect(dark.get('--dsw-alias-bg-document-selection')).toBe('rgba(160, 164, 172, 0.28)')
  })
})
