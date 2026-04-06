'use strict';

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', 'data', 'rules.json');

function loadRules() {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRule(rule, whyAmbiguous) {
  const rules = loadRules();

  // Avoid exact duplicates
  const exists = rules.some(r => r.rule.trim() === rule.trim());
  if (exists) {
    console.log('📋 Rule already exists, skipping duplicate.');
    return;
  }

  rules.push({
    id: Date.now(),
    rule,
    whyAmbiguous: whyAmbiguous || '',
    dateAdded: new Date().toISOString(),
    timesApplied: 0,
    yellowsPrevented: 0,
  });

  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  console.log(`✅ New rule saved: "${rule.slice(0, 80)}..."`);
}

function incrementRuleUsage(ruleId) {
  const rules = loadRules();
  const rule = rules.find(r => r.id === ruleId);
  if (rule) {
    rule.timesApplied = (rule.timesApplied || 0) + 1;
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  }
}

function buildJudgePromptWithRules(basePrompt, rules) {
  if (!rules || rules.length === 0) return basePrompt;
  const rulesText = rules
    .map((r, i) => `Rule ${i + 1}: ${r.rule}`)
    .join('\n');
  return (
    basePrompt +
    `\n\nAdditional evaluation rules learned from past disagreements:\n${rulesText}`
  );
}

module.exports = { loadRules, saveRule, incrementRuleUsage, buildJudgePromptWithRules };
