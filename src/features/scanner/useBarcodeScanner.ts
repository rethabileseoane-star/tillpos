import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeFrame, hasNativeDetector } from './detector'
import { RETAIL_FORMATS } from '@/domain/barcode'

export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'denied'
  | 'insecure'
  | 'unavailable'
  | 'error'

export interface UseScannerOptions {
  /** Fired once per accepted read. The hook debounces repeats itself. */
  onDetected: (code: string) => void
  /**
   * A barcode held in front of the lens fires continuously. Without this guard
   * a single physical item would add ten copies to the cart.
   */
  debounceMs?: number
}

export interface ScannerState {
  status: ScannerStatus
  error: string | null
  torchOn: boolean
  torchAvailable: boolean
  isSecure: boolean
  isInstalled: boolean
  nativeApi: boolean
  /**
   * `RefObject<HTMLVideoElement | null>` is the React 19 type. React 18 wants the
   * narrower form, and the cast here keeps the hook usable on both.
   */
  videoRef: React.RefObject<HTMLVideoElement | null> & {
    current: HTMLVideoElement | null
  }
  start: () => Promise<void>
  stop: () => void
  toggleTorch: () => void
}

function isSecureContextOk(): boolean {
  return (
    window.isSecureContext ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1'
  )
}

function isInstalled(): boolean {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  return standalone
}

export function useBarcodeScanner(options: UseScannerOptions): ScannerState {
  const { onDetected, debounceMs = 1500 } = options
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  /**
   * Bumped on every start/stop. An in-flight `decodeFrame` that resolves after
   * stop() must not schedule another frame, or the loop resurrects itself and a
   * later start() runs a second decoder alongside the first.
   */
  const runIdRef = useRef(0)
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  const [status, setStatus] = useState<ScannerStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchAvailable, setTorchAvailable] = useState(false)

  const stop = useCallback(() => {
    runIdRef.current++
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStatus('idle')
    setTorchOn(false)
    setTorchAvailable(false)
  }, [])

  const start = useCallback(async () => {
    if (!isSecureContextOk()) {
      setStatus('insecure')
      setError(
        'Camera needs HTTPS. Open the app over https:// or use localhost.',
      )
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable')
      setError(
        'This browser will not expose the camera until the app is installed. ' +
          'Use "Add to Home screen" and launch from the icon.',
      )
      return
    }
    // Already live (e.g. a double tap on "Start scanner") — one stream only.
    if (streamRef.current) return

    setStatus('starting')
    setError(null)

    // Token for this attempt. stop() bumps runIdRef, so a permission prompt
    // that resolves after the user gave up releases its stream instead of
    // turning the camera back on behind them.
    const startId = ++runIdRef.current

    try {
      // Rear camera is the only one pointed at the barcode.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      })
      if (startId !== runIdRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream

      const video = videoRef.current
      if (!video) {
        stop()
        return
      }
      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      video.muted = true
      await video.play()

      // stop() may have fired while the first frame was loading.
      if (startId !== runIdRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        return
      }

      const track = stream.getVideoTracks()[0]

      // Torch support is reported inconsistently. Chrome/Edge declare a
      // `torch` capability in getCapabilities(), but iOS Safari and some
      // Android builds still honour the torch constraint without ever listing
      // it — so gating purely on `caps.torch` hides an otherwise working
      // flashlight on those phones. Instead: offer the button whenever the
      // track can take a constraint at all, and let toggleTorch() hide it
      // after a real attempt fails (see the .catch below).
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
        torch?: boolean
      }
      setTorchAvailable(Boolean(caps.torch) || typeof track.applyConstraints === 'function')
      setStatus('scanning')

      let canvas: HTMLCanvasElement | null = null
      const runId = ++runIdRef.current
      const loop = async () => {
        if (runId !== runIdRef.current) return
        if (!streamRef.current || video.readyState < 2) {
          rafRef.current = requestAnimationFrame(() => void loop())
          return
        }
        canvas ??= document.createElement('canvas')
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 480
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const hit = await decodeFrame(canvas, RETAIL_FORMATS)
          if (runId !== runIdRef.current) return
          if (hit?.code) {
            const now = Date.now()
            const last = lastCodeRef.current
            const isRepeat =
              last?.code === hit.code && now - last.at < debounceMs
            if (!isRepeat) {
              lastCodeRef.current = { code: hit.code, at: now }
              onDetectedRef.current(hit.code)
            }
          }
        }
        rafRef.current = requestAnimationFrame(() => void loop())
      }
      rafRef.current = requestAnimationFrame(() => void loop())
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied')
        setError('Camera permission was refused. Enable it in your browser settings.')
      } else if (name === 'NotFoundError') {
        setStatus('unavailable')
        setError('No camera found on this device.')
      } else {
        setStatus('error')
        setError(err instanceof Error ? err.message : 'Could not start the camera.')
      }
    }
  }, [debounceMs, stop])

  const toggleTorch = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    void track
      .applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      .then(() => setTorchOn(next))
      .catch(() => setTorchAvailable(false))
  }, [torchOn])

  useEffect(() => stop, [stop])

  return {
    status,
    error,
    torchOn,
    torchAvailable,
    isSecure: isSecureContextOk(),
    isInstalled: isInstalled(),
    nativeApi: hasNativeDetector(),
    videoRef,
    start,
    stop,
    toggleTorch,
  }
}