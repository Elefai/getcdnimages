#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/**
 * Simple, legal downloader for images behind a CDN when you already have access.
 * - Accepts URLs and optional headers/cookies/auth to pass through
 * - Concurrent downloads, retries, content-type guard (image/*)
 * - Does NOT bypass protections; requires valid tokens/URLs you own or are authorized to use
 */

const args = process.argv.slice(2)

function parseArgs(argv) {
  const o = { urls: [], headers: {}, outDir: 'downloads', concurrency: 4, retries: 2 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--url': o.urls.push(next()); break
      case '--input': o.input = next(); break
      case '--output': o.outDir = next(); break
      case '--concurrency': o.concurrency = Number(next() || 4) || 4; break
      case '--retry': o.retries = Number(next() || 2) || 2; break
      case '--header': {
        const h = next();
        if (h) {
          const idx = h.indexOf(':')
          if (idx > 0) { const k = h.slice(0, idx).trim(); const v = h.slice(idx + 1).trim(); o.headers[k] = v }
        }
        break
      }
      case '--cookie': {
        const v = next();
        if (v) {
          o.headers['Cookie'] = (o.headers['Cookie'] ? o.headers['Cookie'] + '; ' : '') + v
        }
        break
      }
      case '--auth': {
        const v = next();
        if (v) o.headers['Authorization'] = v.startsWith('Bearer ') || v.startsWith('Basic ') ? v : `Bearer ${v}`
        break
      }
      case '--referer': o.headers['Referer'] = next(); break
      case '--origin': o.headers['Origin'] = next(); break
      case '-h':
      case '--help':
        printHelp(); process.exit(0)
      default:
        if (a && !a.startsWith('-')) o.urls.push(a)
        break
    }
  }
  return o
}

function printHelp() {
  console.log(`Usage: cdn-dl [options] --url <URL> [...]
Options:
  --url <URL>            Adiciona uma URL (pode repetir)
  --input <arquivo>      Arquivo com URLs (TXT uma por linha ou JSON array)
  --output <dir>         Pasta destino (default: downloads)
  --concurrency <n>      Concorrência de downloads (default: 4)
  --retry <n>            Tentativas por arquivo (default: 2)
  --header "K: V"        Header adicional (pode repetir)
  --cookie "k=v"         Cookie (pode repetir)
  --auth <token|Bearer>  Define Authorization (Bearer <token>)
  --referer <url>        Define Referer
  --origin <url>         Define Origin
  -h, --help             Ajuda

Exemplos:
  cdn-dl --url https://cdn.exemplo.com/img/1.jpg --output imgs
  cdn-dl --input urls.txt --header "User-Agent: MyAgent/1.0"
  cdn-dl --url https://cdn..../img --auth abc123 --referer https://seu-site
`)
}

async function loadUrls(input) {
  if (!input) return []
  const data = fs.readFileSync(input, 'utf8')
  let list = []
  try {
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) list = parsed
  } catch {
    list = data.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  }
  return list
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function pickFilenameFromUrl(u) {
  try {
    const url = new URL(u)
    const base = path.basename(url.pathname) || 'file'
    return sanitizeName(base)
  } catch {
    return 'file'
  }
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null
  // very naive parsing for filename= or filename*=
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition)
  const v = (m && (m[1] || m[2])) || null
  return v ? sanitizeName(decodeURIComponent(v)) : null
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true })
}

async function uniquePath(dir, base) {
  let p = path.join(dir, base)
  let i = 1
  const ext = path.extname(base)
  const name = path.basename(base, ext)
  while (fs.existsSync(p)) {
    p = path.join(dir, `${name} (${i++})${ext}`)
  }
  return p
}

async function downloadOne(url, headers, outDir, retries) {
  let attempt = 0
  let lastErr = null
  while (attempt++ <= retries) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ctype = res.headers.get('content-type') || ''
      if (!ctype.toLowerCase().startsWith('image/')) {
        throw new Error(`Content-Type not image/* (${ctype})`)
      }
      let filename = filenameFromDisposition(res.headers.get('content-disposition')) || pickFilenameFromUrl(url)
      const outPath = await uniquePath(outDir, filename)
      const file = fs.createWriteStream(outPath)
      // Pipe WHATWG ReadableStream to Node stream for compatibility across Node 18/20/22
      await pipeline(Readable.fromWeb(res.body), file)
      return { url, path: outPath, ok: true }
    } catch (err) {
      lastErr = err
      if (attempt <= retries) await sleep(250 * attempt)
    }
  }
  return { url, error: String(lastErr), ok: false }
}

async function main() {
  const opts = parseArgs(args)
  const fromFile = await loadUrls(opts.input)
  const urls = [...fromFile, ...opts.urls]
  if (!urls.length) { printHelp(); process.exit(1) }
  await ensureDir(opts.outDir)

  const queue = urls.map((u) => ({ url: u }))
  let active = 0; let idx = 0
  const results = []

  async function next() {
    if (idx >= queue.length) return
    const { url } = queue[idx++]
    active++
    try {
      const r = await downloadOne(url, opts.headers, opts.outDir, opts.retries)
      results.push(r)
      if (r.ok) console.log(`ok downloaded: ${r.path}`)
      else console.error(`fail: ${url} -> ${r.error}`)
    } finally {
      active--
      if (idx < queue.length) await next()
    }
  }

  const starters = Math.min(opts.concurrency, queue.length)
  await Promise.all(Array.from({ length: starters }, () => next()))

  const ok = results.filter(r => r.ok).length
  const fail = results.length - ok
  console.log(`Done. Success: ${ok}, Failed: ${fail}`)
  process.exit(fail ? 2 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })

