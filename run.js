#!/usr/bin/env node
'use strict';

require('dotenv').config();
const path = require('path');
const { fetchMeeting, fetchAllMeetings, loadMeetingFromFile, discoverWorkingEndpoint } = require('./src/proshot');
const { evaluateMeeting } = require('./src/evaluator');
const { logEvaluation } = require('./src/airtable');
const { loadRules } = require('./src/rules');
const { formatScore, verdictEmoji } = require('./src/utils');

const args = process.argv.slice(2);

function checkEnv() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('PASTE_YOUR')) {
    console.error('\n❌ Missing required API key in .env: ANTHROPIC_API_KEY');
    console.error('   Get it at: https://console.anthropic.com/settings/keys\n');
    process.exit(1);
  }
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.trim().length < 10) {
    console.log('  ℹ️  OPENROUTER_API_KEY not set — Judge B will use Claude skeptic mode, tiebreaker will use Claude\n');
  }
}

function printStatus() {
  const keys = {
    'ANTHROPIC_API_KEY': process.env.ANTHROPIC_API_KEY,
    'OPENROUTER_API_KEY': process.env.OPENROUTER_API_KEY,
    'PROSHOT_API_KEY': process.env.PROSHOT_API_KEY,
    'AIRTABLE_TOKEN': process.env.AIRTABLE_TOKEN,
    'AIRTABLE_BASE_ID': process.env.AIRTABLE_BASE_ID,
  };
  console.log('\n🔑 API Key Status:');
  for (const [k, v] of Object.entries(keys)) {
    const ok = v && !v.includes('PASTE_YOUR') && !v.includes('PASTE_BASE');
    const masked = ok ? `${v.slice(0, 8)}...${v.slice(-4)}` : '❌ NOT SET';
    console.log(`   ${ok ? '✅' : '❌'} ${k}: ${masked}`);
  }
  console.log();
}

function printUsage() {
  console.log(`
Proshot Meeting Evaluator
=========================
Usage:
  node run.js --meeting <id>          Evaluate one meeting by ID
  node run.js --file <path>           Evaluate from local JSON file
  node run.js --all [--days <n>]      Evaluate all recent meetings
  node run.js --discover              Probe Proshot API endpoints
  node run.js --rules                 Show current prompt rules
  node run.js --serve                 Start dashboard server
  node run.js --status                Show API key status
  node run.js --setup                 Create Airtable tables
  node run.js --help                  Show this help
`);
}

function printResult(result) {
  const emoji = verdictEmoji(result.verdict);
  console.log(`
╔══════════════════════════════════════════════════╗
  ${emoji}  ${result.meetingTitle}
  ID: ${result.meetingId} | Date: ${result.meetingDate?.split('T')[0] || 'N/A'}
══════════════════════════════════════════════════
  Final Score:   ${formatScore(result.finalScore)}  (${result.verdict.toUpperCase()})
  Claude Score:  ${result.claudeScore}
  GPT-4o Score:  ${result.gptScore}
  Disagreement:  ${result.disagreement ? `YES (diff: ${result.scoreDiff})` : `No (diff: ${result.scoreDiff})`}
${result.tiebreakerResult ? `  Tiebreaker:    ${result.tiebreakerResult.verdict} (evidence: ${result.tiebreakerResult.evidence_found})` : ''}
══════════════════════════════════════════════════
  ✅ Got Right (${result.right.length}):
${result.right.map(r => `    • ${r}`).join('\n') || '    (none)'}

  ❌ Got Wrong (${result.wrong.length}):
${result.wrong.map(r => `    • ${r}`).join('\n') || '    (none)'}

  🔍 Missed (${result.missed.length}):
${result.missed.map(r => `    • ${r}`).join('\n') || '    (none)'}
╚══════════════════════════════════════════════════╝`);
}

async function runEvaluation(meeting) {
  const result = await evaluateMeeting(meeting);
  printResult(result);

  console.log('\n📊 Logging to Airtable...');
  await logEvaluation(result);

  return result;
}

async function main() {
  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    return;
  }

  if (args.includes('--status')) {
    printStatus();
    return;
  }

  if (args.includes('--setup')) {
    require('./setup-airtable');
    return;
  }

  if (args.includes('--serve')) {
    const server = require('./server');
    return; // server.js starts itself
  }

  if (args.includes('--discover')) {
    const found = await discoverWorkingEndpoint();
    if (!found) {
      console.log('\n❌ No working endpoint found. Use --file to load meetings from JSON files.');
    }
    return;
  }

  if (args.includes('--rules')) {
    const rules = loadRules();
    if (rules.length === 0) {
      console.log('No prompt rules yet. They are generated automatically from tiebreaker decisions.');
    } else {
      console.log(`\n📋 Current Prompt Rules (${rules.length}):\n`);
      rules.forEach((r, i) => {
        console.log(`Rule ${i + 1}: ${r.rule}`);
        console.log(`  Why: ${r.whyAmbiguous}`);
        console.log(`  Applied: ${r.timesApplied} times | Added: ${r.dateAdded?.split('T')[0]}`);
        console.log();
      });
    }
    return;
  }

  // All commands below require AI keys
  if (!args.includes('--rules') && !args.includes('--discover')) {
    checkEnv();
  }

  if (args.includes('--file')) {
    const idx = args.indexOf('--file');
    const filePath = args[idx + 1];
    if (!filePath) {
      console.error('❌ --file requires a path argument');
      process.exit(1);
    }
    const meeting = loadMeetingFromFile(filePath);
    await runEvaluation(meeting);
    return;
  }

  if (args.includes('--meeting')) {
    const idx = args.indexOf('--meeting');
    const meetingId = args[idx + 1];
    if (!meetingId) {
      console.error('❌ --meeting requires an ID argument');
      process.exit(1);
    }
    const meeting = await fetchMeeting(meetingId);
    await runEvaluation(meeting);
    return;
  }

  if (args.includes('--all')) {
    const daysIdx = args.indexOf('--days');
    const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 7 : 7;
    const meetings = await fetchAllMeetings(days);

    if (meetings.length === 0) {
      console.log('No meetings found.');
      return;
    }

    console.log(`\nFound ${meetings.length} meetings. Evaluating...\n`);
    const results = [];
    for (const meeting of meetings) {
      try {
        const result = await runEvaluation(meeting);
        results.push(result);
      } catch (err) {
        console.error(`❌ Failed to evaluate ${meeting.id}: ${err.message}`);
      }
    }

    if (args.includes('--summary') && results.length > 0) {
      const avg = Math.round(results.reduce((s, r) => s + r.finalScore, 0) / results.length);
      const green = results.filter(r => r.verdict === 'green').length;
      const yellow = results.filter(r => r.verdict === 'yellow').length;
      const red = results.filter(r => r.verdict === 'red').length;
      console.log(`\n📊 Summary: ${results.length} meetings | Avg score: ${avg}`);
      console.log(`   🟢 ${green} green | 🟡 ${yellow} yellow | 🔴 ${red} red`);
    }
    return;
  }

  printUsage();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
