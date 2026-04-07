'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { parseJsonSafely, sleep } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Gemini 2.5 Pro as neutral arbiter ────────────────────────────────────────
// When Claude and GPT-4o disagree, we don't ask either to defend themselves
// (that's marking your own homework). Instead, Gemini 2.5 Pro reads the full
// transcript + both evaluations independently and makes the final call.
// ─────────────────────────────────────────────────────────────────────────────

const ARBITER_PROMPT = `You are a neutral AI arbiter. Two expert AI judges evaluated the same sales meeting transcript and gave significantly different scores. Your job is to settle the disagreement.

You will receive:
1. The raw meeting transcript (ground truth — the ONLY source of truth)
2. Judge A's full evaluation and score
3. Judge B's full evaluation and score

Your task:
- Read the transcript yourself, independently
- For each major dispute between the judges, check the actual transcript to verify who is right
- Give your own final score based purely on transcript evidence
- Do NOT simply average the two scores — make a real judgment call
- Identify what made this case genuinely ambiguous

Scoring weights (same as judges):
  Summary accuracy: 30%
  Action items accuracy: 30%
  CRM fields accuracy: 20%
  Missed insights: 20%

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "final_score": <0-100, your independent assessment — not an average>,
  "winner": "judge_a" | "judge_b" | "split",
  "evidence_for_higher_score": ["transcript quote or fact supporting the higher judge's position"],
  "evidence_for_lower_score": ["transcript quote or fact supporting the lower judge's position"],
  "evidence_found": <true if the lower score was genuinely justified by transcript evidence, false if the higher score was clearly correct>,
  "verdict": "proshot_correct" | "proshot_incorrect" | "partial",
  "key_disputes": ["specific items where the judges disagreed and what the transcript actually shows"],
  "confidence": <0-100>,
  "why_ambiguous": "why this was a borderline case — what made the two judges reach different conclusions",
  "prompt_improvement": "one specific rule to add to future evaluation prompts that would prevent this type of disagreement"
}`;

async function runTiebreaker(transcript, proshortOutput, judgeAResult, judgeBResult) {
  const aScore = judgeAResult.overall_score;
  const bScore = judgeBResult.overall_score;
  const aName = judgeAResult.judge === 'claude' ? 'Claude Opus 4.6' : 'GPT-4o';
  const bName = judgeBResult.judge === 'gpt4o' ? 'GPT-4o' : judgeBResult.judge === 'claude-skeptic' ? 'Claude Skeptic' : 'GPT-4o';

  console.log(`\n  ⚖️  Tiebreaker: Gemini 2.5 Pro arbitrating between ${aName} (${aScore}) and ${bName} (${bScore})...`);

  const userContent = `## Raw Meeting Transcript (Ground Truth)

${transcript}

## Proshot AI Analysis (Being Evaluated)

**Summary:**
${proshortOutput.summary || '(none)'}

**Action Items:**
${JSON.stringify(proshortOutput.actionItems || [], null, 2)}

**CRM Fields:**
${JSON.stringify(proshortOutput.crmFields || {}, null, 2)}

---

## Judge A — ${aName} — Score: ${aScore}/100

**Got Right:**
${(judgeAResult.what_proshot_got_right || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Got Wrong:**
${(judgeAResult.what_proshot_got_wrong || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Missed:**
${(judgeAResult.what_proshot_missed || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Reasoning:** ${judgeAResult.reasoning || ''}

---

## Judge B — ${bName} — Score: ${bScore}/100

**Got Right:**
${(judgeBResult.what_proshot_got_right || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Got Wrong:**
${(judgeBResult.what_proshot_got_wrong || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Missed:**
${(judgeBResult.what_proshot_missed || []).map(x => `• ${x}`).join('\n') || '(none)'}

**Reasoning:** ${judgeBResult.reasoning || ''}

---

Now read the transcript yourself and make your independent judgment. Check the transcript directly for every disputed item.`;

  // Try Gemini 2.5 Pro via OpenRouter first (neutral third party)
  const hasOpenRouter = !!(
    process.env.OPENROUTER_API_KEY &&
    process.env.OPENROUTER_API_KEY.trim().length > 10
  );

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let result;

      if (hasOpenRouter) {
        const OpenAI = require('openai');
        const openRouter = new OpenAI.default({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/anmolsam/proshot-evaluator',
            'X-Title': 'Proshot Evaluator',
          },
        });

        console.log('  🔮 Gemini 2.5 Pro reading transcript...');
        const response = await openRouter.chat.completions.create({
          model: 'google/gemini-2.5-pro-preview',
          max_tokens: 8192,
          temperature: 0,
          messages: [
            { role: 'system', content: ARBITER_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
        });

        const text = response.choices[0]?.message?.content;
        if (!text) throw new Error('No content in Gemini response');
        result = parseJsonSafely(text);
        result.arbiter = 'gemini-2.5-pro';
      } else {
        // Fallback to Claude if no OpenRouter
        console.log('  🔮 Claude arbiter (OpenRouter not available)...');
        const stream = anthropic.messages.stream({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          system: ARBITER_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        });
        const response = await stream.finalMessage();
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock) throw new Error('No text in Claude arbiter response');
        result = parseJsonSafely(textBlock.text);
        result.arbiter = 'claude-fallback';
      }

      result.final_score = Math.round(Number(result.final_score) || Math.round((aScore + bScore) / 2));
      console.log(
        `  ✅ Arbiter verdict: ${result.verdict} | final_score: ${result.final_score} | evidence_found: ${result.evidence_found} | winner: ${result.winner}`
      );
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  Tiebreaker attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(3000);
    }
  }
  throw new Error(`Tiebreaker failed after 2 attempts: ${lastErr.message}`);
}

module.exports = { runTiebreaker };
