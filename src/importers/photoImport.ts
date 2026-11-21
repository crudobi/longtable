/**
 * Photo importer: attach local photos to a recipe.
 *
 * No network involved — files are read locally and stored as data URLs in
 * the recipe document. Large images are downscaled to a maximum
 * dimension of 1280px (JPEG, quality 0.85) so IndexedDB stays reasonable.
 *
 * MAX_PHOTO_BYTES (M2(int)): no photo larger than 5 MiB is stored or
 * uploaded anywhere — the URL importer (urlImport.ts) drops remote photos
 * over the cap instead of fetching them, and publish (publish.ts)
 * refuses to upload an over-cap photo. The cap is on the BYTES, not the
 * data-URL string: a 5 MiB image is ~6.8 MB as base64, and IndexedDB +
 * the PDS blob endpoint both have to hold it.
 *
 * Failure is fail-visible (M18): a file that cannot be decoded is
 * reported in `failed` (by file name) instead of being kept at full
 * size as if the downscale had worked, and `attachPhotos` callers show
 * that list. `filesToDataUrls` keeps the old fail-the-batch contract
 * for any caller that wants it; `filesToDataUrlsDetailed` is the
 * partial-success form the form uses.
 *
 * Cap enforcement (Sec L13): the byte cap is checked on the RESULT
 * here, not the input file — a large photo that downscales under the
 * cap is kept, but a photo still over MAX_PHOTO_BYTES after
 * downscaling (small dimensions with huge bytes, an undecodable file
 * kept whole on a platform without canvas, or the no-DOM fallback)
 * is reported in `tooLarge` and never stored. Before this, the cap
 * was only checked at publish time, so an oversized photo could sit
 * in IndexedDB (and in the 16 MiB API body) until publish refused it.
 * Publish still re-checks (defense in depth); the 5 MiB cap itself is
 * the single limit shared with the importer contract and publish.
 */
import { u8ToBase64 } from '../identity/codec'

const MAX_DIMENSION = 1280

/** Largest photo, in raw bytes, the app will store or upload. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

/** Result of attaching a batch of photos: the good ones, and the names
 *  of the files that could not be read as images. */
export interface PhotoAttachResult {
  urls: string[]
  failed: string[]
  /** Names of files still over MAX_PHOTO_BYTES after downscaling. */
  tooLarge: string[]
}

/**
 * Decoded byte size of a `data:<mime>;base64,...` URL (the cap is on
 * BYTES, not the base64 string, which is ~4/3 larger). Exported for
 * unit tests. A non-data URL is measured by its string length.
 */
export function dataUrlByteSize(url: string): number {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma < 0) return url.length
  const b64 = url.slice(comma + 1).replace(/\s/g, '')
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/**
 * Output encoding for a downscaled photo: PNG stays PNG so transparency
 * survives (M18 — a transparent PNG downscaled to JPEG used to come
 * out with a black background); anything else becomes JPEG.
 */
export function downscaleOutputMime(fileType: string): 'image/png' | 'image/jpeg' {
  return fileType === 'image/png' ? 'image/png' : 'image/jpeg'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime || 'image/jpeg'};base64,${u8ToBase64(bytes)}`
}

/**
 * Downscale one image blob to a data URL (max 1280px, JPEG 0.85), the
 * same path local file attaches use. In a runtime without DOM image APIs
 * (node tests, or a WebView without canvas) the original bytes are
 * returned as a data URL instead — downscaling is an optimization, and
 * its absence must never lose the photo. An unparseable image keeps its
 * original bytes for the same reason (pre-existing behavior, M18-int
 * documents the lossy side of it; the byte cap above still applies at
 * the call sites that fetch from untrusted sources).
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const mime = blob.type || 'image/jpeg'
  if (
    typeof FileReader === 'undefined' ||
    typeof Image === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return bytesToDataUrl(bytes, mime)
  }
  const original = bytesToDataUrl(bytes, mime)
  return imageDataUrlToDataUrl(original)
}

function imageDataUrlToDataUrl(original: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onerror = () => resolve(original) // unparseable image: keep the original bytes
    img.onload = () => {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height))
      if (scale >= 1 || img.width === 0) {
        resolve(original)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(original)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch {
        // A tainted canvas (cross-origin image without CORS) cannot be
        // read back — keep the original bytes rather than failing the
        // import. The byte cap at the call site still bounds the size.
        resolve(original)
      }
    }
    img.src = original
  })
}

/** Draw a decoded image (or bitmap) down to MAX_DIMENSION, or return
 *  the original data URL when no downscale is needed — or when the
 *  platform cannot provide a canvas context at all. */
function downscaleToDataUrl(
  source: CanvasImageSource & { width: number; height: number },
  fileType: string,
  original: string,
): string {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(source.width, source.height))
  if (scale >= 1 || source.width === 0) return original
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return original
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL(downscaleOutputMime(fileType), 0.85)
}

/** Decode via an <img> element. Rejects when the bytes are not a
 *  decodable image — the caller reports the file instead of keeping
 *  the undecodable original as a "photo". */
function loadViaImageElement(original: string, fileType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () =>
      reject(new Error('could not be decoded as an image — the file may be damaged or in an unsupported format'))
    img.onload = () => {
      try {
        resolve(downscaleToDataUrl(img, fileType, original))
      } catch (e) {
        reject(e instanceof Error ? e : new Error('could not be downscaled'))
      }
    }
    img.src = original
  })
}

async function imageFileToDataUrl(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file)
  // EXIF-aware decode when the platform offers it: createImageBitmap
  // with imageOrientation 'from-image' applies the photo's orientation
  // tag, so a portrait phone photo no longer lands sideways (M18).
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      try {
        return downscaleToDataUrl(bitmap, file.type, original)
      } finally {
        bitmap.close()
      }
    } catch {
      // A bitmap decode failure is not conclusive (older WebViews reject
      // the options object) — fall through to the <img> path, which
      // rejects for real when the bytes are undecodable.
    }
  }
  return loadViaImageElement(original, file.type)
}

export async function filesToDataUrlsDetailed(
  files: Iterable<File>,
): Promise<PhotoAttachResult> {
  const urls: string[] = []
  const failed: string[] = []
  const tooLarge: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    try {
      const url = await imageFileToDataUrl(file)
      // Sec L13: the downscale may not have shrunk the photo (see the
      // module header) — refuse the result, not just the input.
      if (dataUrlByteSize(url) > MAX_PHOTO_BYTES) {
        tooLarge.push(file.name || 'an unnamed image')
      } else {
        urls.push(url)
      }
    } catch {
      failed.push(file.name || 'an unnamed image')
    }
  }
  return { urls, failed, tooLarge }
}

export async function filesToDataUrls(files: Iterable<File>): Promise<string[]> {
  const { urls, failed, tooLarge } = await filesToDataUrlsDetailed(files)
  if (failed.length > 0) {
    throw new Error(
      `Could not read ${failed.length === 1 ? 'this photo' : 'these photos'} as images: ${failed.join(', ')}.`,
    )
  }
  if (tooLarge.length > 0) {
    throw new Error(
      `${tooLarge.length === 1 ? 'This photo is' : 'These photos are'} still over the 5 MB photo limit after downscaling: ${tooLarge.join(', ')}.`
    )
  }
  return urls
}
