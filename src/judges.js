'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { loadRules, buildJudgePromptWithRules } = require('./rules');
const { parseJsonSafely, sleep } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const hasOpenRouter = !!(
  process.env.OPENROUTER_API_KEY &&
  process.env.OPENROUTER_API_KEY.trim().length > 10
);

// OpenRouter uses the OpenAI-compatible API — just swap the base URL
let openRouter = null;
if (hasOpenRouter) {
  openRouter = new OpenAI.default({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/anmolsam/proshot-evaluator',
      'X-Title': 'Proshot Evaluator',
    },
  });
}

// ── Base judge prompt ─────────────────────────────────────────────────────

const BASE_JUDGE_PROMPT = `You are an expert sales meeting analyst and strict evaluator.

You will receive:
1. A raw meeting transcript (ground truth)
2. Proshot AI's analysis of that meeting (what we are evaluating)

Your job: independently extract what actually happened in the meeting from the transcript, then compare it against Proshot's output field by field.

Evaluate these dimensions:
- Summary accuracy (0-100): Does Proshot's summary correctly reflect what was discussed?
- Action items accuracy (0-100): Did Proshot capture all action items? Are they attributed to the right people with correct deadlines?
- CRM fields accuracy (0-100): Are deal stage, next steps, risks, pain points, and buying signals correct?
- Missed insights (0-100): Did Proshot miss important signals like competitor mentions, objections, budget concerns, timeline pressure, or stakeholder dynamics?

Rules:
- Only flag something as WRONG if the transcript clearly and directly contradicts it
- Only flag something as MISSED if it is clearly present in the transcript but completely absent from Proshot's output
- Be specific — quote the relevant transcript section when flagging an issue
- Do not penalise Proshot for subjective interpretations unless they are clearly wrong

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "summary_score": <0-100>,
  "action_items_score": <0-100>,
  "crm_fields_score": <0-100>,
  "missed_insights_score": <0-100>,
  "overall_score": <weighted average: summary*0.3 + action_items*0.3 + crm*0.2 + missed*0.2>,
  "what_proshot_got_right": ["specific item with brief explanation"],
  "what_proshot_missed": ["specific item with transcript evidence"],
  "what_proshot_got_wrong": ["specific item — what Proshot said vs what transcript says"],
  "reasoning": "2-3 sentence overall assessment"
}`;

// Skeptic variant — only used when OpenRouter is also unavailable
const SKEPTIC_JUDGE_PROMPT = `You are a demanding sales operations analyst who evaluates AI meeting summaries with a critical eye.

You will receive:
1. A raw meeting transcript (the only source of truth)
2. Proshot AI's analysis of that meeting

Your job: scrutinise Proshot's output for errors, omissions, and missed signals. Assume nothing is correct unless the transcript explicitly confirms it. You are the quality control layer that catches what optimistic reviewers miss.

Evaluate these dimensions:
- Summary accuracy (0-100): Is every claim in the summary verifiable from the transcript? Penalise vagueness and spin.
- Action items accuracy (0-100): Are ALL action items captured with correct owners, deadlines, and specifics? Missing one item is a significant deduction.
- CRM fields accuracy (0-100): Are all CRM fields grounded in explicit transcript evidence? Penalise inferred fields that aren't stated.
- Missed insights (0-100): Did Proshot capture every competitor mention, objection, pricing concern, stakeholder change, and buying signal? Miss any one — deduct points.

Rules:
- Flag something as WRONG if the transcript contradicts it OR if Proshot stated something that wasn't clearly said
- Flag something as MISSED if it appears in the transcript but is absent or understated in Proshot's output
- Quote the exact transcript line when flagging
- Be specific and evidence-based

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "summary_score": <0-100>,
  "action_items_score": <0-100>,
  "crm_fields_score": <0-100>,
  "missed_insights_score": <0-100>,
  "overall_score": <weighted average: summary*0.3 + action_items*0.3 + crm*0.2 + missed*0.2>,
  "what_proshot_got_right": ["specific item with brief explanation"],
  "what_proshot_missed": ["specific item with transcript evidence"],
  "what_proshot_got_wrong": ["specific item — what Proshot said vs what transcript says"],
  "reasoning": "2-3 sentence overall assessment"
}`;

function buildMessages(transcript, proshortOutput, useSkeptic = false) {
  const rules = loadRules();
  const base = useSkeptic ? SKEPTIC_JUDGE_PROMPT : BASE_JUDGE_PROMPT;
  const prompt = buildJudgePromptWithRules(base, rules);

  const userContent = `## Raw Meeting Transcript (Ground Truth)

${transcript}

## Proshot AI Analysis (To Evaluate)

**Summary:**
${proshortOutput.summary || '(none provided)'}

**Action Items:**
${JSON.stringify(proshortOutput.actionItems || [], null, 2)}

**CRM Fields:**
${JSON.stringify(proshortOutput.crmFields || {}, null, 2)}`;

  return { systemPrompt: prompt, userContent };
}

async function callClaude(systemPrompt, userContent) {
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const response = await stream.finalMessage();
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  return parseJsonSafely(textBlock.text);
}

async function callOpenRouter(model, systemPrompt, userContent) {
  const response = await openRouter.chat.completions.create({
    model,
    max_tokens: 4096,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error(`No content in OpenRouter response (${model})`);
  return parseJsonSafely(text);
}

async function judgeWithClaude(transcript, proshortOutput) {
  console.log('  🤖 Claude Opus 4.6 (optimist) judging...');
  const { systemPrompt, userContent } = buildMessages(transcript, proshortOutput, false);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callClaude(systemPrompt, userContent);
      result.judge = 'claude';
      result.overall_score = Math.round(Number(result.overall_score) || 0);
      console.log(`  ✅ Claude score: ${result.overall_score}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  Claude attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  throw new Error(`Claude judging failed: ${lastErr.message}`);
}

async function judgeWithGPT4o(transcript, proshortOutput) {
  if (!hasOpenRouter) {
    // Fallback: second Claude with skeptic persona
    console.log('  🤖 Claude (skeptic) judging... [OpenRouter key not set — using Claude skeptic mode]');
    const { systemPrompt, userContent } = buildMessages(transcript, proshortOutput, true);

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callClaude(systemPrompt, userContent);
        result.judge = 'claude-skeptic';
        result.overall_score = Math.round(Number(result.overall_score) || 0);
        console.log(`  ✅ Claude skeptic score: ${result.overall_score}`);
        return result;
      } catch (err) {
        lastErr = err;
        console.log(`  ⚠️  Claude skeptic attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt === 0) await sleep(2000);
      }
    }
    throw new Error(`Claude skeptic judging failed: ${lastErr.message}`);
  }

  // GPT-4o via OpenRouter — real independent second opinion
  console.log('  🤖 GPT-4o via OpenRouter (skeptic) judging...');
  const { systemPrompt, userContent } = buildMessages(transcript, proshortOutput, true);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callOpenRouter('openai/gpt-4o', systemPrompt, userContent);
      result.judge = 'gpt4o';
      result.overall_score = Math.round(Number(result.overall_score) || 0);
      console.log(`  ✅ GPT-4o score: ${result.overall_score}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  GPT-4o attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  throw new Error(`GPT-4o judging failed: ${lastErr.message}`);
}

module.exports = { judgeWithClaude, judgeWithGPT4o, hasOpenRouter, callOpenRouter };
