#!/usr/bin/env node
/**
 * codesense CLI — @codesenseai/cli
 * Usage: npx @codesenseai/cli check --api-key <key> --diff <file> [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { resolve, dirname, join } from 'path'
import { homedir } from 'os'

// ── Spinner (no deps) ────────────────────────────────────────────────────────
function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const id = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${text}   `)
  }, 80)
  return {
    stop(finalLine) {
      clearInterval(id)
      process.stdout.write(`\r${finalLine}\n`)
    }
  }
}

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
const clr  = (col, str) => `${col}${str}${c.reset}`
const bold = str => clr(c.bold, str)
const dim  = str => clr(c.dim, str)

// ── .codesenserc loader ──────────────────────────────────────────────────────
function loadRc() {
  let dir = process.cwd()
  const home = homedir()
  while (true) {
    for (const name of ['.codesenserc', '.codesenserc.json']) {
      const p = join(dir, name)
      if (existsSync(p)) {
        try {
          const rc = JSON.parse(readFileSync(p, 'utf8'))
          return { ...rc, _file: p }
        } catch {
          process.stderr.write(`  Warning: could not parse ${p} — ignoring\n`)
          return {}
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }
  return {}
}

// ── Arg parser ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key  = a.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        args[key] = true
      } else {
        i++
        // accumulate repeated flags into arrays (e.g. --ignore a --ignore b)
        if (key in args) {
          args[key] = [].concat(args[key], next)
        } else {
          args[key] = next
        }
      }
    }
  }
  return args
}

// ── HTTP helper (native — no deps) ──────────────────────────────────────────
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
  if (body) {
    opts.body = JSON.stringify(body)
    opts.headers['Content-Type'] = 'application/json'
  }
  let res
  try {
    res = await fetch(url, opts)
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw Object.assign(new Error(`Request timed out after ${timeoutMs / 1000}s`), { code: 'TIMEOUT' })
    }
    throw Object.assign(new Error(`Could not reach server (${e.message})`), { code: 'NETWORK' })
  }
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
  const lines = []
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) lines.push(line)
  return lines.join('\n')
}

// ── Poll until done ──────────────────────────────────────────────────────────
const LIVE = new Set(['queued', 'processing', 'running'])
const POLL_MS    = 2500
const MAX_WAIT_MS = 5 * 60 * 1000

async function pollResult(host, apiKey, jobId) {
  const url     = `${host}/api/pipeline/result/${jobId}`
  const headers = { 'x-api-key': apiKey }
  const start   = Date.now()
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
  const CAT_LABEL = { security: '🔒 Security', performance: '⚡ Performance', best_practice: '📐 Best Practice', style: '🎨 Style' }

  for (const [sev, list] of Object.entries(bySeverity)) {
    if (!list.length) continue
    for (const issue of list) {
      const loc = issue.line > 0 ? `:${issue.line}` : ''
      const cat = CAT_LABEL[issue.category] || issue.category || ''
      const src = issue.source === 'static' ? dim(' [static]') : dim(' [ai]')
      console.log(`  ${clr(SEV_COLOR[sev], `[${sev.toUpperCase()}]`)} ${cat}${src}`)
      console.log(`  ${dim('→')} ${dim(issue.file + loc)}`)
      console.log(`    ${bold(issue.message)}`)
      if (issue.suggestion) console.log(`    ${clr(c.cyan, 'Fix:')} ${issue.suggestion}`)
      console.log()
    }
  }
}

// ── Score breakdown ──────────────────────────────────────────────────────────
function printBreakdown(breakdown) {
  if (!breakdown) return
  const categories = ['security', 'performance', 'best_practice', 'style']
  const CAT_LABEL  = { security: 'Security', performance: 'Performance', best_practice: 'Best Practice', style: 'Style' }
  console.log(`  ${bold('Score breakdown:')}`)
  for (const cat of categories) {
    const b = breakdown[cat]
    if (!b) continue
    const bar       = '█'.repeat(Math.round(b.score / 10)) + '░'.repeat(10 - Math.round(b.score / 10))
    const scoreCol  = b.score >= 80 ? c.green : b.score >= 60 ? c.yellow : c.red
    const issuesTxt = b.issueCount > 0 ? dim(` (${b.issueCount} issue${b.issueCount !== 1 ? 's' : ''})`) : ''
    console.log(`  ${(CAT_LABEL[cat] + ':').padEnd(16)} ${clr(scoreCol, bar)} ${clr(scoreCol, String(b.score).padStart(3))}${issuesTxt}`)
  }
  console.log()
}

// ── HTML report generator ────────────────────────────────────────────────────
function generateHtmlReport(result) {
  const { score, threshold, status, summary, filesAnalyzed, breakdown, issues = [], repo, branch, commitSha, duration } = result
  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444'
  const statusColor = status === 'pass' ? '#10b981' : '#ef4444'
  const pct = Math.min(100, score)
  const dash = 2 * Math.PI * 54
  const offset = dash - (pct / 100) * dash

  const cats = ['security', 'performance', 'best_practice', 'style']
  const catLabels = { security: '🔒 Security', performance: '⚡ Performance', best_practice: '📐 Best Practice', style: '🎨 Style' }
  const sevColors = { high: '#ef4444', medium: '#f59e0b', low: '#94a3b8' }

  const issueRows = issues.map(i => {
    const sev = i.severity || 'low'
    return `<tr>
      <td><span style="color:${sevColors[sev] || '#94a3b8'};font-weight:700">${sev.toUpperCase()}</span></td>
      <td>${catLabels[i.category] || i.category || ''}</td>
      <td style="font-family:monospace;font-size:12px">${i.file || ''}${i.line ? ':' + i.line : ''}</td>
      <td>${i.message || ''}</td>
      <td style="color:#6366f1">${i.suggestion || ''}</td>
    </tr>`
  }).join('')

  const breakdownRows = cats.map(cat => {
    const b = breakdown?.[cat]
    if (!b) return ''
    const bc = b.score >= 80 ? '#10b981' : b.score >= 60 ? '#f59e0b' : '#ef4444'
    const w  = Math.min(100, b.score)
    return `<tr>
      <td>${catLabels[cat]}</td>
      <td><div style="background:#e2e8f0;border-radius:4px;height:8px;width:200px">
        <div style="background:${bc};height:8px;border-radius:4px;width:${w}%"></div></div></td>
      <td style="color:${bc};font-weight:700">${b.score}</td>
      <td style="color:#64748b">${b.issueCount} issue${b.issueCount !== 1 ? 's' : ''}</td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSense Report${repo ? ' — ' + repo : ''}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,system-ui,sans-serif;background:#f8fafc;color:#0f172a;padding:32px 16px}
  .card{background:#fff;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 1px 8px rgba(0,0,0,.07)}
  h1{font-size:22px;font-weight:800;color:#6366f1}
  h2{font-size:16px;font-weight:700;margin-bottom:16px;color:#0f172a}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;background:#f1f5f9;font-weight:600;color:#475569}
  td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  .meta{display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:#64748b;margin-top:8px}
  .meta span{background:#f1f5f9;padding:4px 10px;border-radius:6px}
  .badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:13px}
</style>
</head>
<body>
<div style="max-width:900px;margin:0 auto">
  <div class="card" style="display:flex;align-items:center;gap:32px;flex-wrap:wrap">
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="54" fill="none" stroke="#e2e8f0" stroke-width="10"/>
      <circle cx="60" cy="60" r="54" fill="none" stroke="${scoreColor}" stroke-width="10"
        stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
        stroke-linecap="round" transform="rotate(-90 60 60)"/>
      <text x="60" y="56" text-anchor="middle" font-size="28" font-weight="900" fill="${scoreColor}">${score}</text>
      <text x="60" y="74" text-anchor="middle" font-size="12" fill="#64748b">/ 100</text>
    </svg>
    <div>
      <h1>CodeSense AI — Code Review Report</h1>
      <div class="meta">
        ${repo ? `<span>📦 ${repo}</span>` : ''}
        ${branch ? `<span>🌿 ${branch}</span>` : ''}
        ${commitSha ? `<span>🔖 ${commitSha.slice(0, 7)}</span>` : ''}
        ${filesAnalyzed ? `<span>📁 ${filesAnalyzed} files</span>` : ''}
        ${duration ? `<span>⏱ ${(duration / 1000).toFixed(1)}s</span>` : ''}
        <span>Threshold: ${threshold}</span>
      </div>
      <div style="margin-top:12px">
        <span class="badge" style="background:${statusColor}20;color:${statusColor}">${status === 'pass' ? '✓ PASS' : '✗ FAIL'}</span>
      </div>
      ${summary ? `<p style="margin-top:10px;font-size:13px;color:#475569">${summary}</p>` : ''}
    </div>
  </div>

  ${breakdown ? `<div class="card">
    <h2>Score Breakdown</h2>
    <table><tbody>${breakdownRows}</tbody></table>
  </div>` : ''}

  ${issues.length > 0 ? `<div class="card">
    <h2>${issues.length} Issue${issues.length !== 1 ? 's' : ''} Found</h2>
    <table>
      <thead><tr><th>Severity</th><th>Category</th><th>Location</th><th>Issue</th><th>Suggestion</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table>
  </div>` : `<div class="card" style="text-align:center;color:#10b981;font-weight:600">✓ No issues found</div>`}

  <div style="text-align:center;font-size:12px;color:#94a3b8;margin-top:8px">
    Generated by <strong>CodeSense AI</strong> · ${new Date().toUTCString()}
  </div>
</div>
</body></html>`
}

// ── init-ci: generate GitHub Actions workflow ────────────────────────────────
async function runInitCi() {
  const workflowDir  = join(process.cwd(), '.github', 'workflows')
  const workflowFile = join(workflowDir, 'codesense.yml')

  if (existsSync(workflowFile)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise(resolve => rl.question(`  ${clr(c.yellow, 'codesense.yml already exists.')} Overwrite? (y/N) `, resolve))
    rl.close()
    if (String(answer).toLowerCase() !== 'y') {
      console.log(dim('  Aborted.'))
      return
    }
  }

  mkdirSync(workflowDir, { recursive: true })

  const yaml = `name: CodeSense Quality Gate

on:
  pull_request:
    branches: ['**']
  push:
    branches: [main, master, dev]

jobs:
  codesense:
    name: AI Code Review
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate diff
        run: |
          if [ "\${{ github.event_name }}" = "pull_request" ]; then
            git diff origin/\${{ github.base_ref }}...HEAD > diff.patch
          else
            git diff \${{ github.event.before }}...\${{ github.sha }} > diff.patch
          fi

      - name: Run CodeSense Quality Gate
        run: npx @codesenseai/cli@latest check --api-key \${{ secrets.CODESENSE_API_KEY }} --diff diff.patch --threshold 70
`

  writeFileSync(workflowFile, yaml)
  console.log(`  ${clr(c.green, '✓')} Created ${bold('.github/workflows/codesense.yml')}`)
  console.log()
  console.log(`  ${bold('Next steps:')}`)
  console.log(`  1. Go to your GitHub repo ${dim('→')} Settings ${dim('→')} Secrets and variables ${dim('→')} Actions`)
  console.log(`  2. Add a secret named ${bold('CODESENSE_API_KEY')} with your pipeline API key`)
  console.log(`  3. Commit and push the workflow file`)
  console.log()
  console.log(dim('  Generate a pipeline API key at: https://app.codesense.online → Settings → Pipeline Keys'))
  console.log()
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
${bold('codesense')} — AI-powered code quality gate

${bold('Usage:')}
  npx @codesenseai/cli check   --api-key <key> --diff <file> [options]
  npx @codesenseai/cli init-ci

${bold('Commands:')}
  check     Submit a diff for analysis and wait for result
  init-ci   Generate a GitHub Actions workflow file

${bold('Options (check):')}
  --api-key   <key>     Your CodeSense pipeline API key  ${clr(c.red, '(required)')}
  --diff      <file>    Path to diff file, or "-" for stdin  ${clr(c.red, '(required)')}
  --threshold <n>       Minimum score to pass (default: 70)
  --host      <url>     API host (default: https://api.codesense.online)
  --ignore    <glob>    Ignore files matching pattern (repeatable)
  --output    <file>    Save HTML report to file (e.g. report.html)
  --json                Output raw JSON result
  --print-config        Show resolved config and exit

${bold('.codesenserc')} (project config file — JSON):
  { "apiKey": "cs_pipe_...", "threshold": 80, "host": "...", "ignorePatterns": ["dist/**"] }

${bold('Examples:')}
  git diff HEAD~1 | npx @codesenseai/cli check --api-key cs_xxx --diff -
  npx @codesenseai/cli check --api-key cs_xxx --diff changes.diff --threshold 80
  npx @codesenseai/cli check --api-key cs_xxx --diff - --output report.html
  npx @codesenseai/cli check --diff - --ignore "dist/**" --ignore "*.min.js"
  npx @codesenseai/cli init-ci

${bold('Exit codes:')}
  0  Quality gate passed
  1  Quality gate failed or error
`)
    process.exit(0)
  }

  if (command === 'init-ci') {
    await runInitCi()
    process.exit(0)
  }

  if (command !== 'check') {
    console.error(`Unknown command: ${command}. Run "npx @codesenseai/cli help" for usage.`)
    process.exit(1)
  }

  // ── Load config ────────────────────────────────────────────────────────────
  const rc   = loadRc()
  const args = parseArgs(rest)

  const apiKey    = args['api-key']   ?? rc.apiKey
  const threshold = args['threshold'] != null
    ? parseInt(args['threshold'], 10)
    : (rc.threshold ?? 70)
  const host      = ((args['host'] ?? rc.host ?? 'https://api.codesense.online')).replace(/\/$/, '')
  const diffPath  = args['diff']
  const outputFile = args['output'] ?? null
  const jsonOut   = !!args['json']

  // --ignore accumulates into array; merge with rc.ignorePatterns
  const argsIgnore = args['ignore'] ? [].concat(args['ignore']) : []
  const ignorePatterns = [...(rc.ignorePatterns ?? []), ...argsIgnore]

  // ── --print-config diagnostic ──────────────────────────────────────────────
  if (args['print-config']) {
    console.log()
    console.log(bold('Resolved config:'))
    console.log(`  api-key:        ${apiKey ? '***' + String(apiKey).slice(-4) : clr(c.red, 'NOT SET')}`)
    console.log(`  host:           ${host}`)
    console.log(`  threshold:      ${threshold}`)
    console.log(`  ignorePatterns: ${ignorePatterns.length ? ignorePatterns.join(', ') : '(none)'}`)
    if (rc._file) console.log(`  config file:    ${rc._file}`)
    console.log()
    process.exit(0)
  }

  if (!apiKey) { console.error(clr(c.red, 'Error: --api-key is required (or set apiKey in .codesenserc)')); process.exit(1) }
  if (!diffPath) { console.error(clr(c.red, 'Error: --diff is required')); process.exit(1) }

  console.log()
  console.log(`${bold('CodeSense')} Quality Gate`)
  console.log(dim(`  host: ${host}  threshold: ${threshold}`))
  if (ignorePatterns.length) console.log(dim(`  ignoring: ${ignorePatterns.join(', ')}`))
  if (rc._file) console.log(dim(`  config: ${rc._file}`))
  console.log()

  // ── Read diff ──────────────────────────────────────────────────────────────
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

  const MAX_DIFF_BYTES = 300000
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    console.log(clr(c.yellow, '  ⚠ Diff is large — truncating to first 300 KB for analysis.'))
    console.log(dim('  Tip: use "git diff HEAD~1" or a specific commit range for faster results.'))
    console.log()
    diff = diff.slice(0, MAX_DIFF_BYTES)
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  let jobId
  try {
    const spin = spinner('Submitting diff...')
    const res = await request(`${host}/api/pipeline/analyze`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { diff, threshold, config: { ignorePatterns } },
      timeoutMs: 120000,
    })
    jobId = res.jobId
    spin.stop(`  ${clr(c.green, '✓')} Submitted — job ${dim(jobId)}`)
  } catch (e) {
    process.stdout.write('\n')
    console.error(clr(c.red, `  Error submitting diff: ${e.message}`))
    if (e.code === 'NETWORK') console.error(dim('  Cannot reach the server. Check your internet connection or --host value.'))
    if (e.code === 'TIMEOUT') console.error(dim('  Server did not respond in time. It may be starting up — retry in 30 seconds.'))
    if (e.status === 401) console.error(dim('  Check your --api-key value.'))
    if (e.status === 413) console.error(dim('  Diff is too large. Try a smaller range: git diff HEAD~1'))
    if (e.status === 429) console.error(dim('  Rate limit exceeded — wait a minute and retry.'))
    if (e.status === 503) console.error(dim('  Server queue is temporarily unavailable. Retry in 30 seconds.'))
    process.exit(1)
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  let result
  try {
    result = await pollResult(host, apiKey, jobId)
    process.stdout.write('\n')
  } catch (e) {
    process.stdout.write('\n')
    console.error(clr(c.red, `  Polling error: ${e.message}`))
    process.exit(1)
  }

  // ── JSON output ────────────────────────────────────────────────────────────
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.status === 'pass' ? 0 : 1)
  }

  // ── HTML report ────────────────────────────────────────────────────────────
  if (outputFile) {
    try {
      writeFileSync(outputFile, generateHtmlReport(result))
      console.log(`  ${clr(c.green, '✓')} Report saved to ${bold(outputFile)}`)
    } catch (e) {
      console.error(clr(c.red, `  Could not write report: ${e.message}`))
    }
  }

  // ── Human output ──────────────────────────────────────────────────────────
  const passed      = result.status === 'pass'
  const scoreColor  = passed ? c.green : c.red
  const statusIcon  = passed ? clr(c.green, '✓ PASS') : clr(c.red, '✗ FAIL')

  console.log(`  Status:  ${bold(statusIcon)}`)
  console.log(`  Score:   ${clr(scoreColor, bold(result.score))} / ${threshold} required`)
  if (result.filesAnalyzed) console.log(`  Files:   ${dim(result.filesAnalyzed + ' analyzed')}`)
  if (result.summary) console.log(`  Summary: ${dim(result.summary)}`)
  console.log()

  printBreakdown(result.breakdown)

  const issueCount = result.issues?.length ?? 0
  if (issueCount > 0) {
    console.log(`  ${bold(issueCount + ' issue' + (issueCount !== 1 ? 's' : '') + ' found:')}`)
    console.log()
    printIssues(result.issues)
  } else if (passed) {
    console.log(`  ${clr(c.green, 'No issues found.')}`)
    console.log()
  }

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
