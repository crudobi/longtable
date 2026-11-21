// @vitest-environment jsdom
/**
 * Photo importer tests (integrity M18):
 * - an undecodable file is reported as failed, never kept at full size;
 * - non-image files are skipped;
 * - a mixed batch attaches the good files and names the bad ones;
 * - PNG output stays PNG (transparency survives the downscale).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downscaleOutputMime,
  filesToDataUrls,
  filesToDataUrlsDetailed,
} from '../importers/photoImport'

/**
 * Fake <img>: decodes a data URL whose bytes contain GOODIMAGE as a
 * 100x50 image (small enough that no downscale runs); anything else
 * fires onerror, like a real undecodable file.
 */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 0
  height = 0
  private _src = ''
  set src(v: string) {
    this._src = v
    queueMicrotask(() => {
      try {
        const decoded = atob(v.split(',')[1] ?? '')
        if (decoded.includes('GOODIMAGE')) {
          this.width = 100
          this.height = 50
          this.onload?.()
          return
        }
      } catch {
        // Not decodable base64 — fall through to onerror.
      }
      this.onerror?.()
    })
  }
  get src(): string {
    return this._src
  }
}

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage)
  // Force the <img> path: the EXIF-aware createImageBitmap path is a
  // real-browser behavior, not a jsdom one.
  vi.stubGlobal('createImageBitmap', undefined as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const goodFile = (name = 'good.jpg') =>
  new File(['GOODIMAGE-bytes'], name, { type: 'image/jpeg' })
const badFile = (name = 'bad.jpg') =>
  new File(['NOTANIMAGE'], name, { type: 'image/jpeg' })

describe('filesToDataUrlsDetailed (M18)', () => {
  it('attaches a decodable image as a data URL', async () => {
    const { urls, failed } = await filesToDataUrlsDetailed([goodFile()])
    expect(urls).toHaveLength(1)
    expect(urls[0].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(failed).toEqual([])
  })

  it('reports an undecodable image as failed instead of keeping it', async () => {
    const { urls, failed } = await filesToDataUrlsDetailed([badFile()])
    expect(urls).toEqual([])
    expect(failed).toEqual(['bad.jpg'])
  })

  it('attaches the good files in a mixed batch and names the bad ones', async () => {
    const { urls, failed } = await filesToDataUrlsDetailed([
      goodFile('a.jpg'),
      badFile('b.jpg'),
      goodFile('c.jpg'),
    ])
    expect(urls).toHaveLength(2)
    expect(failed).toEqual(['b.jpg'])
  })

  it('skips non-image files silently', async () => {
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const { urls, failed } = await filesToDataUrlsDetailed([text, goodFile()])
    expect(urls).toHaveLength(1)
    expect(failed).toEqual([])
  })
})

describe('filesToDataUrls (fail-the-batch contract)', () => {
  it('throws naming the unreadable file', async () => {
    await expect(filesToDataUrls([badFile('nope.jpg')])).rejects.toThrow(/nope\.jpg/)
  })
})

describe('downscaleOutputMime (M18)', () => {
  it('keeps PNG as PNG and uses JPEG for everything else', () => {
    expect(downscaleOutputMime('image/png')).toBe('image/png')
    expect(downscaleOutputMime('image/jpeg')).toBe('image/jpeg')
    expect(downscaleOutputMime('image/webp')).toBe('image/jpeg')
  })
})
