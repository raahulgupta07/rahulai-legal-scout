/**
 * Response helpers shared by every admin screen.
 *
 * The Legal Scout API reports validation failures as HTTP 200 with a
 * `{success: false, error}` body. Checking `res.ok` alone therefore turns a
 * rejected write into a success toast. Every write path must run the response
 * through `assertSuccess` before it celebrates.
 *
 * These were proven on /admin/people first; they live here so the other
 * screens consume the same implementation rather than re-deriving it.
 */

/**
 * Throws when the body says `success: false`, even though the status was 2xx.
 *
 * Reads a *clone* so the caller can still consume `res.json()` afterwards —
 * a Response body may only be read once.
 */
export async function assertSuccess(res: Response, fallback: string): Promise<void> {
  let body: unknown = null
  try {
    body = await res.clone().json()
  } catch {
    // No JSON body (204, a file download, HTML error page) — nothing to assert.
    return
  }
  if (body && typeof body === 'object' && (body as { success?: unknown }).success === false) {
    const b = body as Record<string, unknown>
    const msg = b.error || b.detail || b.message
    throw new Error(typeof msg === 'string' && msg ? msg : fallback)
  }
}

/** Pulls a human-readable message out of a failed response. */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  let detail = ''
  try {
    const body = await res.clone().json()
    detail = body?.detail || body?.error || body?.message || ''
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
  } catch {
    // Response had no JSON body — fall through to the status-based message.
  }
  if (res.status === 409) {
    return detail || 'That record already exists. Open the existing one instead of creating a duplicate.'
  }
  if (res.status === 401 || res.status === 403) {
    return detail || 'Your session has expired. Sign in again.'
  }
  return detail || `${fallback} (HTTP ${res.status})`
}

/**
 * Both guards in one call, for the common `fetch` → `use the JSON` path.
 * Throws on transport failure *and* on the 200-with-`success:false` case.
 */
export async function ensureOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback))
  await assertSuccess(res, fallback)
}

/** Endpoints return several envelope shapes; accept the common ones. */
export function unwrapList<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[]
  const b = body as Record<string, unknown> | null
  if (!b) return []
  for (const key of keys) {
    if (Array.isArray(b[key])) return b[key] as T[]
  }
  if (Array.isArray(b.data)) return b.data as T[]
  return []
}

export function unwrapOne<T>(body: unknown, ...keys: string[]): T | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  for (const key of keys) {
    if (b[key] && typeof b[key] === 'object') return b[key] as T
  }
  if (b.data && typeof b.data === 'object') return b.data as T
  if (b.id !== undefined) return b as T
  return null
}
