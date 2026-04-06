'use strict';

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.PROSHOT_API_KEY;

// Endpoint candidates to try in order
const ENDPOINT_CANDIDATES = [
  'https://api.proshort.ai/v1/meetings',
  'https://api.proshort.ai/v1/calls',
  'https://api.proshort.ai/api/v1/meetings',
  'https://api.proshort.ai/v1/recordings',
  'https://api.proshort.ai/meetings',
];

const MEETING_ENDPOINT_CANDIDATES = (id) => [
  `https://api.proshort.ai/v1/meetings/${id}`,
  `https://api.proshort.ai/v1/calls/${id}`,
  `https://api.proshort.ai/api/v1/meetings/${id}`,
  `https://api.proshort.ai/v1/recordings/${id}`,
  `https://api.proshort.ai/meetings/${id}`,
];

const AUTH_STYLES = (key) => [
  { Authorization: `Bearer ${key}` },
  { Authorization: key },
  { 'x-api-key': key },
  { 'X-API-Key': key },
];

async function tryFetch(url, headers) {
  try {
    const res = await fetch(url, { headers, timeout: 10000 });
    const text = await res.text();
    if (res.ok) {
      try {
        return { ok: true, data: JSON.parse(text), status: res.status };
      } catch {
        return { ok: false, error: `Non-JSON response: ${text.slice(0, 200)}`, status: res.status };
      }
    }
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message, status: 0 };
  }
}

async function discoverWorkingEndpoint() {
  console.log('🔍 Probing Proshot API endpoints...');
  for (const url of ENDPOINT_CANDIDATES) {
    for (const authHeaders of AUTH_STYLES(API_KEY)) {
      const authLabel = Object.keys(authHeaders)[0];
      process.stdout.write(`  Trying ${url} [${authLabel}]... `);
      const result = await tryFetch(url, authHeaders);
      if (result.ok) {
        console.log(`✅ SUCCESS`);
        console.log('  Response keys:', Object.keys(result.data));
        return { url, headers: authHeaders, data: result.data };
      }
      console.log(`❌ ${result.status}`);
    }
  }
  return null;
}

async function fetchMeeting(meetingId) {
  if (!API_KEY || API_KEY === 'your_fresh_proshot_key_here') {
    throw new Error('PROSHOT_API_KEY not configured in .env');
  }

  console.log(`\n📡 Fetching meeting ${meetingId} from Proshot API...`);

  for (const url of MEETING_ENDPOINT_CANDIDATES(meetingId)) {
    for (const authHeaders of AUTH_STYLES(API_KEY)) {
      const authLabel = Object.keys(authHeaders)[0];
      process.stdout.write(`  Trying ${url} [${authLabel}]... `);
      const result = await tryFetch(url, authHeaders);
      if (result.ok) {
        console.log(`✅ SUCCESS`);
        return normalizeMeeting(result.data, meetingId);
      }
      console.log(`❌ ${result.status}`);
    }
  }

  throw new Error(
    `Could not fetch meeting ${meetingId} from any Proshot endpoint. ` +
    `Check your API key and try loading from a JSON file with --file path/to/meeting.json`
  );
}

async function fetchAllMeetings(days = 7) {
  if (!API_KEY || API_KEY === 'your_fresh_proshot_key_here') {
    throw new Error('PROSHOT_API_KEY not configured in .env');
  }

  console.log(`\n📡 Fetching meetings from last ${days} days...`);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  for (const url of ENDPOINT_CANDIDATES) {
    const urlWithParams = `${url}?from=${cutoff}&limit=100`;
    for (const authHeaders of AUTH_STYLES(API_KEY)) {
      const authLabel = Object.keys(authHeaders)[0];
      process.stdout.write(`  Trying ${urlWithParams} [${authLabel}]... `);
      const result = await tryFetch(urlWithParams, authHeaders);
      if (result.ok) {
        console.log(`✅ SUCCESS`);
        const meetings = extractMeetingsList(result.data);
        return meetings.map(m => normalizeMeeting(m, m.id || m.meetingId || m.call_id));
      }
      console.log(`❌ ${result.status}`);
    }
  }

  throw new Error('Could not fetch meetings list from any Proshot endpoint.');
}

function extractMeetingsList(data) {
  // Handle various response shapes
  if (Array.isArray(data)) return data;
  if (data.meetings) return data.meetings;
  if (data.calls) return data.calls;
  if (data.recordings) return data.recordings;
  if (data.data) return Array.isArray(data.data) ? data.data : [data.data];
  return [data];
}

function normalizeMeeting(raw, id) {
  // Normalize various Proshot response shapes into our standard format
  return {
    id: id || raw.id || raw.meetingId || raw.call_id || 'unknown',
    title: raw.title || raw.name || raw.meeting_title || raw.subject || `Meeting ${id}`,
    date: raw.date || raw.created_at || raw.start_time || raw.startTime || new Date().toISOString(),
    transcript: extractTranscript(raw),
    proshortOutput: extractPrshortOutput(raw),
    raw,
  };
}

function extractTranscript(raw) {
  // Try all known field names for transcript
  const candidates = [
    raw.transcript,
    raw.transcription,
    raw.full_transcript,
    raw.raw_transcript,
    raw.call_transcript,
    raw.meeting_transcript,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.length > 10) return c;
    if (c && typeof c === 'object') {
      // Could be array of speaker turns
      if (Array.isArray(c)) {
        return c.map(turn => {
          const speaker = turn.speaker || turn.name || turn.participant || 'Unknown';
          const text = turn.text || turn.content || turn.transcript || '';
          return `${speaker}: ${text}`;
        }).join('\n');
      }
    }
  }
  return raw.transcript || '[No transcript available]';
}

function extractPrshortOutput(raw) {
  return {
    summary: raw.summary || raw.ai_summary || raw.meeting_summary || raw.notes || '',
    actionItems: raw.action_items || raw.actionItems || raw.tasks || raw.todos || [],
    crmFields: {
      dealStage: raw.deal_stage || raw.dealStage || raw.crm?.deal_stage || '',
      nextSteps: raw.next_steps || raw.nextSteps || raw.crm?.next_steps || '',
      risks: raw.risks || raw.crm?.risks || '',
      painPoints: raw.pain_points || raw.painPoints || raw.crm?.pain_points || '',
      buyingSignals: raw.buying_signals || raw.buyingSignals || raw.crm?.buying_signals || '',
      ...((raw.crm_fields || raw.crmFields || raw.crm) || {}),
    },
  };
}

// Load a meeting from a local JSON file (fallback when API is unavailable)
function loadMeetingFromFile(filePath) {
  const resolved = path.resolve(filePath);
  console.log(`\n📂 Loading meeting from file: ${resolved}`);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  const id = raw.id || raw.meetingId || path.basename(filePath, '.json');
  return normalizeMeeting(raw, id);
}

module.exports = { fetchMeeting, fetchAllMeetings, loadMeetingFromFile, discoverWorkingEndpoint };
