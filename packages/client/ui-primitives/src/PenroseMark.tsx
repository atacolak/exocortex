/** The penrose-lab Penrose tribar: one masked material path tinted by currentColor. */
import clsx from 'clsx'
import { useRef } from 'react'
import css from './PenroseMark.module.css'
import {
  PENROSE_BREATH_BODY_VALUES,
  PENROSE_BREATH_KEY_TIMES,
  PENROSE_BREATH_LINE_VALUES,
} from './penrose-breath.ts'

export const PENROSE_MARK_VIEWBOX = '-541.587 -541.583 1083.17 1083.17'

/** Full-period duration of the topological breathing wave (2x the '08 cadence). */
export const PENROSE_BREATH_MS = 4000

/** Exact penrose-lab material geometry: outer triangle with the central aperture cut out. */
export const PENROSE_BODY_PATH =
  'M-81.99 -431.57L82.83 -431.57L515.72 309.67L439.35 431.58L-441.37 431.58L-515.72 308.15ZM-6.34 -73.41L161.79 211.56L-175.39 211.56Z'

/** Exact penrose-lab seam geometry over the material path, knocked out of the mask. */
export const PENROSE_LINES_PATH = `${PENROSE_BODY_PATH}M81.5 -431.57L-302.17 211.56L-175.39 211.56M432.52 431.58L64.17 -192.27L-6.34 -73.41M-512.74 313.11L221.7 313.11L161.79 211.56`

const VIEW_X = -541.587
const VIEW_Y = -541.583
const VIEW_SIDE = 1083.17
const SEAM_WIDTH_RATIO = 0.9
const MIN_SEAM_WIDTH = 6

let maskSequence = 0

export interface PenroseMarkProps {
  readonly size?: number
  readonly className?: string | undefined
  /** Render the 08-topological-breathing mask wave at 2x speed. */
  readonly animated?: boolean
}

/**
 * Render the masked penrose-lab tribar at the requested edge size.
 * @param props - Edge size, extra class, and the breathing-wave toggle.
 * @returns the inline SVG mark.
 */
export function PenroseMark({ size = 24, className, animated = false }: PenroseMarkProps) {
  const maskIdRef = useRef<string | null>(null)
  if (maskIdRef.current === null) {
    maskSequence += 1
    maskIdRef.current = `dsh-penrose-mask-${maskSequence}`
  }
  const maskId = maskIdRef.current
  const safeSize = Math.max(1, size || 24)
  const seamWidth = Math.max(MIN_SEAM_WIDTH, (SEAM_WIDTH_RATIO * VIEW_SIDE) / safeSize)
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const breathing = animated && !reducedMotion
  return (
    <svg
      aria-hidden="true"
      className={clsx(css.mark, className)}
      data-penrose-mark=""
      focusable="false"
      height={size}
      viewBox={PENROSE_MARK_VIEWBOX}
      width={size}
    >
      <defs>
        <mask
          height={VIEW_SIDE}
          id={maskId}
          maskUnits="userSpaceOnUse"
          width={VIEW_SIDE}
          x={VIEW_X}
          y={VIEW_Y}
        >
          <path d={PENROSE_BODY_PATH} fill="#fff" fillRule="evenodd">
            {breathing ? (
              <animate
                attributeName="d"
                calcMode="linear"
                dur={`${PENROSE_BREATH_MS / 1000}s`}
                keyTimes={PENROSE_BREATH_KEY_TIMES}
                repeatCount="indefinite"
                values={PENROSE_BREATH_BODY_VALUES}
              />
            ) : null}
          </path>
          <path
            d={PENROSE_LINES_PATH}
            fill="none"
            stroke="#000"
            strokeLinejoin="miter"
            strokeMiterlimit={8}
            strokeWidth={seamWidth}
          >
            {breathing ? (
              <animate
                attributeName="d"
                calcMode="linear"
                dur={`${PENROSE_BREATH_MS / 1000}s`}
                keyTimes={PENROSE_BREATH_KEY_TIMES}
                repeatCount="indefinite"
                values={PENROSE_BREATH_LINE_VALUES}
              />
            ) : null}
          </path>
        </mask>
      </defs>
      <rect
        fill="currentColor"
        height={VIEW_SIDE}
        mask={`url(#${maskId})`}
        width={VIEW_SIDE}
        x={VIEW_X}
        y={VIEW_Y}
      />
    </svg>
  )
}
