'use strict';

require('dotenv').config();
const fetch = require('node-fetch');

const BASE_URL = 'https://api.airtable.com/v0';
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.AIRTABLE_TABLE || 'Evaluations';
const RULES_TABLE = process.env.AIRTABLE_RULES_TABLE || 'PromptRules';

function isConfigured() {
  return (
    TOKEN && TOKEN !== 'your_fresh_airtable_token_here' &&
    BASE_ID && BASE_ID !== 'your_airtable_base_id_here'
  );
}

async function airtableRequest(method, table, body) {
  const url = `${BASE_URL}/${BASE_ID}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Airtable ${method} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function logEvaluation(evalResult) {
  if (!isConfigured()) {
    console.log('  ⚠️  Airtable not configured — skipping log');
    return null;
  }

  try {
    const fields = {
      'Meeting ID': String(evalResult.meetingId || ''),
      'Meeting Title': String(evalResult.meetingTitle || ''),
      'Meeting Date': evalResult.meetingDate
        ? new Date(evalResult.meetingDate).toISOString().split('T')[0]
        : '',
      'Final Score': Number(evalResult.finalScore) || 0,
      'Verdict': evalResult.verdict || 'yellow',
      'Claude Score': Number(evalResult.claudeScore) || 0,
      'GPT4o Score': Number(evalResult.gptScore) || 0,
      'Score Difference': Number(evalResult.scoreDiff) || 0,
      'Disagreement': Boolean(evalResult.disagreement),
      'What Proshot Got Right': (evalResult.right || []).join('\n• '),
      'What Proshot Missed': (evalResult.missed || []).join('\n• '),
      'What Proshot Got Wrong': (evalResult.wrong || []).join('\n• '),
      'Tiebreaker Verdict': evalResult.tiebreakerResult?.verdict || '',
      'Prompt Rule Generated': evalResult.tiebreakerResult?.prompt_improvement || '',
      'Timestamp': evalResult.timestamp || new Date().toISOString(),
      // ── BANT fields ──
      ...buildBantFields(evalResult.bantResult),
    };

    const result = await airtableRequest('POST', TABLE, { fields });
    console.log(`  ✅ Logged to Airtable: record ${result.id}`);
    return result.id;
  } catch (err) {
    console.error(`  ⚠️  Airtable log failed: ${err.message}`);
    return null;
  }
}

async function updateHumanDecision(meetingId, item, decision) {
  if (!isConfigured()) {
    console.log('  ⚠️  Airtable not configured');
    return;
  }

  try {
    // Find the record first
    const url = `${BASE_URL}/${BASE_ID}/${encodeURIComponent(TABLE)}?filterByFormula=${encodeURIComponent(`{Meeting ID}="${meetingId}"`)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();

    if (!data.records || data.records.length === 0) {
      throw new Error(`No Airtable record found for meeting ${meetingId}`);
    }

    const recordId = data.records[0].id;
    await airtableRequest('PATCH', `${TABLE}/${recordId}`, {
      fields: {
        'Human Decision': `${item}: ${decision}`,
      },
    });
    console.log(`  ✅ Human decision saved for meeting ${meetingId}`);
  } catch (err) {
    console.error(`  ⚠️  Failed to save human decision: ${err.message}`);
    throw err;
  }
}

async function logRule(rule, whyAmbiguous) {
  if (!isConfigured()) return;

  try {
    await airtableRequest('POST', RULES_TABLE, {
      fields: {
        'Rule': rule,
        'Why Ambiguous': whyAmbiguous || '',
        'Date Added': new Date().toISOString().split('T')[0],
        'Times Applied': 0,
        'Yellows Prevented': 0,
      },
    });
    console.log('  ✅ Rule logged to Airtable');
  } catch (err) {
    console.error(`  ⚠️  Failed to log rule to Airtable: ${err.message}`);
  }
}

async function fetchAllEvaluations() {
  if (!isConfigured()) return [];

  try {
    const url = `${BASE_URL}/${BASE_ID}/${encodeURIComponent(TABLE)}?sort[0][field]=Timestamp&sort[0][direction]=desc&maxRecords=200`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    return (data.records || []).map(r => ({ id: r.id, ...r.fields }));
  } catch (err) {
    console.error(`  ⚠️  Airtable fetch failed: ${err.message}`);
    return [];
  }
}

async function getStats() {
  const records = await fetchAllEvaluations();
  if (records.length === 0) return { total: 0, avgScore: 0, green: 0, yellow: 0, red: 0 };

  const total = records.length;
  const avgScore = Math.round(records.reduce((s, r) => s + (r['Final Score'] || 0), 0) / total);
  const green = records.filter(r => r['Verdict'] === 'green').length;
  const yellow = records.filter(r => r['Verdict'] === 'yellow').length;
  const red = records.filter(r => r['Verdict'] === 'red').length;

  return { total, avgScore, green, yellow, red, records };
}

function buildBantFields(bant) {
  if (!bant) return {};
  const a = (q) => (bant[q]?.answer || 'unknown').toLowerCase();
  const evidence = Object.entries(bant)
    .filter(([k, v]) => k.startsWith('q') && v?.evidence)
    .map(([k, v]) => `${k}: ${v.evidence}`)
    .join('\n');

  return {
    'BANT Status': bant.q10_bant_status?.answer || 'needs_review',
    'BANT Score': bant.q10_bant_status?.bant_score || '',
    'Q1 Trade Supported': a('q1_trade_supported'),
    'Q2 TAT Aligned': a('q2_tat_aligned'),
    'Q3 Budget Confirmed': a('q3_budget_confirmed'),
    'Q4 Decision Criteria': a('q4_decision_criteria'),
    'Q5 Approval Steps Mapped': a('q5_approval_steps_mapped'),
    'Q6 Need End to End': a('q6_need_end_to_end'),
    'Q7 Close Within 90 Days': a('q7_close_within_90_days'),
    'Q8 Deal Over 50K If Long': a('q8_deal_size_over_50k_if_long'),
    'Tech Qualified': a('q9_tech_qualified'),
    'Proshot Captured BANT': bant.proshot_captured_bant?.answer || 'unknown',
    'BANT Evidence': evidence,
    'Recommended Next Action': bant.recommended_next_action || '',
  };
}

module.exports = { logEvaluation, updateHumanDecision, logRule, fetchAllEvaluations, getStats };
