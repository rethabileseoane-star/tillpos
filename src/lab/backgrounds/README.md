# Background Visual Laboratory

A dev-only design surface for comparing four **light** background directions for
TILL, using full-bleed approved reference images as the visual source of truth.
It is deliberately isolated from the POS shell: no business logic, routes,
storage, or production code depends on it.

## Open it

```bash
npm run dev
```

Then visit:

```
http://localhost:5173/#/lab/backgrounds
```

The route is registered only when `import.meta.env.DEV` is true. Production
builds tree-shake the lab chunk and never ship the lab or its images.

## The four studies

Each study displays a full-bleed approved reference image behind the simulated
glass sales panel. The images are the visual source of truth, taken from
`reference images for background/` and copied into
`src/lab/backgrounds/assets/`.

| # | Study | Source image | Direction |
|---|-------|--------------|-----------|
| A | Ice Flow | `a-ice-flow.jpg` | Bright icy-white pools with flowing pale cyan glass ribbons |
| B | Liquid Chrome | `b-liquid-chrome.jpg` | Rich liquid chrome ribbon with cyan-blue reflections |
| C | Glass Aurora | `c-glass-aurora.jpg` | Iridescent glass tubes with pale ice-blue light |
| D | Crystal Waves | `d-crystal-waves.jpg` | Light blue crystal liquid with rounded droplets and glossy reflections |

The visual source of truth is the light chrome/ice TILL logo direction: bright
icy-white environment, reflective silver with vivid blue/cyan reflections, soft
blue shadows and a dark navy wordmark.

## Controls

All controls are live and apply to the active study:

- **Glass panel** — mounts or removes the simulated sales surface.
- **Glass transparency** — 0–100%, changes the real panel fill. A conditional
  white frost protects legibility at the transparent end.
- **Backdrop blur** — 4–36px, changes the real `backdrop-filter`.
- **Background intensity** — 0.45–1.35, drives a subtle overlay on the
  background image.
- **Readability veil** — frosts the background under the glass.
- **Pause motion** — freezes ambient overlays for A/B comparison.
- **Full screen** — hides the lab chrome and previews the active study at full
  size (`Esc` exits).

`Compare` shows four static posters instead of four live backgrounds, so the
lab never mounts more than one study at a time.

## Performance model

- Only the active study mounts; the others are unmounted.
- The lab is loaded via a dynamic import gated by `import.meta.env.DEV`, so
  production builds never ship the lab chunk, its CSS, or its images.
- Image backgrounds use no canvas and no JavaScript frame loop.
- Ambient overlays stop when the study is paused, the document is hidden, or
  `prefers-reduced-motion: reduce` is active.

## Verification

`design/background-lab/verify/` contains the current light-direction screenshots:

- all four stages at 1580×900
- full-screen preview
- glass at maximum transparency + blur
- readability veil, pause, glass off
- Compare mode
- 390×844 mobile stages for all four studies
- reduced-motion state
- production POS home and lab route

Automated checks (headless Edge 158) confirmed zero canvases per stage, zero
console/page errors, no horizontal overflow at 390px, working controls, and no
lab code or images in `dist/`. A pixel audit of the saved frames confirmed mean
luminance of 210–236/255 and dark-pixel ratios at or below 1.6%, consistent
with the light-only brief.

Earlier dark-direction captures are kept in
`design/background-lab/archive-dark-direction/` for history only and are not
the active reference.
