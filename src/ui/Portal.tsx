import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/**
 * Render a modal at the top of the document.
 *
 * The screens keep their content inside a `relative z-10` wrapper so the
 * background image sits behind it. That wrapper is a stacking context, so a
 * sheet's `z-50` is only compared against its siblings inside the screen — the
 * app's `z-40` tab bar and `z-50` header still paint over it. On a phone the tab
 * bar covered the bottom of every sheet, hiding the Save / Complete button.
 *
 * Portalling to `document.body` takes the sheet out of that stacking context,
 * so its z-index is global and it always sits above the header and tab bar.
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
