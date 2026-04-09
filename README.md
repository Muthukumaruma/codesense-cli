# codesense

> AI-powered code quality gate CLI for CI/CD pipelines.

Submit a git diff to [CodeSense AI](https://app.codesense.online), get an AI + static analysis score, and automatically pass or fail your build — all in one command.

```bash
npx @codesenseai/cli check --api-key cs_xxx --diff changes.diff --threshold 70
```

---

## Installation

No installation needed. Use directly with `npx`:

```bash
npx @codesenseai/cli@latest check ...
```

Or install globally:

```bash
npm install -g @codesenseai/cli
```

---

## Prerequisites

- Node.js **18 or later**
- A **CodeSense pipeline API key** — get one at [codesense.online](https://app.codesense.online) → Pipeline → API Keys

---

## Usage

```
codesense check --api-key <key> --diff <file> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--api-key` | Your CodeSense pipeline API key | *(required)* |
| `--diff` | Path to a diff file, or `-` to read from stdin | *(required)* |
| `--threshold` | Minimum score to pass the quality gate | `70` |
| `--host` | Custom API host (self-hosted installs) | `https://api.codesense.online` |
| `--json` | Print the full JSON result instead of formatted output | `false` |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Quality gate **passed** |
| `1` | Quality gate **failed**, or an error occurred |

---

## Examples

### Pipe diff from stdin
```bash
git diff origin/main...HEAD | npx @codesenseai/cli@latest check --api-key cs_xxx --diff -
```

### From a diff file
```bash
git diff origin/main...HEAD > changes.diff
npx @codesenseai/cli@latest check --api-key cs_xxx --diff changes.diff --threshold 80
```

### Check a specific commit
```bash
git show <commit-hash> | npx @codesenseai/cli@latest check --api-key cs_xxx --diff -
```

### Compare a commit against its parent
```bash
git diff <commit-hash>^ <commit-hash> > changes.diff
npx @codesenseai/cli@latest check --api-key cs_xxx --diff changes.diff
```

### Output raw JSON (for custom scripts)
```bash
npx @codesenseai/cli@latest check --api-key cs_xxx --diff - --json < changes.diff
```

---

## Common mistakes

### ❌ Passing a commit hash as `--diff`

```bash
# WRONG — ea58e70a... is not a file path
npx @codesenseai/cli@latest check --api-key cs_xxx --diff ea58e70a88139c8ed2951f465061bcbdb9d6c7b9
# Error: ENOENT: no such file or directory, open '...ea58e70a...'
```

`--diff` expects a **file path** or `-` for stdin, not a git commit hash. Generate the diff first:

```bash
# Correct — pipe the commit's diff via stdin
git show ea58e70a88139c8ed2951f465061bcbdb9d6c7b9 | npx @codesenseai/cli@latest check --api-key cs_xxx --diff -
```

### ❌ Missing `fetch-depth: 0` in GitHub Actions

Without full history, `git diff origin/main...HEAD` may produce an empty diff. Always set:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

---

## Local testing (step-by-step)

Before wiring up CI, verify your key and setup works locally:

**Step 1 — Get your API key**

Sign in at [app.codesense.online](https://app.codesense.online) → **Pipeline** → **API Keys** → click **New Key** → copy it.

**Step 2 — Generate a diff**

```bash
# Changes since last commit
git diff HEAD~1 > changes.diff

# Changes in a specific commit
git show <commit-hash> > changes.diff

# Changes between your branch and main
git diff main...HEAD > changes.diff
```

**Step 3 — Run the check**

```bash
npx @codesenseai/cli@latest check \
  --api-key cs_pipe_YOUR_KEY_HERE \
  --diff changes.diff \
  --threshold 70
```

**Step 4 — Read the result**

- Exit code `0` → passed (score ≥ threshold)
- Exit code `1` → failed (score < threshold, or a high-severity security issue found)

---

## CI/CD Integration

### GitHub Actions

```yaml
name: CodeSense Quality Gate
on: [pull_request]

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate diff
        run: git diff origin/${{ github.base_ref }}...HEAD > changes.diff

      - name: Run CodeSense check
        run: |
          npx @codesenseai/cli@latest check \
            --api-key ${{ secrets.CODESENSE_API_KEY }} \
            --diff changes.diff \
            --threshold 70
```

> Add `CODESENSE_API_KEY` in your repo → Settings → Secrets and variables → Actions.

---

### GitLab CI

```yaml
quality-gate:
  stage: pre-build
  image: node:20-alpine
  script:
    - git diff origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME...HEAD > changes.diff
    - npx @codesenseai/cli@latest check --api-key $CODESENSE_API_KEY --diff changes.diff
  rules:
    - if: $CI_MERGE_REQUEST_ID
```

> Add `CODESENSE_API_KEY` in Settings → CI/CD → Variables.

---

### Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: CodeSense Quality Gate
          image: node:20-alpine
          script:
            - git diff origin/main...HEAD > changes.diff
            - npx @codesenseai/cli@latest check --api-key $CODESENSE_API_KEY --diff changes.diff
```

> Add `CODESENSE_API_KEY` in Repository settings → Repository variables.

---

### Azure DevOps Pipelines

```yaml
trigger: none
pr:
  - main

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    fetchDepth: 0

  - script: git diff origin/$(System.PullRequest.TargetBranch)...HEAD > changes.diff
    displayName: Generate diff

  - script: |
      npx @codesenseai/cli@latest check \
        --api-key $(CODESENSE_API_KEY) \
        --diff changes.diff \
        --threshold 70
    displayName: Run CodeSense Quality Gate
```

> Add `CODESENSE_API_KEY` in Pipelines → Library → Variable groups, marked as secret.

---

### curl / Manual API

If you'd rather call the API directly without the CLI:

```bash
# 1. Submit diff
DIFF=$(git diff HEAD~1)
JOB=$(curl -s -X POST https://api.codesense.online/api/pipeline/analyze \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"diff\": \"$DIFF\", \"threshold\": 70}")

JOB_ID=$(echo $JOB | jq -r '.jobId')

# 2. Poll result
curl -s https://api.codesense.online/api/pipeline/result/$JOB_ID \
  -H "x-api-key: YOUR_API_KEY" | jq '.status,.score'
```

---

## How it works

1. **Submits** your diff to the CodeSense API
2. **Waits** while the engine runs AI analysis + Semgrep static analysis
3. **Scores** the code across Security, Performance, Best Practice, and Style
4. **Prints** a colour-coded summary of issues
5. **Exits** `0` (pass) or `1` (fail) so your CI pipeline reacts automatically

Any **high-severity security issue** causes an immediate fail regardless of score.

---

## Security

- Store your API key as a **CI/CD secret** — never commit it to your repository.
- API keys can be revoked at any time from the [CodeSense dashboard](https://app.codesense.online).
- Each key has a configurable rate limit (requests per minute).

---

## License

MIT © [Muthukumar](https://muthukumar.win)
