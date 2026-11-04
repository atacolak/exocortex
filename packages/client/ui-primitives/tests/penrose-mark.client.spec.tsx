// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PenroseMark } from '../src/PenroseMark.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const markCss = readFileSync(resolve(import.meta.dirname, '../src/PenroseMark.module.css'), 'utf8')

const MARK_VIEWBOX = '-541.587 -541.583 1083.17 1083.17'
const BODY_PATH =
  'M-81.99 -431.57L82.83 -431.57L515.72 309.67L439.35 431.58L-441.37 431.58L-515.72 308.15ZM-6.34 -73.41L161.79 211.56L-175.39 211.56Z'
const LINES_PATH = `${BODY_PATH}M81.5 -431.57L-302.17 211.56L-175.39 211.56M432.52 431.58L64.17 -192.27L-6.34 -73.41M-512.74 313.11L221.7 313.11L161.79 211.56`
const BREATH_BODY_FIRST =
  'M-82.33 -431L83.16 -431.02L515.72 309.67L439.7 431.02L-441.7 431.02L-515.72 308.15ZM3.92 -80L166.51 208.61L-165.27 211.83Z'
const BREATH_LINES_FIRST = `${BREATH_BODY_FIRST}M81.16 -431.02L-303.13 213.17L-165.27 211.83M432.19 431.02L66.62 -188.13L3.92 -80M-515.48 307.74L222.35 307.74L166.51 208.61`

const widthFor = (size: number): string => String(Math.max(6, (0.9 * 1083.17) / Math.max(1, size || 24)))

function markSvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  expect(svg).not.toBeNull()
  return svg as SVGSVGElement
}

describe('PenroseMark geometry', () => {
  it('renders the penrose-lab masked mark in currentColor with no tonal faces', () => {
    const view = render(<PenroseMark size={24} />)
    const svg = markSvg(view.container)

    expect(svg.getAttribute('viewBox')).toBe(MARK_VIEWBOX)
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')

    const mask = svg.querySelector('mask')
    expect(mask).not.toBeNull()
    expect(mask!.getAttribute('maskUnits')).toBe('userSpaceOnUse')
    expect(mask!.getAttribute('x')).toBe('-541.587')
    expect(mask!.getAttribute('y')).toBe('-541.583')
    expect(mask!.getAttribute('width')).toBe('1083.17')
    expect(mask!.getAttribute('height')).toBe('1083.17')
    expect(mask!.id).not.toBe('')

    const paths = [...mask!.querySelectorAll('path')]
    expect(paths).toHaveLength(2)
    const [body, lines] = paths
    expect(body!.getAttribute('d')).toBe(BODY_PATH)
    expect(body!.getAttribute('fill')).toBe('#fff')
    expect(body!.getAttribute('fill-rule')).toBe('evenodd')
    expect(lines!.getAttribute('d')).toBe(LINES_PATH)
    expect(lines!.getAttribute('fill')).toBe('none')
    expect(lines!.getAttribute('stroke')).toBe('#000')
    expect(lines!.getAttribute('stroke-width')).toBe(widthFor(24))
    expect(lines!.getAttribute('stroke-linejoin')).toBe('miter')
    expect(lines!.getAttribute('stroke-miterlimit')).toBe('8')

    const rect = svg.querySelector('rect')
    expect(rect).not.toBeNull()
    expect(rect!.getAttribute('fill')).toBe('currentColor')
    expect(rect!.getAttribute('mask')).toBe(`url(#${mask!.id})`)
    expect(rect!.getAttribute('x')).toBe('-541.587')
    expect(rect!.getAttribute('width')).toBe('1083.17')

    expect(svg.querySelectorAll('[data-penrose-face]')).toHaveLength(0)
    expect(svg.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
    expect(markCss).not.toMatch(/penrose-light|penrose-mid|penrose-deep|penrose-breathe/)
  })

  it('scales the seam knockout to a hairline and floors it at the canonical width', () => {
    const small = render(<PenroseMark size={14} />)
    const large = render(<PenroseMark size={500} />)
    expect(markSvg(small.container).querySelectorAll('mask path')[1]!.getAttribute('stroke-width'))
      .toBe(widthFor(14))
    expect(markSvg(large.container).querySelectorAll('mask path')[1]!.getAttribute('stroke-width'))
      .toBe('6')
  })

  it('mints a unique mask id for every instance', () => {
    const view = render(
      <>
        <PenroseMark />
        <PenroseMark />
      </>,
    )
    const ids = [...view.container.querySelectorAll('mask')].map(mask => mask.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('PenroseMark breathing', () => {
  it('runs the 08-topological-breathing wave at 2x speed', () => {
    const view = render(<PenroseMark size={14} animated />)
    const svg = markSvg(view.container)
    const animations = [...svg.querySelectorAll('animate')]

    expect(animations).toHaveLength(2)
    for (const animation of animations) {
      expect(animation.getAttribute('attributeName')).toBe('d')
      expect(animation.getAttribute('dur')).toBe('4s')
      expect(animation.getAttribute('repeatCount')).toBe('indefinite')
      expect(animation.getAttribute('calcMode')).toBe('linear')
    }

    const keyTimes = animations[0]!.getAttribute('keyTimes')!.split(';')
    expect(keyTimes).toHaveLength(161)
    expect(keyTimes[0]).toBe('0')
    expect(keyTimes.at(-1)).toBe('1')

    const bodyFrames = animations[0]!.getAttribute('values')!.split(';')
    const lineFrames = animations[1]!.getAttribute('values')!.split(';')
    expect(bodyFrames).toHaveLength(161)
    expect(lineFrames).toHaveLength(161)
    expect(bodyFrames[0]).toBe(BREATH_BODY_FIRST)
    expect(bodyFrames.at(-1)).toBe(BREATH_BODY_FIRST)
    expect(lineFrames[0]).toBe(BREATH_LINES_FIRST)
    expect(lineFrames.at(-1)).toBe(BREATH_LINES_FIRST)
    for (const [index, frame] of lineFrames.entries()) {
      expect(frame.startsWith(bodyFrames[index]!)).toBe(true)
    }
  })

  it('keeps the mark still when prefers-reduced-motion asks for it', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }))

    const view = render(<PenroseMark animated />)
    const svg = markSvg(view.container)
    expect(svg.querySelectorAll('animate')).toHaveLength(0)
    expect(svg.querySelectorAll('mask path')).toHaveLength(2)
  })
})
