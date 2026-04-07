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
    // Disagreement — Gemini 2.5 Pro arbitrates as neutral third party
    console.log(`\n⚠️  Judges disagree by ${scoreDiff} points. Invoking Gemini arbiter...`);

    tiebreakerResult = await runTiebreaker(
      transcript,
      proshortOutput,
      claudeResult,
      gptResult
    );

    // Use Gemini's independent final_score
    finalScore = tiebreakerResult.final_score;
    if (tiebreakerResult.evidence_found) {
      // Genuine dispute substantiated by transcript — flag for human review
      verdict = 'yellow';
      console.log(`  📋 Gemini found evidence for lower score (${tiebreakerResult.winner}). Flagging for review.`);
    } else {
      // Clear answer — use Gemini's score
      verdict = scoreToVerdict(finalScore);
      console.log(`  ✅ Gemini resolved: ${finalScore} → ${verdict} (winner: ${tiebreakerResult.winner})`);
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
