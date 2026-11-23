import type { CSSProperties } from 'react'

type GlassAuroraProps = {
  intensity: number
  paused: boolean
}

/**
 * Study C — Glass Aurora.
 * Full-bleed approved reference image as the background. Intensity drives a
 * subtle iridescent veil overlay.
 */
export function GlassAurora({ intensity, paused }: GlassAuroraProps) {
  return (
    <div
      className={`lab-effect lab-effect--aurora${paused ? ' is-paused' : ''}`}
      style={{ '--effect-intensity': intensity } as CSSProperties}
    >
      <div className="lab-effect__image" aria-hidden="true" />
      <div className="lab-effect__intensity-overlay" aria-hidden="true" />
      <div className="lab-effect__grain" aria-hidden="true" />
    </div>
  )
}
