// @vitest-environment jsdom
/**
 * startQrScan session behaviour (Rel L3): progress + idle hint on every
 * tick, decode fires exactly once and stops the camera, and the hard
 * timeout fires exactly once with the camera already stopped.
 *
 * The detector and the camera are both stubbed; the real-camera decode
 * on the emulator is a separate proof (see the Wave 5A report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startQrScan } from '../qrscan'

let trackStop: ReturnType<typeof vi.fn>
let detectMock: ReturnType<typeof vi.fn>
let getUserMediaMock: ReturnType<typeof vi.fn>
let video: HTMLVideoElement

beforeEach(() => {
  vi.useFakeTimers()
  trackStop = vi.fn()
  detectMock = vi.fn(async () => [] as Array<{ rawValue: string }>)
  getUserMediaMock = vi.fn(async () => ({
    getTracks: () => [{ stop: trackStop }],
  }))
  class FakeDetector {
    detect = detectMock
  }
  ;(window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: getUserMediaMock },
    configurable: true,
  })
  video = document.createElement('video')
  video.play = async () => {}
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector
})

describe('startQrScan session (Rel L3)', () => {
  it('decodes a code exactly once, then stops the camera', async () => {
    detectMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ rawValue: 'HELLO' }])
    const onCode = vi.fn()
    const session = await startQrScan(video, onCode)
    expect(typeof session.stop).toBe('function')
    // First tick ran empty; the 250 ms tick finds the code.
    await vi.advanceTimersByTimeAsync(250)
    expect(onCode).toHaveBeenCalledTimes(1)
    expect(onCode).toHaveBeenCalledWith('HELLO')
    expect(trackStop).toHaveBeenCalledTimes(1)
    // The session is over: further ticks do nothing, and a second stop
    // is a no-op rather than a second track stop.
    session.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onCode).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('reports progress and the idle hint, then times out exactly once with the camera already stopped', async () => {
    const order: string[] = []
    trackStop.mockImplementation(() => {
      order.push('track-stop')
    })
    const onProgress = vi.fn()
    const onTimeout = vi.fn(() => {
      order.push('timeout')
    })
    await startQrScan(video, vi.fn(), {
      idleHintMs: 100,
      timeoutMs: 600,
      onProgress,
      onTimeout,
    })
    await vi.advanceTimersByTimeAsync(1000)
    // First tick: elapsed 0, not idle yet. Later ticks: idle.
    expect(onProgress).toHaveBeenCalledWith(0, false)
    expect(onProgress.mock.calls.some(([, idle]) => idle === true)).toBe(true)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
    // The session is already stopped when onTimeout runs.
    expect(order).toEqual(['track-stop', 'timeout'])
    // No second timeout after more time passes.
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('stop() ends the session without a timeout', async () => {
    const onProgress = vi.fn()
    const onTimeout = vi.fn()
    const session = await startQrScan(video, vi.fn(), {
      idleHintMs: 100,
      timeoutMs: 600,
      onProgress,
      onTimeout,
    })
    // The first tick already reported (elapsed 0, not idle).
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(0, false)
    session.stop()
    expect(trackStop).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('rejects when the camera cannot be opened', async () => {
    getUserMediaMock.mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    )
    await expect(startQrScan(video, vi.fn())).rejects.toThrow(/Permission denied/)
    expect(trackStop).not.toHaveBeenCalled()
  })
})
