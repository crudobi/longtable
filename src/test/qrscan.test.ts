/**
 * QR scanning capability decision (M-J). The camera session itself
 * needs a real device/WebView; what is pinned here is the pure
 * canScan() logic the UI branches on — when scanning can't work, each
 * join flow must say why in plain words and point at the paste box.
 */
import { describe, expect, it } from 'vitest'
import { scanCapability, type ScanEnvironment } from '../qrscan'

const full: ScanEnvironment = {
  barcodeDetector: class {},
  getUserMedia: () => Promise.resolve(),
  isSecureContext: true,
}

describe('scanCapability', () => {
  it('is ok when detector, camera, and secure context are all present', () => {
    expect(scanCapability(full)).toEqual({ ok: true })
  })

  it('is not ok without a BarcodeDetector', () => {
    const cap = scanCapability({ ...full, barcodeDetector: undefined })
    expect(cap.ok).toBe(false)
    expect(cap.reason).toMatch(/QR codes/)
  })

  it('is not ok without getUserMedia', () => {
    const cap = scanCapability({ ...full, getUserMedia: undefined })
    expect(cap.ok).toBe(false)
    expect(cap.reason).toMatch(/camera/i)
  })

  it('is not ok outside a secure context', () => {
    const cap = scanCapability({ ...full, isSecureContext: false })
    expect(cap.ok).toBe(false)
    expect(cap.reason).toMatch(/secure/)
  })

  it('reports the detector first when several things are missing', () => {
    const cap = scanCapability({
      barcodeDetector: undefined,
      getUserMedia: undefined,
      isSecureContext: false,
    })
    expect(cap.ok).toBe(false)
    expect(cap.reason).toMatch(/QR codes/)
  })
})
