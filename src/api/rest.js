'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const versionCompat = require('../version-compat')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const BODY_LIMIT = 8192

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(httpError(413, 'body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function httpError (statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

function sendJson (res, statusCode, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function serveStatic (res, webRoot, rel) {
  const clean = path.normalize(rel).replace(/^([/\\])+/, '')
  const file = path.join(webRoot, clean)
  if (!file.startsWith(webRoot)) return false
  let data
  try {
    data = fs.readFileSync(file)
  } catch (e) {
    return false
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
  res.end(data)
  return true
}

// REST + static file server. one http server instance per process, shared
// with the websocket gateway (which upgrades /ws).
function createApp ({ fleet, webRoot }) {
  const startedAt = Date.now()

  async function api (req, res, u) {
    const p = u.pathname

    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000), bots: fleet.units.size, node: process.version })
    }
    if (p === '/api/versions' && req.method === 'GET') {
      return sendJson(res, 200, versionCompat.supportedVersions())
    }
    if (p === '/api/bots' && req.method === 'GET') {
      return sendJson(res, 200, { bots: fleet.list() })
    }
    if (p === '/api/bots' && req.method === 'POST') {
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch (e) { throw httpError(400, 'body is not valid JSON') }
      const snapshot = fleet.add(body)
      return sendJson(res, 201, { bot: snapshot })
    }

    let m = /^\/api\/bots\/([^/]+)$/.exec(p)
    if (m && req.method === 'DELETE') {
      fleet.remove(m[1])
      return sendJson(res, 200, { ok: true, removed: m[1] })
    }
    m = /^\/api\/bots\/([^/]+)\/command$/.exec(p)
    if (m && req.method === 'POST') {
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch (e) { throw httpError(400, 'body is not valid JSON') }
      if (typeof body.text !== 'string' || body.text.trim() === '') throw httpError(400, 'missing "text"')
      const result = await fleet.command(m[1], body.text, 'web')
      return sendJson(res, 200, { ok: result && result.ok !== false, result })
    }
    if (p.startsWith('/api/')) throw httpError(404, 'no such API route')
    return false
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    Promise.resolve()
      .then(() => api(req, res, u))
      .then((handled) => {
        if (handled !== false) return
        if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'method not allowed')
        const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1)
        if (!serveStatic(res, webRoot, rel)) throw httpError(404, 'not found')
      })
      .catch((err) => {
        if (res.headersSent) { res.end(); return }
        sendJson(res, err.statusCode || 500, { error: err.message || 'internal error' })
      })
  })

  return server
}

module.exports = { createApp }
