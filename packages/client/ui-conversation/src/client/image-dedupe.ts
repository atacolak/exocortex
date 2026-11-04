/**
 * Pasted-image reuse: the composer names staged images by ordinal in
 * `[Image #N]`, so pasting the exact bytes that are already staged must name
 * the existing image instead of uploading and appending a second copy.
 * Identity is the encoded file content (SHA-256), never the file name or
 * type. Browsers without WebCrypto fall back to no dedupe rather than
 * guessing by metadata.
 */

const digests = new WeakMap<File, Promise<string | null>>()

/** The SHA-256 hex digest of one file's bytes, or null without WebCrypto. */
function digest(file: File): Promise<string | null> {
  const cached = digests.get(file)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<string | null> => {
    if (typeof crypto === 'undefined' || crypto.subtle === undefined) return null
    try {
      const bytes = await file.arrayBuffer()
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      return null
    }
  })()
  digests.set(file, pending)
  return pending
}

/** The files to upload and one ordinal per pasted image, duplicates resolved. */
export interface ImageIntakePlan {
  /** Images whose bytes are not staged yet, in paste order. */
  readonly fresh: readonly File[]
  /** Marker ordinal per pasted image: a fresh image's new number or a staged one's existing number. */
  readonly ordinals: readonly number[]
}

/**
 * Resolve a pasted image batch against the images already staged in the draft.
 * @param images - pasted images in clipboard order.
 * @param staged - the draft's staged image files in marker order.
 * @returns the fresh files to upload and the marker ordinal for every paste.
 */
export async function planImageIntake(images: readonly File[], staged: readonly File[]): Promise<ImageIntakePlan> {
  const known = new Map<string, number>()
  const stagedHashes = await Promise.all(staged.map(file => digest(file)))
  stagedHashes.forEach((hash, index) => {
    if (hash !== null && !known.has(hash)) known.set(hash, index + 1)
  })
  const fresh: File[] = []
  const ordinals: number[] = []
  let next = staged.length
  for (const file of images) {
    const hash = await digest(file)
    const match = hash === null ? undefined : known.get(hash)
    if (match !== undefined) {
      ordinals.push(match)
      continue
    }
    next += 1
    fresh.push(file)
    ordinals.push(next)
    if (hash !== null) known.set(hash, next)
  }
  return { fresh, ordinals }
}
