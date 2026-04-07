#!/usr/bin/env node
'use strict';

/**
 * Airtable Setup Script
 *
 * Run this ONCE after creating a base at airtable.com to create the
 * required tables and fields automatically.
 *
 * Usage:
 *   1. Go to airtable.com and create a new base called "Proshot Evaluator"
 *   2. Copy the base ID from the URL: airtable.com/YOUR_BASE_ID/...
 *   3. Update AIRTABLE_BASE_ID in your .env file
 *   4. Run: node setup-airtable.js
 */

require('dotenv').config();
const fetch = require('node-fetch');

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID;

if (!TOKEN || TOKEN.includes('PASTE_YOUR')) {
  console.error('❌ AIRTABLE_TOKEN not set in .env');
  process.exit(1);
}
if (!BASE_ID || BASE_ID.includes('PASTE_BASE_ID')) {
  console.error('❌ AIRTABLE_BASE_ID not set in .env');
  console.error('\nSteps:');
  console.error('  1. Go to https://airtable.com and create a new base called "Proshot Evaluator"');
  console.error('  2. The URL will be: airtable.com/appXXXXXXXXXXXXXX/...');
  console.error('  3. Copy the appXXXX part → that is your AIRTABLE_BASE_ID');
  console.error('  4. Update .env: AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX');
  console.error('  5. Re-run: node setup-airtable.js');
  process.exit(1);
}

const BASE_URL = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;

async function apiRequest(method, path, body) {
  const url = `${BASE_URL}${path}`;
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
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function getExistingTables() {
  const schema = await apiRequest('GET', '/tables');
  return schema.tables || [];
}

async function createTable(tableName, fields) {
  console.log(`  Creating table: ${tableName}...`);
  try {
    await apiRequest('POST', '/tables', { name: tableName, fields });
    console.log(`  ✅ Created: ${tableName}`);
  } catch (err) {
    if (err.message.includes('already exists') || err.message.includes('DUPLICATE')) {
      console.log(`  ℹ️  Already exists: ${tableName}`);
    } else {
      throw err;
    }
  }
}

async function addFields(tableId, tableName, fields) {
  for (const field of fields) {
    try {
      await apiRequest('POST', `/tables/${tableId}/fields`, field);
      console.log(`    ✅ Field: ${field.name}`);
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('DUPLICATE')) {
        process.stdout.write('.');
      } else {
        console.log(`    ⚠️  Field ${field.name}: ${err.message.slice(0, 80)}`);
      }
    }
  }
}

async function main() {
  console.log('\n🔧 Proshot Evaluator — Airtable Setup');
  console.log(`   Base ID: ${BASE_ID}\n`);

  // Test connection
  try {
    await apiRequest('GET', '/tables');
    console.log('✅ Connected to Airtable\n');
  } catch (err) {
    console.error('❌ Cannot connect to Airtable:', err.message);
    console.error('\nCheck:');
    console.error('  1. AIRTABLE_TOKEN is correct in .env');
    console.error('  2. The token has "data.records:read/write" and "schema.bases:read/write" scopes');
    console.error('  3. AIRTABLE_BASE_ID is correct (starts with "app")');
    process.exit(1);
  }

  const tables = await getExistingTables();
  const tableNames = tables.map(t => t.name);
  console.log(`Found ${tables.length} existing tables: ${tableNames.join(', ') || 'none'}\n`);

  // ── Evaluations table ──────────────────────────────────────────────────
  console.log('📊 Setting up Evaluations table...');
  let evalTable = tables.find(t => t.name === 'Evaluations');

  if (!evalTable) {
    await createTable('Evaluations', [
      { name: 'Meeting ID', type: 'singleLineText' },
    ]);
    const updated = await getExistingTables();
    evalTable = updated.find(t => t.name === 'Evaluations');
  }

  if (evalTable) {
    const existingFields = (evalTable.fields || []).map(f => f.name);
    const newFields = [
      { name: 'Meeting Title', type: 'singleLineText' },
      { name: 'Meeting Date', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } },
      { name: 'Final Score', type: 'number', options: { precision: 0 } },
      { name: 'Verdict', type: 'singleSelect', options: { choices: [
        { name: 'green', color: 'greenBright' },
        { name: 'yellow', color: 'yellowBright' },
        { name: 'red', color: 'redBright' },
      ]}},
      { name: 'Claude Score', type: 'number', options: { precision: 0 } },
      { name: 'GPT4o Score', type: 'number', options: { precision: 0 } },
      { name: 'Score Difference', type: 'number', options: { precision: 0 } },
      { name: 'Disagreement', type: 'checkbox', options: { color: 'yellowBright', icon: 'check' } },
      { name: 'What Proshot Got Right', type: 'multilineText' },
      { name: 'What Proshot Missed', type: 'multilineText' },
      { name: 'What Proshot Got Wrong', type: 'multilineText' },
      { name: 'Tiebreaker Verdict', type: 'singleLineText' },
      { name: 'Human Decision', type: 'singleLineText' },
      { name: 'Prompt Rule Generated', type: 'multilineText' },
      { name: 'Timestamp', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } },
      // ── BANT Qualification Fields ──────────────────────────────────────
      { name: 'BANT Status', type: 'singleSelect', options: { choices: [
        { name: 'qualified', color: 'greenBright' },
        { name: 'needs_review', color: 'yellowBright' },
        { name: 'disqualified', color: 'redBright' },
      ]}},
      { name: 'BANT Score', type: 'singleLineText' },
      { name: 'Q1 Trade Supported', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q2 TAT Aligned', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q3 Budget Confirmed', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q4 Decision Criteria', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q5 Approval Steps Mapped', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q6 Need End to End', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q7 Close Within 90 Days', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Q8 Deal Over 50K If Long', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }, { name: 'n/a', color: 'blueBright' }] } },
      { name: 'Tech Qualified', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'no', color: 'redBright' }, { name: 'unknown', color: 'grayBright' }] } },
      { name: 'Proshot Captured BANT', type: 'singleSelect', options: { choices: [{ name: 'yes', color: 'greenBright' }, { name: 'partial', color: 'yellowBright' }, { name: 'no', color: 'redBright' }] } },
      { name: 'BANT Evidence', type: 'multilineText' },
      { name: 'Recommended Next Action', type: 'multilineText' },
    ].filter(f => !existingFields.includes(f.name));

    if (newFields.length > 0) {
      console.log(`  Adding ${newFields.length} fields...`);
      await addFields(evalTable.id, 'Evaluations', newFields);
    } else {
      console.log('  ✅ All fields already exist');
    }
  }

  // ── PromptRules table ──────────────────────────────────────────────────
  console.log('\n📋 Setting up PromptRules table...');
  let rulesTable = tables.find(t => t.name === 'PromptRules');

  if (!rulesTable) {
    await createTable('PromptRules', [
      { name: 'Rule', type: 'multilineText' },
    ]);
    const updated = await getExistingTables();
    rulesTable = updated.find(t => t.name === 'PromptRules');
  }

  if (rulesTable) {
    const existingFields = (rulesTable.fields || []).map(f => f.name);
    const newFields = [
      { name: 'Why Ambiguous', type: 'multilineText' },
      { name: 'Date Added', type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } },
      { name: 'Times Applied', type: 'number', options: { precision: 0 } },
      { name: 'Yellows Prevented', type: 'number', options: { precision: 0 } },
    ].filter(f => !existingFields.includes(f.name));

    if (newFields.length > 0) {
      console.log(`  Adding ${newFields.length} fields...`);
      await addFields(rulesTable.id, 'PromptRules', newFields);
    } else {
      console.log('  ✅ All fields already exist');
    }
  }

  console.log('\n✅ Airtable setup complete!');
  console.log('\nNext steps:');
  console.log('  1. Run: node run.js --meeting jy5af2dc');
  console.log('  2. Or:  node run.js --file data/sample-meeting.json');
  console.log('  3. Or:  node run.js --serve  (start dashboard)\n');
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
