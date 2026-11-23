import type { CSSProperties } from 'react'

type CrystalWavesProps = {
  intensity: number
  paused: boolean
}

/**
 * Study D — Crystal Waves.
 * Full-bleed approved reference image as the background. Intensity drives a
 * subtle luminous edge overlay.
 */
export function CrystalWaves({ intensity, paused }: CrystalWavesProps) {
  return (
    <div
      className={`lab-effect lab-effect--crystal${paused ? ' is-paused' : ''}`}
      style={{ '--effect-intensity': intensity } as CSSProperties}
    >
      <div className="lab-effect__image" aria-hidden="true" />
      <div className="lab-effect__intensity-overlay" aria-hidden="true" />
      <div className="lab-effect__grain" aria-hidden="true" />
    </div>
  )
}
