import { useState } from 'react'

interface Props {
  onSubmit: (code: string) => void
  /** Hidden while the camera is live, so it does not tempt you away from scanning. */
  disabled: boolean
  /** Unique id when the page might host more than one entry form. */
  id?: string
}

/**
 * Typed barcode fallback, shared by the sell screen and the catalog scan sheet.
 *
 * Two uses: a hardware scanner gun behaves as a keyboard and lands here, and it
 * makes the whole flow testable on a desktop with no camera and no printed
 * labels.
 */
export function ManualEntry({ onSubmit, disabled, id = 'manual-barcode' }: Props) {
  const [code, setCode] = useState('')

  if (disabled) return null

  return (
    <form
      className="px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        const value = code.trim()
        if (!value) return
        onSubmit(value)
        setCode('')
      }}
    >
      <label className="label" htmlFor={id}>
        Enter barcode
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className="field font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Type a code and press Enter"
          autoComplete="off"
        />
        <button type="submit" className="btn-ghost shrink-0" disabled={!code.trim()}>
          Add
        </button>
      </div>
    </form>
  )
}