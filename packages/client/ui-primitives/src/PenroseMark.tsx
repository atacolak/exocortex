/** The 3-tone isometric Penrose tribar: one exact geometry, three shared seams. */
import clsx from 'clsx'
import css from './PenroseMark.module.css'

/** Contract shared with slot bundles that render the same mark. */
export type PenroseFaceTone = 'light' | 'mid' | 'deep'

/** One seamless L-ribbon: its tone and its closed polygon. */
export interface PenroseFace {
  readonly tone: PenroseFaceTone
  readonly d: string
}

export const PENROSE_MARK_VIEWBOX = '0 0 64 64'

/** Full-period duration of the topological breathing wave (2x the '08 cadence). */
export const PENROSE_BREATH_MS = 1400

const VIEWBOX_SIZE = 64
const PADDING = 6
const SQRT3 = Math.sqrt(3)
const UNIT = 1
const CAP = 0.13
const APERTURE = 0.295
const PRECISION = 1000

type Point = readonly [number, number]

const APEX: Point = [0, -UNIT / SQRT3]
const RIGHT: Point = [UNIT / 2, UNIT / (2 * SQRT3)]
const LEFT: Point = [-UNIT / 2, UNIT / (2 * SQRT3)]

const WINDOW_APEX: Point = [0, -APERTURE / SQRT3]
const WINDOW_RIGHT: Point = [APERTURE / 2, APERTURE / (2 * SQRT3)]
const WINDOW_LEFT: Point = [-APERTURE / 2, APERTURE / (2 * SQRT3)]

const DOWN_RIGHT: Point = [0.5, SQRT3 / 2]
const DOWN_LEFT: Point = [-0.5, SQRT3 / 2]
const HORIZONTAL: Point = [1, 0]

function along(origin: Point, target: Point, distance: number): Point {
  const dx = target[0] - origin[0]
  const dy = target[1] - origin[1]
  const length = Math.hypot(dx, dy)
  return [origin[0] + (dx / length) * distance, origin[1] + (dy / length) * distance]
}

function intersect(origin: Point, direction: Point, anchor: Point, axis: Point): Point {
  const determinant = axis[0] * direction[1] - direction[0] * axis[1]
  const bx = anchor[0] - origin[0]
  const by = anchor[1] - origin[1]
  const distance = (axis[0] * by - bx * axis[1]) / determinant
  return [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance]
}

const OUTER_A = along(APEX, LEFT, CAP)
const OUTER_B = along(APEX, RIGHT, CAP)
const OUTER_C = along(RIGHT, APEX, CAP)
const OUTER_D = along(RIGHT, LEFT, CAP)
const OUTER_E = along(LEFT, RIGHT, CAP)
const OUTER_F = along(LEFT, APEX, CAP)

const SEAM_X = intersect(WINDOW_APEX, DOWN_LEFT, OUTER_D, DOWN_RIGHT)
const SEAM_G = intersect(WINDOW_APEX, DOWN_RIGHT, OUTER_F, HORIZONTAL)
const SEAM_V = intersect(WINDOW_LEFT, HORIZONTAL, OUTER_B, DOWN_LEFT)

const BRIGHT_RIBBON: readonly Point[] = [OUTER_B, OUTER_C, OUTER_D, SEAM_X, WINDOW_LEFT, SEAM_V]
const MID_RIBBON: readonly Point[] = [OUTER_A, OUTER_B, SEAM_V, WINDOW_RIGHT, SEAM_G, OUTER_F]
const DEEP_RIBBON: readonly Point[] = [WINDOW_APEX, SEAM_X, OUTER_D, OUTER_E, OUTER_F, SEAM_G]

const SILHOUETTE: readonly Point[] = [OUTER_A, OUTER_B, OUTER_C, OUTER_D, OUTER_E, OUTER_F]
const APERTURE_OUTLINE: readonly Point[] = [WINDOW_APEX, WINDOW_LEFT, WINDOW_RIGHT]

const OUTLINE: readonly Point[] = [...SILHOUETTE, ...APERTURE_OUTLINE]
const BOUNDS: readonly [number, number, number, number] = [
  Math.min(...OUTLINE.map(point => point[0])),
  Math.min(...OUTLINE.map(point => point[1])),
  Math.max(...OUTLINE.map(point => point[0])),
  Math.max(...OUTLINE.map(point => point[1])),
]

const SCALE = (VIEWBOX_SIZE - 2 * PADDING) / Math.max(BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1])
const OFFSET_X = (VIEWBOX_SIZE - (BOUNDS[2] - BOUNDS[0]) * SCALE) / 2 - BOUNDS[0] * SCALE
const OFFSET_Y = (VIEWBOX_SIZE - (BOUNDS[3] - BOUNDS[1]) * SCALE) / 2 - BOUNDS[1] * SCALE

function round(value: number): string {
  const scaled = Math.round(value * PRECISION) / PRECISION
  return Object.is(scaled, -0) ? '0' : String(scaled)
}

function toPath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point[0] * SCALE + OFFSET_X)} ${round(point[1] * SCALE + OFFSET_Y)}`)
    .join('') + 'Z'
}

/** The three faces in tonal order: highest contrast first. */
export const PENROSE_FACES: readonly PenroseFace[] = [
  { tone: 'light', d: toPath(BRIGHT_RIBBON) },
  { tone: 'mid', d: toPath(MID_RIBBON) },
  { tone: 'deep', d: toPath(DEEP_RIBBON) },
]

/** The union outline with its aperture punched out, for animated variants. */
export const PENROSE_SILHOUETTE_PATH = `${toPath(SILHOUETTE)}${toPath(APERTURE_OUTLINE)}`

const FACE_CLASS: Record<PenroseFaceTone, string | undefined> = {
  light: css.light,
  mid: css.mid,
  deep: css.deep,
}

export interface PenroseMarkProps {
  readonly size?: number
  readonly className?: string | undefined
  /** Render the silhouette backing and cycle the faces' luminous breathing wave. */
  readonly animated?: boolean
}

/**
 * The brand mark: a mathematically continuous Penrose tribar, three tones, no gaps.
 * @param props - Rendered edge size, extra class, and the breathing-wave toggle.
 * @returns the inline SVG mark.
 */
export function PenroseMark({ size = 24, className, animated = false }: PenroseMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={PENROSE_MARK_VIEWBOX}
      className={clsx(css.mark, animated && css.breathing, className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated && <path d={PENROSE_SILHOUETTE_PATH} fillRule="evenodd" className={css.backing} />}
      {PENROSE_FACES.map(face => (
        <path
          key={face.tone}
          d={face.d}
          data-penrose-face={face.tone}
          className={FACE_CLASS[face.tone]}
        />
      ))}
    </svg>
  )
}
