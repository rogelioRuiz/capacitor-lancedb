#!/usr/bin/env node
/**
 * capacitor-lancedb iOS Simulator E2E Test Suite
 *
 * Approach: HTTP server on localhost:8099.
 *   - index.html POSTs __LANCEDB_TEST__ results and __LANCEDB_DONE__ to this server
 *   - iOS Simulator shares the Mac's loopback, so fetch('http://localhost:8099') works
 *
 * Sections:
 *   1  Simulator Setup   (4 tests)
 *   2  HTTP Handshake    (1 test)
 *   3  Plugin API        (11 legacy + 5 generic = 16 tests)
 */

import { execSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const BUNDLE_ID    = 'io.t6x.lancedb.test'
const RUNNER_PORT  = 8099
const TOTAL_TESTS  = 28
const TIMEOUT_MS   = 120_000

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

// ─── simctl helpers ───────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, { encoding: 'utf8', timeout: 30000, ...opts }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === 'Booted') return d.udid
    }
  }
  return null
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
  // Legacy memory-prefixed API
  open:       'open() — initialise database',
  store1:     'memoryStore() — insert entry A',
  store2:     'memoryStore() — insert entry B',
  upsert:     'memoryStore() — upsert (overwrite) entry A',
  search:     'memorySearch() — finds A nearest to query',
  list:       'memoryList() — returns both keys',
  prefix:     'memoryList(prefix) — filters by prefix',
  delete:     'memoryDelete() — removes entry B',
  after_del:  'memoryList() after delete — only A remains',
  clear:      'memoryClear() — drops all data',
  empty:      'memoryList() after clear — empty',
  // Generic vector DB API
  gen_store:  'store() — generic insert',
  gen_search: 'search() — generic vector search',
  gen_list:   'list() — generic list keys',
  gen_delete: 'delete() — generic delete',
  gen_clear:  'clear() — generic drop all',
  // Hybrid search (RRF + BM25)
  hybrid_basic:      'hybridSearch() — RRF-ranked results',
  hybrid_text_boost: 'hybridSearch() — text match boosts ranking',
  hybrid_filter:     'hybridSearch() — filter excludes items',
  hybrid_empty_text: 'hybridSearch() — empty text falls back to vector',
  // Kuzu Graph Adapter (mock KuzuConnection)
  kuzu_init:       'KuzuGraphAdapter — open + schema init',
  kuzu_add_entity: 'KuzuGraphAdapter — add entity',
  kuzu_add_rel:    'KuzuGraphAdapter — add relation',
  kuzu_query:      'KuzuGraphAdapter — query with filters',
  kuzu_multi_hop:  'KuzuGraphAdapter — multi-hop expansion',
  kuzu_context:    'KuzuGraphAdapter — entity context text',
  kuzu_temporal:   'KuzuGraphAdapter — temporal invalidation',
  kuzu_hubs:       'KuzuGraphAdapter — hub discovery',
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🔵 capacitor-lancedb iOS Simulator E2E Test Suite\n')

  // ─── Section 1: Simulator Setup ──────────────────────────────────────────
  logSection('1 — Simulator Setup')

  // 1.1 Find booted simulator
  let udid
  try {
    udid = getBootedUDID()
    if (!udid) throw new Error('No booted simulator found')
    pass('1.1 Booted simulator found', `UDID ${udid}`)
  } catch (err) {
    fail('1.1 Booted simulator found', err.message)
    console.error('\nFatal: no booted simulator.\n')
    process.exit(1)
  }

  // 1.2 Sync web assets into Xcode project
  try {
    console.log('  → Running cap sync ios...')
    const nodePath = execSync('which node', { encoding: 'utf8' }).trim()
    const npmPath  = execSync('which npm',  { encoding: 'utf8' }).trim()
    const npxPath  = path.join(path.dirname(npmPath), 'npx')
    execSync(`${npxPath} cap sync ios`, {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(nodePath)}:${process.env.PATH}` }
    })
    pass('1.2 cap sync ios succeeded')
  } catch (err) {
    fail('1.2 cap sync ios succeeded', (err.stderr || err.message).slice(0, 120))
    // non-fatal — continue with existing assets
  }

  // 1.3 Build for simulator
  try {
    console.log('  → Building (xcodebuild)...')
    execSync(
      `xcodebuild -scheme App -sdk iphonesimulator ` +
      `-destination "platform=iOS Simulator,id=${udid}" -configuration Debug ` +
      `-derivedDataPath build build`,
      { cwd: path.join(__dirname, 'ios/App'), encoding: 'utf8', timeout: 300000,
        stdio: ['ignore', 'pipe', 'pipe'] }
    )
    pass('1.3 xcodebuild succeeded')
  } catch (err) {
    const lines = (err.stderr || err.stdout || err.message).split('\n')
    const errorLines = lines.filter(l => l.includes('error:')).slice(0, 3).join(' | ')
    fail('1.3 xcodebuild succeeded', errorLines || 'build failed')
    process.exit(1)
  }

  // 1.4 Install app (don't launch yet — server must be up first)
  let appPath
  try {
    // Find the .app in local build dir or DerivedData
    const localBuild = path.join(__dirname, 'ios/App/build/Build/Products/Debug-iphonesimulator/App.app')
    const ddOut = execSync(
      `find ~/Library/Developer/Xcode/DerivedData -name "App.app" -path "*/Debug-iphonesimulator/*" -not -path "*PlugIns*" 2>/dev/null | head -1`,
      { encoding: 'utf8', shell: true }
    ).trim()
    appPath = fs.existsSync(localBuild) ? localBuild : ddOut
    if (!appPath) throw new Error('App.app not found in build dir or DerivedData')

    simctl(`install ${udid} "${appPath}"`)
    try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
    pass('1.4 App installed')
  } catch (err) {
    fail('1.4 App installed', err.message)
    process.exit(1)
  }

  // ─── Section 2: HTTP Handshake ────────────────────────────────────────────
  // Start HTTP server BEFORE launching the app — the app runs tests immediately
  // after the Capacitor bridge is ready, so the server must be up first.
  logSection('2 — HTTP Handshake')

  console.log(`  → HTTP result server listening on :${RUNNER_PORT}...`)

  const { allDonePromise } = await startResultServer()

  // Launch app now that the server is ready
  try {
    simctl(`launch ${udid} ${BUNDLE_ID}`)
    console.log('  → App launched. Waiting for test results (up to 120s)...\n')
  } catch (err) {
    fail('2.0 App launch', err.message)
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

  const ORDER = ['open','store1','store2','upsert','search','list','prefix','delete','after_del','clear','empty','gen_store','gen_search','gen_list','gen_delete','gen_clear','hybrid_basic','hybrid_text_boost','hybrid_filter','hybrid_empty_text','kuzu_init','kuzu_add_entity','kuzu_add_rel','kuzu_query','kuzu_multi_hop','kuzu_context','kuzu_temporal','kuzu_hubs']
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
