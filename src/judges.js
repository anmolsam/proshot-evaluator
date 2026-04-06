'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { loadRules, buildJudgePromptWithRules } = require('./rules');
const { parseJsonSafely, sleep } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY });

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

function buildJudgeMessages(transcript, proshortOutput) {
  const rules = loadRules();
  const prompt = buildJudgePromptWithRules(BASE_JUDGE_PROMPT, rules);

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

async function judgeWithClaude(transcript, proshortOutput) {
  console.log('  🤖 Claude judging...');
  const { systemPrompt, userContent } = buildJudgeMessages(transcript, proshortOutput);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
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

      const result = parseJsonSafely(textBlock.text);
      result.judge = 'claude';
      result.overall_score = Math.round(result.overall_score);
      console.log(`  ✅ Claude score: ${result.overall_score}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  Claude attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  throw new Error(`Claude judging failed after 2 attempts: ${lastErr.message}`);
}

async function judgeWithGPT4o(transcript, proshortOutput) {
  console.log('  🤖 GPT-4o judging...');
  const { systemPrompt, userContent } = buildJudgeMessages(transcript, proshortOutput);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
      });

      const text = response.choices[0]?.message?.content;
      if (!text) throw new Error('No content in GPT-4o response');

      const result = parseJsonSafely(text);
      result.judge = 'gpt4o';
      result.overall_score = Math.round(result.overall_score);
      console.log(`  ✅ GPT-4o score: ${result.overall_score}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  GPT-4o attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  throw new Error(`GPT-4o judging failed after 2 attempts: ${lastErr.message}`);
}

module.exports = { judgeWithClaude, judgeWithGPT4o };
