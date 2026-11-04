/**
 * Host half of dsh-always-on-top.
 *
 * The renderer cannot touch the native window: the desktop shell exposes no
 * window-control API, so the always-on-top bit is flipped here, in the DSH host
 * process (normal integrity, not inside the agent sandbox), by calling Win32
 * SetWindowPos through a bundled PowerShell script.
 *
 * Contract with the client half:
 *   GET  /dsh-always-on-top/status  -> { ok, topmost, hwnd?, reason? }
 *   POST /dsh-always-on-top/toggle  -> { ok, topmost, hwnd?, reason? }
 *   POST /dsh-always-on-top/set?on=1|0 -> { ok, topmost, hwnd?, reason? }
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-always-on-top'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'pin-window.ps1')
const STATE_FILE = path.join(os.homedir(), '.dsh', 'always-on-top.json')
const PREFIX = '/dsh-always-on-top'
const TIMEOUT_MS = 20000

const isWindows = process.platform === 'win32'

/** Electron main process — the host runtime is spawned as its direct child. */
let cachedTargetPid = 0
function targetPid() {
  if (cachedTargetPid > 0) return cachedTargetPid
  const fromEnv = Number(process.env.DSH_DESKTOP_PID)
  const candidate = Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : Number(process.ppid)
  cachedTargetPid = Number.isInteger(candidate) && candidate > 0 ? candidate : 0
  return cachedTargetPid
}

/** One PowerShell run; resolves the parsed JSON line the script prints. */
function runPin(action) {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve({ ok: false, reason: 'unsupported-platform', topmost: false })
      return
    }
    let child
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT,
          '-Action',
          action,
          '-TargetPid',
          String(targetPid()),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      resolve({ ok: false, reason: String(error && error.message ? error.message : error), topmost: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: 'timeout', topmost: false })
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, reason: String(error && error.message ? error.message : error), topmost: false }))
    child.on('close', () => {
      const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('{') && entry.endsWith('}'))
        .pop()
      if (!line) {
        finish({ ok: false, reason: (stderr || stdout || 'no-output').trim().slice(0, 600), topmost: false })
        return
      }
      try {
        const parsed = JSON.parse(line)
        finish({
          ok: parsed.ok === true,
          topmost: parsed.topmost === true,
          hwnd: parsed.hwnd,
          pid: parsed.pid,
          title: parsed.title,
          win32error: parsed.win32error,
          reason: parsed.ok === true ? undefined : parsed.error || (parsed.win32error ? `win32-error-${parsed.win32error}` : 'failed'),
        })
      } catch (error) {
        finish({ ok: false, reason: `bad-output: ${String(error && error.message ? error.message : error)}`, topmost: false })
      }
    })
  })
}

/** Serialize script runs: concurrent clicks must not race the same window bit. */
let queue = Promise.resolve()
function enqueue(action) {
  const next = queue.then(() => runPin(action))
  queue = next.catch(() => undefined)
  return next
}

function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return parsed && parsed.topmost === true
  } catch {
    return false
  }
}

function writePersisted(topmost) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ topmost, at: new Date().toISOString() }, null, 2))
  } catch {
    /* preference persistence is best effort */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function passThrough(result) {
  const body = { ok: result.ok === true, topmost: result.topmost === true }
  if (result.hwnd !== undefined) body.hwnd = result.hwnd
  if (result.pid !== undefined) body.pid = result.pid
  if (result.reason !== undefined) body.reason = result.reason
  return body
}

async function handle(req, res) {
  if (!req.url) {
    sendJson(res, 400, { ok: false, reason: 'missing-url', topmost: false })
    return
  }
  const url = new URL(req.url, 'http://localhost')
  const tail = url.pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')

  if (tail === 'status' && (req.method === 'GET' || req.method === 'HEAD')) {
    const result = await enqueue('status')
    sendJson(res, 200, passThrough(result))
    return
  }

  if (tail === 'toggle' && req.method === 'POST') {
    const result = await enqueue('toggle')
    if (result.ok) writePersisted(result.topmost)
    sendJson(res, result.ok ? 200 : 503, passThrough(result))
    return
  }

  if (tail === 'set' && req.method === 'POST') {
    const on = url.searchParams.get('on')
    const result = await enqueue(on === '0' || on === 'false' ? 'off' : 'on')
    if (result.ok) writePersisted(result.topmost)
    sendJson(res, result.ok ? 200 : 503, passThrough(result))
    return
  }

  sendJson(res, 404, { ok: false, reason: 'not-found', topmost: false })
}

/** Re-assert the persisted pin once the desktop window exists again. */
function restorePersistedPin(ctx) {
  if (!isWindows || !readPersisted()) return
  let attempts = 0
  const tick = async () => {
    attempts += 1
    const result = await enqueue('on')
    if (result.ok) return
    if (attempts < 10) setTimeout(tick, 3000)
  }
  ctx.effect(() => {
    const timer = setTimeout(tick, 4000)
    return () => clearTimeout(timer)
  }, 'dsh-always-on-top: restore persisted pin')
}

export function apply(ctx) {
  restorePersistedPin(ctx)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle }),
      'dsh-always-on-top: routes',
    )
  })
}
