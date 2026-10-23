/**
 * Scan feedback.
 *
 * `navigator.vibrate` is Android-only; iOS Safari ignores it entirely. The
 * audio beep is the reliable path on iPhone, so it plays on both and the
 * vibration is best-effort on top.
 */

let audioCtx: AudioContext | null = null

function beep(freq: number, durationMs: number): void {
  try {
    audioCtx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    // Browsers start contexts suspended until a user gesture; scanning counts.
    if (audioCtx.state === 'suspended') void audioCtx.resume()

    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'square'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + durationMs / 1000)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start()
    osc.stop(audioCtx.currentTime + durationMs / 1000)
  } catch {
    // No audio context available; the visual flash still confirms the scan.
  }
}

/** Successful read. */
export function feedbackSuccess(): void {
  beep(1400, 70)
  navigator.vibrate?.(45)
}

/** Unknown barcode, or a read error. */
export function feedbackError(): void {
  beep(320, 180)
  navigator.vibrate?.([25, 60, 25])
}

/** Primes the audio context on the first tap, before any scan happens. */
export function primeAudio(): void {
  try {
    audioCtx ??= new AudioContext()
    void audioCtx.resume()
  } catch {
    // Ignore.
  }
}