// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningPenrose } from '../src/client/chat/RunningPenrose.tsx'

afterEach(cleanup)

const chatCss = readFileSync(resolve(import.meta.dirname, '../src/client/chat/ChatView.module.css'), 'utf8')

describe('RunningPenrose', () => {
  it('renders the three-face mark in a decorative seat without inline styles', () => {
    const view = render(<RunningPenrose />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(1)
    const svg = icon.querySelector('svg')!
    expect(icon.firstElementChild).toBe(svg)
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64')
    expect([...svg.querySelectorAll('[data-penrose-face]')].map(face => face.getAttribute('data-penrose-face')))
      .toEqual(['light', 'mid', 'deep'])
    expect(svg.querySelectorAll('path')).toHaveLength(4)
    expect(svg.querySelectorAll('animate')).toHaveLength(0)
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('breathes at the 2x cadence with phased faces and a reduced-motion escape', () => {
    expect(chatCss).toMatch(/\.runningMark \{\s*width: 100%;\s*height: 100%;\s*\}/)
    expect(chatCss).not.toMatch(/running-whale|runningWhale/)
  })

  it('ships no whale artwork', () => {
    expect(() => readFileSync(resolve(import.meta.dirname, '../src/client/assets/running-whale@2x.png'))).toThrow()
  })
})
