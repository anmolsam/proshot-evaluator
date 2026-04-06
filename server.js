'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const { fetchMeeting, fetchAllMeetings } = require('./src/proshot');
const { evaluateMeeting } = require('./src/evaluator');
const { logEvaluation, updateHumanDecision, fetchAllEvaluations, getStats } = require('./src/airtable');
const { loadRules } = require('./src/rules');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET / — serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET /api/meetings — list meetings from Proshot
app.get('/api/meetings', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const meetings = await fetchAllMeetings(days);
    res.json({ meetings, count: meetings.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/evaluate/:meetingId — run evaluation
app.post('/api/evaluate/:meetingId', async (req, res) => {
  const { meetingId } = req.params;
  try {
    console.log(`\n🔬 API: evaluating meeting ${meetingId}`);
    const meeting = await fetchMeeting(meetingId);
    const result = await evaluateMeeting(meeting);
    await logEvaluation(result);
    res.json(result);
  } catch (err) {
    console.error('Evaluation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/human-decision — save human decision on disputed item
app.post('/api/human-decision', async (req, res) => {
  const { meetingId, item, decision } = req.body;
  if (!meetingId || !item || !decision) {
    return res.status(400).json({ error: 'meetingId, item, and decision are required' });
  }
  try {
    await updateHumanDecision(meetingId, item, decision);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/evaluations — fetch all evaluations from Airtable
app.get('/api/evaluations', async (req, res) => {
  try {
    const evaluations = await fetchAllEvaluations();
    res.json({ evaluations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rules — return all prompt rules
app.get('/api/rules', (req, res) => {
  const rules = loadRules();
  res.json({ rules });
});

// GET /api/stats — aggregate stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Proshot Evaluator Dashboard: http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop\n`);
});

module.exports = app;
