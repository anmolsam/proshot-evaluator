# Proshot Evaluator

**Automated AI quality assurance for Proshot meeting intelligence — using Claude and GPT-4o as independent judges.**

Proshot Evaluator is a production-grade pipeline that continuously audits your Proshot AI outputs (summaries, action items, CRM fields) against raw meeting transcripts. Two AI judges evaluate independently, a tiebreaker resolves disagreements with evidence, human reviewers handle edge cases, and every verdict is logged to Airtable. The system learns over time — each disputed case generates a prompt rule that reduces future disagreements.

---

## Why This Exists

AI meeting tools like Proshot are only as valuable as their accuracy. Without a systematic way to measure output quality, errors go undetected:

- Missed action items that never get assigned
- Wrong deal stages pushed into your CRM
- Competitor mentions and objections that vanish from the record
- Summaries that confidently misrepresent what was actually said

This system puts a rigorous, automated QA layer on top of Proshot — scoring every meeting, surfacing every miss, and building institutional knowledge about where Proshot's models consistently struggle.

---

## How It Works (60-second version)

```
Meeting Transcript + Proshot Output
           │
    ┌──────┴──────┐
    │             │
 Claude        GPT-4o
 Judge         Judge
    │             │
    └──────┬──────┘
           │
    Scores within 20 pts?
    ┌──────┴──────┐
   YES            NO
    │              │
 Average       Tiebreaker
 scores        (dissenter must
    │           cite evidence)
    │              │
    │         Evidence found?
    │         ┌────┴────┐
    │        YES        NO
    │         │          │
    │       Yellow    Use higher
    │      (human     score
    │      review)
    │
 Green (≥80) / Yellow (40-79) / Red (<40)
           │
      Airtable log
           │
      Dashboard
```

1. **Two independent judges** (Claude Opus 4.6 + GPT-4o) evaluate the same meeting, in parallel, without seeing each other's scores
2. **If they agree** (within 20 points) → average their scores, assign green/yellow/red
3. **If they disagree** → the lower-scoring judge is asked to re-read the transcript and cite specific evidence
4. **If evidence is found** → Proshot was wrong, case flagged yellow for human review
5. **If no evidence is found** → dissenter concedes, higher score wins
6. **Every disputed case** generates a prompt rule that prevents the same disagreement in future evaluations

---

## Features

| Feature | Description |
|---|---|
| **Dual-judge evaluation** | Claude Opus 4.6 + GPT-4o score independently — eliminates single-model bias |
| **Evidence-based tiebreaker** | Dissenters must prove their case with transcript quotes, not assertions |
| **Adaptive thinking** | Claude uses `thinking: {type: "adaptive"}` — reasons deeply on ambiguous meetings |
| **Self-improving prompts** | Tiebreaker verdicts auto-generate evaluation rules, reducing yellows over time |
| **Airtable logging** | Full evaluation record stored in Airtable with scores, verdicts, and reasoning |
| **Human review queue** | Yellow meetings surface for human decision with one-click verdict saving |
| **Dashboard** | Real-time web UI showing scores, trends, missed insights, and prompt rules |
| **CLI + API** | Evaluate a single meeting or batch-process a week of calls from the command line |
| **File fallback** | If Proshot API is unavailable, load meeting data from local JSON |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js | Fast, async-first, excellent for parallel API calls |
| AI Judge 1 | Anthropic Claude Opus 4.6 | Primary evaluator — adaptive thinking for deep reasoning |
| AI Judge 2 | OpenAI GPT-4o | Independent evaluator — different training, different blind spots |
| Orchestration | `@anthropic-ai/sdk` + `openai` | Official SDKs with streaming and retry support |
| Storage | Airtable REST API | Human-friendly database for evaluations and rules |
| API Server | Express.js | Lightweight REST endpoints + static file serving |
| Dashboard | Vanilla JS + HTML | Zero-dependency frontend, loads instantly |
| Config | dotenv | Environment-based secrets management |
| Data Source | Proshot REST API | Fetches meeting transcripts and AI outputs |

---

## Quick Start

### Prerequisites

- Node.js 18+
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- OpenAI API key ([platform.openai.com](https://platform.openai.com))
- Airtable account + token ([airtable.com](https://airtable.com)) *(optional — skipped gracefully if not configured)*
- Proshot API key *(optional — file fallback available)*

### Installation

```bash
git clone https://github.com/anmolsam/proshot-evaluator.git
cd proshot-evaluator
npm install
```

### Configuration

Copy `.env` and fill in your keys:

```bash
cp .env .env.local  # or edit .env directly
```

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional but recommended
PROSHOT_API_KEY=ps_...
AIRTABLE_TOKEN=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE=Evaluations
AIRTABLE_RULES_TABLE=PromptRules
PORT=3000
```

See [Configuration Reference](#configuration-reference) for full details.

### Your first evaluation

**Option A — from Proshot API (once connected):**
```bash
node run.js --meeting jy5af2dc
```

**Option B — from a local JSON file (works immediately):**
```bash
node run.js --file data/sample-meeting.json
```

See [Sample Meeting Format](#sample-meeting-json-format) for the expected shape.

---

## CLI Reference

```bash
# Evaluate one meeting by ID
node run.js --meeting <id>

# Evaluate from a local JSON file (API fallback)
node run.js --file path/to/meeting.json

# Evaluate all meetings from the last N days
node run.js --all --days 7

# Evaluate all and print a summary
node run.js --all --days 7 --summary

# Probe all Proshot API endpoint variants
node run.js --discover

# Show all auto-generated prompt rules
node run.js --rules

# Start the dashboard web server
node run.js --serve
# → http://localhost:3000
```

### Example output

```
🔬 Running dual-judge evaluation...
  🤖 Claude judging...
  ✅ Claude score: 82
  🤖 GPT-4o judging...
  ✅ GPT-4o score: 61

  ⚠️  Judges disagree by 21 points. Invoking tiebreaker...
  ⚖️  Tiebreaker: asking GPT-4o to justify its lower score...
  ✅ Tiebreaker verdict: proshot_incorrect (evidence_found: true)
  ✅ New rule saved: "When evaluating timelines..."

╔══════════════════════════════════════════════════╗
  🟡  Q3 Pipeline Review — Acme Corp
  ID: jy5af2dc | Date: 2026-04-01
══════════════════════════════════════════════════
  Final Score:   🟡 71  (YELLOW)
  Claude Score:  82
  GPT-4o Score:  61
  Disagreement:  YES (diff: 21)
  Tiebreaker:    proshot_incorrect (evidence: true)
══════════════════════════════════════════════════
  ✅ Got Right (3):
    • Correctly identified budget discussion in Q2
    • Captured follow-up call scheduled for April 10
    • Noted ACME's preference for phased rollout

  ❌ Got Wrong (1):
    • Stated "no objections raised" — transcript shows CFO raised pricing concern at 14:32

  🔍 Missed (2):
    • Competitor mention: prospect referenced Gong as alternative at 22:15
    • Stakeholder note: CFO joining future calls, not mentioned in CRM update
╚══════════════════════════════════════════════════╝
```

---

## REST API Reference

The Express server (`node run.js --serve`) exposes these endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/meetings?days=30` | Fetch meeting list from Proshot |
| `POST` | `/api/evaluate/:meetingId` | Run evaluation for a meeting |
| `GET` | `/api/evaluations` | All evaluations from Airtable |
| `POST` | `/api/human-decision` | Save human verdict on disputed item |
| `GET` | `/api/rules` | All prompt improvement rules |
| `GET` | `/api/stats` | Aggregate stats (scores, green/yellow/red counts) |

### POST /api/evaluate/:meetingId

Triggers a full evaluation pipeline run server-side.

```bash
curl -X POST http://localhost:3000/api/evaluate/jy5af2dc
```

Returns the full evaluation result JSON.

### POST /api/human-decision

```bash
curl -X POST http://localhost:3000/api/human-decision \
  -H "Content-Type: application/json" \
  -d '{"meetingId": "jy5af2dc", "item": "timeline", "decision": "proshot_correct"}'
```

Valid decisions: `proshot_correct` | `proshot_incorrect` | `ambiguous`

---

## Dashboard

Start with `node run.js --serve` then open [http://localhost:3000](http://localhost:3000).

**Evaluations tab:**
- All evaluated meetings listed with score badges (🟢🟡🔴)
- Click any meeting for the full breakdown: what Proshot got right, wrong, and missed
- Yellow meetings show a human decision panel for disputed items
- Tiebreaker verdicts and generated rules visible per meeting

**Prompt Rules tab:**
- All auto-generated evaluation rules
- When each rule was added, how many times applied

---

## Airtable Setup

The system logs to two tables. Create them in your Airtable base with these exact field names:

### `Evaluations` table

| Field | Type |
|---|---|
| Meeting ID | Single line text |
| Meeting Title | Single line text |
| Meeting Date | Date |
| Final Score | Number |
| Verdict | Single select: `green`, `yellow`, `red` |
| Claude Score | Number |
| GPT4o Score | Number |
| Score Difference | Number |
| Disagreement | Checkbox |
| What Proshot Got Right | Long text |
| What Proshot Missed | Long text |
| What Proshot Got Wrong | Long text |
| Tiebreaker Verdict | Single line text |
| Human Decision | Single line text |
| Prompt Rule Generated | Long text |
| Timestamp | Date (include time) |

### `PromptRules` table

| Field | Type |
|---|---|
| Rule | Long text |
| Why Ambiguous | Long text |
| Date Added | Date |
| Times Applied | Number |
| Yellows Prevented | Number |

---

## Proshot API Discovery

The Proshot client (`src/proshot.js`) auto-probes all known endpoint and authentication variants:

**Endpoints tried:**
```
https://api.proshort.ai/v1/meetings/{id}
https://api.proshort.ai/v1/calls/{id}
https://api.proshort.ai/api/v1/meetings/{id}
https://api.proshort.ai/v1/recordings/{id}
https://api.proshort.ai/meetings/{id}
```

**Auth styles tried for each:**
```
Authorization: Bearer <key>
Authorization: <key>
x-api-key: <key>
X-API-Key: <key>
```

Run `node run.js --discover` to print the HTTP status for every combination.

---

## Sample Meeting JSON Format

When using `--file`, your JSON should follow this shape. Only `transcript` is required — all other fields are optional:

```json
{
  "id": "jy5af2dc",
  "title": "Q3 Pipeline Review — Acme Corp",
  "date": "2026-04-01T14:00:00Z",
  "transcript": "John (AE): Thanks for joining today. Let's start with where you are on budget...\nSarah (CFO): We're concerned about the per-seat pricing...\n...",
  "summary": "Productive call. Discussed Q3 roadmap. No major objections raised.",
  "action_items": [
    { "owner": "John", "task": "Send revised pricing deck", "due": "2026-04-05" }
  ],
  "crm_fields": {
    "deal_stage": "Proposal Sent",
    "next_steps": "Follow-up call April 10",
    "risks": "",
    "pain_points": "Budget concerns",
    "buying_signals": "Wants phased rollout"
  }
}
```

---

## Configuration Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude Opus 4.6 API key |
| `OPENAI_API_KEY` | ✅ | — | GPT-4o API key |
| `PROSHOT_API_KEY` | ⚠️ | — | Proshot API key (use `--file` if unavailable) |
| `AIRTABLE_TOKEN` | ⚠️ | — | Airtable personal access token |
| `AIRTABLE_BASE_ID` | ⚠️ | — | Airtable base ID (starts with `app`) |
| `AIRTABLE_TABLE` | — | `Evaluations` | Airtable table name for evaluations |
| `AIRTABLE_RULES_TABLE` | — | `PromptRules` | Airtable table name for prompt rules |
| `PORT` | — | `3000` | Dashboard server port |

---

## Scoring Logic

Each judge scores four dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Summary accuracy | 30% | Does the summary reflect what was actually discussed? |
| Action items accuracy | 30% | Were all action items captured, attributed correctly, with right deadlines? |
| CRM fields accuracy | 20% | Are deal stage, next steps, risks, pain points, buying signals correct? |
| Missed insights accuracy | 20% | Did Proshot catch competitor mentions, objections, budget signals, stakeholder dynamics? |

**Final score thresholds:**

| Score | Verdict | Meaning |
|---|---|---|
| 80–100 | 🟢 Green | High confidence — Proshot output is accurate |
| 40–79 | 🟡 Yellow | Disputed or uncertain — human review recommended |
| 0–39 | 🔴 Red | High confidence — Proshot output has significant errors |

---

## Project Structure

```
proshot-evaluator/
├── .env                        # API keys (never committed)
├── .gitignore
├── package.json
├── README.md
├── ARCHITECTURE.md             # System design deep-dive
│
├── run.js                      # CLI entry point
├── server.js                   # Express REST API + static serving
│
├── src/
│   ├── proshot.js              # Proshot API client with multi-endpoint probing
│   ├── judges.js               # Claude + GPT-4o judge functions
│   ├── tiebreaker.js           # Dissenter evidence-gathering logic
│   ├── evaluator.js            # Core evaluation orchestration
│   ├── airtable.js             # Airtable read/write operations
│   ├── rules.js                # Prompt rules engine (load/save/inject)
│   └── utils.js                # Shared helpers
│
├── data/
│   └── rules.json              # Persisted prompt improvement rules
│
└── public/
    └── index.html              # Dashboard SPA (no framework, no build step)
```

---

## Roadmap

- [ ] **Webhook support** — auto-evaluate new meetings as they complete in Proshot
- [ ] **Slack notifications** — ping channel when a red meeting is detected
- [ ] **Trend charts** — dashboard yellow% over time as rules accumulate
- [ ] **Per-rep scoring** — track which reps have the most missed insights
- [ ] **Batch API** — use Anthropic's Batch API for 50% cost reduction on bulk runs
- [ ] **Rule versioning** — A/B test prompt rules to measure their actual impact
- [ ] **Export** — CSV/PDF export of evaluation reports for QBRs

---

## License

MIT
