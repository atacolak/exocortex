/** CSS checks for the Session header title claim on the row width. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)

function declarationsFrom(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('Session header title width', () => {
  it('lets the cluster, the crumb row, and the current title claim the free row width', () => {
    expect(declarationsFrom(css, '.titleCluster')).toEqual(expect.arrayContaining([
      'flex: 1 1 auto',
      'min-width: 0',
      'max-width: none',
    ]))
    expect(declarationsFrom(css, '.crumbs')).toEqual(expect.arrayContaining([
      'flex: 1 1 auto',
      'min-width: 0',
      'max-width: none',
    ]))
    expect(declarationsFrom(css, '.crumbCurrent')).toEqual(expect.arrayContaining([
      'flex: 1 1 auto',
      'min-width: 0',
      'max-width: none',
    ]))
  })

  it('grows the current segment while ancestor crumbs keep their compact cap', () => {
    expect(declarationsFrom(css, '.crumbSeg:last-child')).toEqual(expect.arrayContaining([
      'flex: 1 1 auto',
      'min-width: 0',
    ]))
    expect(declarationsFrom(css, '.crumb')).toEqual(expect.arrayContaining(['max-width: 220px']))
    expect(declarationsFrom(css, '.crumbCurrent')).toEqual(expect.arrayContaining([
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ]))
  })
})
