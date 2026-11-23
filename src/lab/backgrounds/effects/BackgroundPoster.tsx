import type { StudyId } from '../studies'

type BackgroundPosterProps = {
  study: StudyId
  className?: string
}

/**
 * Static, GPU-free approximation used for comparison cards, while the effect
 * chunk loads, and when WebGL 2 is unavailable. The stage only ever mounts one
 * live effect at a time.
 */
export function BackgroundPoster({ study, className = '' }: BackgroundPosterProps) {
  return (
    <div
      className={`lab-poster lab-poster--${study}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <div className="lab-poster__sheen" />
      <div className="lab-poster__grain" />
    </div>
  )
}
