/**
 * dsh-user-profile — browser half.
 *
 * Two surfaces, one local profile:
 *   1. Settings → Profile: edit the display name and avatar, with a live
 *      preview. Values are stored by the host half (index.js) in
 *      `<DSH_HOME>/plugins-data/dsh-user-profile/profile.json`.
 *   2. Sidebar account chip: the existing trigger (`button[data-signed-out]`)
 *      always exists, but with no DeepSeek account connected it degrades to a
 *      generic "More" button. When a profile is set we overlay the custom
 *      avatar and name on that same button — the account menu itself keeps
 *      working, we only replace its face.
 *
 * The chip overlay is defensive by design: it is a plain DOM decoration on
 * someone else's component, so it is idempotent, reversible, and does nothing
 * at all when the trigger or the profile is absent.
 *
 * Bundle shape follows the DSH client module contract: the factory registers a
 * plugin object exporting `apply` (and `inject: ['slots']`).
 */

window.__ModuleLoader__.load({
  id: 'dsh-user-profile',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    // ---------------------------------------------------------------------
    // Copy — registered with the DSH locale service, so the page's language
    // setting decides which table is used (keys stay lowercase, English is the
    // complete fallback set).
    // ---------------------------------------------------------------------

    var NS = 'user-profile'

    var en = {
      'nav': 'Profile',
      'intro': 'Set the name and picture this app shows for you. Stored locally on this computer.',
      'name.label': 'Username',
      'name.placeholder': 'Your name',
      'name.hint': 'Shown in the sidebar account chip. Leave empty to keep the default.',
      'avatar.label': 'Avatar',
      'avatar.upload': 'Upload image…',
      'avatar.remove': 'Remove',
      'avatar.hint': 'PNG, JPG or WebP. Cropped to a square and stored locally.',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.reset': 'Reset',
      'state.saved': 'Saved.',
      'state.reset': 'Profile cleared.',
      'state.none': 'Not set',
      'state.custom': 'Custom avatar',
      'state.default': 'Default avatar',
      'state.stored': 'Stored in',
      'error.unavailable': 'Profile service is not available: the dsh-user-profile host plugin is not loaded.',
      'error.tooLarge': 'That image is larger than 8 MB. Pick a smaller file.',
      'error.notImage': 'That file is not an image.',
      'error.badImage': 'That image could not be read.',
      'error.nameTooLong': 'Name must be at most 32 characters.',
      'error.save': 'Could not save the profile.',
    }

    var zh = {
      'nav': '个人资料',
      'intro': '设置这个应用显示你的名字和头像，只保存在本机。',
      'name.label': '用户名',
      'name.placeholder': '你的名字',
      'name.hint': '显示在侧边栏账号位置。留空则保持默认。',
      'avatar.label': '头像',
      'avatar.upload': '上传图片…',
      'avatar.remove': '移除',
      'avatar.hint': '支持 PNG / JPG / WebP，会自动裁成方形并保存在本地。',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.reset': '重置',
      'state.saved': '已保存。',
      'state.reset': '已清除个人资料。',
      'state.none': '未设置',
      'state.custom': '自定义头像',
      'state.default': '默认头像',
      'state.stored': '存储位置',
      'error.unavailable': '个人资料服务不可用：dsh-user-profile 宿主插件未加载。',
      'error.tooLarge': '图片超过 8 MB，请换一张小一些的。',
      'error.notImage': '这个文件不是图片。',
      'error.badImage': '图片读取失败。',
      'error.nameTooLong': '用户名最多 32 个字符。',
      'error.save': '保存失败。',
    }

    /** Translator; replaced by the locale-service binding when the service exists. */
    var T = function (key) {
      return en[key] !== undefined ? en[key] : key
    }

    function t(key) {
      try {
        return T(key)
      } catch {
        return en[key] !== undefined ? en[key] : key
      }
    }

    var CTX = null

    /** Fallback when no locale service is present: follow the document language. */
    function detectLanguage() {
      var declared = (document.documentElement && document.documentElement.lang) || navigator.language || 'en'
      return String(declared).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    // ---------------------------------------------------------------------
    // Profile store (shared by the settings page and the chip overlay)
    // ---------------------------------------------------------------------

    var ENDPOINT = '/user-profile'

    var state = {
      status: 'cold', // cold | loading | ready | unavailable | error
      profile: { name: '', avatar: null, updatedAt: null },
      storagePath: '',
      error: null,
    }
    var listeners = new Set()
    var loading = null

    function publish(patch) {
      state = Object.assign({}, state, patch)
      listeners.forEach(function (listener) {
        try { listener() } catch { /* a broken listener must not break the store */ }
      })
      applyChip()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () { listeners.delete(listener) }
    }

    function getState() { return state }

    function request(init) {
      return fetch(ENDPOINT, Object.assign({
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
      }, init || {})).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (body) {
          if (!response.ok || body.ok === false) {
            throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          }
          return body
        })
      })
    }

    function loadProfile(force) {
      if (loading && !force) return loading
      loading = request()
        .then(function (body) {
          publish({
            status: 'ready',
            profile: body.profile || { name: '', avatar: null, updatedAt: null },
            storagePath: typeof body.storagePath === 'string' ? body.storagePath : '',
            error: null,
          })
          return state.profile
        })
        .catch(function (error) {
          // 404 means the host half is not mounted; anything else is a real error.
          var message = String(error && error.message ? error.message : error)
          publish({
            status: message.indexOf('404') >= 0 ? 'unavailable' : 'error',
            error: message,
          })
          return null
        })
        .then(function (value) {
          loading = null
          return value
        })
      return loading
    }

    function saveProfile(next) {
      return request({ method: 'POST', body: JSON.stringify(next) })
        .then(function (body) {
          publish({
            status: 'ready',
            profile: body.profile || { name: '', avatar: null, updatedAt: null },
            storagePath: typeof body.storagePath === 'string' ? body.storagePath : state.storagePath,
            error: null,
          })
          return state.profile
        })
    }

    // ---------------------------------------------------------------------
    // Sidebar account chip overlay
    // ---------------------------------------------------------------------

    var observer = null
    var scheduled = 0
    var ORIGINAL = 'data-dupx-display'

    function chipTrigger() {
      try {
        return document.querySelector('button[data-signed-out]')
      } catch {
        return null
      }
    }

    /** Read the label the app itself renders inside the trigger ("More" / account name). */
    function nativeLabelText(trigger) {
      var spans = trigger.querySelectorAll(':scope > span')
      for (var i = 0; i < spans.length; i += 1) {
        var text = (spans[i].textContent || '').trim()
        if (text && !spans[i].hasAttribute('data-dupx-el')) return text
      }
      return ''
    }

    function initialsOf(name) {
      var trimmed = (name || '').trim()
      if (!trimmed) return ''
      var first = Array.from(trimmed)[0]
      return first ? first.toUpperCase() : ''
    }

    function ensureElement(trigger, tag, key, className) {
      var existing = trigger.querySelector(':scope > [data-dupx-el="' + key + '"]')
      if (existing && existing.tagName === tag.toUpperCase()) return existing
      var node = document.createElement(tag)
      node.setAttribute('data-dupx-el', key)
      node.className = className
      return node
    }

    function hideNative(trigger) {
      var children = Array.prototype.slice.call(trigger.children)
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i]
        if (child.hasAttribute('data-dupx-el')) continue
        if (!child.hasAttribute(ORIGINAL)) {
          child.setAttribute(ORIGINAL, child.style.display || '')
        }
        if (child.style.display !== 'none') child.style.display = 'none'
      }
    }

    function restoreNative(trigger) {
      var hidden = trigger.querySelectorAll('[' + ORIGINAL + ']')
      for (var i = 0; i < hidden.length; i += 1) {
        hidden[i].style.display = hidden[i].getAttribute(ORIGINAL) || ''
        hidden[i].removeAttribute(ORIGINAL)
      }
      var ours = trigger.querySelectorAll('[data-dupx-el]')
      for (var j = 0; j < ours.length; j += 1) ours[j].remove()
      trigger.removeAttribute('data-dupx-active')
    }

    /** Apply (or remove) the custom identity on the sidebar trigger. Idempotent. */
    function applyChip() {
      var trigger = chipTrigger()
      if (!trigger) return
      var profile = state.profile || {}
      var hasIdentity = Boolean(profile.name || profile.avatar)
      if (!hasIdentity) {
        if (trigger.hasAttribute('data-dupx-active')) restoreNative(trigger)
        return
      }

      hideNative(trigger)
      trigger.setAttribute('data-dupx-active', '1')

      var collapsed = trigger.getAttribute('data-collapsed') === 'true'
      var labelText = profile.name || nativeLabelText(trigger)

      // Avatar: the picture, else the first character of the name. A picture
      // the renderer refuses (CSP, corrupt data) falls back to the initial
      // instead of leaving an empty hole, and the failure is remembered so the
      // observer cannot retry it forever.
      var avatar = ensureElement(trigger, 'span', 'avatar', 'dupx-chip-avatar')
      var avatarSource = profile.avatar || ''
      if (trigger.getAttribute('data-dupx-src') !== avatarSource) {
        trigger.setAttribute('data-dupx-src', avatarSource)
        avatar.removeAttribute('data-dupx-broken')
        avatar.textContent = ''
      }
      var mark = initialsOf(profile.name) || '?'
      var broken = avatar.getAttribute('data-dupx-broken') === '1'
      if (profile.avatar && !broken) {
        var image = avatar.querySelector('img')
        if (!image) {
          image = document.createElement('img')
          image.setAttribute('data-dupx-el', 'avatar-img')
          image.alt = ''
          image.onerror = function () {
            avatar.setAttribute('data-dupx-broken', '1')
            avatar.textContent = mark
          }
          avatar.appendChild(image)
        }
        if (image.getAttribute('src') !== profile.avatar) image.src = profile.avatar
      } else if (avatar.textContent !== mark) {
        var stale = avatar.querySelector('img')
        if (stale) stale.remove()
        avatar.textContent = mark
        avatar.setAttribute('data-dupx-empty', profile.name ? 'false' : 'true')
      }

      var label = ensureElement(trigger, 'span', 'label', 'dupx-chip-label')
      if (label.textContent !== labelText) label.textContent = labelText
      label.style.display = collapsed || !labelText ? 'none' : ''

      // Keep DOM order stable (avatar, then label). Appending an element that is
      // already last would still be a DOM mutation, so only move when needed:
      // the observer must settle instead of observing its own writes.
      if (trigger.lastElementChild !== label || label.previousElementSibling !== avatar) {
        trigger.appendChild(avatar)
        trigger.appendChild(label)
      }
    }

    function scheduleChip() {
      if (scheduled) return
      scheduled = window.setTimeout(function () {
        scheduled = 0
        try { applyChip() } catch { /* decoration only */ }
      }, 80)
    }

    function watchChip() {
      if (observer) return
      observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var node = records[i].target
          if (node && node.nodeType === 1 && node.closest && node.closest('[data-dupx-el]')) continue
          scheduleChip()
          return
        }
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-collapsed', 'data-signed-out'],
      })
    }

    // ---------------------------------------------------------------------
    // Styles (DSH design tokens with neutral fallbacks)
    // ---------------------------------------------------------------------

    var STYLE_ID = 'dsh-user-profile-styles'

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dupx-section{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary,#e7e9ef);max-width:640px}',
        '.dupx-intro{color:var(--dsw-alias-label-tertiary,#8f96a8);max-width:520px}',
        '.dupx-card{display:flex;align-items:center;gap:12px;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(255,255,255,.12));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,rgba(255,255,255,.04))}',
        '.dupx-card-avatar{width:48px;height:48px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.08));color:var(--dsw-alias-label-tertiary,#8f96a8);font-size:18px;font-weight:600}',
        '.dupx-card-avatar img{width:100%;height:100%;object-fit:cover;display:block}',
        '.dupx-card-name{font-size:14px;font-weight:500}',
        '.dupx-card-sub{color:var(--dsw-alias-label-tertiary,#8f96a8)}',
        '.dupx-field{display:flex;flex-direction:column;gap:6px}',
        '.dupx-field-label{font-weight:500}',
        '.dupx-hint{color:var(--dsw-alias-label-tertiary,#8f96a8)}',
        '.dupx-input{box-sizing:border-box;width:100%;max-width:360px;height:34px;padding:0 10px;color:inherit;font:inherit;background:transparent;border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));border-radius:var(--dsw-radius-md,8px);outline:none}',
        '.dupx-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 25%,transparent)}',
        '.dupx-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dupx-btn{box-sizing:border-box;height:32px;padding:0 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#e7e9ef);background:transparent;border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));border-radius:var(--dsw-radius-md,8px);cursor:pointer}',
        '.dupx-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}',
        '.dupx-btn:disabled{opacity:.45;cursor:default}',
        '.dupx-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:2px}',
        '.dupx-primary{box-sizing:border-box;height:32px;padding:0 16px;font:inherit;font-size:13px;font-weight:500;color:#fff;background:var(--dsw-alias-state-business-primary,#4d6bfe);border:0;border-radius:var(--dsw-radius-md,8px);cursor:pointer}',
        '.dupx-primary:hover:not(:disabled){filter:brightness(1.08)}',
        '.dupx-primary:disabled{opacity:.6;cursor:default}',
        '.dupx-link{font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary,#8f96a8);background:none;border:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:0}',
        '.dupx-link:hover{color:var(--dsw-alias-label-primary,#e7e9ef)}',
        '.dupx-status{color:var(--dsw-alias-label-tertiary,#8f96a8)}',
        '.dupx-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5534b)}',
        '.dupx-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#2f9e5f)}',
        '.dupx-footnote{color:var(--dsw-alias-label-tertiary,#8f96a8);font-size:12px;word-break:break-all}',
        'button[data-dupx-active] > .dupx-chip-avatar{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.1));font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#c9cede)}',
        'button[data-dupx-active] > .dupx-chip-avatar img{width:100%;height:100%;object-fit:cover;display:block}',
        'button[data-dupx-active] > .dupx-chip-label{text-overflow:ellipsis;white-space:nowrap;overflow:hidden;max-width:180px}',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------------
    // Settings section
    // ---------------------------------------------------------------------

    var MAX_INPUT_BYTES = 8 * 1024 * 1024
    var AVATAR_SIZE = 192

    function readAsDataUrl(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onload = function () { resolve(String(reader.result || '')) }
        reader.onerror = function () { reject(new Error('read-failed')) }
        reader.readAsDataURL(file)
      })
    }

    function decodeImage(source) {
      return new Promise(function (resolve, reject) {
        var image = new Image()
        image.onload = function () { resolve(image) }
        image.onerror = function () { reject(new Error('decode-failed')) }
        image.src = source
      })
    }

    /** Center-crop to a square and downscale, so stored avatars stay small. */
    function squareAvatar(file) {
      return readAsDataUrl(file)
        .then(decodeImage)
        .then(function (image) {
          var canvas = document.createElement('canvas')
          canvas.width = AVATAR_SIZE
          canvas.height = AVATAR_SIZE
          var context = canvas.getContext('2d')
          if (!context) return readAsDataUrl(file)
          var side = Math.min(image.width || AVATAR_SIZE, image.height || AVATAR_SIZE)
          var sx = Math.max(0, ((image.width || side) - side) / 2)
          var sy = Math.max(0, ((image.height || side) - side) / 2)
          context.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
          try {
            return canvas.toDataURL('image/png')
          } catch {
            return readAsDataUrl(file)
          }
        })
    }

    function useProfileState() {
      var pair = React.useState(getState())
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () {
        var off = subscribe(function () { setSnapshot(getState()) })
        if (getState().status === 'cold') loadProfile()
        return off
      }, [])
      return snapshot
    }

    function AvatarPreview(props) {
      var name = props.name || ''
      var avatar = props.avatar
      var failed = React.useState(false)
      var broken = failed[0]
      var setBroken = failed[1]
      if (avatar && !broken) {
        return h('div', { className: 'dupx-card-avatar' },
          h('img', { src: avatar, alt: '', onError: function () { setBroken(true) } }))
      }
      return h('div', { className: 'dupx-card-avatar' }, initialsOf(name) || '?')
    }

    function ProfileSection() {
      var snapshot = useProfileState()
      var formName = React.useState('')
      var name = formName[0]
      var setName = formName[1]
      var formAvatar = React.useState(null)
      var avatar = formAvatar[0]
      var setAvatar = formAvatar[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var messageState = React.useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]
      var seeded = React.useRef(false)
      var fileInput = React.useRef(null)
      var version = React.useState(0)
      var setVersion = version[1]

      // Re-render on a language switch: `t` resolves live, the tree does not.
      React.useEffect(function () {
        try {
          var locale = CTX && CTX.locale
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(function () { setVersion(function (value) { return value + 1 }) })
        } catch {
          return undefined
        }
      }, [])

      React.useEffect(function () {
        if (seeded.current) return
        if (snapshot.status !== 'ready') return
        seeded.current = true
        setName(snapshot.profile.name || '')
        setAvatar(snapshot.profile.avatar || null)
      }, [snapshot.status])

      function note(text, tone) { setMessage({ text: text, tone: tone || 'ok' }) }

      function onPick(event) {
        var file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (!/^image\//.test(file.type)) { note(t('error.notImage'), 'error'); return }
        if (file.size > MAX_INPUT_BYTES) { note(t('error.tooLarge'), 'error'); return }
        squareAvatar(file)
          .then(function (dataUrl) { setAvatar(dataUrl); setMessage(null) })
          .catch(function () { note(t('error.badImage'), 'error') })
      }

      function onSave() {
        if (busy) return
        var nextName = String(name || '').trim()
        if (Array.from(nextName).length > 32) { note(t('error.nameTooLong'), 'error'); return }
        setBusy(true)
        setMessage(null)
        saveProfile({ name: nextName, avatar: avatar || null })
          .then(function () { note(t('state.saved'), 'ok') })
          .catch(function () { note(t('error.save'), 'error') })
          .then(function () { setBusy(false) })
      }

      function onReset() {
        if (busy) return
        setBusy(true)
        setMessage(null)
        saveProfile({ name: '', avatar: null })
          .then(function () {
            setName('')
            setAvatar(null)
            note(t('state.reset'), 'ok')
          })
          .catch(function () { note(t('error.save'), 'error') })
          .then(function () { setBusy(false) })
      }

      if (snapshot.status === 'unavailable' || snapshot.status === 'error') {
        return h('div', { className: 'dupx-section' },
          h('div', { className: 'dupx-intro' }, t('error.unavailable')),
          snapshot.error ? h('div', { className: 'dupx-footnote' }, snapshot.error) : null)
      }

      var pendingName = Array.from(String(name || '').trim()).length > 0
      var previewName = pendingName ? String(name).trim() : (snapshot.profile.name || '')
      var previewAvatar = avatar

      return h('div', { className: 'dupx-section' },
        h('div', { className: 'dupx-intro' }, t('intro')),

        h('div', { className: 'dupx-card' },
          h(AvatarPreview, { key: previewAvatar || 'none', name: previewName, avatar: previewAvatar }),
          h('div', null,
            h('div', { className: 'dupx-card-name' }, previewName || t('state.none')),
            h('div', { className: 'dupx-card-sub' }, previewAvatar ? t('state.custom') : t('state.default')))),

        h('label', { className: 'dupx-field' },
          h('span', { className: 'dupx-field-label' }, t('name.label')),
          h('input', {
            className: 'dupx-input',
            type: 'text',
            value: name,
            maxLength: 32,
            placeholder: t('name.placeholder'),
            onChange: function (event) { setName(event.target.value); setMessage(null) },
          }),
          h('span', { className: 'dupx-hint' }, t('name.hint'))),

        h('div', { className: 'dupx-field' },
          h('span', { className: 'dupx-field-label' }, t('avatar.label')),
          h('div', { className: 'dupx-row' },
            h('button', {
              type: 'button',
              className: 'dupx-btn',
              onClick: function () { if (fileInput.current) fileInput.current.click() },
            }, t('avatar.upload')),
            h('button', {
              type: 'button',
              className: 'dupx-btn',
              disabled: !avatar,
              onClick: function () { setAvatar(null); setMessage(null) },
            }, t('avatar.remove')),
            h('input', {
              ref: fileInput,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp',
              style: { display: 'none' },
              onChange: onPick,
            })),
          h('span', { className: 'dupx-hint' }, t('avatar.hint'))),

        h('div', { className: 'dupx-actions' },
          h('button', {
            type: 'button',
            className: 'dupx-primary',
            disabled: busy,
            onClick: onSave,
          }, busy ? t('action.saving') : t('action.save')),
          h('button', {
            type: 'button',
            className: 'dupx-link',
            disabled: busy,
            onClick: onReset,
          }, t('action.reset')),
          message ? h('span', { className: 'dupx-status', 'data-tone': message.tone }, message.text) : null),

        snapshot.storagePath
          ? h('div', { className: 'dupx-footnote' }, t('state.stored') + ': ' + snapshot.storagePath)
          : null)
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    /** Required services: the UI slot registry and the locale service. */
    var inject = ['slots', 'locale']

    /**
     * Register the settings section and decorate the sidebar account chip.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      CTX = ctx

      // Copy: register the dictionaries with the DSH locale service when it is
      // present, then bind a translator that follows the page's language live.
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: zh, en: en })
          }, 'dsh-user-profile: dictionaries')
        }
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          T = ctx.locale.bind(NS)
        } else {
          var fallback = detectLanguage()
          T = function (key) {
            var table = fallback === 'zh' ? zh : en
            return table[key] !== undefined ? table[key] : en[key] !== undefined ? en[key] : key
          }
        }
      } catch (error) {
        console.warn('[dsh-user-profile] locale binding failed', error)
      }

      try { injectStyles() } catch { /* styling is best effort */ }

      // The settings page is the primary surface. It is registered through the
      // same slot contract the shipped sections use.
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'profile',
            order: -30,
            label: function () { return t('nav') },
            locale: NS,
          }, ProfileSection)
        })
      } catch (error) {
        console.warn('[dsh-user-profile] settings section registration failed', error)
      }

      // The sidebar decoration.
      try {
        watchChip()
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { scheduleChip() }, { once: true })
        }
        loadProfile()
        scheduleChip()
      } catch (error) {
        console.warn('[dsh-user-profile] chip overlay failed', error)
      }
    }

    exports.name = 'dsh-user-profile'
    exports.inject = inject
    exports.apply = apply
    exports.__state = getState
    exports.__reload = function () { return loadProfile(true) }
    return module.exports
  },
})
