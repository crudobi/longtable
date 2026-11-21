/**
 * Photo importer: attach local photos to a recipe.
 *
 * No network involved — files are read locally and stored as data URLs in
 * the recipe's Automerge document. Large images are downscaled to a maximum
 * dimension of 1280px (JPEG, quality 0.85) so IndexedDB stays reasonable.
 *
 * MAX_PHOTO_BYTES (M2(int)): no photo larger than 5 MiB is stored or
 * uploaded anywhere — the URL importer (urlImport.ts) drops remote photos
 * over the cap instead of fetching them, and publish (publish.ts)
 * refuses to upload an over-cap photo. The cap is on the BYTES, not the
 * data-URL string: a 5 MiB image is ~6.8 MB as base64, and IndexedDB +
 * the PDS blob endpoint both have to hold it.
 */
import { u8ToBase64 } from '../identity/codec'

const MAX_DIMENSION = 1280

/** Largest photo, in raw bytes, the app will store or upload. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export async function filesToDataUrls(files: Iterable<File>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    out.push(await blobToDataUrl(file))
  }
  return out
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
