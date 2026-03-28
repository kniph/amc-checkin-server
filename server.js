const express = require('express');
const cors    = require('cors');
const Database= require('better-sqlite3');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');

// ── Setup ──────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Database ───────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'data.db');

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS classrooms (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    card_id TEXT PRIMARY KEY,
    name    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teachers (
    card_id      TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    classroom_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id      TEXT NOT NULL,
    classroom_id TEXT NOT NULL,
    teacher_card_id TEXT,
    timestamp    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slot_plays (
    card_id  TEXT NOT NULL,
    play_date TEXT NOT NULL,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (card_id, play_date)
  );

  CREATE TABLE IF NOT EXISTS slot_wins (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id   TEXT NOT NULL,
    win_date  TEXT NOT NULL,
    win_time  TEXT NOT NULL
  );
`);

// ── DB migration (for existing data.db) ─────────────
// Add teacher_card_id column if the table was created before this feature.
try {
  db.exec('ALTER TABLE records ADD COLUMN teacher_card_id TEXT');
} catch (e) {}
// Add win_ts (Unix ms) to slot_wins for cooldown calculation.
try {
  db.exec('ALTER TABLE slot_wins ADD COLUMN win_ts INTEGER');
} catch (e) {}

// ── WebSocket broadcast ────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('Client connected, total:', wss.clients.size);
  ws.on('close', () => console.log('Client disconnected'));
});

// ── Helper ─────────────────────────────────────────
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// ── API: Classrooms ────────────────────────────────
app.get('/api/classrooms', (req, res) => {
  const rows = db.prepare('SELECT * FROM classrooms').all();
  res.json(rows);
});

app.post('/api/classrooms', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    db.prepare('INSERT OR REPLACE INTO classrooms (id, name) VALUES (?, ?)').run(id, name);
    broadcast('classroom_added', { id, name });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/classrooms/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM classrooms WHERE id = ?').run(id);
  db.prepare('DELETE FROM teachers WHERE classroom_id = ?').run(id);
  db.prepare('DELETE FROM records WHERE classroom_id = ?').run(id);
  broadcast('classroom_deleted', { id });
  res.json({ ok: true });
});

// ── API: Students ──────────────────────────────────
app.get('/api/students', (req, res) => {
  const rows = db.prepare('SELECT card_id, name FROM students').all();
  // Return as { cardId: name } map
  const map = {};
  rows.forEach(r => { map[r.card_id] = r.name; });
  res.json(map);
});

app.post('/api/students', (req, res) => {
  const { cardId, name } = req.body;
  if (!cardId || !name) return res.status(400).json({ error: 'cardId and name required' });
  db.prepare('INSERT OR REPLACE INTO students (card_id, name) VALUES (?, ?)').run(cardId, name);
  broadcast('student_updated', { cardId, name });
  res.json({ ok: true });
});

app.post('/api/students/batch', (req, res) => {
  const { students } = req.body; // [{ cardId, name }]
  if (!Array.isArray(students)) return res.status(400).json({ error: 'students array required' });
  const insert = db.prepare('INSERT OR REPLACE INTO students (card_id, name) VALUES (?, ?)');
  const tx = db.transaction(() => {
    students.forEach(({ cardId, name }) => insert.run(cardId, name));
  });
  tx();
  broadcast('students_batch_updated', { count: students.length });
  res.json({ ok: true, count: students.length });
});

app.delete('/api/students/:cardId', (req, res) => {
  db.prepare('DELETE FROM students WHERE card_id = ?').run(req.params.cardId);
  broadcast('student_deleted', { cardId: req.params.cardId });
  res.json({ ok: true });
});

// ── API: Teachers ──────────────────────────────────
app.get('/api/teachers', (req, res) => {
  const rows = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers ORDER BY name ASC').all();
  res.json(rows);
});

app.post('/api/teachers', (req, res) => {
  const { cardId, name, classroomId } = req.body;
  if (!cardId || !name || !classroomId) {
    return res.status(400).json({ error: 'cardId, name, classroomId required' });
  }

  try {
    db.prepare('INSERT OR REPLACE INTO teachers (card_id, name, classroom_id) VALUES (?, ?, ?)').run(cardId, name, classroomId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/teachers/:cardId', (req, res) => {
  const { cardId } = req.params;
  db.prepare('DELETE FROM teachers WHERE card_id = ?').run(cardId);
  res.json({ ok: true });
});

app.get('/api/teachers/lookup', (req, res) => {
  const { cardId } = req.query;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });
  const row = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers WHERE card_id = ?').get(cardId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// ── API: Records (check-in) ────────────────────────
app.get('/api/records', (req, res) => {
  const rows = db.prepare(
    `SELECT
      r.card_id as cardId,
      r.classroom_id as classroomId,
      r.teacher_card_id as teacherCardId,
      t.name as teacherName,
      r.timestamp as timestamp
    FROM records r
    LEFT JOIN teachers t ON t.card_id = r.teacher_card_id
    ORDER BY r.timestamp DESC`
  ).all();
  res.json(rows);
});

app.post('/api/records', (req, res) => {
  const { cardId, classroomId, timestamp, teacherCardId } = req.body;
  if (!cardId || !classroomId || !timestamp || !teacherCardId) {
    return res.status(400).json({ error: 'cardId, classroomId, timestamp, teacherCardId required' });
  }

  // Validate teacher exists and is responsible for the classroom.
  const teacher = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers WHERE card_id = ?').get(teacherCardId);
  if (!teacher) return res.status(403).json({ error: 'teacher not bound' });
  if (teacher.classroomId !== classroomId) return res.status(403).json({ error: 'teacher classroom mismatch' });

  db.prepare(
    'INSERT INTO records (card_id, classroom_id, teacher_card_id, timestamp) VALUES (?, ?, ?, ?)'
  ).run(cardId, classroomId, teacherCardId, timestamp);

  // Get total points for this card
  const { total } = db.prepare(
    'SELECT COUNT(*) as total FROM records WHERE card_id = ?'
  ).get(cardId);

  broadcast('record_added', {
    cardId,
    classroomId,
    teacherCardId,
    teacherName: teacher.name,
    timestamp,
    totalPts: total
  });
  res.json({ ok: true, totalPts: total });
});

app.delete('/api/records', (req, res) => {
  db.prepare('DELETE FROM records').run();
  broadcast('records_cleared', {});
  res.json({ ok: true });
});

// ── API: Slot machine ──────────────────────────────
const MAX_DAILY_WINS      = 50;               // hard safety cap (use cooldown as main rate control)
const COST_PER_PLAY       = 5;
const WIN_PROBABILITY     = 0.20;             // 20% per pull when cooldown has cleared
const MIN_WIN_INTERVAL_MS = 20 * 60 * 1000;  // 20-min global cooldown → ~3 wins/hr max

app.get('/api/slot/status/:cardId', (req, res) => {
  const { cardId } = req.params;
  const date = today();

  // Total points
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);

  // Cumulative plays used (all time, not just today)
  const usedRow = db.prepare('SELECT SUM(count) as total FROM slot_plays WHERE card_id = ?').get(cardId);
  const usedPlays = usedRow?.total || 0;

  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  const availablePlays = Math.max(0, earnedPlays - usedPlays);

  // Today's total wins (global)
  const { wins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  const remainingPrizes = Math.max(0, MAX_DAILY_WINS - wins);

  // Has this person already won today?
  const { wonToday } = db.prepare('SELECT COUNT(*) as wonToday FROM slot_wins WHERE card_id = ? AND win_date = ?').get(cardId, date);

  // Global win cooldown
  const lastWin = db.prepare('SELECT win_ts FROM slot_wins WHERE win_ts IS NOT NULL ORDER BY win_ts DESC LIMIT 1').get();
  const msSinceLastWin = lastWin ? Date.now() - lastWin.win_ts : Infinity;
  const cooldownMs = Math.max(0, MIN_WIN_INTERVAL_MS - msSinceLastWin);

  res.json({ totalPts: total, availablePlays, usedPlays, earnedPlays, remainingPrizes, todayWins: wins, hasWonToday: wonToday > 0, cooldownMs });
});

app.post('/api/slot/play', (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });

  const date = today();

  // Check cumulative plays available (all time)
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const usedRow = db.prepare('SELECT SUM(count) as total FROM slot_plays WHERE card_id = ?').get(cardId);
  const usedPlays = usedRow?.total || 0;
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  const availablePlays = earnedPlays - usedPlays;

  if (availablePlays <= 0) return res.status(400).json({ error: 'no_plays', message: '沒有可用次數' });

  // Check daily prize cap (safety)
  const { wins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  if (wins >= MAX_DAILY_WINS) return res.status(400).json({ error: 'no_prizes', message: '今日獎品已送完' });

  // Deduct one play (cumulative — stored per day for analytics, summed for availability)
  db.prepare(`
    INSERT INTO slot_plays (card_id, play_date, count) VALUES (?, ?, 1)
    ON CONFLICT(card_id, play_date) DO UPDATE SET count = count + 1
  `).run(cardId, date);

  // Per-person daily win limit: max 1 win per person per day
  const { wonToday } = db.prepare('SELECT COUNT(*) as wonToday FROM slot_wins WHERE card_id = ? AND win_date = ?').get(cardId, date);

  // Global cooldown: min 20 min between wins → ~3 wins/hr
  const lastWin = db.prepare('SELECT win_ts FROM slot_wins WHERE win_ts IS NOT NULL ORDER BY win_ts DESC LIMIT 1').get();
  const msSinceLastWin = lastWin ? Date.now() - lastWin.win_ts : Infinity;
  const cooldownActive = msSinceLastWin < MIN_WIN_INTERVAL_MS;

  // Decide win
  let isWin = false;
  if (!wonToday && !cooldownActive) {
    isWin = Math.random() < WIN_PROBABILITY;
  }

  if (isWin) {
    const ts   = Date.now();
    const time = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
    db.prepare('INSERT INTO slot_wins (card_id, win_date, win_time, win_ts) VALUES (?, ?, ?, ?)').run(cardId, date, time, ts);
    const { wins: newWins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
    broadcast('slot_win', { cardId, date, time, todayWins: newWins, remainingPrizes: MAX_DAILY_WINS - newWins });
  }

  broadcast('slot_play', { cardId, isWin });
  res.json({ ok: true, isWin });
});

app.get('/api/slot/winners', (req, res) => {
  const date = today();
  const rows = db.prepare(
    'SELECT card_id as cardId, win_time as time FROM slot_wins WHERE win_date = ? ORDER BY id ASC'
  ).all(date);
  res.json(rows);
});

app.get('/api/slot/daily', (req, res) => {
  const date = today();
  const { wins } = db.prepare('SELECT COUNT(*) as wins FROM slot_wins WHERE win_date = ?').get(date);
  res.json({ todayWins: wins, remainingPrizes: Math.max(0, MAX_DAILY_WINS - wins) });
});

// ── Health check ───────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Start ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ AMC 積點系統後端已啟動 port ${PORT}`);
});
