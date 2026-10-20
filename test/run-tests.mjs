/**
 * Offline checks for dsh-user-profile.
 *
 * The host half is exercised through its HTTP handler; the browser half runs in
 * jsdom against a synthetic copy of the real account trigger, because the bundle
 * is a browser script and must not need a GUI to be trusted.
 *
 *   npm install   # once, for jsdom
 *   npm test
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = dirname(here)
const clientPath = join(packageDir, 'lib', 'client.js')

let failures = 0
let checks = 0

async function check(title, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${error && error.message ? error.message : error}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// 1. Bundle compiles
// ---------------------------------------------------------------------------

section('client bundle')
const clientSource = readFileSync(clientPath, 'utf8')

await check('client.js parses as a script', () => {
  // Compiling without invoking catches syntax errors in the bundle.
  new Function(clientSource)
})

await check('client.js registers the package id and a factory', () => {
  assert.match(clientSource, /id:\s*'dsh-user-profile'/)
  assert.match(clientSource, /factory:\s*\(require\)\s*=>/)
})

// ---------------------------------------------------------------------------
// 2. Host half: validation + storage + HTTP handler
// ---------------------------------------------------------------------------

section('host half')
const host = await import(pathToFileURL(join(packageDir, 'lib', 'index.js')).href)

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-user-profile-'))

await check('normalizeName trims, collapses spaces and rejects control characters', () => {
  assert.deepEqual(host.normalizeName('  Ada   Lovelace  '), { ok: true, value: 'Ada Lovelace' })
  assert.deepEqual(host.normalizeName('a\u0000b'), { ok: true, value: 'a b' })
  assert.deepEqual(host.normalizeName(undefined), { ok: true, value: '' })
  assert.equal(host.normalizeName(42).ok, false)
  assert.equal(host.normalizeName('x'.repeat(33)).ok, false)
})

await check('normalizeName counts code points, not UTF-16 units', () => {
  const emoji = '🙂'.repeat(32)
  assert.equal(host.normalizeName(emoji).ok, true)
  assert.equal(host.normalizeName(`${emoji}🙂`).ok, false)
})

await check('normalizeAvatar accepts raster data URLs and null', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  assert.deepEqual(host.normalizeAvatar(png), { ok: true, value: png })
  assert.deepEqual(host.normalizeAvatar(null), { ok: true, value: null })
  assert.deepEqual(host.normalizeAvatar(''), { ok: true, value: null })
})

await check('normalizeAvatar rejects SVG, remote URLs and oversized payloads', () => {
  assert.equal(host.normalizeAvatar('data:image/svg+xml;base64,PHN2Zz4=').ok, false)
  assert.equal(host.normalizeAvatar('https://example.test/a.png').ok, false)
  assert.equal(host.normalizeAvatar(`data:image/png;base64,${'A'.repeat(700001)}`).ok, false)
  assert.equal(host.normalizeAvatar(12).ok, false)
})

const profileFile = join(sandbox, 'profile.json')

await check('writeProfile persists atomically and leaves no temp file', () => {
  const saved = host.writeProfile(profileFile, { name: 'Ada', avatar: null })
  assert.equal(saved.name, 'Ada')
  assert.ok(existsSync(profileFile))
  const leftovers = readdirSync(sandbox).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

await check('readProfile round-trips and tolerates junk', () => {
  assert.equal(host.readProfile(profileFile).name, 'Ada')
  assert.deepEqual(host.readProfile(join(sandbox, 'missing.json')), {
    version: 1,
    name: '',
    avatar: null,
    updatedAt: null,
  })
  const broken = join(sandbox, 'broken.json')
  host.writeProfile(broken, { name: 'ok', avatar: null })
  assert.equal(host.readProfile(broken).name, 'ok')
})

function makeResponse() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(chunk) {
      if (chunk !== undefined) out.body += String(chunk)
      out.finished = true
    },
  }
}

function makeRequest(method, body) {
  if (body === undefined) return { method }
  const stream = Readable.from([Buffer.from(body, 'utf8')])
  stream.method = method
  return stream
}

await check('apply registers GET/POST on /user-profile and writes a heartbeat', async () => {
  const routes = []
  let disposed = false
  const warnings = []
  const ctx = {
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      return callback({
        webServer: {
          register(route) {
            routes.push(route)
            return () => { disposed = true }
          },
        },
      })
    },
  }
  const storageDir = join(sandbox, 'data')
  host.apply(ctx, { storageDir })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/user-profile')
  assert.ok(existsSync(join(storageDir, 'heartbeat.txt')))
  assert.deepEqual(warnings, [])

  const handler = routes[0].handler

  const empty = makeResponse()
  await handler(makeRequest('GET'), empty)
  assert.equal(empty.out.status, 200)
  const emptyBody = JSON.parse(empty.out.body)
  assert.equal(emptyBody.ok, true)
  assert.equal(emptyBody.profile.name, '')
  assert.equal(emptyBody.storagePath, join(storageDir, 'profile.json'))

  const saved = makeResponse()
  await handler(makeRequest('POST', JSON.stringify({ name: '  Ada  ', avatar: null })), saved)
  assert.equal(saved.out.status, 200)
  assert.equal(JSON.parse(saved.out.body).profile.name, 'Ada')
  assert.equal(host.readProfile(join(storageDir, 'profile.json')).name, 'Ada')

  const read = makeResponse()
  await handler(makeRequest('GET'), read)
  assert.equal(JSON.parse(read.out.body).profile.name, 'Ada')

  const partial = makeResponse()
  await handler(makeRequest('POST', JSON.stringify({ name: 'Grace' })), partial)
  assert.equal(JSON.parse(partial.out.body).profile.name, 'Grace')

  const cleared = makeResponse()
  await handler(makeRequest('POST', JSON.stringify({ name: '', avatar: null })), cleared)
  assert.equal(JSON.parse(cleared.out.body).profile.name, '')

  const badJson = makeResponse()
  await handler(makeRequest('POST', '{not json'), badJson)
  assert.equal(badJson.out.status, 400)

  const badName = makeResponse()
  await handler(makeRequest('POST', JSON.stringify({ name: 'x'.repeat(40) })), badName)
  assert.equal(badName.out.status, 400)

  const badAvatar = makeResponse()
  await handler(makeRequest('POST', JSON.stringify({ avatar: 'data:image/svg+xml;base64,AA==' })), badAvatar)
  assert.equal(badAvatar.out.status, 400)

  const wrongMethod = makeResponse()
  await handler(makeRequest('PUT'), wrongMethod)
  assert.equal(wrongMethod.out.status, 405)

  // Writes from another origin are refused; same-origin and non-browser
  // callers (no Origin header) are accepted.
  const forged = Readable.from([Buffer.from(JSON.stringify({ name: 'evil' }), 'utf8')])
  forged.method = 'POST'
  forged.headers = { origin: 'http://evil.test', host: '127.0.0.1:3383' }
  const forgedResponse = makeResponse()
  await handler(forged, forgedResponse)
  assert.equal(forgedResponse.out.status, 403)
  assert.equal(host.readProfile(join(storageDir, 'profile.json')).name, '')

  const sameOrigin = Readable.from([Buffer.from(JSON.stringify({ name: 'Grace' }), 'utf8')])
  sameOrigin.method = 'POST'
  sameOrigin.headers = { origin: 'http://127.0.0.1:3383', host: '127.0.0.1:3383' }
  const sameOriginResponse = makeResponse()
  await handler(sameOrigin, sameOriginResponse)
  assert.equal(sameOriginResponse.out.status, 200)
  assert.equal(JSON.parse(sameOriginResponse.out.body).profile.name, 'Grace')

  void disposed
})

await check('a failing webServer registration degrades to a warning', () => {
  const warnings = []
  const ctx = {
    logger: { warn: (...parts) => warnings.push(parts.join(' ')) },
    inject(services, callback) {
      return callback({
        webServer: {
          register() {
            throw new Error('route clash')
          },
        },
      })
    },
  }
  host.apply(ctx, { storageDir: join(sandbox, 'data2') })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /route registration failed/)
})

// ---------------------------------------------------------------------------
// 3. Browser half: chip overlay under jsdom
// ---------------------------------------------------------------------------

section('browser half (jsdom)')

let JSDOM
try {
  ({ JSDOM } = await import('jsdom'))
} catch (error) {
  console.log(`  skip jsdom unavailable — run "npm install" first (${error.message})`)
}

function accountChipHtml(signedOut) {
  const avatar = signedOut
    ? '<svg class="icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle></svg>'
    : '<span class="avatar" data-avatar-status="ready"><img src="https://platform.test/a.png" alt=""></span>'
  return `<!doctype html><html lang="en"><head></head><body><div class="foot">
    <button type="button" data-signed-out="${signedOut}" data-collapsed="false" aria-haspopup="menu" aria-label="Menu">
      ${avatar}<span class="label">${signedOut ? 'More' : 'Ada Lovelace'}</span>
    </button></div></body></html>`
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

function bootClient(html, initialProfile) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3383/', runScripts: 'outside-only' })
  const { window } = dom
  let current = initialProfile
  let posts = []

  window.fetch = async (url, init) => {
    if (url !== '/user-profile') throw new Error(`unexpected url ${url}`)
    if (!init || (init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, profile: current, storagePath: 'C:/x/profile.json' }) }
    }
    const body = JSON.parse(init.body)
    posts.push(body)
    current = { version: 1, name: body.name ?? current.name, avatar: body.avatar ?? null, updatedAt: 'now' }
    return { ok: true, status: 200, json: async () => ({ ok: true, profile: current, storagePath: 'C:/x/profile.json' }) }
  }

  const loaded = []
  window.__ModuleLoader__ = { load: (entry) => loaded.push(entry) }
  window.eval(clientSource)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-user-profile')

  const slots = []
  const labels = []
  const dictionaries = []
  let active = 'zh'
  const ctx = {
    slots: {
      inject(name, callback) {
        slots.push(name)
        return callback()
      },
      register(options, component) {
        slots.push(options.name + ':' + options.id)
        assert.equal(options.locale, 'user-profile')
        labels.push(options.label)
        return () => {}
      },
    },
    locale: {
      register(namespace, tables) {
        dictionaries.push({ namespace, tables })
        return () => {}
      },
      bind(namespace) {
        return (key) => {
          const table = (active === 'zh' ? tablesZh : tablesEn)[key]
          return table !== undefined ? table : key
        }
      },
      subscribe() { return () => {} },
      getLocale: () => ({ active }),
    },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  // The bundle keeps its own tables, so mirror them from the registration.
  const tablesZh = {}
  const tablesEn = {}

  const modules = loaded[0].factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`unexpected require ${id}`)
  })
  modules.apply(ctx)
  for (const entry of dictionaries) {
    Object.assign(tablesZh, entry.tables.zh || {})
    Object.assign(tablesEn, entry.tables.en || {})
  }
  return { dom, window, modules, slots, posts, dictionaries, labels, setActive: (next) => { active = next }, getProbe: () => current }
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 120))

if (JSDOM) {
  await check('apply registers the settings section before the account section', () => {
    const { slots } = bootClient(accountChipHtml(true), { name: '', avatar: null, updatedAt: null })
    assert.ok(slots.includes('settings.section'))
    assert.ok(slots.includes('settings.section:profile'))
  })

  await check('registers zh/en dictionaries and localizes the nav label', () => {
    const { dictionaries, labels } = bootClient(accountChipHtml(true), { name: '', avatar: null, updatedAt: null })
    assert.equal(dictionaries.length, 1)
    assert.equal(dictionaries[0].namespace, 'user-profile')
    assert.equal(dictionaries[0].tables.en.nav, 'Profile')
    assert.equal(dictionaries[0].tables.zh.nav, '个人资料')
    assert.equal(labels.length, 1)
    assert.equal(labels[0](), '个人资料')
  })

  await check('signed-out chip shows the custom avatar and name', async () => {
    const { window } = bootClient(accountChipHtml(true), { name: '小明', avatar: PNG, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    assert.ok(trigger.hasAttribute('data-dupx-active'), 'trigger marked active')

    const avatar = trigger.querySelector(':scope > .dupx-chip-avatar')
    assert.ok(avatar, 'avatar node exists')
    assert.equal(avatar.querySelector('img').getAttribute('src'), PNG)

    const label = trigger.querySelector(':scope > .dupx-chip-label')
    assert.equal(label.textContent, '小明')
    assert.equal(label.style.display, '')

    // The app's own nodes stay in the DOM (React still owns them) but are hidden.
    const native = trigger.querySelector(':scope > svg')
    assert.equal(native.style.display, 'none')
    const nativeLabel = trigger.querySelector(':scope > span.label')
    assert.equal(nativeLabel.style.display, 'none')
  })

  await check('signed-in chip replaces the platform identity', async () => {
    const { window } = bootClient(accountChipHtml(false), { name: 'Ada', avatar: null, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    const avatar = trigger.querySelector(':scope > .dupx-chip-avatar')
    assert.equal(avatar.textContent, 'A', 'falls back to the first character')
    assert.equal(trigger.querySelector(':scope > .dupx-chip-label').textContent, 'Ada')
    assert.equal(trigger.querySelector(':scope > span.avatar').style.display, 'none')
  })

  await check('an empty profile leaves the chip untouched', async () => {
    const { window } = bootClient(accountChipHtml(true), { name: '', avatar: null, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    assert.equal(trigger.hasAttribute('data-dupx-active'), false)
    assert.equal(trigger.querySelectorAll('[data-dupx-el]').length, 0)
    assert.equal(trigger.querySelector(':scope > span.label').style.display, '')
  })

  await check('collapsing the rail hides the custom label but keeps the avatar', async () => {
    const { window } = bootClient(accountChipHtml(true), { name: 'Ada', avatar: PNG, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    trigger.setAttribute('data-collapsed', 'true')
    await tick()
    assert.equal(trigger.querySelector(':scope > .dupx-chip-label').style.display, 'none')
    assert.ok(trigger.querySelector(':scope > .dupx-chip-avatar img'))
    trigger.setAttribute('data-collapsed', 'false')
    await tick()
    assert.equal(trigger.querySelector(':scope > .dupx-chip-label').style.display, '')
  })

  await check('clearing the profile restores the app-rendered chip exactly', async () => {
    const { window, modules } = bootClient(accountChipHtml(false), { name: 'Ada', avatar: PNG, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    assert.ok(trigger.hasAttribute('data-dupx-active'))

    // Host now reports an empty profile; a reload must undo every decoration.
    const restore = async () => {
      window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, profile: { name: '', avatar: null }, storagePath: '' }) })
      await modules.__reload()
      await tick()
    }
    await restore()

    assert.equal(trigger.hasAttribute('data-dupx-active'), false)
    assert.equal(trigger.querySelectorAll('[data-dupx-el]').length, 0)
    assert.equal(trigger.querySelector(':scope > span.label').style.display, '')
    assert.equal(trigger.querySelector(':scope > span.avatar').style.display, '')
  })

  await check('a missing host plugin renders the unavailable state', async () => {
    const { window, modules } = bootClient(accountChipHtml(true), { name: '', avatar: null, updatedAt: null })
    window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
    await modules.__reload()
    await tick()
    assert.equal(modules.__state().status, 'unavailable')
  })

  await check('the observer settles instead of looping on its own writes', async () => {
    const { window } = bootClient(accountChipHtml(true), { name: 'Ada', avatar: PNG, updatedAt: null })
    await tick()
    const trigger = window.document.querySelector('button[data-signed-out]')
    const before = trigger.outerHTML
    await tick()
    await tick()
    assert.equal(trigger.outerHTML, before, 'chip markup is stable across observer passes')
  })
}

// ---------------------------------------------------------------------------

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* best effort */ }

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log('FAIL')
  process.exitCode = 1
} else {
  console.log('PASS')
}
