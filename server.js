const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

// ── Setup ──────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

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

  CREATE TABLE IF NOT EXISTS slot_entries (
    card_id    TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    PRIMARY KEY (card_id, entry_date)
  );

  CREATE TABLE IF NOT EXISTS slot_draws (
    draw_date TEXT PRIMARY KEY,
    drawn_at  TEXT NOT NULL
  );
`);

// ── DB migration (for existing data.db) ─────────────
try {
  db.exec('ALTER TABLE records ADD COLUMN teacher_card_id TEXT');
} catch (e) { }

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
  // Taiwan date (UTC+8)
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return tw.toISOString().slice(0, 10);
}

function twHour() {
  // Taiwan local hour (UTC+8), 0-23
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return tw.getUTCHours();
}

function currentUtcHourPrefix() {
  // win_time is stored as UTC ISO string, so match on UTC hour prefix
  // e.g. "2026-04-08T06" when Taiwan time is 14:xx (UTC+8)
  return new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH" in UTC
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
  const { students } = req.body;
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

  const teacher = db.prepare('SELECT card_id as cardId, name, classroom_id as classroomId FROM teachers WHERE card_id = ?').get(teacherCardId);
  if (!teacher) return res.status(403).json({ error: 'teacher not bound' });
  if (teacher.classroomId !== classroomId) return res.status(403).json({ error: 'teacher classroom mismatch' });

  db.prepare(
    'INSERT INTO records (card_id, classroom_id, teacher_card_id, timestamp) VALUES (?, ?, ?, ?)'
  ).run(cardId, classroomId, teacherCardId, timestamp);

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

// ── API: Lottery ───────────────────────────────────
const MAX_DAILY_WINS = 21; // [FIX #1] 全天總上限改為 21
const MAX_HOURLY_WINS = 3;  // [FIX #1] 每小時上限 3 人
const MAX_WINS_PER_PERSON = 2;  // 每人累計最多中獎次數
const COST_PER_PLAY = 5;  // 每 5 點換 1 次

// 中獎機率（依累計中獎次數）
function getWinProb(histWins) {
  if (histWins === 0) return 0.12;
  if (histWins === 1) return 0.05;
  return 0;
}

// GET /api/slot/status/:cardId
app.get('/api/slot/status/:cardId', (req, res) => {
  const { cardId } = req.params;
  const date = today();
  const hourPfx = currentUtcHourPrefix();

  // [FIX #3] 終身總積點 vs 終身總用次數
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const { usedPlays } = db.prepare(
    'SELECT COALESCE(SUM(count), 0) as usedPlays FROM slot_plays WHERE card_id = ?'
  ).get(cardId);
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  const availablePlays = Math.max(0, earnedPlays - usedPlays);

  const { todayCnt } = db.prepare('SELECT COUNT(*) as todayCnt FROM slot_wins WHERE card_id = ? AND win_date = ?').get(cardId, date);
  const { histWins } = db.prepare('SELECT COUNT(*) as histWins FROM slot_wins WHERE card_id = ?').get(cardId);
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE win_date = ?').get(date);
  const { hourlyWins } = db.prepare(
    "SELECT COUNT(*) as hourlyWins FROM slot_wins WHERE win_date = ? AND win_time LIKE ?"
  ).get(date, hourPfx + '%');  // [FIX #1] 本小時中獎數

  const canWin = histWins < MAX_WINS_PER_PERSON;

  res.json({
    totalPts: total,
    availablePlays,
    usedPlays,
    earnedPlays,
    hasWonToday: todayCnt > 0,
    winCount: histWins,
    winProb: getWinProb(histWins),
    canWin,
    remainingPrizes: Math.max(0, MAX_DAILY_WINS - totalWins),
    remainingHourly: Math.max(0, MAX_HOURLY_WINS - hourlyWins), // [FIX #1]
    totalWins
  });
});

// POST /api/slot/play
app.post('/api/slot/play', (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });

  const twH = twHour();
  if (twH < 13 || twH >= 20) {
    return res.status(400).json({ error: 'closed', message: '活動時間為台灣時間 13:00–20:00' });
  }

  const date = today();
  const hourPfx = currentUtcHourPrefix();

  // [FIX #3] 終身總用次數（跨日累計）
  const { total } = db.prepare('SELECT COUNT(*) as total FROM records WHERE card_id = ?').get(cardId);
  const { usedPlays } = db.prepare(
    'SELECT COALESCE(SUM(count), 0) as usedPlays FROM slot_plays WHERE card_id = ?'
  ).get(cardId);
  const earnedPlays = Math.floor(total / COST_PER_PLAY);
  if (earnedPlays - usedPlays <= 0) {
    return res.status(400).json({ error: 'no_plays', message: '沒有可用次數，繼續刷卡累積積點！' });
  }

  // 已中獎2次者 getWinProb 回傳 0，isWin 永遠 false，仍可正常拉霸並消耗次數
  const { histWins } = db.prepare('SELECT COUNT(*) as histWins FROM slot_wins WHERE card_id = ?').get(cardId);

  // [FIX #1] 全天上限
  const { dailyWins } = db.prepare('SELECT COUNT(*) as dailyWins FROM slot_wins WHERE win_date = ?').get(date);
  if (dailyWins >= MAX_DAILY_WINS) {
    return res.status(400).json({ error: 'no_prizes', message: '今日獎品已全數送出！' });
  }

  // [FIX #1] 每小時上限
  const { hourlyWins } = db.prepare(
    "SELECT COUNT(*) as hourlyWins FROM slot_wins WHERE win_date = ? AND win_time LIKE ?"
  ).get(date, hourPfx + '%');
  if (hourlyWins >= MAX_HOURLY_WINS) {
    return res.status(400).json({ error: 'hourly_limit', message: '本小時中獎名額已滿，下個小時再試！' });
  }

  // 先扣次數（防止重試作弊）
  db.prepare(`
    INSERT INTO slot_plays (card_id, play_date, count) VALUES (?, ?, 1)
    ON CONFLICT(card_id, play_date) DO UPDATE SET count = count + 1
  `).run(cardId, date);

  const winProb = getWinProb(histWins);
  const isWin = Math.random() < winProb;

  const newUsed = usedPlays + 1;
  const newAvailable = Math.max(0, earnedPlays - newUsed);

  if (isWin) {
    const winTime = new Date().toISOString();
    db.prepare('INSERT INTO slot_wins (card_id, win_date, win_time) VALUES (?, ?, ?)').run(cardId, date, winTime);
    const { newTotal } = db.prepare('SELECT COUNT(*) as newTotal FROM slot_wins WHERE win_date = ?').get(date);
    broadcast('slot_win', {
      cardId,
      date,
      time: winTime,
      totalWins: newTotal,
      remainingPrizes: MAX_DAILY_WINS - newTotal
    });
  }

  broadcast('slot_play', { cardId, isWin });
  res.json({ ok: true, isWin, availablePlays: newAvailable });
});

// GET /api/slot/winners — 今日中獎名單
app.get('/api/slot/winners', (req, res) => {
  const date = today();
  const rows = db.prepare(
    'SELECT card_id as cardId, win_time as time FROM slot_wins WHERE win_date = ? ORDER BY id ASC'
  ).all(date);
  res.json(rows);
});

// GET /api/slot/daily — 今日統計
app.get('/api/slot/daily', (req, res) => {
  const date = today();
  const hourPfx = currentUtcHourPrefix();
  const { totalWins } = db.prepare('SELECT COUNT(*) as totalWins FROM slot_wins WHERE win_date = ?').get(date);
  const { totalEntries } = db.prepare('SELECT COUNT(*) as totalEntries FROM slot_entries WHERE entry_date = ?').get(date);
  const { hourlyWins } = db.prepare(
    "SELECT COUNT(*) as hourlyWins FROM slot_wins WHERE win_date = ? AND win_time LIKE ?"
  ).get(date, hourPfx + '%');
  res.json({
    totalWins,
    totalEntries,
    remainingPrizes: Math.max(0, MAX_DAILY_WINS - totalWins),
    remainingHourly: Math.max(0, MAX_HOURLY_WINS - hourlyWins),
    maxDailyWins: MAX_DAILY_WINS,
    maxHourlyWins: MAX_HOURLY_WINS
  });
});


// ── Health check ───────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Start ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ AMC 積點系統後端已啟動 port ${PORT}`);
});
