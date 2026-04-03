# codesense

> AI-powered code quality gate CLI for CI/CD pipelines.

Submit a git diff to [CodeSense AI](https://codesense.online), get an AI + static analysis score, and automatically pass or fail your build — all in one command.

```bash
npx codesense check --api-key cs_xxx --diff changes.diff --threshold 70
```

---

## Installation

No installation needed. Use directly with `npx`:

```bash
npx codesense@latest check ...
```

Or install globally:

```bash
npm install -g codesense
```

---

## Prerequisites

- Node.js **18 or later**
- A **CodeSense pipeline API key** — get one at [codesense.online](https://codesense.online) → Pipeline → API Keys

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
git diff origin/main...HEAD | npx codesense check --api-key cs_xxx --diff -
```

### From a diff file
```bash
git diff origin/main...HEAD > changes.diff
npx codesense check --api-key cs_xxx --diff changes.diff --threshold 80
```

### Output raw JSON (for custom scripts)
```bash
npx codesense check --api-key cs_xxx --diff - --json < changes.diff
```

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
          npx codesense@latest check \
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
    - npx codesense@latest check --api-key $CODESENSE_API_KEY --diff changes.diff
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
            - npx codesense@latest check --api-key $CODESENSE_API_KEY --diff changes.diff
```

> Add `CODESENSE_API_KEY` in Repository settings → Repository variables.

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
- API keys can be revoked at any time from the [CodeSense dashboard](https://codesense.online).
- Each key has a configurable rate limit (requests per minute).

---

## License

MIT © [Muthukumar](https://muthukumar.win)
