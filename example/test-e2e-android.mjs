#!/usr/bin/env node
/**
 * capacitor-lancedb Android E2E Test Suite
 *
 * Approach: HTTP server on localhost:8099 + ADB reverse port-forward.
 *   - `adb reverse tcp:8099 tcp:8099` maps device port 8099 → host port 8099
 *   - index.html POSTs __LANCEDB_TEST__ results and __LANCEDB_DONE__ to this server
 *   - Works on both real devices and emulators
 *
 * Sections:
 *   1  Android Setup   (4 tests)
 *   2  HTTP Handshake  (1 test)
 *   3  Plugin API      (11 tests)
 */

import { execSync } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const BUNDLE_ID   = 'io.t6x.lancedb.test'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 11
const TIMEOUT_MS  = 120_000
const ADB         = process.env.ADB_PATH || 'adb'

// ─── Test runner state ────────────────────────────────────────────────────────
let passedTests = 0, failedTests = 0
const testResults = []

function logSection(title) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`) }
function pass(name, detail) {
  passedTests++
  testResults.push({ name, status: 'PASS' })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, error) {
  failedTests++
  testResults.push({ name, status: 'FAIL', error })
  console.log(`  ❌ ${name} — ${error}`)
}

// ─── ADB helpers ──────────────────────────────────────────────────────────────
function adb(args, opts = {}) {
  const serial = process.env.ANDROID_SERIAL ? `-s ${process.env.ANDROID_SERIAL}` : ''
  return execSync(`${ADB} ${serial} ${args}`, { encoding: 'utf8', timeout: 60000, ...opts }).trim()
}

function getConnectedDevice() {
  const out = execSync(`${ADB} devices`, { encoding: 'utf8' }).trim()
  const lines = out.split('\n').slice(1).filter(l => l.includes('\tdevice'))
  if (lines.length === 0) return null
  return lines[0].split('\t')[0].trim()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── HTTP result collector ────────────────────────────────────────────────────
function startResultServer() {
  const received = new Map()

  const serverReady = new Promise((resolveServer, rejectServer) => {
    const allDonePromise = new Promise((resolveDone, rejectDone) => {

      const server = http.createServer((req, res) => {
        // Allow CORS from the WebView
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const payload = JSON.parse(body)
            if (req.url === '/__lancedb_result') {
              received.set(payload.id, payload)
              console.log(`  [app] ${payload.id}: ${payload.status}${payload.detail ? ' — ' + payload.detail : ''}${payload.error ? ' — ' + payload.error : ''}`)
              res.writeHead(200)
              res.end('ok')
            } else if (req.url === '/__lancedb_done') {
              res.writeHead(200)
              res.end('ok')
              server.close()
              resolveDone({ results: received, summary: payload })
            } else {
              res.writeHead(404)
              res.end()
            }
          } catch (e) {
            res.writeHead(400)
            res.end()
          }
        })
      })

      server.listen(RUNNER_PORT, '0.0.0.0', () => {
        resolveServer({ server, allDonePromise })
      })

      server.on('error', rejectServer)

      // Timeout
      setTimeout(() => {
        server.close()
        rejectDone(new Error(`Timeout after ${TIMEOUT_MS / 1000}s — ${received.size}/${TOTAL_TESTS} results received`))
      }, TIMEOUT_MS)
    })
  })

  return serverReady
}

// ─── Test name map ────────────────────────────────────────────────────────────
const TEST_NAMES = {
  open:     'open() — initialise database',
  store1:   'memoryStore() — insert entry A',
  store2:   'memoryStore() — insert entry B',
  upsert:   'memoryStore() — upsert (overwrite) entry A',
  search:   'memorySearch() — finds A nearest to query',
  list:     'memoryList() — returns both keys',
  prefix:   'memoryList(prefix) — filters by prefix',
  delete:   'memoryDelete() — removes entry B',
  after_del:'memoryList() after delete — only A remains',
  clear:    'memoryClear() — drops all data',
  empty:    'memoryList() after clear — empty',
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🟢 capacitor-lancedb Android E2E Test Suite\n')

  // ─── Section 1: Android Setup ─────────────────────────────────────────────
  logSection('1 — Android Setup')

  // 1.1 Find connected device
  let deviceSerial
  try {
    deviceSerial = getConnectedDevice()
    if (!deviceSerial) throw new Error('No device found — connect a device or start an emulator')
    if (process.env.ANDROID_SERIAL && process.env.ANDROID_SERIAL !== deviceSerial) {
      deviceSerial = process.env.ANDROID_SERIAL
    }
    pass('1.1 Android device connected', `serial ${deviceSerial}`)
  } catch (err) {
    fail('1.1 Android device connected', err.message)
    console.error('\nFatal: no Android device.\n')
    process.exit(1)
  }

  // Set serial for subsequent adb calls
  process.env.ANDROID_SERIAL = deviceSerial

  // 1.2 Build APK
  const apkPath = path.join(__dirname, 'android/app/build/outputs/apk/debug/app-debug.apk')
  try {
    console.log('  → Building APK (./gradlew assembleDebug)...')
    execSync('./gradlew assembleDebug', {
      cwd: path.join(__dirname, 'android'),
      encoding: 'utf8',
      timeout: 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!fs.existsSync(apkPath)) throw new Error('APK not found after build')
    const apkSize = Math.round(fs.statSync(apkPath).size / 1024 / 1024)
    pass('1.2 APK built', `${apkSize} MB`)
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message).split('\n').filter(l => l.includes('error')).slice(0, 2).join(' | ') || err.message.slice(0, 120)
    fail('1.2 APK built', msg)
    process.exit(1)
  }

  // 1.3 Install APK + ADB reverse port-forward
  try {
    // ADB reverse: device:8099 → host:8099 (must be set before app launch)
    adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)

    // Uninstall (clear state) then install fresh
    try { adb(`uninstall ${BUNDLE_ID}`) } catch { /* not installed, fine */ }
    adb(`install -r "${apkPath}"`)
    pass('1.3 APK installed + ADB reverse configured')
  } catch (err) {
    fail('1.3 APK installed + ADB reverse configured', err.message)
    process.exit(1)
  }

  // ─── Section 2: HTTP Handshake ────────────────────────────────────────────
  // Start HTTP server BEFORE launching the app — the app runs tests immediately
  // after the Capacitor bridge is ready (~1s), so the server must be up first.
  logSection('2 — HTTP Handshake')

  console.log(`  → HTTP result server listening on :${RUNNER_PORT}...`)
  console.log('  → Launching app and waiting for test results (up to 120s)...\n')

  const { allDonePromise } = await startResultServer()

  // 1.4 Launch app (after server is ready)
  try {
    adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`)
    pass('1.4 App launched')
  } catch (err) {
    fail('1.4 App launched', err.message)
    process.exit(1)
  }

  let captureResult
  try {
    captureResult = await allDonePromise
    pass('2.1 All test results received via HTTP', `${captureResult.results.size}/${TOTAL_TESTS} results`)
  } catch (err) {
    fail('2.1 All test results received via HTTP', err.message)
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`  Results: ${passedTests}/${passedTests + failedTests} passed`)
    console.log(`${'═'.repeat(60)}\n`)
    process.exit(1)
  }

  // ─── Section 3: Plugin API Results ───────────────────────────────────────
  logSection('3 — Plugin API Results')

  const ORDER = ['open','store1','store2','upsert','search','list','prefix','delete','after_del','clear','empty']
  let num = 1

  for (const id of ORDER) {
    const name = `3.${num++} ${TEST_NAMES[id] || id}`
    const r = captureResult.results.get(id)
    if (!r) {
      fail(name, 'no result received (test did not run)')
    } else if (r.status === 'pass') {
      pass(name, r.detail || '')
    } else {
      fail(name, r.error || 'failed')
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const total = passedTests + failedTests
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Results: ${passedTests}/${total} passed, ${failedTests} failed`)
  if (captureResult.summary) {
    console.log(`  App reported: ${captureResult.summary.passed}/${captureResult.summary.total} passed`)
  }
  if (failedTests > 0) {
    console.log('\n  Failed tests:')
    testResults.filter(r => r.status === 'FAIL').forEach(r => console.log(`    ❌ ${r.name} — ${r.error}`))
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)

  process.exit(failedTests > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('\n  Fatal error:', err.message)
  process.exit(1)
})
