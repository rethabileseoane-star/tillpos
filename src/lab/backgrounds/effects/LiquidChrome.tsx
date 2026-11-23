import type { CSSProperties } from 'react'

type LiquidChromeProps = {
  intensity: number
  paused: boolean
}

/**
 * Study B — Liquid Chrome.
 * Full-bleed approved reference image as the background. Intensity drives a
 * subtle chrome highlight overlay.
 */
export function LiquidChrome({ intensity, paused }: LiquidChromeProps) {
  return (
    <div
      className={`lab-effect lab-effect--chrome${paused ? ' is-paused' : ''}`}
      style={{ '--effect-intensity': intensity } as CSSProperties}
    >
      <div className="lab-effect__image" aria-hidden="true" />
      <div className="lab-effect__intensity-overlay" aria-hidden="true" />
      <div className="lab-effect__grain" aria-hidden="true" />
    </div>
  )
}
