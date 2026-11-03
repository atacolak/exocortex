/** The 3-tone topological-breathing Penrose spinner for the running Chat status. */
import { PenroseMark } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the decorative running icon as the breathing Penrose tribar.
 * @returns the icon seat with the animated mark.
 */
export function RunningPenrose() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <PenroseMark size={14} animated className={css.runningMark} />
    </span>
  )
}
