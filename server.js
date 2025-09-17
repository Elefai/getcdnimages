import http from 'node:http'
import { Readable } from 'node:stream'
import { Readable as NodeReadable } from 'node:stream'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function bad(res, code, message, extra = {}) {
  json(res, code, { ok: false, error: message, ...extra })
}

function parseHeadersFromQuery(sp) {
  const headers = {}
  const pushHeader = (k, v) => {
    if (!k || v === undefined || v === null) return
    // merge cookies specially
    if (k.toLowerCase() === 'cookie') {
      headers['Cookie'] = (headers['Cookie'] ? headers['Cookie'] + '; ' : '') + String(v)
    } else {
      headers[k] = String(v)
    }
  }

  // header can repeat: ?header=K:V&header=Foo:Bar
  const hdrs = sp.getAll('header')
  for (const h of hdrs) {
    const idx = h.indexOf(':')
    if (idx > 0) {
      const k = h.slice(0, idx).trim()
      const v = h.slice(idx + 1).trim()
      pushHeader(k, v)
    }
  }

  // dedicated helpers
  const auth = sp.get('auth')
  if (auth) pushHeader('Authorization', auth.startsWith('Bearer ') || auth.startsWith('Basic ') ? auth : `Bearer ${auth}`)
  const referer = sp.get('referer')
  if (referer) pushHeader('Referer', referer)
  const origin = sp.get('origin')
  if (origin) pushHeader('Origin', origin)
  for (const c of sp.getAll('cookie')) pushHeader('Cookie', c)

  return headers
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition)
  const v = (m && (m[1] || m[2])) || null
  try { return v ? decodeURIComponent(v) : null } catch { return v }
}

function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function proxyImage(req, res, sp) {
  const url = sp.get('url')
  if (!url) return bad(res, 400, 'missing url parameter')
  if (!/^https?:\/\//i.test(url)) return bad(res, 400, 'url must be http(s)')

  const headers = parseHeadersFromQuery(sp)
  const allowAny = sp.get('allowAny') === '1' || sp.get('allowAny') === 'true'
  const cd = sp.get('contentDisposition') || 'inline' // or 'attachment'
  const overrideName = sp.get('filename')
  const timeoutMs = Math.min(Math.max(Number(sp.get('timeout') || 15000), 1_000), 120_000)

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  let resp
  try {
    resp = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
  } catch (err) {
    clearTimeout(t)
    return bad(res, 502, 'fetch error', { detail: String(err) })
  }
  clearTimeout(t)

  if (!resp.ok) {
    return bad(res, 502, `upstream HTTP ${resp.status}`)
  }
  const ctype = (resp.headers.get('content-type') || '').toLowerCase()
  if (!allowAny && !ctype.startsWith('image/')) {
    return bad(res, 415, `unsupported content-type: ${ctype}`)
  }

  const filename = sanitizeFilename(overrideName || filenameFromDisposition(resp.headers.get('content-disposition')))
  const headersOut = {
    'content-type': ctype || 'application/octet-stream',
    'cache-control': 'no-store',
    'content-disposition': `${cd}; filename="${filename || 'file'}"`,
  }
  const clen = resp.headers.get('content-length')
  if (clen) headersOut['content-length'] = clen

  res.writeHead(200, headersOut)
  try {
    // WHATWG ReadableStream -> Node stream
    const nodeStream = NodeReadable.fromWeb ? NodeReadable.fromWeb(resp.body) : Readable.from(resp.body)
    nodeStream.on('error', (e) => {
      if (!res.headersSent) bad(res, 500, 'stream error', { detail: String(e) })
      else try { res.destroy(e) } catch {}
    })
    nodeStream.pipe(res)
  } catch (e) {
    if (!res.headersSent) return bad(res, 500, 'stream setup error', { detail: String(e) })
    try { res.destroy(e) } catch {}
  }
}

async function handlePostImage(req, res) {
  // Accept JSON: { url, headers, auth, referer, origin, allowAny, contentDisposition, filename, timeout }
  const chunks = []
  let size = 0
  const MAX = 1_000_000 // 1MB
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length
      if (size > MAX) { reject(new Error('payload too large')); try { req.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', resolve)
    req.on('error', reject)
  })
  let body = {}
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
  const sp = new URLSearchParams()
  if (body.url) sp.set('url', body.url)
  if (body.timeout) sp.set('timeout', String(body.timeout))
  if (body.allowAny) sp.set('allowAny', body.allowAny ? '1' : '0')
  if (body.contentDisposition) sp.set('contentDisposition', body.contentDisposition)
  if (body.filename) sp.set('filename', body.filename)
  if (body.auth) sp.set('auth', body.auth)
  if (body.referer) sp.set('referer', body.referer)
  if (body.origin) sp.set('origin', body.origin)
  if (body.cookie) {
    const list = Array.isArray(body.cookie) ? body.cookie : [body.cookie]
    for (const c of list) sp.append('cookie', c)
  }
  if (body.headers && typeof body.headers === 'object') {
    for (const [k, v] of Object.entries(body.headers)) sp.append('header', `${k}: ${v}`)
  }
  return proxyImage(req, res, sp)
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost`)
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health')) {
      return json(res, 200, { ok: true, service: 'getcdnimages', endpoints: ['/image'], ts: Date.now() })
    }
    if (u.pathname === '/image') {
      if (req.method === 'GET') return proxyImage(req, res, u.searchParams)
      if (req.method === 'POST') return handlePostImage(req, res)
      res.setHeader('Allow', 'GET, POST')
      return bad(res, 405, 'method not allowed')
    }
    return bad(res, 404, 'not found')
  } catch (e) {
    return bad(res, 500, 'internal error', { detail: String(e) })
  }
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`getcdnimages API listening on :${PORT}`)
})

