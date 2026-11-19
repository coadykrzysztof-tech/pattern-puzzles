const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv(path.join(__dirname, '.env'));

function loadPuzzleData(staticDir) {
  const dataPath = path.join(staticDir, 'data.js');
  const code = fs.readFileSync(dataPath, 'utf8');
  const context = {};
  vm.runInNewContext(`${code}\nglobalThis.__PUZZLE_DATA__ = PUZZLE_DATA;`, context);
  return context.__PUZZLE_DATA__;
}

function hashPasscode(passcode, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(passcode), salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPasscode(passcode, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(passcode), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function generateCapabilityToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function initDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instructor_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_drills (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      coach_note TEXT NOT NULL DEFAULT '',
      layout_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS practice_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS practice_plan_drills (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES practice_plans(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      drill_type TEXT NOT NULL,
      source_ref_json TEXT NOT NULL,
      title TEXT NOT NULL,
      target_attempts INTEGER NOT NULL,
      target_successes INTEGER NOT NULL,
      coach_note TEXT NOT NULL DEFAULT '',
      layout_snapshot_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      plan_id TEXT REFERENCES practice_plans(id) ON DELETE SET NULL,
      plan_name_snapshot TEXT NOT NULL,
      plan_desc_snapshot TEXT NOT NULL DEFAULT '',
      student_name TEXT NOT NULL,
      student_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assignment_drills (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      drill_type TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      coach_note_snapshot TEXT NOT NULL DEFAULT '',
      target_attempts INTEGER NOT NULL,
      target_successes INTEGER NOT NULL,
      layout_snapshot_json TEXT NOT NULL,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      student_note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- Phase 2 Extension Schema: Student Video Uploads & Server-Side AI Analysis
    CREATE TABLE IF NOT EXISTS assignment_drill_videos (
      id TEXT PRIMARY KEY,
      assignment_drill_id TEXT NOT NULL REFERENCES assignment_drills(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      duration_sec REAL,
      ai_provider TEXT,
      ai_status TEXT NOT NULL DEFAULT 'pending',
      ai_analysis_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  if (process.env.INSTRUCTOR_PASSCODE && process.env.INSTRUCTOR_PASSCODE.trim().length >= 4) {
    const existing = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('instructor_passcode_hash');
    if (!existing) {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'instructor_passcode_hash',
        hashPasscode(process.env.INSTRUCTOR_PASSCODE.trim()),
        now
      );
    }
  }

  return db;
}

function sanitizeCustomLayout(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid custom drill layout');
  }
  const clampCoord = (pt, defX, defY) => ({
    x: Math.max(1.0, Math.min(50.0, Number(pt?.x) || defX)),
    y: Math.max(1.0, Math.min(26.0, Number(pt?.y) || defY))
  });
  const validPockets = new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  const pocket = validPockets.has(raw.pocket) ? raw.pocket : 'P3';
  const objBallNum = Math.max(1, Math.min(15, parseInt(raw.objBallNum, 10) || 1));

  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.slice(0, 14).map((b, idx) => ({
        number: Math.max(1, Math.min(15, parseInt(b?.number, 10) || ((idx + 2) % 14) + 2)),
        ...clampCoord(b, 25, 13)
      }))
    : [];

  const tip = {
    x: Math.max(-1, Math.min(1, Number(raw.tip?.x) || 0)),
    y: Math.max(-1, Math.min(1, Number(raw.tip?.y) || 0))
  };
  const power = Math.max(1, Math.min(5, parseInt(raw.power, 10) || 3));
  const compensateSquirt = Boolean(raw.compensateSquirt);

  let targetZone = null;
  if (raw.targetZone && raw.targetZone.enabled) {
    const tzPt = clampCoord(raw.targetZone, 25, 13);
    const radius = Math.max(20, Math.min(85, Number(raw.targetZone.radius) || 46));
    const col = Math.max(1, Math.min(50, Math.round(tzPt.x)));
    const row = Math.max(1, Math.min(26, Math.round(tzPt.y)));
    targetZone = {
      enabled: true,
      x: tzPt.x,
      y: tzPt.y,
      radius,
      coord: String.fromCharCode(64 + row) + col
    };
  }

  return {
    kind: 'custom_drill',
    cue: clampCoord(raw.cue, 18, 18),
    obj: clampCoord(raw.obj, 34, 9),
    objBallNum,
    pocket,
    blockers,
    tip,
    power,
    compensateSquirt,
    targetZone
  };
}

function gameDisplayLabel(game, subset) {
  if (game === '9ball') return '9-Ball';
  if (game === '10ball') return '10-Ball';
  if (game === '8ball') return subset === 'stripes' ? '8-Ball Stripes' : '8-Ball Solids';
  return 'Custom';
}

function buildDrillSnapshot(puzzleData, db, drillInput, existingSnapshotFallback = null) {
  const drillType = drillInput?.drillType;
  const sourceRef = drillInput?.sourceRef || {};

  if (drillType === 'rack') {
    const game = String(sourceRef.game || '9ball');
    const subset = String(sourceRef.subset || (game === '8ball' ? 'solids' : 'rot'));
    const rackNum = parseInt(sourceRef.rackNum, 10);
    const gData = puzzleData.games?.[game];
    const rData = gData?.racks?.[rackNum];
    if (!rData) throw new Error(`Rack not found: ${game} #${rackNum}`);

    const bih = game === '8ball' && subset === 'stripes' ? (rData.bihStripes || rData.bih) : rData.bih;
    const rawStrokes = game === '8ball'
      ? (subset === 'stripes' ? rData.stripesStrokes : rData.solidsStrokes)
      : rData.strokes;

    const defaultTitle = `${gameDisplayLabel(game, subset)} · Rack ${rackNum}`;
    const snapshot = {
      kind: 'rack',
      game,
      subset,
      rackNum,
      title: defaultTitle,
      bih,
      balls: JSON.parse(JSON.stringify(rData.balls)),
      strokes: JSON.parse(JSON.stringify(rawStrokes))
    };
    return {
      drillType: 'rack',
      sourceRef: { game, subset, rackNum },
      defaultTitle,
      defaultCoachNote: `Run out ${defaultTitle} starting with ball in hand at ${bih}.`,
      snapshot
    };
  }

  if (drillType === 'rack_shot') {
    const game = String(sourceRef.game || '9ball');
    const subset = String(sourceRef.subset || (game === '8ball' ? 'solids' : 'rot'));
    const rackNum = parseInt(sourceRef.rackNum, 10);
    const strokeNum = parseInt(sourceRef.strokeNum, 10);
    const gData = puzzleData.games?.[game];
    const rData = gData?.racks?.[rackNum];
    if (!rData) throw new Error(`Rack not found: ${game} #${rackNum}`);

    const rawStrokes = game === '8ball'
      ? (subset === 'stripes' ? rData.stripesStrokes : rData.solidsStrokes)
      : rData.strokes;
    if (!Number.isInteger(strokeNum) || strokeNum < 1 || strokeNum > rawStrokes.length) {
      throw new Error(`Invalid shot #${strokeNum} for ${game} Rack ${rackNum}`);
    }

    const chosenStroke = JSON.parse(JSON.stringify(rawStrokes[strokeNum - 1]));
    const pocketedBefore = new Set();
    for (let i = 0; i < strokeNum - 1; i++) {
      pocketedBefore.add(parseInt(rawStrokes[i].ball, 10));
    }
    const remainingBalls = JSON.parse(JSON.stringify(
      rData.balls.filter(b => !pocketedBefore.has(parseInt(b.number, 10)))
    ));
    const rackBih = game === '8ball' && subset === 'stripes' ? (rData.bihStripes || rData.bih) : rData.bih;
    const startCueCoord = strokeNum === 1 ? rackBih : rawStrokes[strokeNum - 2].leave;
    const nextBallCoord = strokeNum < rawStrokes.length
      ? (rawStrokes[strokeNum].obj || rawStrokes[strokeNum].coord || null)
      : null;

    chosenStroke.stroke = 1;
    const leaveSuffix = chosenStroke.leave && chosenStroke.leave !== 'Rack over'
      ? ` → Zone ${chosenStroke.leave}`
      : '';
    const defaultTitle = `${gameDisplayLabel(game, subset)} R${rackNum} · Shot ${strokeNum} (#${chosenStroke.ball} → ${chosenStroke.pocket}${leaveSuffix})`;

    const snapshot = {
      kind: 'rack_shot',
      game,
      subset,
      rackNum,
      originalStrokeNum: strokeNum,
      title: defaultTitle,
      bih: startCueCoord,
      balls: remainingBalls,
      strokes: [chosenStroke],
      nextBallCoord
    };

    return {
      drillType: 'rack_shot',
      sourceRef: { game, subset, rackNum, strokeNum },
      defaultTitle,
      defaultCoachNote: chosenStroke.notes || '',
      snapshot
    };
  }

  if (drillType === 'custom_drill') {
    const customDrillId = sourceRef.customDrillId ? String(sourceRef.customDrillId) : null;
    const row = customDrillId
      ? db.prepare('SELECT * FROM custom_drills WHERE id = ?').get(customDrillId)
      : null;

    if (row) {
      const parsedLayout = sanitizeCustomLayout(JSON.parse(row.layout_json));
      return {
        drillType: 'custom_drill',
        sourceRef: { customDrillId: row.id },
        defaultTitle: row.title,
        defaultCoachNote: row.coach_note || '',
        snapshot: {
          ...parsedLayout,
          title: row.title
        }
      };
    }

    if (existingSnapshotFallback) {
      return {
        drillType: 'custom_drill',
        sourceRef: { customDrillId },
        defaultTitle: existingSnapshotFallback.title || 'Custom Spin Lab Drill',
        defaultCoachNote: '',
        snapshot: existingSnapshotFallback
      };
    }

    if (drillInput.inlineLayout) {
      const parsedLayout = sanitizeCustomLayout(drillInput.inlineLayout);
      const fallbackTitle = String(drillInput.title || 'Custom Spin Lab Drill').trim();
      return {
        drillType: 'custom_drill',
        sourceRef: { customDrillId: null },
        defaultTitle: fallbackTitle,
        defaultCoachNote: String(drillInput.coachNote || '').trim(),
        snapshot: {
          ...parsedLayout,
          title: fallbackTitle
        }
      };
    }

    throw new Error('Saved custom drill not found');
  }

  throw new Error(`Unsupported drillType: ${drillType}`);
}

function computeDrillProgress(drillRow) {
  const attempts = JSON.parse(drillRow.attempts_json || '[]');
  const targetAttempts = drillRow.target_attempts;
  const targetSuccesses = drillRow.target_successes;
  const attemptsLogged = attempts.length;
  const successes = attempts.filter(Boolean).length;
  const isComplete = attemptsLogged >= targetAttempts;
  const targetMet = isComplete ? successes >= targetSuccesses : null;

  return {
    attempts,
    attemptsLogged,
    successes,
    targetAttempts,
    targetSuccesses,
    isComplete,
    targetMet
  };
}

function summarizeAssignmentDrills(formattedDrills) {
  const totalDrills = formattedDrills.length;
  let completedDrills = 0;
  let targetsMet = 0;
  let totalAttemptsLogged = 0;
  let totalTargetAttempts = 0;

  for (const d of formattedDrills) {
    totalAttemptsLogged += d.attemptsLogged;
    totalTargetAttempts += d.targetAttempts;
    if (d.isComplete) {
      completedDrills++;
      if (d.targetMet) targetsMet++;
    }
  }

  let status = 'not_started';
  if (totalDrills > 0 && completedDrills === totalDrills) {
    status = 'completed';
  } else if (totalAttemptsLogged > 0 || formattedDrills.some(d => d.studentNote && d.studentNote.trim().length > 0)) {
    status = 'in_progress';
  }

  return {
    totalDrills,
    completedDrills,
    targetsMet,
    totalAttemptsLogged,
    totalTargetAttempts,
    status
  };
}

function createAppServer(options = {}) {
  const staticDir = options.staticDir || __dirname;
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(__dirname, 'cuelab.db');
  const db = initDatabase(dbPath);
  const puzzleData = loadPuzzleData(staticDir);

  function getPasscodeHash() {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('instructor_passcode_hash');
    return row ? row.value : null;
  }

  function createInstructorSession() {
    const rawToken = generateCapabilityToken();
    const tokenHash = hashSessionToken(rawToken);
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
    db.prepare('INSERT INTO instructor_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
      tokenHash,
      now.toISOString(),
      expires.toISOString()
    );
    return rawToken;
  }

  function extractBearerToken(req) {
    const auth = req.headers['authorization'] || '';
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }
    return null;
  }

  function isInstructorAuthenticated(req) {
    const token = extractBearerToken(req);
    if (!token) return false;
    const tokenHash = hashSessionToken(token);
    const row = db.prepare('SELECT expires_at FROM instructor_sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return false;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare('DELETE FROM instructor_sessions WHERE token_hash = ?').run(tokenHash);
      return false;
    }
    return true;
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  function readJsonBody(req, maxBytes = 512 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function formatPlanRow(planRow) {
    const drillRows = db.prepare(
      'SELECT * FROM practice_plan_drills WHERE plan_id = ? ORDER BY position ASC'
    ).all(planRow.id);
    const countRow = db.prepare(
      'SELECT COUNT(*) AS cnt FROM assignments WHERE plan_id = ?'
    ).get(planRow.id);

    return {
      id: planRow.id,
      name: planRow.name,
      description: planRow.description,
      createdAt: planRow.created_at,
      updatedAt: planRow.updated_at,
      assignmentCount: Number(countRow?.cnt || 0),
      drills: drillRows.map(d => ({
        id: d.id,
        position: d.position,
        drillType: d.drill_type,
        sourceRef: JSON.parse(d.source_ref_json),
        title: d.title,
        targetAttempts: d.target_attempts,
        targetSuccesses: d.target_successes,
        coachNote: d.coach_note,
        layout: JSON.parse(d.layout_snapshot_json)
      }))
    };
  }

  function formatInstructorAssignment(assignRow) {
    const drillRows = db.prepare(
      'SELECT * FROM assignment_drills WHERE assignment_id = ? ORDER BY position ASC'
    ).all(assignRow.id);

    const drills = drillRows.map(d => {
      const prog = computeDrillProgress(d);
      return {
        id: d.id,
        position: d.position,
        drillType: d.drill_type,
        title: d.title_snapshot,
        coachNote: d.coach_note_snapshot,
        targetAttempts: d.target_attempts,
        targetSuccesses: d.target_successes,
        layout: JSON.parse(d.layout_snapshot_json),
        attempts: prog.attempts,
        attemptsLogged: prog.attemptsLogged,
        successes: prog.successes,
        isComplete: prog.isComplete,
        targetMet: prog.targetMet,
        studentNote: d.student_note,
        updatedAt: d.updated_at
      };
    });

    return {
      id: assignRow.id,
      planId: assignRow.plan_id,
      planName: assignRow.plan_name_snapshot,
      planDescription: assignRow.plan_desc_snapshot,
      studentName: assignRow.student_name,
      studentToken: assignRow.student_token,
      sharePath: `/?assignment=${encodeURIComponent(assignRow.student_token)}`,
      createdAt: assignRow.created_at,
      updatedAt: assignRow.updated_at,
      summary: summarizeAssignmentDrills(drills),
      drills
    };
  }

  function formatStudentAssignment(assignRow) {
    const drillRows = db.prepare(
      'SELECT * FROM assignment_drills WHERE assignment_id = ? ORDER BY position ASC'
    ).all(assignRow.id);

    const drills = drillRows.map(d => {
      const prog = computeDrillProgress(d);
      return {
        id: d.id,
        position: d.position,
        drillType: d.drill_type,
        title: d.title_snapshot,
        coachNote: d.coach_note_snapshot,
        targetAttempts: d.target_attempts,
        targetSuccesses: d.target_successes,
        layout: JSON.parse(d.layout_snapshot_json),
        attempts: prog.attempts,
        attemptsLogged: prog.attemptsLogged,
        successes: prog.successes,
        isComplete: prog.isComplete,
        targetMet: prog.targetMet,
        studentNote: d.student_note,
        updatedAt: d.updated_at
      };
    });

    return {
      studentName: assignRow.student_name,
      planName: assignRow.plan_name_snapshot,
      planDescription: assignRow.plan_desc_snapshot,
      createdAt: assignRow.created_at,
      updatedAt: assignRow.updated_at,
      summary: summarizeAssignmentDrills(drills),
      drills
    };
  }

  function validatePlanPayload(body) {
    const name = String(body?.name || '').trim();
    if (!name || name.length > 140) {
      throw Object.assign(new Error('Plan name is required (1–140 characters).'), { statusCode: 400 });
    }
    const description = String(body?.description || '').trim().slice(0, 1000);
    if (!Array.isArray(body?.drills) || body.drills.length === 0) {
      throw Object.assign(new Error('Add at least one drill to the practice plan.'), { statusCode: 400 });
    }
    if (body.drills.length > 30) {
      throw Object.assign(new Error('A practice plan can contain up to 30 drills.'), { statusCode: 400 });
    }

    const preparedDrills = body.drills.map((item, idx) => {
      const targetAttempts = parseInt(item?.targetAttempts, 10);
      const targetSuccesses = parseInt(item?.targetSuccesses, 10);
      if (!Number.isInteger(targetAttempts) || targetAttempts < 1 || targetAttempts > 50) {
        throw Object.assign(
          new Error(`Drill #${idx + 1}: target attempts must be between 1 and 50.`),
          { statusCode: 400 }
        );
      }
      if (!Number.isInteger(targetSuccesses) || targetSuccesses < 1 || targetSuccesses > targetAttempts) {
        throw Object.assign(
          new Error(`Drill #${idx + 1}: target successes must be between 1 and ${targetAttempts}.`),
          { statusCode: 400 }
        );
      }

      let built;
      try {
        built = buildDrillSnapshot(puzzleData, db, item, item?.fallbackLayout || null);
      } catch (err) {
        throw Object.assign(new Error(`Drill #${idx + 1}: ${err.message}`), { statusCode: 400 });
      }

      const title = String(item?.title || built.defaultTitle).trim().slice(0, 160) || built.defaultTitle;
      const coachNote = String(
        item?.coachNote !== undefined ? item.coachNote : built.defaultCoachNote
      ).trim().slice(0, 1500);

      return {
        position: idx + 1,
        drillType: built.drillType,
        sourceRef: built.sourceRef,
        title,
        targetAttempts,
        targetSuccesses,
        coachNote,
        snapshot: {
          ...built.snapshot,
          title
        }
      };
    });

    return { name, description, preparedDrills };
  }

  const ALLOWED_STATIC_FILES = new Map([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/data.js', 'application/javascript; charset=utf-8'],
    ['/planner.js', 'application/javascript; charset=utf-8'],
    ['/planner.css', 'text/css; charset=utf-8']
  ]);

  async function handleRequest(req, res) {
    try {
      const urlObj = new URL(req.url || '/', 'http://localhost');
      const pathname = urlObj.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // ==================== HEALTH ====================
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          phase2VideoReady: Boolean(process.env.GEMINI_API_KEY)
        });
      }

      // ==================== INSTRUCTOR AUTH ====================
      if (pathname === '/api/instructor/auth/status' && method === 'GET') {
        const configured = Boolean(getPasscodeHash());
        const authenticated = configured && isInstructorAuthenticated(req);
        return sendJson(res, 200, { configured, authenticated });
      }

      if (pathname === '/api/instructor/auth/setup' && method === 'POST') {
        if (getPasscodeHash()) {
          return sendJson(res, 409, { error: 'Instructor passcode is already configured. Please sign in.' });
        }
        const body = await readJsonBody(req);
        const passcode = String(body?.passcode || '').trim();
        if (passcode.length < 4 || passcode.length > 128) {
          return sendJson(res, 400, { error: 'Passcode must be between 4 and 128 characters.' });
        }
        const now = new Date().toISOString();
        db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
          'instructor_passcode_hash',
          hashPasscode(passcode),
          now
        );
        const token = createInstructorSession();
        return sendJson(res, 201, { token, configured: true, authenticated: true });
      }

      if (pathname === '/api/instructor/auth/login' && method === 'POST') {
        const storedHash = getPasscodeHash();
        if (!storedHash) {
          return sendJson(res, 400, { error: 'No instructor passcode configured yet.' });
        }
        const body = await readJsonBody(req);
        const passcode = String(body?.passcode || '').trim();
        if (!verifyPasscode(passcode, storedHash)) {
          return sendJson(res, 401, { error: 'Incorrect instructor passcode.' });
        }
        const token = createInstructorSession();
        return sendJson(res, 200, { token, configured: true, authenticated: true });
      }

      if (pathname === '/api/instructor/auth/logout' && method === 'POST') {
        const token = extractBearerToken(req);
        if (token) {
          db.prepare('DELETE FROM instructor_sessions WHERE token_hash = ?').run(hashSessionToken(token));
        }
        return sendJson(res, 200, { ok: true });
      }

      // ==================== STUDENT CAPABILITY ROUTES (STRICT ISOLATION) ====================
      const studentDrillMatch = pathname.match(/^\/api\/student\/assignments\/([A-Za-z0-9_-]+)\/drills\/([A-Za-z0-9_-]+)$/);
      if (studentDrillMatch) {
        const studentToken = decodeURIComponent(studentDrillMatch[1]);
        const drillId = decodeURIComponent(studentDrillMatch[2]);

        if (method !== 'PUT') {
          return sendJson(res, 405, { error: 'Method not allowed' });
        }

        const assignRow = db.prepare('SELECT * FROM assignments WHERE student_token = ?').get(studentToken);
        if (!assignRow) {
          return sendJson(res, 404, { error: 'Assignment not found.' });
        }

        const drillRow = db.prepare(
          'SELECT * FROM assignment_drills WHERE id = ? AND assignment_id = ?'
        ).get(drillId, assignRow.id);
        if (!drillRow) {
          return sendJson(res, 404, { error: 'Assigned drill not found.' });
        }

        const body = await readJsonBody(req);
        let nextAttempts = JSON.parse(drillRow.attempts_json || '[]');
        let nextNote = drillRow.student_note;

        if (body.attempts !== undefined) {
          if (!Array.isArray(body.attempts)) {
            return sendJson(res, 400, { error: 'attempts must be an array of booleans.' });
          }
          if (body.attempts.length > drillRow.target_attempts) {
            return sendJson(res, 400, {
              error: `Cannot log more than ${drillRow.target_attempts} assigned attempts.`
            });
          }
          if (!body.attempts.every(v => typeof v === 'boolean')) {
            return sendJson(res, 400, { error: 'Each attempt entry must be true (success) or false (miss).' });
          }
          nextAttempts = body.attempts;
        }

        if (body.studentNote !== undefined) {
          if (typeof body.studentNote !== 'string') {
            return sendJson(res, 400, { error: 'studentNote must be a string.' });
          }
          nextNote = body.studentNote.slice(0, 2000);
        }

        const now = new Date().toISOString();
        db.prepare(
          'UPDATE assignment_drills SET attempts_json = ?, student_note = ?, updated_at = ? WHERE id = ? AND assignment_id = ?'
        ).run(JSON.stringify(nextAttempts), nextNote, now, drillRow.id, assignRow.id);

        db.prepare('UPDATE assignments SET updated_at = ? WHERE id = ?').run(now, assignRow.id);

        const updatedAssign = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignRow.id);
        const formatted = formatStudentAssignment(updatedAssign);
        const updatedDrill = formatted.drills.find(d => d.id === drillRow.id);
        return sendJson(res, 200, {
          drill: updatedDrill,
          summary: formatted.summary,
          updatedAt: now
        });
      }

      const studentAssignMatch = pathname.match(/^\/api\/student\/assignments\/([A-Za-z0-9_-]+)$/);
      if (studentAssignMatch) {
        const studentToken = decodeURIComponent(studentAssignMatch[1]);
        if (method !== 'GET') {
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        const assignRow = db.prepare('SELECT * FROM assignments WHERE student_token = ?').get(studentToken);
        if (!assignRow) {
          return sendJson(res, 404, { error: 'Assignment link is invalid or no longer active.' });
        }
        return sendJson(res, 200, { assignment: formatStudentAssignment(assignRow) });
      }

      // ==================== PROTECTED INSTRUCTOR ROUTES ====================
      if (pathname.startsWith('/api/instructor/')) {
        if (!isInstructorAuthenticated(req)) {
          return sendJson(res, 401, { error: 'Instructor authentication required.' });
        }

        // --- Custom Spin Lab Drills ---
        if (pathname === '/api/instructor/custom-drills' && method === 'GET') {
          const rows = db.prepare('SELECT * FROM custom_drills ORDER BY updated_at DESC').all();
          return sendJson(res, 200, {
            customDrills: rows.map(r => ({
              id: r.id,
              title: r.title,
              coachNote: r.coach_note,
              layout: JSON.parse(r.layout_json),
              createdAt: r.created_at,
              updatedAt: r.updated_at
            }))
          });
        }

        if (pathname === '/api/instructor/custom-drills' && method === 'POST') {
          const body = await readJsonBody(req);
          const title = String(body?.title || '').trim().slice(0, 140);
          if (!title) {
            return sendJson(res, 400, { error: 'Custom drill title is required.' });
          }
          const coachNote = String(body?.coachNote || '').trim().slice(0, 1500);
          const layout = sanitizeCustomLayout(body?.layout);
          const id = generateId('cd');
          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO custom_drills (id, title, coach_note, layout_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(id, title, coachNote, JSON.stringify(layout), now, now);

          return sendJson(res, 201, {
            customDrill: { id, title, coachNote, layout, createdAt: now, updatedAt: now }
          });
        }

        const customDrillIdMatch = pathname.match(/^\/api\/instructor\/custom-drills\/([A-Za-z0-9_-]+)$/);
        if (customDrillIdMatch) {
          const drillId = customDrillIdMatch[1];
          const existing = db.prepare('SELECT * FROM custom_drills WHERE id = ?').get(drillId);
          if (!existing) {
            return sendJson(res, 404, { error: 'Custom drill not found.' });
          }

          if (method === 'PUT') {
            const body = await readJsonBody(req);
            const title = String(body?.title || '').trim().slice(0, 140);
            if (!title) {
              return sendJson(res, 400, { error: 'Custom drill title is required.' });
            }
            const coachNote = String(body?.coachNote || '').trim().slice(0, 1500);
            const layout = sanitizeCustomLayout(body?.layout);
            const now = new Date().toISOString();
            db.prepare(
              'UPDATE custom_drills SET title = ?, coach_note = ?, layout_json = ?, updated_at = ? WHERE id = ?'
            ).run(title, coachNote, JSON.stringify(layout), now, drillId);

            return sendJson(res, 200, {
              customDrill: {
                id: drillId,
                title,
                coachNote,
                layout,
                createdAt: existing.created_at,
                updatedAt: now
              }
            });
          }

          if (method === 'DELETE') {
            db.prepare('DELETE FROM custom_drills WHERE id = ?').run(drillId);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { error: 'Method not allowed' });
        }

        // --- Practice Plans ---
        if (pathname === '/api/instructor/plans' && method === 'GET') {
          const rows = db.prepare('SELECT * FROM practice_plans ORDER BY updated_at DESC').all();
          return sendJson(res, 200, { plans: rows.map(formatPlanRow) });
        }

        if (pathname === '/api/instructor/plans' && method === 'POST') {
          const body = await readJsonBody(req);
          const { name, description, preparedDrills } = validatePlanPayload(body);
          const planId = generateId('plan');
          const now = new Date().toISOString();

          db.exec('BEGIN IMMEDIATE;');
          try {
            db.prepare(
              'INSERT INTO practice_plans (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            ).run(planId, name, description, now, now);

            const insertDrill = db.prepare(`
              INSERT INTO practice_plan_drills (
                id, plan_id, position, drill_type, source_ref_json, title,
                target_attempts, target_successes, coach_note, layout_snapshot_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const d of preparedDrills) {
              insertDrill.run(
                generateId('pd'),
                planId,
                d.position,
                d.drillType,
                JSON.stringify(d.sourceRef),
                d.title,
                d.targetAttempts,
                d.targetSuccesses,
                d.coachNote,
                JSON.stringify(d.snapshot)
              );
            }
            db.exec('COMMIT;');
          } catch (txErr) {
            db.exec('ROLLBACK;');
            throw txErr;
          }

          const createdRow = db.prepare('SELECT * FROM practice_plans WHERE id = ?').get(planId);
          return sendJson(res, 201, { plan: formatPlanRow(createdRow) });
        }

        const planAssignMatch = pathname.match(/^\/api\/instructor\/plans\/([A-Za-z0-9_-]+)\/assignments$/);
        if (planAssignMatch && method === 'POST') {
          const planId = planAssignMatch[1];
          const planRow = db.prepare('SELECT * FROM practice_plans WHERE id = ?').get(planId);
          if (!planRow) {
            return sendJson(res, 404, { error: 'Practice plan not found.' });
          }

          const body = await readJsonBody(req);
          const studentName = String(body?.studentName || '').trim().slice(0, 120);
          if (!studentName) {
            return sendJson(res, 400, { error: 'Student name is required.' });
          }

          const planDrills = db.prepare(
            'SELECT * FROM practice_plan_drills WHERE plan_id = ? ORDER BY position ASC'
          ).all(planId);
          if (!planDrills.length) {
            return sendJson(res, 400, { error: 'Cannot share an empty practice plan.' });
          }

          const assignId = generateId('asgn');
          const studentToken = generateCapabilityToken();
          const now = new Date().toISOString();

          db.exec('BEGIN IMMEDIATE;');
          try {
            db.prepare(`
              INSERT INTO assignments (
                id, plan_id, plan_name_snapshot, plan_desc_snapshot,
                student_name, student_token, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              assignId,
              planRow.id,
              planRow.name,
              planRow.description,
              studentName,
              studentToken,
              now,
              now
            );

            const insertAssignDrill = db.prepare(`
              INSERT INTO assignment_drills (
                id, assignment_id, position, drill_type, title_snapshot,
                coach_note_snapshot, target_attempts, target_successes,
                layout_snapshot_json, attempts_json, student_note, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?)
            `);

            for (const pd of planDrills) {
              const sourceRef = JSON.parse(pd.source_ref_json);
              const fallbackSnapshot = JSON.parse(pd.layout_snapshot_json);
              // Snapshot current drill layout at share time; after this insert, it is 100% immutable!
              const fresh = buildDrillSnapshot(
                puzzleData,
                db,
                { drillType: pd.drill_type, sourceRef },
                fallbackSnapshot
              );
              const frozenSnapshot = {
                ...fresh.snapshot,
                title: pd.title
              };

              insertAssignDrill.run(
                generateId('ad'),
                assignId,
                pd.position,
                pd.drill_type,
                pd.title,
                pd.coach_note,
                pd.target_attempts,
                pd.target_successes,
                JSON.stringify(frozenSnapshot),
                now
              );
            }
            db.exec('COMMIT;');
          } catch (txErr) {
            db.exec('ROLLBACK;');
            throw txErr;
          }

          const assignRow = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignId);
          return sendJson(res, 201, { assignment: formatInstructorAssignment(assignRow) });
        }

        const planIdMatch = pathname.match(/^\/api\/instructor\/plans\/([A-Za-z0-9_-]+)$/);
        if (planIdMatch) {
          const planId = planIdMatch[1];
          const existingPlan = db.prepare('SELECT * FROM practice_plans WHERE id = ?').get(planId);
          if (!existingPlan) {
            return sendJson(res, 404, { error: 'Practice plan not found.' });
          }

          if (method === 'GET') {
            return sendJson(res, 200, { plan: formatPlanRow(existingPlan) });
          }

          if (method === 'PUT') {
            const body = await readJsonBody(req);
            const { name, description, preparedDrills } = validatePlanPayload(body);
            const now = new Date().toISOString();

            db.exec('BEGIN IMMEDIATE;');
            try {
              db.prepare(
                'UPDATE practice_plans SET name = ?, description = ?, updated_at = ? WHERE id = ?'
              ).run(name, description, now, planId);

              db.prepare('DELETE FROM practice_plan_drills WHERE plan_id = ?').run(planId);

              const insertDrill = db.prepare(`
                INSERT INTO practice_plan_drills (
                  id, plan_id, position, drill_type, source_ref_json, title,
                  target_attempts, target_successes, coach_note, layout_snapshot_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);

              for (const d of preparedDrills) {
                insertDrill.run(
                  generateId('pd'),
                  planId,
                  d.position,
                  d.drillType,
                  JSON.stringify(d.sourceRef),
                  d.title,
                  d.targetAttempts,
                  d.targetSuccesses,
                  d.coachNote,
                  JSON.stringify(d.snapshot)
                );
              }
              db.exec('COMMIT;');
            } catch (txErr) {
              db.exec('ROLLBACK;');
              throw txErr;
            }

            const updatedRow = db.prepare('SELECT * FROM practice_plans WHERE id = ?').get(planId);
            return sendJson(res, 200, { plan: formatPlanRow(updatedRow) });
          }

          if (method === 'DELETE') {
            db.prepare('DELETE FROM practice_plans WHERE id = ?').run(planId);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { error: 'Method not allowed' });
        }

        // --- Student Assignments Review ---
        if (pathname === '/api/instructor/assignments' && method === 'GET') {
          const filterPlanId = urlObj.searchParams.get('planId');
          const rows = filterPlanId
            ? db.prepare('SELECT * FROM assignments WHERE plan_id = ? ORDER BY created_at DESC').all(filterPlanId)
            : db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all();
          return sendJson(res, 200, { assignments: rows.map(formatInstructorAssignment) });
        }

        const assignIdMatch = pathname.match(/^\/api\/instructor\/assignments\/([A-Za-z0-9_-]+)$/);
        if (assignIdMatch) {
          const assignId = assignIdMatch[1];
          const assignRow = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignId);
          if (!assignRow) {
            return sendJson(res, 404, { error: 'Assignment not found.' });
          }

          if (method === 'GET') {
            return sendJson(res, 200, { assignment: formatInstructorAssignment(assignRow) });
          }

          if (method === 'DELETE') {
            db.prepare('DELETE FROM assignments WHERE id = ?').run(assignId);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { error: 'Method not allowed' });
        }

        return sendJson(res, 404, { error: 'API endpoint not found.' });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'API endpoint not found.' });
      }

      // ==================== STATIC FRONTEND SERVING ====================
      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      const cleanPath = pathname === '/' ? '/index.html' : pathname;
      const contentType = ALLOWED_STATIC_FILES.get(cleanPath);
      if (!contentType) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const resolvedFile = path.resolve(staticDir, '.' + cleanPath);
      if (!resolvedFile.startsWith(path.resolve(staticDir) + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      if (!fs.existsSync(resolvedFile)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const content = fs.readFileSync(resolvedFile);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cleanPath === '/data.js' ? 'public, max-age=3600' : 'no-cache'
      });
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
    } catch (err) {
      const status = err?.statusCode || 500;
      sendJson(res, status, { error: err?.message || 'Internal server error' });
    }
  }

  const server = http.createServer(handleRequest);
  return { server, db, handleRequest };
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createAppServer();
  server.listen(port, host, () => {
    console.log(`CueLab Arena running at http://${host}:${port}`);
  });
}

module.exports = { createAppServer };
