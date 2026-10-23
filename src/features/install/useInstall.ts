import { useEffect, useState } from 'react'
import { canPromptInstall, isStandalone, onInstallAvailability } from './install'

/** Live install state for React components. */
export function useInstall() {
  const [installed, setInstalled] = useState(isStandalone)
  const [canInstall, setCanInstall] = useState(canPromptInstall)

  useEffect(() => {
    const sync = () => {
      setCanInstall(canPromptInstall())
      setInstalled(isStandalone())
    }
    sync()
    return onInstallAvailability(sync)
  }, [])

  return { installed, canInstall }
}
