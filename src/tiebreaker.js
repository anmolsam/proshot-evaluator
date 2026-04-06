'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { parseJsonSafely, sleep } = require('./utils');

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY });

const DISSENTER_PROMPT = `You are a strict evidence-based auditor. In a previous evaluation, you and another AI judge disagreed about Proshot's meeting analysis. You scored it lower.

You must now re-read the full transcript and find SPECIFIC evidence — direct quotes or clear references — that support your lower score. You cannot simply assert that Proshot was wrong. You must prove it from the transcript.

If you cannot find clear evidence, you must concede — Proshot was probably right and your initial score was too strict.

Also: identify what made this case ambiguous and suggest a specific improvement to the evaluation prompt that would prevent this disagreement in future evaluations.

Respond ONLY in this exact JSON format:
{
  "evidence_found": true or false,
  "evidence": ["exact quote from transcript that supports your disagreement"],
  "disputed_items": ["list of specific items you are disputing"],
  "verdict": "proshot_correct" or "proshot_incorrect",
  "confidence": <0-100>,
  "why_ambiguous": "explanation of why this was a borderline case",
  "prompt_improvement": "specific rule to add to future evaluation prompts to handle this pattern"
}`;

async function runTiebreaker(transcript, proshortOutput, dissenterResult, dissenterName) {
  console.log(`\n  ⚖️  Tiebreaker: asking ${dissenterName} to justify its lower score...`);

  const userContent = `## Raw Meeting Transcript

${transcript}

## Proshot AI Analysis

**Summary:** ${proshortOutput.summary || '(none)'}
**Action Items:** ${JSON.stringify(proshortOutput.actionItems || [])}
**CRM Fields:** ${JSON.stringify(proshortOutput.crmFields || {})}

## Your Original Evaluation (Lower Score)

Score: ${dissenterResult.overall_score}
What you said Proshot got wrong: ${JSON.stringify(dissenterResult.what_proshot_got_wrong || [])}
What you said Proshot missed: ${JSON.stringify(dissenterResult.what_proshot_missed || [])}
Your reasoning: ${dissenterResult.reasoning || ''}

Now re-examine the transcript carefully and determine if your lower score was justified.`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let result;

      if (dissenterName === 'Claude') {
        const stream = anthropic.messages.stream({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          system: DISSENTER_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        });
        const response = await stream.finalMessage();
        const textBlock = response.content.find(b => b.type === 'text');
        if (!textBlock) throw new Error('No text in Claude tiebreaker response');
        result = parseJsonSafely(textBlock.text);
      } else {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 4096,
          temperature: 0,
          messages: [
            { role: 'system', content: DISSENTER_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
        });
        const text = response.choices[0]?.message?.content;
        if (!text) throw new Error('No content in GPT-4o tiebreaker response');
        result = parseJsonSafely(text);
      }

      result.dissenter = dissenterName;
      console.log(
        `  ✅ Tiebreaker verdict: ${result.verdict} (evidence_found: ${result.evidence_found})`
      );
      return result;
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  Tiebreaker attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  throw new Error(`Tiebreaker failed after 2 attempts: ${lastErr.message}`);
}

module.exports = { runTiebreaker };
