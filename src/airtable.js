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

    // Strip null/undefined values — Airtable rejects null for singleSelect fields
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)
    );
    const result = await airtableRequest('POST', TABLE, { fields: cleanFields });
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

  // Safely extract a string answer — strips any accidental surrounding quotes
  const ans = (field) => {
    const raw = bant[field]?.answer ?? bant[field] ?? '';
    return String(raw).replace(/^["']+|["']+$/g, '').toLowerCase().trim();
  };

  // Map to exact Airtable choice names — return null for unknown (leaves field blank)
  const ynu = (field) => {
    const v = ans(field);
    if (v === 'yes') return 'Yes';
    if (v === 'no') return 'No';
    return 'Unknown';   // 'Unknown' IS a valid choice in every yes/no/unknown field
  };
  const ynNa = (field) => {
    const v = ans(field);
    if (v === 'yes') return 'Yes';
    if (v === 'no') return 'No';
    if (v === 'n/a' || v === 'na') return 'N/A';
    return null;  // leave blank when truly unknown for N/A-type fields
  };

  const techEligible = ans('tech_eligible');
  const qualifiedDeal = ans('qualified_deal');
  const ntQual = ans('nt_300_qualified');
  const pcBant = ans('proshot_captured_bant');

  // Build evidence lines
  const evidence = [
    ['q1_trade_supported', 'Q1 Trade'],
    ['q2_tat_aligned', 'Q2 TAT'],
    ['qb_budget_confirmed', 'B Budget'],
    ['qa1_decision_criteria', 'A1 Decision Criteria'],
    ['qa2_approval_steps_mapped', 'A2 Approval Steps'],
    ['qn_end_to_end_offload', 'N End-to-End'],
    ['qt1_close_within_90_days', 'T1 90 Days'],
    ['qt2_deal_over_50k_if_long', 'T2 >$50K'],
  ].filter(([k]) => bant[k]?.evidence)
    .map(([k, label]) => `${label}: "${bant[k].evidence}"`)
    .join('\n');

  return {
    // ── Section 1: Tech Eligibility ──
    'Tech: Is trade/service supported by Beam AI?':
      ans('q1_trade_supported') === 'yes' ? 'Yes' : 'No',
    'Tech: Does required TAT align with Beam AI delivery?': ynu('q2_tat_aligned'),
    'Tech: If DQ — Proof Attached?':
      ans('q_dq_proof') === 'proshot' ? 'Proshot'
      : ans('q_dq_proof') === 'written_proof' ? 'Written Proof'
      : 'N/A',
    'Tech Eligible':
      techEligible === 'yes' ? 'Yes'
      : techEligible === 'no' ? 'No — Technical DQ'
      : 'Unknown',
    // ── Section 2: BANT ──
    'B: Prospect confirmed ability to invest? (DFY $10K / DIY $7K + licensing)': ynu('qb_budget_confirmed'),
    'A: Decision Criteria identified?': ynu('qa1_decision_criteria'),
    'A: Internal approval steps mapped? (procurement/legal)': ynu('qa2_approval_steps_mapped'),
    'N: Customer willing to offload end-to-end to AI? (Mandatory)': ynu('qn_end_to_end_offload'),
    'T: Can deal close within 90 days?': ynu('qt1_close_within_90_days'),
    'T: If >90 days — deal size > $50K?': ynNa('qt2_deal_over_50k_if_long'),
    // ── Section 3: Deal Control ──
    'BANT Score': String(bant.bant_score || ''),
    'Qualified Deal (Tech Eligible + 3/4 BANT)':
      qualifiedDeal === 'yes' ? 'Yes'
      : qualifiedDeal === 'no' ? 'No'
      : 'Needs Review',
    'Pilot Allowed (Qualified Deal only)': qualifiedDeal === 'yes' ? 'Yes' : 'No',
    'Sales Cycle Started (at 3/4 BANT)': ans('sales_cycle_start') === 'yes' ? 'Yes' : 'No',
    'Forecast Allowed (Qualified Deal only)': qualifiedDeal === 'yes' ? 'Yes' : 'No',
    // ── Section 4: Closed Lost ──
    'N+T+$300 Qualified':
      ntQual === 'yes' ? 'Yes' : ntQual === 'no' ? 'No' : 'Unknown',
    // ── Meta ──
    'Proshot Captured BANT?':
      pcBant === 'yes' ? 'Yes' : pcBant === 'partial' ? 'Partial' : pcBant === 'no' ? 'No' : 'Partial',
    'BANT Evidence': evidence,
    'Recommended Next Action': String(bant.recommended_next_action || ''),
  };
}

module.exports = { logEvaluation, updateHumanDecision, logRule, fetchAllEvaluations, getStats };
