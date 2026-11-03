// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PENROSE_BREATH_MS, PENROSE_FACES, PENROSE_MARK_VIEWBOX, PENROSE_SILHOUETTE_PATH, PenroseMark,
} from '../src/PenroseMark.tsx'

afterEach(cleanup)

const markCss = readFileSync(resolve(import.meta.dirname, '../src/PenroseMark.module.css'), 'utf8')

type Point = [number, number]

function parsePolygon(d: string): Point[] {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)!
  expect(numbers.length % 2).toBe(0)
  const points: Point[] = []
  for (let index = 0; index < numbers.length; index += 2) {
    points.push([Number(numbers[index]), Number(numbers[index + 1])])
  }
  return points
}

function shoelace(points: readonly Point[]): number {
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!
    const [x2, y2] = points[(index + 1) % points.length]!
    total += x1 * y2 - x2 * y1
  }
  return Math.abs(total) / 2
}

const key = (point: Point): string => `${point[0].toFixed(3)},${point[1].toFixed(3)}`

describe('PenroseMark geometry', () => {
  it('is three closed L-ribbons that tile the tribar exactly: no gap cuts, no overlaps', () => {
    expect(PENROSE_FACES.map(face => face.tone)).toEqual(['light', 'mid', 'deep'])
    const polygons = PENROSE_FACES.map(face => parsePolygon(face.d))
    for (const polygon of polygons) expect(polygon).toHaveLength(6)

    const outline = parsePolygon(PENROSE_SILHOUETTE_PATH)
    expect(outline).toHaveLength(9)
    const silhouette = outline.slice(0, 6)
    const aperture = outline.slice(6)
    expect(shoelace(aperture)).toBeGreaterThan(0)

    const expected = shoelace(silhouette) - shoelace(aperture)
    const tessellated = polygons.reduce((sum, polygon) => sum + shoelace(polygon), 0)
    expect(Math.abs(tessellated - expected) / expected).toBeLessThan(1e-5)

    const edgeKeys = polygons.flatMap(polygon => polygon.map((point, index) => {
      const next = polygon[(index + 1) % polygon.length]!
      return [key(point), key(next)].sort().join('|')
    }))
    const counts = new Map<string, number>()
    for (const edge of edgeKeys) counts.set(edge, (counts.get(edge) ?? 0) + 1)
    expect([...counts.values()].filter(count => count === 2)).toHaveLength(3)
    expect([...counts.values()].every(count => count <= 2)).toBe(true)

    const vertices = new Set(polygons.flat().map(key))
    expect(vertices.size).toBe(12)
    for (const face of PENROSE_FACES) {
      expect(face.d.startsWith('M')).toBe(true)
      expect(face.d.endsWith('Z')).toBe(true)
      expect(face.d).not.toMatch(/NaN|Infinity|undefined/)
    }
  })

  it('stays inside the 64 box with even padding', () => {
    for (const face of PENROSE_FACES) {
      for (const [x, y] of parsePolygon(face.d)) {
        expect(x).toBeGreaterThanOrEqual(6)
        expect(x).toBeLessThanOrEqual(58)
        expect(y).toBeGreaterThanOrEqual(9)
        expect(y).toBeLessThanOrEqual(55)
      }
    }
  })
})

describe('PenroseMark rendering', () => {
  it('renders the three faces in order with no inline styles and no whale', () => {
    const view = render(<PenroseMark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe(PENROSE_MARK_VIEWBOX)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const faces = [...svg.querySelectorAll('[data-penrose-face]')]
    expect(faces.map(face => face.getAttribute('data-penrose-face'))).toEqual(['light', 'mid', 'deep'])
    expect(faces.map(face => face.getAttribute('d'))).toEqual(PENROSE_FACES.map(face => face.d))
    expect(faces.map(face => face.getAttribute('fill'))).toEqual([null, null, null])
    expect(view.container.querySelector('[style]')).toBeNull()
    expect(view.container.querySelector('animate')).toBeNull()
  })

  it('adds the silhouette backing only for the breathing variant', () => {
    const still = render(<PenroseMark size={34} />)
    expect(still.container.querySelectorAll('path')).toHaveLength(3)
    still.unmount()
    const animated = render(<PenroseMark size={14} animated />)
    const paths = [...animated.container.querySelectorAll('path')]
    expect(paths).toHaveLength(4)
    expect(paths[0]!.getAttribute('d')).toBe(PENROSE_SILHOUETTE_PATH)
    expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd')
    expect(animated.container.querySelector('svg')?.getAttribute('width')).toBe('14')
  })
})

describe('PenroseMark breathing contract', () => {
  it('cycles the three tones at the 2x cadence with phase offsets', () => {
    expect(PENROSE_BREATH_MS).toBe(1400)
    expect(markCss).toContain('--dsw-alias-penrose-light')
    expect(markCss).toContain('--dsw-alias-penrose-mid')
    expect(markCss).toContain('--dsw-alias-penrose-deep')
    expect(markCss.match(/1\.4s cubic-bezier\(0\.45, 0, 0\.55, 1\)/g)).toHaveLength(4)
    expect(markCss).toMatch(/\.breathing \.mid \{\s*animation-delay: -0\.45s;/)
    expect(markCss).toMatch(/\.breathing \.deep \{\s*animation-delay: -0\.9s;/)
    expect(markCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
