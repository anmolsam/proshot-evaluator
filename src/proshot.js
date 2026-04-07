'use strict';

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ── Auth Strategy (in priority order) ────────────────────────────────────────
//
// Option A: PROSHOT_ENTERPRISE_KEY works on recording-hub (ask Proshot to enable)
//   → set PROSHOT_API_KEY=ps__... (already works for enterprise-api endpoints)
//
// Option B: Firebase Refresh Token (auto-renews, no browser DevTools needed)
//   → set FIREBASE_REFRESH_TOKEN=... and FIREBASE_API_KEY=AIza...
//   → this file auto-exchanges it for a fresh ID token before each request
//
// Option C: Short-lived Firebase JWT pasted manually (current fallback)
//   → set PROSHOT_API_KEY=eyJ... (expires ~1 hour)
//
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND = 'https://backend.proshort.ai';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

// In-memory token cache so we don't refresh on every request
let _cachedToken = null;
let _tokenExpiry = 0;

async function getAuthToken() {
  // Option B: Firebase refresh token — auto-renews every ~55 minutes
  const refreshToken = process.env.FIREBASE_REFRESH_TOKEN;
  const firebaseApiKey = process.env.FIREBASE_API_KEY;

  if (refreshToken && firebaseApiKey) {
    // Return cached token if still valid (with 60s buffer)
    if (_cachedToken && Date.now() < _tokenExpiry - 60_000) {
      return _cachedToken;
    }

    try {
      const res = await fetch(
        `${FIREBASE_TOKEN_URL}?key=${firebaseApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
          timeout: 10000,
        }
      );

      const data = await res.json();
      if (!res.ok || !data.id_token) {
        throw new Error(`Firebase token refresh failed: ${JSON.stringify(data).slice(0, 200)}`);
      }

      _cachedToken = data.id_token;
      _tokenExpiry = Date.now() + (Number(data.expires_in) || 3600) * 1000;

      // Persist new refresh token if rotated
      if (data.refresh_token && data.refresh_token !== refreshToken) {
        process.env.FIREBASE_REFRESH_TOKEN = data.refresh_token;
        console.log('  🔄 Firebase refresh token rotated — update FIREBASE_REFRESH_TOKEN in .env');
      }

      console.log('  🔑 Firebase token refreshed (valid ~1h)');
      return _cachedToken;
    } catch (err) {
      console.warn(`  ⚠️  Firebase refresh failed: ${err.message} — falling back to PROSHOT_API_KEY`);
    }
  }

  // Option A or C: use PROSHOT_API_KEY directly (enterprise key or pasted JWT)
  const key = process.env.PROSHOT_API_KEY;
  if (!key || key.includes('PASTE_YOUR')) {
    throw new Error(
      'No valid auth configured.\n\n' +
      'Ask Proshot for ONE of:\n' +
      '  A) Grant ps_... key access to /recording-hub endpoints\n' +
      '  B) Provide FIREBASE_REFRESH_TOKEN + FIREBASE_API_KEY\n' +
      '  C) Provide a webhook that pushes meetings to our /webhook endpoint\n\n' +
      'Or grab a short-lived JWT from DevTools and set PROSHOT_API_KEY=eyJ...'
    );
  }
  return key;
}

async function tryFetch(url, headers) {
  try {
    const res = await fetch(url, { headers, timeout: 15000 });
    const text = await res.text();
    if (res.ok) {
      try {
        const data = JSON.parse(text);
        if (data.view_status === 'UNAUTHORISED') {
          return { ok: false, error: 'UNAUTHORISED — meeting not owned by this API key', status: 403 };
        }
        return { ok: true, data, status: res.status };
      } catch {
        return { ok: false, error: `Non-JSON: ${text.slice(0, 200)}`, status: res.status };
      }
    }
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message, status: 0 };
  }
}

async function fetchMeeting(meetingId) {
  console.log(`\n📡 Fetching meeting ${meetingId} from Proshot...`);

  const token = await getAuthToken();
  const authHeader = { Authorization: `Bearer ${token}` };

  // Primary: recording-hub (requires Firebase JWT or enterprise key with recording access)
  const recordingHubUrl = `${BACKEND}/recording-hub/v1/recording/${meetingId}`;
  process.stdout.write(`  Trying recording-hub... `);
  const result = await tryFetch(recordingHubUrl, authHeader);

  if (result.ok) {
    console.log('✅ SUCCESS');
    const transcript = await fetchTranscriptFromSnippet(meetingId, result.data, authHeader);
    if (transcript) result.data._transcript = transcript;
    return normalizeMeeting(result.data, meetingId);
  }

  console.log(`❌ ${result.status} — ${result.error}`);

  // Fallback: enterprise-api view endpoint (works with ps_ key)
  const enterpriseUrl = `${BACKEND}/enterprise-api/meetings/view/meeting?document_id=${meetingId}`;
  process.stdout.write(`  Trying enterprise-api... `);
  const fallback = await tryFetch(enterpriseUrl, authHeader);

  if (fallback.ok) {
    console.log('✅ SUCCESS via enterprise-api');
    return normalizeMeeting(fallback.data, meetingId);
  }

  console.log(`❌ ${fallback.status} — ${fallback.error}`);

  throw new Error(
    `Could not fetch meeting ${meetingId}.\n\n` +
    `Auth configured: ${token.startsWith('eyJ') ? 'Firebase JWT' : 'Enterprise key (ps_)'}\n\n` +
    `If using ps_ key: ask Proshot to grant it access to /recording-hub endpoints.\n` +
    `If JWT expired: grab a new one from DevTools or set FIREBASE_REFRESH_TOKEN.\n\n` +
    `Quick fix: set PROSHOT_API_KEY=<fresh eyJ... from DevTools>`
  );
}

async function fetchTranscriptFromSnippet(meetingId, recordingData, authHeaders) {
  try {
    const customerId =
      recordingData.customer_id ||
      (recordingData.thumbnail_url || '').match(/ps_videos\/sales_copilot\/([^/]+)\//)?.[1];
    if (!customerId) return null;

    const res = await fetch(`${BACKEND}/snippet/v1/transcript/get_transcript_and_highlights`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: meetingId, customer_id: customerId }),
      timeout: 15000,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sentences = data?.transcript?.sentence_list || [];
    if (sentences.length === 0) return null;

    const lines = [];
    let prevSpeaker = null;
    for (const s of sentences) {
      const speaker = s.speaker || 'Unknown';
      const text = (s.text || '').trim();
      if (!text) continue;
      if (speaker !== prevSpeaker) { lines.push(`${speaker}: ${text}`); prevSpeaker = speaker; }
      else lines[lines.length - 1] += ' ' + text;
    }
    return lines.join('\n\n');
  } catch {
    return null;
  }
}

async function fetchAllMeetings(days = 7) {
  console.log(`\n📡 Fetching meetings (last ${days} days) from Proshot...`);

  const token = await getAuthToken();
  const authHeader = { Authorization: `Bearer ${token}` };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const listUrls = [
    `${BACKEND}/enterprise-api/recent_activity/overview`,
    `${BACKEND}/enterprise-api/v1/calendar/synced_meeting`,
    `${BACKEND}/enterprise-api/profiles/videos/posted`,
  ];

  for (const url of listUrls) {
    const result = await tryFetch(url, authHeader);
    if (result.ok) {
      console.log(`✅ Got meeting list from ${url}`);
      const meetings = extractMeetingsList(result.data);
      return meetings
        .filter(m => !cutoff || new Date(m.date || m.created_at || 0) >= new Date(cutoff))
        .map(m => normalizeMeeting(m, m.document_id || m.id || m.meeting_id));
    }
  }

  throw new Error(
    'Could not fetch meeting list. Use --file to load individual meetings from JSON files.'
  );
}

async function discoverWorkingEndpoint() {
  console.log('🔍 Probing Proshot API endpoints...\n');

  const token = await getAuthToken();
  const authHeader = { Authorization: `Bearer ${token}` };

  const testUrls = [
    `${BACKEND}/enterprise-api/meetings/view/meeting?document_id=test`,
    `${BACKEND}/enterprise-api/recent_activity/overview`,
    `${BACKEND}/enterprise-api/v1/calendar/synced_meeting`,
    `${BACKEND}/enterprise-api/members`,
    `${BACKEND}/enterprise-api/profiles/videos/posted`,
    `${BACKEND}/recording-hub/v1/recording/test`,
  ];

  let found = null;
  for (const url of testUrls) {
    process.stdout.write(`  ${url}... `);
    const result = await tryFetch(url, authHeader);
    const status = result.status === 0 ? 'ERR' : result.status;
    if (result.ok) {
      console.log(`✅ 200 — keys: ${Object.keys(result.data).join(', ')}`);
      if (!found) found = { url, data: result.data };
    } else {
      console.log(`❌ ${status}`);
    }
  }

  if (!found) {
    console.log('\n⚠️  No fully accessible endpoint found.');
    console.log('   Ask Proshot to either:');
    console.log('   A) Grant your ps_... key access to /recording-hub endpoints');
    console.log('   B) Provide FIREBASE_REFRESH_TOKEN + FIREBASE_API_KEY');
  }
  return found;
}

// ── Webhook handler (Option C) ────────────────────────────────────────────────
// Proshot POSTs to our /webhook/proshot endpoint when a meeting is processed.
// Call this from server.js to register the route.
function createWebhookHandler(evaluateFn, logFn) {
  return async (req, res) => {
    try {
      const payload = req.body;
      const meetingId = payload.meeting_id || payload.document_id || payload.id;

      if (!meetingId) {
        return res.status(400).json({ error: 'Missing meeting_id in webhook payload' });
      }

      console.log(`\n📨 Webhook received for meeting ${meetingId}`);
      res.status(200).json({ received: true, meetingId });

      // Process async — don't block the webhook response
      const meeting = normalizeMeeting(payload, meetingId);
      const result = await evaluateFn(meeting);
      await logFn(result);
      console.log(`  ✅ Webhook evaluation complete: ${result.finalScore} → ${result.verdict}`);
    } catch (err) {
      console.error(`  ❌ Webhook handler error: ${err.message}`);
    }
  };
}

function extractMeetingsList(data) {
  if (Array.isArray(data)) return data;
  if (data.meetings) return Array.isArray(data.meetings) ? data.meetings : [];
  if (data.calls) return Array.isArray(data.calls) ? data.calls : [];
  if (data.recordings) return Array.isArray(data.recordings) ? data.recordings : [];
  if (data.videos) return Array.isArray(data.videos) ? data.videos : [];
  if (data.data && Array.isArray(data.data)) return data.data;
  return [];
}

function normalizeMeeting(raw, id) {
  const transcript = raw._transcript || extractTranscript(raw);
  return {
    id: id || raw.document_id || raw.id || raw.meeting_id || 'unknown',
    title: raw.event_title || raw.title || raw.name || raw.meeting_title ||
           raw.subject || raw.meeting_name || `Meeting ${id}`,
    date: raw.scheduled_time || raw.date || raw.created_at || raw.start_time ||
          raw.meeting_date || raw.startTime || new Date().toISOString(),
    transcript,
    proshortOutput: extractProshortOutput(raw),
    raw,
  };
}

function extractTranscript(raw) {
  const candidates = [
    raw.transcript, raw.transcription, raw.full_transcript,
    raw.raw_transcript, raw.call_transcript, raw.meeting_transcript, raw.content,
  ];

  for (const c of candidates) {
    if (c && typeof c === 'string' && c.length > 20) return c;
    if (Array.isArray(c) && c.length > 0) {
      return c.map(turn => {
        const speaker = turn.speaker || turn.name || turn.participant || turn.role || 'Unknown';
        const text = turn.text || turn.content || turn.transcript || turn.message || '';
        const ts = turn.timestamp || turn.time || '';
        return ts ? `[${ts}] ${speaker}: ${text}` : `${speaker}: ${text}`;
      }).join('\n');
    }
  }

  return '[No transcript available]';
}

function extractProshortOutput(raw) {
  if (raw.overview) {
    const overview = raw.overview;
    const actionSection = overview.match(/Action Items\*\*([\s\S]*?)(?:\*\*:|$)/)?.[1] || '';
    const actionItems = actionSection
      .split('\n')
      .filter(l => l.trim().startsWith('-'))
      .map(l => {
        const text = l.replace(/^-\s*/, '').trim();
        const ownerMatch = text.match(/^([^-]+?)\s*-\s*(.+?)\s*-\s*(.+)$/);
        if (ownerMatch) return { owner: ownerMatch[1].trim(), task: ownerMatch[2].trim(), due: ownerMatch[3].trim() };
        return { owner: '', task: text, due: '' };
      });

    const crm = raw.crm_notes_synced || {};
    return {
      summary: overview,
      actionItems,
      crmFields: {
        deal_stage: crm.notes_status || '',
        deal_probability: raw.deal_probability || '',
        deal_name: crm.deal_name || '',
        call_sentiment: raw.call_sentiment || '',
        crm_integration: crm.integration_type || '',
        risks: extractSection(overview, 'Risks Obstacles'),
        pain_points: extractSection(overview, 'Pain Points'),
        buying_signals: extractSection(overview, 'Customer Reactions'),
        next_steps: extractSection(overview, 'Decision Process'),
        competitors_mentioned: '',
      },
    };
  }

  const details = raw.meeting_details || raw;
  return {
    summary: details.summary || details.ai_summary || details.meeting_summary ||
             details.notes || details.description || '',
    actionItems: details.action_items || details.actionItems || details.tasks ||
                 details.todos || details.follow_ups || [],
    crmFields: {
      dealStage: details.deal_stage || details.dealStage || '',
      nextSteps: details.next_steps || details.nextSteps || '',
      risks: details.risks || details.risk_factors || '',
      painPoints: details.pain_points || details.painPoints || '',
      buyingSignals: details.buying_signals || details.buyingSignals || '',
      ...(details.crm_fields || details.crmFields || details.crm || {}),
    },
  };
}

function extractSection(markdown, sectionName) {
  const match = markdown.match(new RegExp(`${sectionName}\\*\\*([\\s\\S]*?)(?:\\*\\*:|$)`));
  if (!match) return '';
  return match[1].split('\n').filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim()).join('; ');
}

function loadMeetingFromFile(filePath) {
  const resolved = path.resolve(filePath);
  console.log(`\n📂 Loading meeting from file: ${resolved}`);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  const id = raw.id || raw.meetingId || raw.document_id || path.basename(filePath, '.json');
  return normalizeMeeting(raw, id);
}

module.exports = {
  fetchMeeting,
  fetchAllMeetings,
  loadMeetingFromFile,
  discoverWorkingEndpoint,
  createWebhookHandler,
  getAuthToken,
};
