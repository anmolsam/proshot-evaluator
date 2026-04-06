'use strict';

function mergeUnique(arrA, arrB) {
  const seen = new Set();
  const result = [];
  for (const item of [...(arrA || []), ...(arrB || [])]) {
    const key = typeof item === 'string' ? item.trim().toLowerCase() : JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function parseJsonSafely(text) {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try extracting the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error(`JSON parse failed: ${e.message}\nRaw text: ${text.slice(0, 300)}`);
  }
}

function formatScore(score) {
  if (score >= 80) return `🟢 ${score}`;
  if (score >= 40) return `🟡 ${score}`;
  return `🔴 ${score}`;
}

function verdictEmoji(verdict) {
  return { green: '🟢', yellow: '🟡', red: '🔴' }[verdict] || '⚪';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { mergeUnique, parseJsonSafely, formatScore, verdictEmoji, sleep };
