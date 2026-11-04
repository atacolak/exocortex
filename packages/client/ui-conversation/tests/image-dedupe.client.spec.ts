// @vitest-environment jsdom
/** Pasted-image reuse: identical bytes never upload twice in one draft. */
import { describe, expect, it } from 'vitest'
import { planImageIntake } from '../src/client/image-dedupe.ts'

function png(bytes: number[], name: string): File {
  return new File([Uint8Array.from(bytes)], name, { type: 'image/png' })
}

describe('planImageIntake', () => {
  it('reuses the staged ordinal without uploading identical bytes again', async () => {
    const staged = png([1, 2, 3, 4], 'first.png')
    const pasted = png([1, 2, 3, 4], 'copy.png')
    const plan = await planImageIntake([pasted], [staged])
    expect(plan.ordinals).toEqual([1])
    expect(plan.fresh).toEqual([])
  })

  it('uploads only the first copy within one batch and reuses its ordinal', async () => {
    const first = png([9, 9, 9, 9], 'a.png')
    const second = png([9, 9, 9, 9], 'b.png')
    const third = png([5, 5, 5], 'c.png')
    const plan = await planImageIntake([first, second, third], [])
    expect(plan.fresh).toEqual([first, third])
    expect(plan.ordinals).toEqual([1, 1, 2])
  })

  it('numbers fresh images after the staged rail and keeps same-size distinct bytes apart', async () => {
    const staged = png([1, 2, 3], 'first.png')
    const sameSize = png([4, 5, 6], 'other.png')
    const plan = await planImageIntake([sameSize], [staged])
    expect(plan.fresh).toEqual([sameSize])
    expect(plan.ordinals).toEqual([2])
  })
})
