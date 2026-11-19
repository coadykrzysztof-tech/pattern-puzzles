const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const path = require('node:path');
const { createAppServer } = require('../server');

async function invoke(handleRequest, method, url, { body, token } = {}) {
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers['authorization'] = `Bearer ${token}`;
  if (payload) req.headers['content-type'] = 'application/json';

  let statusCode = 200;
  let resHeaders = {};
  const chunks = [];

  const res = {
    writeHead(code, headers = {}) {
      statusCode = code;
      resHeaders = { ...resHeaders, ...headers };
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    }
  };

  await handleRequest(req, res);
  const rawText = Buffer.concat(chunks).toString('utf8');
  let json = null;
  if ((resHeaders['Content-Type'] || '').includes('application/json')) {
    json = JSON.parse(rawText);
  }
  return { statusCode, headers: resHeaders, text: rawText, json };
}

test('Practice Planner end-to-end API, snapshot stability, and student isolation', async () => {
  const prevPass = process.env.INSTRUCTOR_PASSCODE;
  delete process.env.INSTRUCTOR_PASSCODE;

  const { handleRequest, db } = createAppServer({
    dbPath: ':memory:',
    staticDir: path.resolve(__dirname, '..')
  });

  try {
    // 1. Static serving & sensitive file protection
    const indexRes = await invoke(handleRequest, 'GET', '/?assignment=abc');
    assert.equal(indexRes.statusCode, 200);
    assert.match(indexRes.text, /CueLab Arena/);

    const blockedServerJs = await invoke(handleRequest, 'GET', '/server.js');
    assert.equal(blockedServerJs.statusCode, 404);

    const blockedDb = await invoke(handleRequest, 'GET', '/cuelab.db');
    assert.equal(blockedDb.statusCode, 404);

    const manualRes = await invoke(handleRequest, 'GET', '/docs/USER_MANUAL.md');
    assert.equal(manualRes.statusCode, 200);
    assert.match(manualRes.headers['Content-Type'], /text\/markdown/);
    assert.match(manualRes.text, /CueLab Arena — User Manual/);
    assert.equal(manualRes.text.includes('/api/instructor/'), false, 'User Manual must never expose private instructor endpoints');

    const shotRes = await invoke(handleRequest, 'GET', '/docs/screenshots/09-expanded-magnifier-mode.png');
    assert.equal(shotRes.statusCode, 200);
    assert.equal(shotRes.headers['Content-Type'], 'image/png');

    const blockedTestPlan = await invoke(handleRequest, 'GET', '/docs/TEST_PLAN.md');
    assert.equal(blockedTestPlan.statusCode, 404);

    const blockedGemini = await invoke(handleRequest, 'GET', '/GEMINI.md');
    assert.equal(blockedGemini.statusCode, 404);

    const blockedTraversal = await invoke(handleRequest, 'GET', '/docs/screenshots/../../server.js');
    assert.equal(blockedTraversal.statusCode, 404);

    // 2. Auth setup, login, and unauthorized rejection
    const initStatus = await invoke(handleRequest, 'GET', '/api/instructor/auth/status');
    assert.deepEqual(initStatus.json, { configured: false, authenticated: false });

    const unauthPlans = await invoke(handleRequest, 'GET', '/api/instructor/plans');
    assert.equal(unauthPlans.statusCode, 401);

    const setupRes = await invoke(handleRequest, 'POST', '/api/instructor/auth/setup', {
      body: { passcode: 'pool-coach-2026' }
    });
    assert.equal(setupRes.statusCode, 201);
    const instructorToken = setupRes.json.token;
    assert.ok(instructorToken.length >= 24);

    // Duplicate setup must be blocked
    const dupSetup = await invoke(handleRequest, 'POST', '/api/instructor/auth/setup', {
      body: { passcode: 'hacker-pass' }
    });
    assert.equal(dupSetup.statusCode, 409);

    // Bad login rejected
    const badLogin = await invoke(handleRequest, 'POST', '/api/instructor/auth/login', {
      body: { passcode: 'wrong' }
    });
    assert.equal(badLogin.statusCode, 401);

    // 3. Create a Saved Custom Spin Lab Drill with Marked Target Zone
    const customRes = await invoke(handleRequest, 'POST', '/api/instructor/custom-drills', {
      token: instructorToken,
      body: {
        title: 'Corner Cut Stun-Draw to Center Zone',
        coachNote: 'Hit low-center at Power 3 so cue ball holds inside M25.',
        layout: {
          cue: { x: 16, y: 19 },
          obj: { x: 35, y: 8 },
          objBallNum: 1,
          pocket: 'P3',
          blockers: [{ number: 8, x: 30, y: 15 }],
          tip: { x: 0, y: 0.55 },
          power: 3,
          compensateSquirt: false,
          targetZone: { enabled: true, x: 25, y: 13, radius: 46 }
        }
      }
    });
    assert.equal(customRes.statusCode, 201);
    const customDrillId = customRes.json.customDrill.id;
    assert.equal(customRes.json.customDrill.layout.targetZone.coord, 'M25');

    // 4. Create a Practice Plan with 2 drills in order (1: Rack Shot, 2: Custom Spin Lab Drill)
    const planRes = await invoke(handleRequest, 'POST', '/api/instructor/plans', {
      token: instructorToken,
      body: {
        name: 'Week 4 — Position Control & Leave Zones',
        description: 'Complete both drills before Tuesday lesson.',
        drills: [
          {
            drillType: 'rack_shot',
            sourceRef: { game: '9ball', subset: 'rot', rackNum: 1, strokeNum: 1 },
            title: '9-Ball R1 Opening Leave',
            targetAttempts: 10,
            targetSuccesses: 7,
            coachNote: 'Land the cue ball in the marked zone on 7 out of 10 attempts.'
          },
          {
            drillType: 'custom_drill',
            sourceRef: { customDrillId },
            title: 'Corner Cut Stun-Draw to Center Zone',
            targetAttempts: 5,
            targetSuccesses: 3,
            coachNote: 'Hold center table without hitting the 8-ball blocker.'
          }
        ]
      }
    });
    assert.equal(planRes.statusCode, 201);
    const planId = planRes.json.plan.id;
    assert.equal(planRes.json.plan.drills.length, 2);

    // 5. Assign the same plan to Two Separate Students
    const assign1Res = await invoke(handleRequest, 'POST', `/api/instructor/plans/${planId}/assignments`, {
      token: instructorToken,
      body: { studentName: 'Maya Lin' }
    });
    assert.equal(assign1Res.statusCode, 201);
    const student1Token = assign1Res.json.assignment.studentToken;

    const assign2Res = await invoke(handleRequest, 'POST', `/api/instructor/plans/${planId}/assignments`, {
      token: instructorToken,
      body: { studentName: 'Devon Brooks' }
    });
    assert.equal(assign2Res.statusCode, 201);
    const student2Token = assign2Res.json.assignment.studentToken;
    assert.notEqual(student1Token, student2Token);

    // 6. Mutate BOTH the Custom Drill AND the Practice Plan AFTER sharing!
    const editCustomRes = await invoke(handleRequest, 'PUT', `/api/instructor/custom-drills/${customDrillId}`, {
      token: instructorToken,
      body: {
        title: 'CHANGED Custom Drill Title',
        coachNote: 'CHANGED note',
        layout: {
          cue: { x: 5, y: 5 },
          obj: { x: 45, y: 22 },
          pocket: 'P6',
          blockers: [],
          tip: { x: 0, y: -0.8 },
          power: 5,
          targetZone: { enabled: true, x: 40, y: 20, radius: 30 }
        }
      }
    });
    assert.equal(editCustomRes.statusCode, 200);

    const editPlanRes = await invoke(handleRequest, 'PUT', `/api/instructor/plans/${planId}`, {
      token: instructorToken,
      body: {
        name: 'MUTATED Plan Name',
        description: 'Changed description',
        drills: [
          {
            drillType: 'rack',
            sourceRef: { game: '10ball', subset: 'rot', rackNum: 5 },
            title: '10-Ball Rack 5 Runout',
            targetAttempts: 20,
            targetSuccesses: 18,
            coachNote: 'Totally different drill and target!'
          }
        ]
      }
    });
    assert.equal(editPlanRes.statusCode, 200);

    // Verify Maya's shared assignment is 100% UNCHANGED by plan & drill edits!
    const s1View = await invoke(handleRequest, 'GET', `/api/student/assignments/${student1Token}`);
    assert.equal(s1View.statusCode, 200);
    assert.equal(s1View.json.assignment.planName, 'Week 4 — Position Control & Leave Zones');
    assert.equal(s1View.json.assignment.drills.length, 2);
    assert.equal(s1View.json.assignment.drills[0].targetAttempts, 10);
    assert.equal(s1View.json.assignment.drills[0].targetSuccesses, 7);
    assert.equal(s1View.json.assignment.drills[1].title, 'Corner Cut Stun-Draw to Center Zone');
    assert.deepEqual(s1View.json.assignment.drills[1].layout.cue, { x: 16, y: 19 });
    assert.equal(s1View.json.assignment.drills[1].layout.pocket, 'P3');
    // Ensure student endpoint does NOT leak internal planId or sibling info
    assert.equal(s1View.json.assignment.planId, undefined);

    // 7. Student token must NEVER grant access to instructor endpoints or other student's drills
    const studentTryInstructor = await invoke(handleRequest, 'GET', '/api/instructor/assignments', {
      token: student1Token
    });
    assert.equal(studentTryInstructor.statusCode, 401);

    const s2View = await invoke(handleRequest, 'GET', `/api/student/assignments/${student2Token}`);
    const s2Drill1Id = s2View.json.assignment.drills[0].id;
    const crossStudentAttack = await invoke(
      handleRequest,
      'PUT',
      `/api/student/assignments/${student1Token}/drills/${s2Drill1Id}`,
      { body: { attempts: [true] } }
    );
    assert.equal(crossStudentAttack.statusCode, 404);

    // 8. Student 1 logs attempts, corrects an accidental entry, completes Drill 1 (6/10 -> not met) & Drill 2 (4/5 -> met)
    const s1Drill1Id = s1View.json.assignment.drills[0].id;
    const s1Drill2Id = s1View.json.assignment.drills[1].id;

    // Partial log with accidental miss at index 1
    let logRes = await invoke(
      handleRequest,
      'PUT',
      `/api/student/assignments/${student1Token}/drills/${s1Drill1Id}`,
      { body: { attempts: [true, false, true] } }
    );
    assert.equal(logRes.statusCode, 200);
    assert.equal(logRes.json.drill.isComplete, false);
    assert.equal(logRes.json.drill.targetMet, null);

    // Correct accidental miss at index 1 -> true, then finish 10 attempts with 6 successes (target was 7)
    logRes = await invoke(
      handleRequest,
      'PUT',
      `/api/student/assignments/${student1Token}/drills/${s1Drill1Id}`,
      {
        body: {
          attempts: [true, true, true, false, true, false, true, false, true, false],
          studentNote: 'Over-hit shots 4 and 6 past the leave zone.'
        }
      }
    );
    assert.equal(logRes.statusCode, 200);
    assert.equal(logRes.json.drill.successes, 6);
    assert.equal(logRes.json.drill.attemptsLogged, 10);
    assert.equal(logRes.json.drill.isComplete, true);
    assert.equal(logRes.json.drill.targetMet, false);

    // Reject logging > targetAttempts (11 > 10)
    const overflowRes = await invoke(
      handleRequest,
      'PUT',
      `/api/student/assignments/${student1Token}/drills/${s1Drill1Id}`,
      { body: { attempts: Array(11).fill(true) } }
    );
    assert.equal(overflowRes.statusCode, 400);

    // Complete Drill 2 with 4 of 5 successes (target was 3 -> targetMet: true)
    const logRes2 = await invoke(
      handleRequest,
      'PUT',
      `/api/student/assignments/${student1Token}/drills/${s1Drill2Id}`,
      {
        body: {
          attempts: [true, true, false, true, true],
          studentNote: 'Power 3 low-center felt super repeatable!'
        }
      }
    );
    assert.equal(logRes2.statusCode, 200);
    assert.equal(logRes2.json.drill.targetMet, true);
    assert.equal(logRes2.json.summary.status, 'completed');
    assert.equal(logRes2.json.summary.targetsMet, 1);

    // 9. Verify Student 2's assignment is still completely untouched & independent
    const s2Check = await invoke(handleRequest, 'GET', `/api/student/assignments/${student2Token}`);
    assert.equal(s2Check.json.assignment.summary.status, 'not_started');
    assert.equal(s2Check.json.assignment.drills[0].attemptsLogged, 0);

    // 10. Verify Instructor sees accurate review across both students
    const instReview = await invoke(handleRequest, 'GET', '/api/instructor/assignments', {
      token: instructorToken
    });
    assert.equal(instReview.statusCode, 200);
    assert.equal(instReview.json.assignments.length, 2);
    const mayaReview = instReview.json.assignments.find(a => a.studentName === 'Maya Lin');
    const devonReview = instReview.json.assignments.find(a => a.studentName === 'Devon Brooks');
    assert.equal(mayaReview.summary.status, 'completed');
    assert.equal(mayaReview.drills[0].successes, 6);
    assert.equal(mayaReview.drills[0].targetMet, false);
    assert.equal(mayaReview.drills[0].studentNote, 'Over-hit shots 4 and 6 past the leave zone.');
    assert.equal(mayaReview.drills[1].successes, 4);
    assert.equal(mayaReview.drills[1].targetMet, true);
    assert.equal(devonReview.summary.status, 'not_started');
  } finally {
    db.close();
    if (prevPass !== undefined) process.env.INSTRUCTOR_PASSCODE = prevPass;
  }
});
