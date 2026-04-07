'use strict';

const { judgeWithClaude, judgeWithGPT4o } = require('./judges');
const { runTiebreaker } = require('./tiebreaker');
const { runBantEvaluation } = require('./bant');
const { saveRule } = require('./rules');
const { mergeUnique } = require('./utils');

const DISAGREEMENT_THRESHOLD = 20;

async function evaluateMeeting(meeting) {
  const { transcript, proshortOutput } = meeting;

  if (!transcript || transcript === '[No transcript available]') {
    throw new Error('Meeting has no transcript — cannot evaluate');
  }

  console.log('\n🔬 Running dual-judge + BANT evaluation...');

  // Run both judges AND BANT in parallel
  const [claudeResult, gptResult, bantResult] = await Promise.all([
    judgeWithClaude(transcript, proshortOutput),
    judgeWithGPT4o(transcript, proshortOutput),
    runBantEvaluation(transcript, proshortOutput).catch(err => {
      console.error(`  ⚠️  BANT evaluation failed (non-fatal): ${err.message}`);
      return null;
    }),
  ]);

  const scoreDiff = Math.abs(claudeResult.overall_score - gptResult.overall_score);
  let finalScore, verdict, tiebreakerResult = null;

  if (scoreDiff < DISAGREEMENT_THRESHOLD) {
    // Both agree — average their scores
    finalScore = Math.round((claudeResult.overall_score + gptResult.overall_score) / 2);
    verdict = scoreToVerdict(finalScore);
    console.log(`\n✅ Judges agree (diff: ${scoreDiff}). Final score: ${finalScore} → ${verdict}`);
  } else {
    // Disagreement — make the dissenter justify with evidence
    console.log(`\n⚠️  Judges disagree by ${scoreDiff} points. Invoking tiebreaker...`);

    const dissenterIsClaude = claudeResult.overall_score < gptResult.overall_score;
    const dissenterResult = dissenterIsClaude ? claudeResult : gptResult;
    // gptResult.judge may be 'gpt4o' or 'claude-skeptic' depending on fallback
    const gptJudgeName = gptResult.judge === 'claude-skeptic' ? 'Claude-Skeptic' : 'GPT-4o';
    const dissenterName = dissenterIsClaude ? 'Claude' : gptJudgeName;

    tiebreakerResult = await runTiebreaker(
      transcript,
      proshortOutput,
      dissenterResult,
      dissenterName
    );

    if (tiebreakerResult.evidence_found) {
      // Dissenter proved its case — flag for human review
      finalScore = Math.round((claudeResult.overall_score + gptResult.overall_score) / 2);
      verdict = 'yellow'; // Always yellow when dissenter found evidence
      console.log(`  📋 Dissenter found evidence. Flagging for human review.`);
    } else {
      // Dissenter could not prove it — use the higher score
      finalScore = Math.max(claudeResult.overall_score, gptResult.overall_score);
      verdict = scoreToVerdict(finalScore);
      console.log(`  ✅ Dissenter conceded. Using higher score: ${finalScore} → ${verdict}`);
    }

    // Save prompt improvement rule
    if (tiebreakerResult.prompt_improvement) {
      try {
        await saveRule(
          tiebreakerResult.prompt_improvement,
          tiebreakerResult.why_ambiguous
        );
      } catch (err) {
        console.error('  ⚠️  Failed to save rule:', err.message);
      }
    }
  }

  return {
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    meetingDate: meeting.date,
    finalScore,
    verdict,
    claudeScore: claudeResult.overall_score,
    gptScore: gptResult.overall_score,
    scoreDiff,
    disagreement: scoreDiff >= DISAGREEMENT_THRESHOLD,
    claudeResult,
    gptResult,
    tiebreakerResult,
    bantResult,
    missed: mergeUnique(claudeResult.what_proshot_missed, gptResult.what_proshot_missed),
    wrong: mergeUnique(claudeResult.what_proshot_got_wrong, gptResult.what_proshot_got_wrong),
    right: mergeUnique(claudeResult.what_proshot_got_right, gptResult.what_proshot_got_right),
    timestamp: new Date().toISOString(),
  };
}

function scoreToVerdict(score) {
  if (score >= 80) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}

module.exports = { evaluateMeeting };
