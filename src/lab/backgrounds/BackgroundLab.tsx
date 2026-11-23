import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { STUDIES, type StudyId } from './studies'
import { BackgroundPoster } from './effects/BackgroundPoster'
import { CrystalWaves } from './effects/CrystalWaves'
import { GlassAurora } from './effects/GlassAurora'
import { IceFlow } from './effects/IceFlow'
import { LiquidChrome } from './effects/LiquidChrome'
import './lab.css'

const DEFAULTS = {
  transparency: 56,
  blur: 18,
  intensity: 1,
  glass: true,
  readabilityVeil: false,
  paused: false,
}

type View = 'stage' | 'compare'

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return undefined
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return reduced
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden)

  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return visible
}

function detectWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2'))
  } catch {
    return false
  }
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  hint?: string
  onChange: (value: number) => void
}) {
  const id = useId()
  const progress = ((value - min) / (max - min)) * 100

  return (
    <div className="lab-control">
      <div className="lab-control__top">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {step < 1 ? Number(value.toFixed(2)) : Math.round(value)}
          {suffix}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--range-fill': `${progress}%` } as CSSProperties}
      />
      {hint && <p className="lab-control__hint">{hint}</p>}
    </div>
  )
}

function ToggleControl({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()

  return (
    <div className="lab-control lab-control--switch">
      <div>
        <label htmlFor={id}>{label}</label>
        {description && <p className="lab-control__hint">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={`lab-switch${checked ? ' is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  )
}

function GlassPanel({
  alpha,
  blur,
}: {
  alpha: number
  blur: number
}) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  // At extreme transparency the white fill alone is not enough to keep navy
  // labels legible over a bright study. A conditional frost fills only the
  // low-opacity end of the range, so the default glass stays clean.
  const frost = Math.min(0.52, Math.max(0, 0.48 - alpha) * 1.25)

  return (
    <div
      className="lab-glass"
      role="region"
      aria-label="Simulated sales panel over the active background"
      style={
        {
          background: `linear-gradient(180deg, rgba(255, 255, 255, ${frost}), rgba(235, 248, 255, ${
            frost * 0.8
          })), linear-gradient(135deg, rgba(255, 255, 255, ${Math.min(
            0.94,
            alpha * 1.35,
          )}), rgba(235, 247, 255, ${Math.min(0.92, alpha * 1.15)}))`,
          backdropFilter: `blur(${blur}px) saturate(1.08)`,
          WebkitBackdropFilter: `blur(${blur}px) saturate(1.08)`,
        } as CSSProperties
      }
    >
      <div className="lab-glass__chrome" aria-hidden="true" />
      <div className="lab-glass__head">
        <div>
          <p className="lab-glass__eyebrow">Sales today</p>
          <p className="lab-glass__amount">M 12,450.00</p>
        </div>
        <span className="lab-glass__delta">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.2 7.6 5 4.8l1.8 1.8 3-3" />
            <path d="M7.9 3.6h2.1v2.1" />
          </svg>
          12.4%
        </span>
      </div>

      <div className="lab-glass__meta">
        <span>38 transactions</span>
        <span>Avg M 327.63</span>
      </div>

      <div className="lab-chart">
        <svg
          viewBox="0 0 420 132"
          role="img"
          aria-label="Illustrative sales trend, fictional data"
        >
          <defs>
            <linearGradient id={`chart-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.26" />
              <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`chart-line-${gradientId}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#7dd3fc" />
              <stop offset="55%" stopColor="#0ea5c9" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <g className="lab-chart__grid">
            <path d="M0 34H420M0 66H420M0 98H420" />
            <path d="M84 0V132M168 0V132M252 0V132M336 0V132" />
          </g>
          <path
            d="M0 103 C 20 99, 31 93, 48 95 S 72 105, 91 90 S 121 72, 141 81 S 173 96, 195 73 S 227 49, 252 58 S 284 76, 307 53 S 345 29, 366 37 S 399 53, 420 31 L420 132 L0 132Z"
            fill={`url(#chart-fill-${gradientId})`}
          />
          <path
            d="M0 103 C 20 99, 31 93, 48 95 S 72 105, 91 90 S 121 72, 141 81 S 173 96, 195 73 S 227 49, 252 58 S 284 76, 307 53 S 345 29, 366 37 S 399 53, 420 31"
            fill="none"
            stroke={`url(#chart-line-${gradientId})`}
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <circle cx="420" cy="31" r="8" className="lab-chart__pulse" />
          <circle cx="420" cy="31" r="3.3" fill="#ffffff" />
        </svg>
      </div>

      <div className="lab-glass__footer">
        <button type="button" className="lab-cta">
          View report
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h9M8.5 3.8 12.7 8l-4.2 4.2" />
          </svg>
        </button>
        <span className="lab-glass__sync">
          <i />
          Illustrative data
        </span>
      </div>
    </div>
  )
}

function ActiveEffect({
  study,
  intensity,
  paused,
}: {
  study: StudyId
  intensity: number
  paused: boolean
}) {
  if (study === 'ice') {
    return <IceFlow intensity={intensity} paused={paused} />
  }
  if (study === 'chrome') {
    return <LiquidChrome intensity={intensity} paused={paused} />
  }
  if (study === 'aurora') {
    return <GlassAurora intensity={intensity} paused={paused} />
  }
  return <CrystalWaves intensity={intensity} paused={paused} />
}

function LabButton({
  children,
  onClick,
  tone = 'quiet',
}: {
  children: ReactNode
  onClick: () => void
  tone?: 'quiet' | 'chrome'
}) {
  return (
    <button type="button" className={`lab-button lab-button--${tone}`} onClick={onClick}>
      {children}
    </button>
  )
}

export function BackgroundLab() {
  const [study, setStudy] = useState<StudyId>('ice')
  const [view, setView] = useState<View>('stage')
  const [glass, setGlass] = useState(DEFAULTS.glass)
  const [transparency, setTransparency] = useState(DEFAULTS.transparency)
  const [blur, setBlur] = useState(DEFAULTS.blur)
  const [intensity, setIntensity] = useState(DEFAULTS.intensity)
  const [readabilityVeil, setReadabilityVeil] = useState(DEFAULTS.readabilityVeil)
  const [paused, setPaused] = useState(DEFAULTS.paused)
  const [focus, setFocus] = useState(false)
  const [webgl2] = useState(detectWebGL2)
  const reducedMotion = useReducedMotion()
  const pageVisible = usePageVisible()

  const active = STUDIES.find((item) => item.id === study) ?? STUDIES[0]
  const motionPaused = paused || reducedMotion || !pageVisible
  const alpha = 0.2 + (1 - transparency / 100) * 0.7
  const gpuStudy = active.id === 'ice' || active.id === 'chrome'
  const renderer = gpuStudy && !webgl2 ? active.fallback : active.engine
  const contexts = gpuStudy && webgl2 ? '1' : '0'

  useEffect(() => {
    if (!focus) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocus(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focus])

  function openStudy(next: StudyId) {
    setStudy(next)
    setView('stage')
  }

  function resetStage() {
    setGlass(DEFAULTS.glass)
    setTransparency(DEFAULTS.transparency)
    setBlur(DEFAULTS.blur)
    setIntensity(DEFAULTS.intensity)
    setReadabilityVeil(DEFAULTS.readabilityVeil)
    setPaused(DEFAULTS.paused)
  }

  return (
    <div className={`lab-root${focus ? ' is-focus' : ''}`}>
      <header className="lab-header">
        <div className="lab-brand">
          <span className="lab-brand__orb" aria-hidden="true" />
          <div>
            <span className="lab-brand__name">TILL</span>
            <span className="lab-brand__sub">Visual Laboratory</span>
          </div>
        </div>

        <div className="lab-segment" role="group" aria-label="Laboratory view">
          <button
            type="button"
            className={view === 'stage' ? 'is-active' : ''}
            aria-pressed={view === 'stage'}
            onClick={() => setView('stage')}
          >
            Stage
          </button>
          <button
            type="button"
            className={view === 'compare' ? 'is-active' : ''}
            aria-pressed={view === 'compare'}
            onClick={() => {
              setView('compare')
              setFocus(false)
            }}
          >
            Compare
          </button>
        </div>

        <div className="lab-header__actions">
          <span className="lab-dev">
            <i />
            Dev only
          </span>
          <LabButton
            tone="chrome"
            onClick={() => {
              setView('stage')
              setFocus((value) => !value)
            }}
          >
            {focus ? 'Exit full screen' : 'Full screen'}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
            </svg>
          </LabButton>
        </div>
      </header>

      <main className="lab-workspace">
        <aside className="lab-rail" aria-label="Background directions">
          <div className="lab-rail__head">
            <span className="lab-kicker">Phase 01</span>
            <h1>Background study</h1>
            <p>Four light-material directions for TILL. One live effect at a time.</p>
          </div>

          <div className="lab-rail__list">
            {STUDIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`lab-variant${item.id === active.id ? ' is-active' : ''}`}
                aria-pressed={item.id === active.id}
                onClick={() => openStudy(item.id)}
              >
                <span className="lab-variant__index">{item.index}</span>
                <span className="lab-variant__copy">
                  <strong>{item.name}</strong>
                  <small>{item.tagline}</small>
                </span>
                <span
                  className="lab-variant__swatch"
                  style={{ background: item.swatch }}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          <div className="lab-rail__note">
            <span className="lab-kicker">Method</span>
            <p>
              Ice, liquid chrome, glass aurora and crystal waves. Bright only.
              The lab is isolated from the POS shell.
            </p>
            <div className="lab-legend">
              <span>
                <i className="lab-legend__cyan" /> Cyan / turquoise
              </span>
              <span>
                <i className="lab-legend__ice" /> Ice / chrome
              </span>
              <span>
                <i className="lab-legend__shadow" /> Soft blue shadow
              </span>
            </div>
          </div>
        </aside>

        <section className="lab-canvas-column" aria-label="Background laboratory">
          {view === 'stage' ? (
            <section
              className="lab-stage"
              aria-label={`${active.name} background preview`}
            >
              <div className="lab-stage__bg">
                <BackgroundPoster study={active.id} className="lab-stage__fallback" />
                <ActiveEffect
                  study={active.id}
                  intensity={intensity}
                  paused={motionPaused}
                />
              </div>
              <div className="lab-stage__vignette" aria-hidden="true" />
              <div className="lab-stage__grain" aria-hidden="true" />
              {readabilityVeil && <div className="lab-stage__veil" aria-hidden="true" />}

              <div className="lab-stage__hud">
                <div className="lab-stage__identity">
                  <span className="lab-stage__index">{active.index}</span>
                  <span>{active.name}</span>
                </div>
                <div className="lab-stage__hud-right">
                  <span className={`lab-live${motionPaused ? ' is-paused' : ''}`}>
                    <i />
                    {reducedMotion
                      ? 'Reduced motion'
                      : paused
                        ? 'Frozen'
                        : pageVisible
                          ? 'Live'
                          : 'Hidden'}
                  </span>
                  {focus && (
                    <button
                      type="button"
                      className="lab-focus-exit"
                      onClick={() => setFocus(false)}
                    >
                      Exit <kbd>Esc</kbd>
                    </button>
                  )}
                </div>
              </div>

              {glass && <GlassPanel alpha={alpha} blur={blur} />}

              <div className="lab-stage__caption">
                <span>
                  {!gpuStudy
                    ? 'CSS composition · no canvas'
                    : webgl2
                      ? 'Move / click to disturb'
                      : 'CSS fallback · WebGL 2 unavailable'}
                </span>
                <span className="lab-stage__caption-right">
                  Glass {glass ? `${100 - transparency}% fill` : 'off'} · blur {blur}px
                </span>
              </div>
            </section>
          ) : (
            <section className="lab-compare" aria-label="Compare background directions">
              <div className="lab-compare__intro">
                <div>
                  <span className="lab-kicker">Compare mode</span>
                  <h2>Four material directions</h2>
                </div>
                <p>
                  Static posters keep the lab to one GPU context. Open a study to
                  inspect the live effect and test the glass.
                </p>
              </div>

              <div className="lab-compare__grid">
                {STUDIES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`lab-compare-card${item.id === active.id ? ' is-active' : ''}`}
                    aria-label={`Open ${item.name}`}
                    onClick={() => openStudy(item.id)}
                  >
                    <div className="lab-compare-card__preview">
                      <BackgroundPoster study={item.id} />
                      <span className="lab-compare-card__index">{item.index}</span>
                    </div>
                    <div className="lab-compare-card__copy">
                      <div className="lab-compare-card__top">
                        <h3>{item.name}</h3>
                        <span>{item.id === 'ice' || item.id === 'chrome' ? 'GPU' : 'CSS'}</span>
                      </div>
                      <p>{item.description}</p>
                      <span className="lab-compare-card__open">
                        Open stage
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 8h9M8.5 3.8 12.7 8l-4.2 4.2" />
                        </svg>
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </section>

        <aside className="lab-controls" aria-label="Stage controls">
          {view === 'stage' ? (
            <>
              <div className="lab-controls__head">
                <div>
                  <span className="lab-kicker">Stage controls</span>
                  <h2>Glass simulation</h2>
                </div>
                <button type="button" className="lab-reset" onClick={resetStage}>
                  Reset
                </button>
              </div>

              <div className="lab-controls__group">
                <ToggleControl
                  label="Glass panel"
                  description="Show the sample sales surface."
                  checked={glass}
                  onChange={setGlass}
                />
                <RangeControl
                  label="Glass transparency"
                  value={transparency}
                  min={0}
                  max={100}
                  suffix="%"
                  hint="Higher transparency reveals more of the background."
                  onChange={setTransparency}
                />
                <RangeControl
                  label="Backdrop blur"
                  value={blur}
                  min={4}
                  max={36}
                  suffix="px"
                  hint="Blur is real backdrop-filter, not a baked image."
                  onChange={setBlur}
                />
                <RangeControl
                  label="Background intensity"
                  value={intensity}
                  min={0.45}
                  max={1.35}
                  step={0.05}
                  hint="Drives the active study and its light layers."
                  onChange={setIntensity}
                />
                <ToggleControl
                  label="Readability veil"
                  description="Frosts the background under the glass."
                  checked={readabilityVeil}
                  onChange={setReadabilityVeil}
                />
                <ToggleControl
                  label="Pause motion"
                  description="Freeze the active study for comparison."
                  checked={paused}
                  onChange={setPaused}
                />
              </div>

              <div className="lab-readout">
                <div>
                  <span>Renderer</span>
                  <strong>{renderer}</strong>
                </div>
                <div>
                  <span>Active contexts</span>
                  <strong>{contexts}</strong>
                </div>
                <div>
                  <span>Motion</span>
                  <strong>{motionPaused ? 'Paused' : 'Live'}</strong>
                </div>
                <div>
                  <span>Panel fill</span>
                  <strong>{Math.round(alpha * 100)}%</strong>
                </div>
              </div>

              <p className="lab-note">
                Only the active study mounts. Compare mode uses static posters, so
                the lab never runs multiple shaders at once.
              </p>
            </>
          ) : (
            <div className="lab-compare-notes">
              <span className="lab-kicker">Reading the studies</span>
              <h2>Four ways to read light.</h2>
              <p>
                A is liquid ice. B is polished silver in a white studio. C is
                luminous atmosphere. D is structured glass. Judge them with the
                glass on: the background must support a quiet, legible till
                surface.
              </p>

              <div className="lab-compare-notes__list">
                {STUDIES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="lab-compare-note-row"
                    onClick={() => openStudy(item.id)}
                  >
                    <span
                      className="lab-compare-note-row__swatch"
                      style={{ background: item.swatch }}
                      aria-hidden="true"
                    />
                    <span>
                      <strong>
                        {item.index} / {item.name}
                      </strong>
                      <small>{item.tagline}</small>
                    </span>
                  </button>
                ))}
              </div>

              <p className="lab-note">
                Compare is deliberately static. Open a study to see the live effect,
                adjust the glass, and test the readability veil.
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

export default BackgroundLab
