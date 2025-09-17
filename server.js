import http from 'node:http'
import { Readable } from 'node:stream'
import { Readable as NodeReadable } from 'node:stream'
import crypto from 'node:crypto'

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

  // Sensible browser-like defaults if not provided
  if (!headers['Accept']) headers['Accept'] = 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.8'
  if (!headers['User-Agent']) headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'

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

function logLine(obj) {
  try { console.log(JSON.stringify(obj)) } catch { /* noop */ }
}

function newReqId() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) }

async function proxyImage(req, res, sp) {
  const url = sp.get('url')
  if (!url) return bad(res, 400, 'missing url parameter')
  if (!/^https?:\/\//i.test(url)) return bad(res, 400, 'url must be http(s)')

  const headers = parseHeadersFromQuery(sp)
  const allowAny = sp.get('allowAny') === '1' || sp.get('allowAny') === 'true'
  const cd = sp.get('contentDisposition') || 'inline' // or 'attachment'
  const overrideName = sp.get('filename')
  const timeoutMs = Math.min(Math.max(Number(sp.get('timeout') || 15000), 1_000), 120_000)
  const reqId = newReqId()
  const t0 = Date.now()
  logLine({ level: 'info', ts: new Date().toISOString(), event: 'start', reqId, method: req.method, url, allowAny })

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  let resp
  try {
    resp = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
  } catch (err) {
    clearTimeout(t)
    logLine({ level: 'error', ts: new Date().toISOString(), event: 'error', reqId, stage: 'fetch', error: String(err) })
    return bad(res, 502, 'fetch error', { detail: String(err) })
  }
  clearTimeout(t)

  if (!resp.ok) {
    logLine({ level: 'warn', ts: new Date().toISOString(), event: 'upstream', reqId, status: resp.status })
    return bad(res, 502, `upstream HTTP ${resp.status}`)
  }
  
  // Sniff image type from magic bytes when upstream lies (e.g., text/plain)
  function sniffImageType(buf) {
    const b = buf
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
    if (b.length >= 12 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    return null
  }

  try {
    const reader = resp.body.getReader()
    const firstRead = await reader.read()
    const firstChunk = firstRead.value ? Buffer.from(firstRead.value) : Buffer.alloc(0)
    const upstreamType = (resp.headers.get('content-type') || '').toLowerCase()
    let outType = upstreamType
    const sniffed = sniffImageType(firstChunk)
    if (!outType || !outType.startsWith('image/')) {
      if (sniffed) outType = sniffed
    }
    if (!allowAny && (!outType || !outType.startsWith('image/'))) {
      logLine({ level: 'warn', ts: new Date().toISOString(), event: 'reject', reqId, reason: 'unsupported content-type', upstreamType })
      return bad(res, 415, `unsupported content-type: ${upstreamType || 'unknown'}`)
    }

    const filename = sanitizeFilename(overrideName || filenameFromDisposition(resp.headers.get('content-disposition')))
    const headersOut = {
      'content-type': outType || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-disposition': `${cd}; filename="${filename || 'file'}"`,
    }
    const clen = resp.headers.get('content-length')
    if (clen) headersOut['content-length'] = clen

    res.writeHead(200, headersOut)

    async function* gen() {
      let bytes = 0
      if (firstChunk.length) yield firstChunk
      bytes += firstChunk.length
      let r
      while (!(r = await reader.read()).done) {
        const buf = Buffer.from(r.value)
        bytes += buf.length
        yield buf
      }
      const ms = Date.now() - t0
      logLine({ level: 'info', ts: new Date().toISOString(), event: 'done', reqId, status: 200, type: outType || upstreamType || 'unknown', bytes, ms })
    }
    const nodeStream = Readable.from(gen())
    nodeStream.on('error', (e) => {
      logLine({ level: 'error', ts: new Date().toISOString(), event: 'error', reqId, stage: 'stream', error: String(e) })
      if (!res.headersSent) bad(res, 500, 'stream error', { detail: String(e) })
      else try { res.destroy(e) } catch {}
    })
    nodeStream.pipe(res)
  } catch (e) {
    logLine({ level: 'error', ts: new Date().toISOString(), event: 'error', reqId, stage: 'setup', error: String(e) })
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
