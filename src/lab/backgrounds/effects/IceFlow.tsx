import type { CSSProperties } from 'react'

type IceFlowProps = {
  intensity: number
  paused: boolean
}

/**
 * Study A — Ice Flow.
 * Full-bleed approved reference image as the background. Intensity drives a
 * subtle light overlay so the study stays bright and readable under glass.
 */
export function IceFlow({ intensity, paused }: IceFlowProps) {
  return (
    <div
      className={`lab-effect lab-effect--ice${paused ? ' is-paused' : ''}`}
      style={{ '--effect-intensity': intensity } as CSSProperties}
    >
      <div className="lab-effect__image" aria-hidden="true" />
      <div className="lab-effect__intensity-overlay" aria-hidden="true" />
      <div className="lab-effect__grain" aria-hidden="true" />
    </div>
  )
}
