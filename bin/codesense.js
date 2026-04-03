#!/usr/bin/env node
/**
 * codesense CLI
 * Usage: npx codesense check --api-key <key> --diff <file> [--threshold 70] [--host https://api.codesense.online]
 */

import { readFileSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

// ── Colours (no deps) ────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
}
const clr = (col, str) => `${col}${str}${c.reset}`
const bold = str => clr(c.bold, str)
const dim  = str => clr(c.dim, str)

// ── Arg parser ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      args[key] = (!next || next.startsWith('--')) ? true : (i++, next)
    }
  }
  return args
}

// ── HTTP helper (native — no deps) ──────────────────────────────────────────
async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers }
  if (body) {
    opts.body = JSON.stringify(body)
    opts.headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(url, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { message: text } }
  if (!res.ok) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { status: res.status, data })
  return data
}

// ── Read diff from file or stdin ─────────────────────────────────────────────
async function readDiff(filePath) {
  if (filePath && filePath !== '-') {
    return readFileSync(filePath, 'utf8')
  }
  // stdin
  const lines = []
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) lines.push(line)
  return lines.join('\n')
}

// ── Poll until done ──────────────────────────────────────────────────────────
const LIVE = new Set(['queued', 'processing', 'running'])
const POLL_MS = 2500
const MAX_WAIT_MS = 5 * 60 * 1000  // 5 min

async function pollResult(host, apiKey, jobId) {
  const url = `${host}/api/pipeline/result/${jobId}`
  const headers = { 'x-api-key': apiKey }
  const start = Date.now()
  let dots = 0

  while (true) {
    const data = await request(url, { headers })
    if (!LIVE.has(data.status)) return data

    dots++
    process.stdout.write(`\r${dim(`  Analyzing${'.'.repeat((dots % 3) + 1)}   `)}`)

    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error('Timed out waiting for result (5 min). Check the dashboard.')
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

// ── Print issues ─────────────────────────────────────────────────────────────
function printIssues(issues) {
  const bySeverity = { high: [], medium: [], low: [] }
  for (const issue of issues) {
    (bySeverity[issue.severity] ?? bySeverity.low).push(issue)
  }

  const SEV_COLOR = { high: c.red, medium: c.yellow, low: c.dim }

  for (const [sev, list] of Object.entries(bySeverity)) {
    if (!list.length) continue
    for (const issue of list) {
      const loc = issue.line > 0 ? `:${issue.line}` : ''
      console.log(`  ${clr(SEV_COLOR[sev], `[${sev.toUpperCase()}]`)} ${dim(issue.file + loc)}`)
      console.log(`    ${bold(issue.message)}`)
      if (issue.suggestion) console.log(`    ${dim('Fix: ' + issue.suggestion)}`)
      console.log()
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
${bold('codesense')} — AI-powered code quality gate

${bold('Usage:')}
  npx codesense check --api-key <key> --diff <file> [options]

${bold('Commands:')}
  check     Submit a diff for analysis and wait for result

${bold('Options:')}
  --api-key   <key>   Your CodeSense pipeline API key  ${clr(c.red, '(required)')}
  --diff      <file>  Path to diff file, or "-" for stdin  ${clr(c.red, '(required)')}
  --threshold <n>     Minimum score to pass (default: 70)
  --host      <url>   API host (default: https://api.codesense.online)
  --json              Output raw JSON result

${bold('Examples:')}
  git diff HEAD~1 | npx codesense check --api-key cs_xxx --diff -
  npx codesense check --api-key cs_xxx --diff changes.diff --threshold 80

${bold('Exit codes:')}
  0  Quality gate passed
  1  Quality gate failed or error
`)
    process.exit(0)
  }

  if (command !== 'check') {
    console.error(`Unknown command: ${command}. Run "npx codesense help" for usage.`)
    process.exit(1)
  }

  const args = parseArgs(rest)
  const apiKey    = args['api-key']
  const diffPath  = args['diff']
  const threshold = parseInt(args['threshold'] ?? '70', 10)
  const host      = (args['host'] ?? 'https://api.codesense.online').replace(/\/$/, '')
  const jsonOut   = !!args['json']

  if (!apiKey) { console.error(clr(c.red, 'Error: --api-key is required')); process.exit(1) }
  if (!diffPath) { console.error(clr(c.red, 'Error: --diff is required')); process.exit(1) }

  console.log()
  console.log(`${bold('CodeSense')} Quality Gate`)
  console.log(dim(`  host: ${host}  threshold: ${threshold}`))
  console.log()

  // 1. Read diff
  let diff
  try {
    diff = await readDiff(diffPath)
  } catch (e) {
    console.error(clr(c.red, `Error reading diff: ${e.message}`))
    process.exit(1)
  }

  if (!diff.trim()) {
    console.log(clr(c.yellow, '  No diff content — nothing to analyze.'))
    console.log(dim('  Skipping quality gate.'))
    console.log()
    process.exit(0)
  }

  // 2. Submit
  let jobId
  try {
    process.stdout.write(dim('  Submitting diff...'))
    const res = await request(`${host}/api/pipeline/analyze`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { diff, threshold },
    })
    jobId = res.jobId
    process.stdout.write(`\r  ${clr(c.green, '✓')} Submitted — job ${dim(jobId)}\n`)
  } catch (e) {
    process.stdout.write('\n')
    console.error(clr(c.red, `  Error submitting diff: ${e.message}`))
    if (e.status === 401) console.error(dim('  Check your --api-key value.'))
    if (e.status === 429) console.error(dim('  Rate limit exceeded — wait a minute and retry.'))
    process.exit(1)
  }

  // 3. Poll
  let result
  try {
    result = await pollResult(host, apiKey, jobId)
    process.stdout.write('\n')
  } catch (e) {
    process.stdout.write('\n')
    console.error(clr(c.red, `  Polling error: ${e.message}`))
    process.exit(1)
  }

  // 4. Output
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.status === 'pass' ? 0 : 1)
  }

  const passed = result.status === 'pass'
  const scoreColor = passed ? c.green : c.red
  const statusIcon = passed ? clr(c.green, '✓ PASS') : clr(c.red, '✗ FAIL')

  console.log(`  Status:  ${bold(statusIcon)}`)
  console.log(`  Score:   ${clr(scoreColor, bold(result.score))} / ${threshold} required`)
  if (result.summary) console.log(`  Summary: ${dim(result.summary)}`)

  const issueCount = result.issues?.length ?? 0
  if (issueCount > 0) {
    console.log()
    console.log(`  ${bold(issueCount + ' issue' + (issueCount !== 1 ? 's' : '') + ' found:')}`)
    console.log()
    printIssues(result.issues)
  } else if (passed) {
    console.log()
    console.log(`  ${clr(c.green, 'No issues found.')}`)
  }

  console.log()

  if (!passed) {
    const hi = result.issues?.filter(i => i.severity === 'high').length ?? 0
    if (hi > 0) {
      console.log(clr(c.red, `  ${hi} high-severity issue${hi !== 1 ? 's' : ''} — quality gate blocked.`))
    } else {
      console.log(clr(c.red, `  Score ${result.score} is below threshold ${threshold} — quality gate failed.`))
    }
    console.log()
  }

  process.exit(passed ? 0 : 1)
}

main().catch(e => {
  console.error(clr('\x1b[31m', `Unexpected error: ${e.message}`))
  process.exit(1)
})
