'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { parseJsonSafely } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Beam AI BANT Qualification Framework ─────────────────────────────────────
// 3 of 4 BANT required for a Qualified Deal
// Any "No" on Tech Eligibility = Technical DQ (hard block)
// ─────────────────────────────────────────────────────────────────────────────

const BANT_PROMPT = `You are a senior sales qualification analyst for Beam AI, an AI-powered construction takeoff platform.

You will receive a raw meeting transcript. Your job is to evaluate it against Beam AI's BANT qualification framework and answer each question STRICTLY from transcript evidence only.

Rules:
- Answer "yes", "no", or "unknown" based solely on what is said in the transcript
- "unknown" = topic was not discussed or not enough information to determine
- Quote the exact transcript line as evidence for every "yes" or "no" answer
- Be strict: do not infer what was "probably" meant — only what was explicitly stated
- For the overall qualification, apply the logic: Tech Eligible + 3/4 BANT = Qualified

The BANT framework:

SECTION 1 — TECH ELIGIBILITY (any "no" = Technical DQ)
Q1: Is the trade/service the prospect needs supported by Beam AI? (electrical, mechanical, plumbing, civil etc.)
Q2: Does the prospect's required turnaround time (TAT) align with Beam AI's delivery speed?

SECTION 2 — BANT
B — Budget
Q3: Has the prospect confirmed ability or willingness to invest in Beam AI? (Pricing: DFY $10K/yr, DIY $7K/yr, licensing model)

A — Authority
Q4: Has the decision criteria been identified? (what does success look like for them to say yes?)
Q5: Are all internal approval steps clearly mapped? (who else needs to sign off, procurement/legal process)

N — Need
Q6: Is the prospect willing to offload end-to-end takeoffs to AI? (This is MANDATORY — partial use is not enough)

T — Timeline
Q7: Can the deal realistically close within 90 days?
Q8: If timeline is longer than 90 days, is the deal size likely >$50K?

SECTION 3 — DERIVED
Q9: Is the prospect technically qualified? (yes = Q1 and Q2 both "yes", no = either is "no")
Q10: What is the overall BANT qualification status? (qualified = tech eligible + 3 or more of B/A(both parts)/N/T; disqualified = tech DQ or <3 BANT; needs_review = unknown on critical fields)

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "q1_trade_supported": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q2_tat_aligned": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q3_budget_confirmed": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q4_decision_criteria": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q5_approval_steps_mapped": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q6_need_end_to_end": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q7_close_within_90_days": { "answer": "yes|no|unknown", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q8_deal_size_over_50k_if_long": { "answer": "yes|no|n/a", "evidence": "exact quote or null", "notes": "brief explanation" },
  "q9_tech_qualified": { "answer": "yes|no|unknown", "evidence": null, "notes": "derived from Q1+Q2" },
  "q10_bant_status": { "answer": "qualified|disqualified|needs_review", "evidence": null, "notes": "explain which BANT criteria passed/failed and why", "bant_score": "X/4" },
  "proshot_captured_bant": { "answer": "yes|partial|no", "evidence": "what BANT signals Proshot's output did or did not capture", "notes": "compare Claude findings vs Proshot output" },
  "recommended_next_action": "string — what the sales rep should do next based on this qualification"
}`;

async function runBantEvaluation(transcript, proshortOutput) {
  console.log('  🎯 Running BANT qualification analysis...');

  const userContent = `## Meeting Transcript

${transcript}

## Proshot AI Output (for comparison)

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
      console.log(`  ✅ BANT status: ${result.q10_bant_status?.answer} (${result.q10_bant_status?.bant_score})`);
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
