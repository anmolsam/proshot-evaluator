'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { parseJsonSafely } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Beam AI Simplified BANT Qualification Framework ───────────────────────────
// Exact framework as specified:
//
// SECTION 1 — TECH ELIGIBILITY (Any "No" = Technical DQ)
//   Q1: Is the trade/service supported by Beam AI?               Yes / No
//   Q2: Does the required TAT align with Beam AI delivery?        Yes / No
//   Q_DQ: If Technical DQ, proof attached?                        Proshot / Written proof
//
// SECTION 2 — BANT QUALIFICATION (3/4 REQUIRED)
//   B:  Has the prospect confirmed ability to invest?             Yes / No / Unknown
//       (DFY: $10K & DIY: $7K) and agreed to licensing model?
//   A1: Has the Decision Criteria been identified?                Yes / No / Unknown
//   A2: Are all internal approval steps clearly mapped?           Yes / No / Unknown
//       (procurement/legal if needed)
//   N:  Is the customer willing to offload end-to-end             Yes (Mandatory)
//       takeoffs to AI?
//   T1: Can the deal close within 90 days?                        Yes / No
//   T2: If longer than 90 days, is the deal size > $50K?          Yes / No
//
// SECTION 3 — DEAL CONTROL (derived)
//   Qualified Deal   → Tech Eligible + 3/4 BANT
//   Pilot Allowed    → Qualified Deal only
//   Sales Cycle Start → At 3/4 BANT
//   Forecast Allowed → Qualified Deal only
//
// SECTION 4 — CLOSED LOST
//   CL Reason: TAT delays / Accuracy limits / Scope limitations /
//              Custom Excel needs / Integration limitation /
//              Budget / Authority / Need / Timeline / Other
//   Slack notification to CL channel if CL reason is B/A/N/T/Other
//   Any other reason = qualification review
//   N + T + $300 payment = qualified
// ─────────────────────────────────────────────────────────────────────────────

const BANT_PROMPT = `You are a sales qualification analyst for Beam AI, an AI-powered construction takeoff platform.

You will receive a meeting transcript. Answer ONLY from explicit transcript evidence. Do not infer or assume.

Rules:
- "yes" = explicitly confirmed in transcript (quote it)
- "no" = explicitly denied or contradicted in transcript (quote it)
- "unknown" = not discussed at all, or insufficient information
- "n/a" = question is not applicable given prior answers
- Never fabricate evidence. If not in the transcript, answer "unknown"

EXACT QUESTIONS TO ANSWER:

SECTION 1 — TECH ELIGIBILITY
Q1: Is the trade/service supported by Beam AI?
  Valid answers: yes / no
  (Supported trades include electrical, mechanical, plumbing, civil, structural)

Q2: Does the required TAT (turnaround time) align with Beam AI delivery?
  Valid answers: yes / no / unknown

Q_DQ: If Technical DQ (Q1=no or Q2=no), what proof is attached?
  Valid answers: proshot / written_proof / n/a
  (n/a if not technically disqualified)

SECTION 2 — BANT (3 out of 4 required)

B — Budget
QB: Has the prospect confirmed ability to invest in Beam AI? (DFY: $10K & DIY: $7K) and has agreed to the licensing model?
  Valid answers: yes / no / unknown

A — Authority
QA1: Has the Decision Criteria been identified?
  Valid answers: yes / no / unknown

QA2: Are all internal approval steps (procurement/legal if needed) clearly mapped?
  Valid answers: yes / no / unknown

N — Need
QN: Is the customer willing to offload end-to-end takeoffs to AI? (Mandatory — partial use does not qualify)
  Valid answers: yes / no / unknown

T — Timeline
QT1: Can the deal close within 90 days?
  Valid answers: yes / no / unknown

QT2: If longer than 90 days, is the deal size > $50K?
  Valid answers: yes / no / n/a
  (n/a if QT1 = yes)

SECTION 3 — DEAL CONTROL (you derive these from the above)
Derive each using these exact rules:
- tech_eligible: yes if Q1=yes AND Q2=yes; no if Q1=no OR Q2=no; unknown otherwise
- bant_score: count how many of B / A(QA1 AND QA2) / N / T(QT1 OR QT2) are "yes" — format as "X/4"
- qualified_deal: yes if tech_eligible=yes AND bant_score >= 3/4; no if tech_eligible=no; needs_review otherwise
- pilot_allowed: yes only if qualified_deal=yes; no otherwise
- sales_cycle_start: yes if bant_score >= 3/4; no otherwise
- forecast_allowed: yes only if qualified_deal=yes; no otherwise

SECTION 4 — CLOSED LOST
nt_300_qualified: yes if QN=yes AND QT1=yes AND transcript mentions a $300 payment or deposit; no otherwise; unknown if N or T unknown

Proshot comparison:
proshot_captured_bant: did Proshot's output capture any of these BANT signals?
  Valid answers: yes / partial / no

Respond ONLY in this exact JSON, no preamble, no markdown:
{
  "q1_trade_supported": { "answer": "yes|no", "evidence": "exact quote or null", "notes": "brief" },
  "q2_tat_aligned": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "q_dq_proof": { "answer": "proshot|written_proof|n/a", "evidence": null, "notes": "brief" },
  "qb_budget_confirmed": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "qa1_decision_criteria": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "qa2_approval_steps_mapped": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "qn_end_to_end_offload": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "qt1_close_within_90_days": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief" },
  "qt2_deal_over_50k_if_long": { "answer": "yes|no|n/a", "evidence": "exact quote or null", "notes": "brief" },
  "tech_eligible": "yes|no|unknown",
  "bant_score": "X/4",
  "qualified_deal": "yes|no|needs_review",
  "pilot_allowed": "yes|no",
  "sales_cycle_start": "yes|no",
  "forecast_allowed": "yes|no",
  "nt_300_qualified": "yes|no|unknown",
  "proshot_captured_bant": { "answer": "yes|partial|no", "notes": "what Proshot did/did not capture vs the 9 BANT questions above" },
  "recommended_next_action": "what the rep must do next based strictly on the qualification gaps above"
}`;

async function runBantEvaluation(transcript, proshortOutput) {
  console.log('  🎯 Running BANT qualification analysis...');

  const userContent = `## Meeting Transcript

${transcript}

## Proshot AI Output (for comparison only)

**Summary:**
${proshortOutput.summary || '(none)'}

**Action Items:**
${JSON.stringify(proshortOutput.actionItems || [], null, 2)}

**CRM Fields:**
${JSON.stringify(proshortOutput.crmFields || {}, null, 2)}`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = anthropic.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: BANT_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const response = await stream.finalMessage();
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text block in BANT response');

      const result = parseJsonSafely(textBlock.text);
      console.log(`  ✅ BANT: tech=${result.tech_eligible} | score=${result.bant_score} | qualified=${result.qualified_deal}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  BANT attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`BANT evaluation failed: ${lastErr.message}`);
}

module.exports = { runBantEvaluation };
