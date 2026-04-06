# Architecture — Proshot Evaluator

This document covers the system design, component responsibilities, data flows, and key decisions behind the Proshot Evaluator. It is intended for engineers and technical stakeholders who want to understand, extend, or operate this system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Map](#2-component-map)
3. [Evaluation Pipeline — Deep Dive](#3-evaluation-pipeline--deep-dive)
4. [Dual-Judge Consensus Mechanism](#4-dual-judge-consensus-mechanism)
5. [Tiebreaker Logic](#5-tiebreaker-logic)
6. [Prompt Rules Engine](#6-prompt-rules-engine)
7. [Data Layer](#7-data-layer)
8. [API Layer](#8-api-layer)
9. [Dashboard](#9-dashboard)
10. [Proshot API Client](#10-proshot-api-client)
11. [Error Handling Strategy](#11-error-handling-strategy)
12. [Cost Model](#12-cost-model)
13. [Key Design Decisions](#13-key-design-decisions)
14. [Known Limitations](#14-known-limitations)
15. [Extension Points](#15-extension-points)

---

## 1. System Overview

Proshot Evaluator is a **multi-model QA pipeline**. Its core job: take a meeting transcript (ground truth) and Proshot's AI-generated analysis of that meeting (the thing being evaluated), send both to two AI judges independently, reconcile their verdicts, and produce a confidence-scored output.

```
┌─────────────────────────────────────────────────────────────┐
│                      EXTERNAL INPUTS                        │
│                                                             │
│  Proshot API  ──or──  Local JSON File                       │
│  (transcript + AI output)                                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   EVALUATION ENGINE                         │
│                                                             │
│   ┌─────────────┐          ┌─────────────┐                  │
│   │  Claude     │          │  GPT-4o     │  (parallel)      │
│   │  Opus 4.6   │          │             │                  │
│   │  Judge      │          │  Judge      │                  │
│   └──────┬──────┘          └──────┬──────┘                  │
│          │                        │                         │
│          └──────────┬─────────────┘                         │
│                     │                                       │
│              Consensus check                                │
│              (±20 point threshold)                          │
│                     │                                       │
│          ┌──────────┴──────────┐                            │
│        AGREE                DISAGREE                        │
│          │                    │                             │
│       Average             Tiebreaker                        │
│       scores              (dissenter)                       │
│          │                    │                             │
│          └──────────┬─────────┘                             │
│                     │                                       │
│            Final score + verdict                            │
│            Rules engine update                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Airtable    Console      Dashboard
      (log)       (output)     (UI)
```

---

## 2. Component Map

```
proshot-evaluator/
│
├── run.js              CLI — argument parsing, orchestration, pretty-print
├── server.js           HTTP server — REST API + static file serving
│
└── src/
    ├── proshot.js      Data ingestion — Proshot API client + file fallback
    ├── judges.js       AI evaluation — Claude + GPT-4o judge prompts + calls
    ├── tiebreaker.js   Dispute resolution — dissenter re-evaluation logic
    ├── evaluator.js    Orchestration — wires judges + tiebreaker + rules
    ├── airtable.js     Persistence — Airtable CRUD for evaluations + rules
    ├── rules.js        Learning — load/save/inject prompt rules from disk
    └── utils.js        Shared utilities — JSON parsing, dedup, formatting
```

### Dependency graph

```
run.js / server.js
    ├── src/proshot.js          (no internal deps)
    ├── src/evaluator.js
    │       ├── src/judges.js
    │       │       ├── src/rules.js
    │       │       └── src/utils.js
    │       ├── src/tiebreaker.js
    │       │       └── src/utils.js
    │       ├── src/rules.js
    │       └── src/utils.js
    └── src/airtable.js         (no internal deps)
```

No circular dependencies. `utils.js` and `rules.js` are the only shared leaves.

---

## 3. Evaluation Pipeline — Deep Dive

### 3.1 Meeting ingestion (`src/proshot.js`)

The pipeline begins by loading meeting data. Two paths:

**Path A — Proshot API**

```javascript
fetchMeeting(meetingId)
  → tries 5 URL patterns × 4 auth styles = 20 probes
  → first 200 OK response wins
  → normalizeMeeting(raw) → { id, title, date, transcript, proshortOutput }
```

`normalizeMeeting` maps the raw API response to a canonical shape regardless of which endpoint or field names Proshot uses. This decouples the rest of the pipeline from Proshot's API specifics.

**Path B — Local JSON**

```javascript
loadMeetingFromFile(path)
  → reads file, parses JSON
  → same normalizeMeeting() call
```

Identical pipeline from this point on.

### 3.2 The canonical meeting object

```javascript
{
  id: string,
  title: string,
  date: ISO8601 string,
  transcript: string,          // full speaker-labelled text — ground truth
  proshortOutput: {
    summary: string,
    actionItems: array,
    crmFields: {
      dealStage, nextSteps, risks, painPoints, buyingSignals, ...
    }
  },
  raw: object                  // original API response, preserved for debugging
}
```

### 3.3 Dual judging (`src/judges.js`)

Both judges receive **identical** input. This is critical for the consensus mechanism to work — any difference in input would confound the score comparison.

The judge prompt is assembled just before each call, not at startup. This means:

1. The latest rules from `data/rules.json` are always injected
2. Rule changes take effect on the next evaluation, no restart needed

```javascript
// Both calls fired simultaneously with Promise.all
const [claudeResult, gptResult] = await Promise.all([
  judgeWithClaude(transcript, proshortOutput),
  judgeWithGPT4o(transcript, proshortOutput)
]);
```

**Claude configuration:**
- Model: `claude-opus-4-6`
- Thinking: `{ type: "adaptive" }` — Claude decides when deep reasoning is needed
- Streaming: enabled via `.stream()` + `.finalMessage()` — prevents HTTP timeouts on long transcripts
- Retry: 1 automatic retry on failure with 2s backoff

**GPT-4o configuration:**
- Model: `gpt-4o`
- Response format: `{ type: "json_object" }` — enforces JSON output
- Temperature: `0` — deterministic scoring
- Retry: 1 automatic retry on failure with 2s backoff

### 3.4 Score dimensions

Both judges evaluate four dimensions using the same scoring rubric:

| Dimension | Weight | Scoring criteria |
|---|---|---|
| `summary_score` | 30% | Does the summary accurately reflect what was discussed? |
| `action_items_score` | 30% | Are all action items captured with correct owners and deadlines? |
| `crm_fields_score` | 20% | Are deal stage, next steps, risks, pain points, buying signals correct? |
| `missed_insights_score` | 20% | Did Proshot catch competitors, objections, budget signals, stakeholders? |

```
overall_score = summary*0.3 + action_items*0.3 + crm*0.2 + missed*0.2
```

---

## 4. Dual-Judge Consensus Mechanism

### 4.1 Why two judges?

Single-model evaluations have systematic blind spots. A model trained on similar data to Proshot may share the same misconceptions. A model with different training data provides independent signal.

More importantly: if two different models with different architectures and training data both agree that Proshot got something wrong, that agreement is much stronger evidence than one model's opinion.

### 4.2 Disagreement threshold

```javascript
const DISAGREEMENT_THRESHOLD = 20;
const scoreDiff = Math.abs(claudeResult.overall_score - gptResult.overall_score);
```

A 20-point threshold was chosen based on the signal/noise tradeoff:
- Below 20: normal variation in how two models interpret subjective criteria
- Above 20: meaningful disagreement that warrants investigation

### 4.3 Agreement path

```javascript
if (scoreDiff < DISAGREEMENT_THRESHOLD) {
  finalScore = Math.round((claudeResult.overall_score + gptResult.overall_score) / 2);
  verdict = finalScore >= 80 ? 'green' : finalScore >= 40 ? 'yellow' : 'red';
}
```

Simple average. Both judges get equal weight when they agree.

### 4.4 Disagreement path → Tiebreaker

```javascript
// Identify which judge scored lower — that judge is the "dissenter"
const dissenterIsClaude = claudeResult.overall_score < gptResult.overall_score;
const dissenterResult = dissenterIsClaude ? claudeResult : gptResult;
const dissenterName = dissenterIsClaude ? 'Claude' : 'GPT-4o';
```

The dissenter is challenged to prove its case. See [Section 5](#5-tiebreaker-logic).

---

## 5. Tiebreaker Logic

The tiebreaker is the most important mechanism in the system. It converts subjective disagreements into evidence-based verdicts.

### 5.1 Design principle

**The dissenter cannot simply reassert its position.** It must find exact quotes or clear references in the transcript that justify its lower score. This prevents a model from being stubbornly wrong without accountability.

If it cannot find evidence → it must concede. This is a key feature: models that score harshly without justification are overruled.

### 5.2 Tiebreaker prompt structure

The dissenter receives:
1. The full transcript (to re-read)
2. Proshot's output (what is being disputed)
3. Its own original evaluation (its earlier low-score reasoning)
4. The instruction to find specific evidence or concede

### 5.3 Decision tree

```
Dissenter re-reads transcript
           │
    Evidence found?
    ┌───────┴───────┐
   YES              NO
    │                │
evidence_found:    evidence_found:
true               false
verdict:           verdict:
proshot_incorrect  proshot_correct
    │                │
Flag yellow        Use higher score
(human review)     from original
    │              two judges
    │
Generate prompt
improvement rule
    │
Save to rules.json
+ Airtable
```

### 5.4 Score resolution after tiebreaker

```javascript
if (tiebreakerResult.evidence_found) {
  // Dissenter was right — average the two original scores
  // Force yellow regardless of score level (human must confirm)
  finalScore = Math.round((claudeResult.overall_score + gptResult.overall_score) / 2);
  verdict = 'yellow';
} else {
  // Dissenter conceded — Proshot was right
  // Use the higher (more lenient) score
  finalScore = Math.max(claudeResult.overall_score, gptResult.overall_score);
  verdict = scoreToVerdict(finalScore); // normal green/yellow/red
}
```

---

## 6. Prompt Rules Engine

### 6.1 Purpose

Every time a tiebreaker runs, it generates:
- A `prompt_improvement` — a specific rule to add to future judge prompts
- A `why_ambiguous` — explanation of why this case was borderline

These rules are saved to `data/rules.json` and injected into every subsequent evaluation. Over time, the system becomes better calibrated to the specific patterns that cause disagreements in your meetings.

### 6.2 Rule injection

```javascript
function buildJudgePromptWithRules(basePrompt, rules) {
  if (rules.length === 0) return basePrompt;
  const rulesText = rules.map((r, i) => `Rule ${i+1}: ${r.rule}`).join('\n');
  return basePrompt + `\n\nAdditional evaluation rules:\n${rulesText}`;
}
```

Rules are appended at the end of the base judge prompt. The base prompt is never modified — rules are always additive. This means:
- You can delete rules from `rules.json` without editing any code
- Rules take effect on the next evaluation (file is read fresh each time)
- The base prompt behaviour is always recoverable

### 6.3 Rule storage schema

```json
{
  "id": 1712345678901,
  "rule": "When evaluating timelines, accept 'next week' or 'next month' as correct if the transcript uses approximate language rather than specific dates.",
  "whyAmbiguous": "Proshot used 'end of Q2' but transcript said 'next quarter' — both mean the same thing.",
  "dateAdded": "2026-04-06T10:30:00.000Z",
  "timesApplied": 4,
  "yellowsPrevented": 2
}
```

### 6.4 Deduplication

Before saving a new rule, the engine checks for exact text matches to prevent duplicates:

```javascript
const exists = rules.some(r => r.rule.trim() === rule.trim());
if (exists) return; // skip
```

---

## 7. Data Layer

### 7.1 Airtable

Airtable is used as the system of record for all evaluations and rules. It was chosen over a local database because:
- No infrastructure to manage
- Human-friendly UI for reviewing yellow meetings
- Easy to export for reporting
- Native formula fields for trend analysis

**Evaluations table** — one record per evaluated meeting. See README for full field list.

**PromptRules table** — one record per auto-generated rule, with counters for tracking impact.

All Airtable calls are wrapped in try/catch with graceful degradation — if Airtable is not configured or fails, the evaluation continues and results are still printed to console.

```javascript
try {
  await logEvaluation(result);
} catch (err) {
  console.error('Airtable log failed:', err.message); // non-fatal
}
```

### 7.2 Local rules file

`data/rules.json` is the source of truth for prompt rules. Airtable stores a copy for visibility, but the evaluation engine reads from disk, not Airtable. This means:
- Evaluations work offline (no Airtable needed for the core pipeline)
- Rules are portable — copy `data/rules.json` to any deployment
- No latency added to the hot path from a rules API call

### 7.3 State lifecycle

```
Evaluation run
    │
    ├── Read rules.json (before building judge prompts)
    ├── Call judges
    ├── If tiebreaker fires:
    │       └── Write rules.json (new rule)
    │       └── Write Airtable PromptRules (async, non-blocking)
    └── Write Airtable Evaluations (async, non-blocking)
```

---

## 8. API Layer

`server.js` is a thin Express wrapper. All business logic lives in `src/`. The server's job:
- Parse HTTP requests
- Call the appropriate `src/` function
- Return JSON
- Serve the dashboard static file

### 8.1 Endpoint implementation pattern

```javascript
app.post('/api/evaluate/:meetingId', async (req, res) => {
  try {
    const meeting = await fetchMeeting(req.params.meetingId);
    const result = await evaluateMeeting(meeting);
    await logEvaluation(result); // non-blocking in terms of HTTP response
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

All endpoints follow the same pattern: try/catch with structured error responses. Never crashes the server.

### 8.2 Long-running requests

The `/api/evaluate/:meetingId` endpoint can take 30–90 seconds (two AI judge calls + optional tiebreaker). This is fine for:
- Dashboard-initiated evaluations (user clicks a button, waits)
- CLI usage (synchronous, terminal waits)

For production workloads with many meetings, use the CLI's `--all` flag, which processes sequentially and handles each failure independently.

---

## 9. Dashboard

`public/index.html` is a single-file SPA with zero build steps and zero framework dependencies.

**Design choices:**
- **Vanilla JS + CSS** — no React, no bundler, no node_modules in frontend. Loads instantly.
- **Dark theme** — suited for operations/monitoring contexts
- **Two tabs** — Evaluations (main view) + Prompt Rules (learning layer)
- **Inline state** — `allEvaluations` array held in memory, re-filtered on selection change

**Data flow:**
```
Page load
  → fetch /api/stats → update header stats
  → fetch /api/evaluations → render meeting list

Click meeting
  → find in allEvaluations[]
  → render detail panel (no network call)

Save human decision
  → POST /api/human-decision
  → update Airtable record
```

The dashboard is read-heavy. Triggering evaluations from the UI calls the REST API, which then runs the full pipeline server-side.

---

## 10. Proshot API Client

### 10.1 Discovery strategy

The client does not assume a specific endpoint because Proshot's API documentation was unavailable at build time. Instead, it systematically probes all plausible variants:

```
5 URL patterns × 4 auth styles = 20 probes per meeting ID
```

**URL patterns:**
```
/v1/meetings/{id}
/v1/calls/{id}
/api/v1/meetings/{id}
/v1/recordings/{id}
/meetings/{id}
```

**Auth styles:**
```
Authorization: Bearer {key}
Authorization: {key}
x-api-key: {key}
X-API-Key: {key}
```

Each probe has a 10-second timeout to avoid hanging on dead endpoints.

### 10.2 Response normalization

The `normalizeMeeting()` function maps whatever field names Proshot uses to the canonical pipeline format. Field name variants handled:

| Canonical field | Proshot variants tried |
|---|---|
| `transcript` | `transcript`, `transcription`, `full_transcript`, `raw_transcript`, `call_transcript` |
| `title` | `title`, `name`, `meeting_title`, `subject` |
| `summary` | `summary`, `ai_summary`, `meeting_summary`, `notes` |
| `actionItems` | `action_items`, `actionItems`, `tasks`, `todos` |
| `date` | `date`, `created_at`, `start_time`, `startTime` |

If transcripts are returned as arrays of speaker turns, they are joined into a single string:
```javascript
turns.map(t => `${t.speaker}: ${t.text}`).join('\n')
```

---

## 11. Error Handling Strategy

The system follows a two-tier error handling model:

**Tier 1 — Fatal errors:** Stop the evaluation and surface clearly
- Missing API keys
- Missing transcript (can't evaluate without ground truth)
- Network failures after retries

**Tier 2 — Non-fatal errors:** Log and continue
- Airtable logging failures
- Rule saving failures
- Individual meeting failures in batch mode

```javascript
// Batch mode: each meeting is independent
for (const meeting of meetings) {
  try {
    await runEvaluation(meeting);
  } catch (err) {
    console.error(`❌ Failed: ${meeting.id}: ${err.message}`);
    // continues to next meeting
  }
}
```

### 11.1 AI call retries

Both Claude and GPT-4o calls include one automatic retry:

```javascript
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    // ... API call
    return result;
  } catch (err) {
    if (attempt === 0) await sleep(2000);
  }
}
throw new Error(`Failed after 2 attempts`);
```

The retry handles: transient network errors, temporary API overload, and occasional JSON parsing failures from non-compliant model output.

### 11.2 JSON validation

Both judges are required to return strict JSON. Before using any judge response:

```javascript
function parseJsonSafely(text) {
  // 1. Strip markdown code fences (```json ... ```)
  // 2. Try JSON.parse directly
  // 3. Extract first {...} block as fallback
  // 4. Throw with original text if all fail
}
```

If `parseJsonSafely` throws, the retry logic catches it and retries the full API call.

---

## 12. Cost Model

Approximate costs per meeting evaluation (as of April 2026):

| Component | Tokens (est.) | Cost |
|---|---|---|
| Claude judge call | ~3,000 input + ~800 output | ~$0.035 |
| GPT-4o judge call | ~3,000 input + ~800 output | ~$0.022 |
| Tiebreaker (if triggered) | ~4,000 input + ~600 output | ~$0.025 |
| **Total (no tiebreaker)** | | **~$0.057** |
| **Total (with tiebreaker)** | | **~$0.082** |

Costs scale with transcript length. A 60-minute meeting with 8,000-word transcript will cost ~2–3× the estimates above.

**Cost optimisation options:**
- Use the Anthropic Batch API for non-urgent bulk runs (50% reduction)
- Reduce `max_tokens` on judge responses once prompts are tuned
- Cache Claude's system prompt (prompt caching) if evaluating many meetings in sequence with the same rules

---

## 13. Key Design Decisions

### Why adaptive thinking for Claude?

`thinking: {type: "adaptive"}` lets Claude decide when to reason deeply. On straightforward meetings (clear transcript, obvious errors), it skips extended thinking and responds fast. On ambiguous meetings (vague language, missing context, complex stakeholder dynamics), it invests more reasoning tokens. This is exactly the right behaviour for an evaluator: spend cognitive effort proportional to the difficulty of the case.

### Why GPT-4o as the second judge?

The second judge must be architecturally independent from the first. Using two Claude instances would create correlated errors — they'd share the same training biases and systematic blind spots. GPT-4o has different training data, different RLHF, and different tendencies. When both models agree despite their differences, the agreement is much more meaningful.

### Why 20 points as the disagreement threshold?

This was set by reasoning about what score differences mean:
- A 5-point difference: noise. Both judges are "around 75".
- A 15-point difference: notable variation, but within the range of reasonable interpretation differences.
- A 25-point difference: one judge thinks Proshot did well (80), the other thinks it struggled (55). That's a meaningful disagreement worth investigating.

The threshold should be tuned based on observed disagreement rates. If >30% of meetings trigger the tiebreaker, lower it. If <5% do, raise it.

### Why not use a third judge to break ties?

A third judge creates new problems:
- 2-1 votes still leave the dissenter unexamined
- More cost per evaluation
- More latency

The evidence-based tiebreaker is better: it forces the dissenter to be accountable, generates a learning signal (prompt improvement), and produces a human-reviewable justification. A third-judge vote produces none of these.

### Why store rules in a JSON file instead of a database?

- Zero infrastructure: no database to provision, connect to, or back up
- Portable: rules travel with the codebase
- Readable: engineers can review and edit rules directly
- Sufficient scale: even at 1 new rule per day for 2 years = 730 rules, JSON file is ~100KB

The tradeoff is no concurrent write safety. This is acceptable because rule writes are rare (only on tiebreaker completion) and the system is single-process.

### Why is Airtable logging non-blocking?

The evaluation result is the primary output. Logging is a side effect. If Airtable is slow, down, or misconfigured, the evaluation should still complete and return results. Making logging block the response would create a fragile dependency on a third-party service for the core pipeline.

---

## 14. Known Limitations

**1. Sequential batch processing**
The `--all` flag processes meetings one at a time. For large backlogs (100+ meetings), this is slow. A parallel processing mode with rate limiting would be the right fix.

**2. No Proshot webhook support**
Currently requires manual triggering. Proshot would need to POST to `/api/evaluate/:id` on meeting completion, or the system would need to poll for new meetings.

**3. Tiebreaker is same model, different prompt**
The tiebreaker uses the same model (Claude or GPT-4o) as the dissenter. Ideally the tiebreaker would use a third, neutral model. In practice, asking the same model to find contradicting evidence it missed is surprisingly effective — models are generally honest about what they can and cannot find in a transcript.

**4. No transcript length handling**
Very long transcripts (>100K tokens) could exceed model context windows. No chunking or summarisation is applied. For now, transcripts above ~50K words should be pre-summarised before evaluation.

**5. Rules are additive, never pruned**
Bad rules accumulate. There's no mechanism to evaluate a rule's contribution and remove it if it's causing worse outcomes. Rule quality degrades if many low-quality tiebreaker decisions generate bad rules.

---

## 15. Extension Points

### Adding a new judge model

In `src/judges.js`, add a new `judgeWithX(transcript, proshortOutput)` function following the same pattern as `judgeWithClaude`. Then update `src/evaluator.js` to include it in the `Promise.all`.

### Adding new evaluation dimensions

Update `BASE_JUDGE_PROMPT` in `src/judges.js` to add a new dimension (e.g., `sentiment_accuracy`). Update the JSON schema in the prompt. Update the `overall_score` weighting formula. Both judges will pick it up immediately.

### Changing the disagreement threshold

Edit the constant in `src/evaluator.js`:
```javascript
const DISAGREEMENT_THRESHOLD = 20; // adjust here
```

### Adding Slack notifications

In `src/evaluator.js`, after `evaluateMeeting()` completes, add a call to a `notifySlack(result)` function when `result.verdict === 'red'` or `result.disagreement === true`.

### Webhook receiver

Add to `server.js`:
```javascript
app.post('/webhook/proshot', async (req, res) => {
  const meetingId = req.body.meetingId || req.body.id;
  res.json({ ok: true }); // respond immediately
  setImmediate(async () => {
    const meeting = await fetchMeeting(meetingId);
    const result = await evaluateMeeting(meeting);
    await logEvaluation(result);
  });
});
```

### Using Anthropic Batch API for bulk runs

Replace the sequential loop in the `--all` CLI path with a batch submission to `client.messages.batches.create()`. Results can be polled after the batch completes. This reduces cost by 50% for bulk evaluations at the cost of latency (batches complete within 1 hour).
