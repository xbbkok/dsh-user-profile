/**
 * dsh-user-profile — host half.
 *
 * A small local "display profile" for the person using this DSH install: a
 * name and an avatar that the browser half renders in the sidebar account
 * chip and edits from Settings → Profile.
 *
 * Why this exists: the sidebar account chip is fed by the DeepSeek Platform
 * account (read-only), and when no account is connected it degrades to a
 * generic "More" button. This plugin adds the missing piece — an identity the
 * user owns and can change at any time.
 *
 * Storage: `<DSH_HOME>/plugins-data/dsh-user-profile/profile.json`
 *   { "version": 1, "name": "…", "avatar": "data:image/png;base64,…" | null, "updatedAt": "…" }
 *
 * HTTP (served by the DSH Web host, same origin as the GUI):
 *   GET  /user-profile   → { ok, profile, storagePath }
 *   POST /user-profile   → body { name?: string, avatar?: string | null }
 *                          → { ok: true, profile } | 400 { ok: false, error }
 *
 * The plugin never throws at load time: a missing web server, an unwritable
 * home directory or a malformed request must not take the plugin tree down.
 *
 * @module dsh-user-profile
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Plugin identity for cordis loader rows. */
export const name = 'dsh-user-profile'

/** No services are required up front; the HTTP routes attach when one exists. */
export const inject = []

/** Request body cap: a 192×192 PNG data URL is far below this. */
const MAX_BODY_BYTES = 1_000_000
/** Avatar data-URL cap (≈ 512 KiB of decoded bytes). */
const MAX_AVATAR_CHARS = 700_000
/** Display-name cap in Unicode code points. */
const MAX_NAME_POINTS = 32

const EMPTY_PROFILE = Object.freeze({ version: 1, name: '', avatar: null, updatedAt: null })

/** @returns {string} the DSH home directory this process belongs to. */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured ? configured : join(home, '.dsh')
}

/**
 * Trim a display name and reject the values the chip cannot render.
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function normalizeName(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' }
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  if ([...value].length > MAX_NAME_POINTS) {
    return { ok: false, error: `name must be at most ${MAX_NAME_POINTS} characters` }
  }
  return { ok: true, value }
}

/**
 * Accept a raster data URL for the avatar, or null to clear it.
 * SVG is deliberately rejected: it is script-bearing markup, not a picture.
 * @param {unknown} raw
 * @returns {{ ok: true, value: string | null } | { ok: false, error: string }}
 */
export function normalizeAvatar(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'avatar must be a data URL or null' }
  if (raw.length > MAX_AVATAR_CHARS) return { ok: false, error: 'avatar image is too large' }
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
    return { ok: false, error: 'avatar must be a PNG, JPEG or WebP data URL' }
  }
  return { ok: true, value: raw }
}

/**
 * Read the stored profile, falling back to the empty profile.
 * @param {string} file
 * @returns {{ version: number, name: string, avatar: string | null, updatedAt: string | null }}
 */
export function readProfile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const name = normalizeName(parsed?.name)
    const avatar = normalizeAvatar(parsed?.avatar)
    return {
      version: 1,
      name: name.ok ? name.value : '',
      avatar: avatar.ok ? avatar.value : null,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return { ...EMPTY_PROFILE }
  }
}

/**
 * Persist the profile atomically (tmp file + rename) so a crash cannot leave
 * a half-written JSON document behind.
 * @param {string} file
 * @param {{ name: string, avatar: string | null }} next
 */
export function writeProfile(file, next) {
  const document = {
    version: 1,
    name: next.name,
    avatar: next.avatar,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return document
}

/** @returns {Promise<string>} the raw request body, or a rejection on overflow. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * The origin this request addressed, rebuilt from its Host header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function requestOrigin(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host.length === 0) return null
  const forwarded = req.headers['x-forwarded-proto']
  const proto = forwarded === 'https' ? 'https' : 'http'
  return `${proto}://${host}`
}

/**
 * Attach the profile routes to a Web host.
 * @param {any} ctx - host plugin context.
 * @param {{ storageDir: string, logger: any }} options
 */
export function attachRoutes(ctx, options) {
  const { storageDir, logger } = options
  const file = join(storageDir, 'profile.json')

  const handler = async (req, res) => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, profile: readProfile(file), storagePath: file })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // The route lives outside the GUI's token fence, so reject a write a
      // different site asked for. Same-origin page writes carry their own
      // Origin; non-browser callers send none.
      const origin = req.headers?.origin
      const own = requestOrigin(req)
      if (typeof origin === 'string' && origin.length > 0 && own !== null && origin !== own) {
        sendJson(res, 403, { ok: false, error: 'cross-origin writes are not allowed' })
        return
      }
      const raw = await readBody(req)
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' })
        return
      }
      const current = readProfile(file)
      const name = normalizeName(body?.name === undefined ? current.name : body.name)
      if (!name.ok) {
        sendJson(res, 400, { ok: false, error: name.error })
        return
      }
      const avatar = normalizeAvatar(body?.avatar === undefined ? current.avatar : body.avatar)
      if (!avatar.ok) {
        sendJson(res, 400, { ok: false, error: avatar.error })
        return
      }
      const saved = writeProfile(file, { name: name.value, avatar: avatar.value })
      sendJson(res, 200, { ok: true, profile: saved, storagePath: file })
    } catch (error) {
      logger.warn?.(`[dsh-user-profile] request failed: ${String(error)}`)
      try {
        sendJson(res, 500, { ok: false, error: 'could not store the profile' })
      } catch { /* response already gone */ }
    }
  }

  return ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (typeof server?.register !== 'function') {
      logger.warn?.('[dsh-user-profile] webServer.register unavailable; profile UI cannot load')
      return
    }
    let dispose
    try {
      dispose = server.register({ kind: 'exact', path: '/user-profile', handler })
    } catch (error) {
      logger.warn?.(`[dsh-user-profile] route registration failed: ${String(error)}`)
      return
    }
    return () => {
      try { dispose?.() } catch { /* already disposed */ }
    }
  })
}

/**
 * Plugin body.
 * @param {any} ctx
 * @param {{ storageDir?: string }} [config]
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const storageDir =
    (typeof config?.storageDir === 'string' && config.storageDir.trim()) ||
    join(resolveDshHome(), 'plugins-data', 'dsh-user-profile')

  // A heartbeat makes "did the host half load?" a fact instead of a guess.
  try {
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(
      join(storageDir, 'heartbeat.txt'),
      `mounted at ${new Date().toISOString()}\npid=${process.pid}\nstorage=${storageDir}\n`,
      'utf8',
    )
  } catch (error) {
    logger.warn?.(`[dsh-user-profile] heartbeat failed: ${String(error)}`)
  }

  if (!existsSync(storageDir)) {
    logger.warn?.(`[dsh-user-profile] storage directory is unavailable: ${storageDir}`)
  }

  try {
    attachRoutes(ctx, { storageDir, logger })
  } catch (error) {
    logger.warn?.(`[dsh-user-profile] route attach failed: ${String(error)}`)
  }
}
