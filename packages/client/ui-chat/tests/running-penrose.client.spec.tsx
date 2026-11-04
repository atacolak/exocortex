// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningPenrose } from '../src/client/chat/RunningPenrose.tsx'

afterEach(cleanup)

const chatCss = readFileSync(resolve(import.meta.dirname, '../src/client/chat/ChatView.module.css'), 'utf8')

describe('RunningPenrose', () => {
  it('renders the masked penrose-lab mark in a decorative seat without inline styles', () => {
    const view = render(<RunningPenrose />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(1)
    const svg = icon.querySelector('svg')!
    expect(icon.firstElementChild).toBe(svg)
    expect(svg.getAttribute('viewBox')).toBe('-541.587 -541.583 1083.17 1083.17')
    expect(svg.getAttribute('width')).toBe('14')
    expect(svg.querySelectorAll('mask')).toHaveLength(1)
    expect(svg.querySelectorAll('mask path')).toHaveLength(2)
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('currentColor')
    expect(svg.querySelectorAll('[data-penrose-face]')).toHaveLength(0)
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('breathes the real 08-topological-breathing wave at 2x speed', () => {
    const view = render(<RunningPenrose />)
    const svg = view.container.querySelector('svg')!
    const animations = [...svg.querySelectorAll('animate')]

    expect(animations).toHaveLength(2)
    for (const animation of animations) {
      expect(animation.getAttribute('attributeName')).toBe('d')
      expect(animation.getAttribute('dur')).toBe('4s')
      expect(animation.getAttribute('repeatCount')).toBe('indefinite')
      expect(animation.getAttribute('values')!.split(';')).toHaveLength(161)
    }
    expect(chatCss).toMatch(/\.runningMark \{\s*width: 100%;\s*height: 100%;\s*\}/)
    expect(chatCss).not.toMatch(/running-whale|runningWhale/)
  })

  it('ships no whale artwork', () => {
    expect(() => readFileSync(resolve(import.meta.dirname, '../src/client/assets/running-whale@2x.png'))).toThrow()
  })
})
