// ==================== PRACTICE PLANNER, CUSTOM DRILLS & STUDENT PRACTICE MODE ====================
(function () {
  const INSTRUCTOR_TOKEN_KEY = 'cuelab_instructor_token';

  let isStudentMode = false;
  let studentToken = null;
  let studentAssignment = null;
  let activeStudentDrillIdx = 0;
  let noteDebounceTimer = null;
  let activeHudContext = null; // { mode: 'student'|'preview', title, kicker, coachNote, callout }

  let instructorState = {
    configured: false,
    authenticated: false,
    token: null,
    serverReachable: true,
    subtab: 'plans', // 'plans' | 'assignments'
    plans: [],
    assignments: [],
    customDrills: [],
    assignmentPlanFilter: '',
    selectedAssignmentId: null,
    editor: {
      planId: null,
      name: '',
      description: '',
      drills: [],
      dirty: false
    },
    picker: {
      sourceType: 'rack_shot', // 'rack_shot' | 'rack' | 'custom_drill'
      gameKey: '9ball_rot',
      rackNum: 1,
      strokeNum: 1,
      customDrillId: ''
    },
    previewReturnActive: false
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const el = document.getElementById('cuelabToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function getSavedInstructorToken() {
    if (isStudentMode) return null;
    try {
      return localStorage.getItem(INSTRUCTOR_TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function saveInstructorToken(tok) {
    instructorState.token = tok;
    try {
      if (tok) localStorage.setItem(INSTRUCTOR_TOKEN_KEY, tok);
      else localStorage.removeItem(INSTRUCTOR_TOKEN_KEY);
    } catch (e) {}
  }

  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.instructorAuth && instructorState.token) {
      headers['Authorization'] = `Bearer ${instructorState.token}`;
    }
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {}
    if (!resp.ok) {
      const err = new Error(data?.error || `Request failed (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  function parseGameKey(gameKey) {
    if (gameKey === '10ball_rot') return { game: '10ball', subset: 'rot', label: '10-Ball' };
    if (gameKey === '8ball_solids') return { game: '8ball', subset: 'solids', label: '8-Ball Solids' };
    if (gameKey === '8ball_stripes') return { game: '8ball', subset: 'stripes', label: '8-Ball Stripes' };
    return { game: '9ball', subset: 'rot', label: '9-Ball' };
  }

  function buildClientSnapshotFromSource(drillType, sourceRef) {
    if (drillType === 'rack') {
      const { game, subset, rackNum } = sourceRef;
      const rData = PUZZLE_DATA.games?.[game]?.racks?.[rackNum];
      if (!rData) return null;
      const bih = game === '8ball' && subset === 'stripes' ? (rData.bihStripes || rData.bih) : rData.bih;
      const strokes = game === '8ball'
        ? (subset === 'stripes' ? rData.stripesStrokes : rData.solidsStrokes)
        : rData.strokes;
      const gLabel = game === '9ball' ? '9-Ball' : (game === '10ball' ? '10-Ball' : (subset === 'stripes' ? '8-Ball Stripes' : '8-Ball Solids'));
      const defaultTitle = `${gLabel} · Rack ${rackNum}`;
      return {
        defaultTitle,
        defaultCoachNote: `Run out ${defaultTitle} starting with ball in hand at ${bih}.`,
        layout: {
          kind: 'rack',
          game,
          subset,
          rackNum: Number(rackNum),
          title: defaultTitle,
          bih,
          balls: JSON.parse(JSON.stringify(rData.balls)),
          strokes: JSON.parse(JSON.stringify(strokes))
        }
      };
    }

    if (drillType === 'rack_shot') {
      const { game, subset, rackNum, strokeNum } = sourceRef;
      const rData = PUZZLE_DATA.games?.[game]?.racks?.[rackNum];
      if (!rData) return null;
      const strokes = game === '8ball'
        ? (subset === 'stripes' ? rData.stripesStrokes : rData.solidsStrokes)
        : rData.strokes;
      const sIdx = Number(strokeNum) - 1;
      if (!strokes || !strokes[sIdx]) return null;

      const chosen = JSON.parse(JSON.stringify(strokes[sIdx]));
      chosen.stroke = 1;
      const pocketedBefore = new Set();
      for (let i = 0; i < sIdx; i++) pocketedBefore.add(parseInt(strokes[i].ball, 10));
      const remainingBalls = JSON.parse(JSON.stringify(
        rData.balls.filter(b => !pocketedBefore.has(parseInt(b.number, 10)))
      ));
      const rackBih = game === '8ball' && subset === 'stripes' ? (rData.bihStripes || rData.bih) : rData.bih;
      const startBih = sIdx === 0 ? rackBih : strokes[sIdx - 1].leave;
      const nextBallCoord = (sIdx + 1 < strokes.length) ? (strokes[sIdx + 1].obj || strokes[sIdx + 1].coord) : null;
      const gLabel = game === '9ball' ? '9-Ball' : (game === '10ball' ? '10-Ball' : (subset === 'stripes' ? '8-Ball Stripes' : '8-Ball Solids'));
      const leavePart = chosen.leave && chosen.leave !== 'Rack over' ? ` → Zone ${chosen.leave}` : '';
      const defaultTitle = `${gLabel} R${rackNum} · Shot ${strokeNum} (#${chosen.ball} → ${chosen.pocket}${leavePart})`;

      return {
        defaultTitle,
        defaultCoachNote: chosen.notes || '',
        layout: {
          kind: 'rack_shot',
          game,
          subset,
          rackNum: Number(rackNum),
          originalStrokeNum: Number(strokeNum),
          title: defaultTitle,
          bih: startBih,
          balls: remainingBalls,
          strokes: [chosen],
          nextBallCoord
        }
      };
    }

    if (drillType === 'custom_drill') {
      const cd = instructorState.customDrills.find(d => d.id === sourceRef.customDrillId);
      if (!cd) return null;
      return {
        defaultTitle: cd.title,
        defaultCoachNote: cd.coachNote || '',
        layout: JSON.parse(JSON.stringify({ ...cd.layout, title: cd.title }))
      };
    }
    return null;
  }

  // ==================== APPLY FROZEN SNAPSHOT TO ARENA CANVAS ====================
  function applySnapshotToArena(snapshot, meta = {}) {
    if (!snapshot) return;
    stopAutoPlay();
    cancelAnim();

    activeHudContext = meta;
    activeSnapshotOverride = JSON.parse(JSON.stringify(snapshot));
    sandboxLocked = meta.locked !== false;

    document.getElementById('plannerWorkspace').classList.remove('visible');
    document.getElementById('arenaTableStage').style.display = 'flex';
    document.getElementById('arenaBentoGrid').style.display = 'grid';

    const isCustom = snapshot.kind === 'custom_drill';
    document.getElementById('puzzlePlaybackBar').style.display = isCustom ? 'none' : 'flex';
    document.getElementById('sandboxPlaybackBar').style.display = isCustom ? 'flex' : 'none';
    const sbEditBtns = document.getElementById('sandboxEditBtns');
    if (sbEditBtns) sbEditBtns.style.display = sandboxLocked ? 'none' : 'flex';

    if (isStudentMode) {
      document.getElementById('scorecardPanel').style.display = 'none';
      document.getElementById('sandboxPocketPanel').style.display = 'none';
      document.getElementById('studentAttemptPanel').style.display = 'flex';
    } else {
      document.getElementById('studentAttemptPanel').style.display = 'none';
      document.getElementById('scorecardPanel').style.display = isCustom ? 'none' : 'flex';
      document.getElementById('sandboxPocketPanel').style.display = isCustom ? 'flex' : 'none';
    }

    canvas.style.cursor = (!sandboxLocked && isCustom) ? 'grab' : 'default';

    if (isCustom) {
      currentGame = 'sandbox';
      currentSubset = 'lab';
      sandboxState = {
        cue: { x: Number(snapshot.cue?.x) || 18, y: Number(snapshot.cue?.y) || 18 },
        obj: { x: Number(snapshot.obj?.x) || 34, y: Number(snapshot.obj?.y) || 9 },
        objBallNum: parseInt(snapshot.objBallNum, 10) || 1,
        pocket: snapshot.pocket || 'P3',
        blockers: JSON.parse(JSON.stringify(snapshot.blockers || [])),
        targetZone: snapshot.targetZone
          ? JSON.parse(JSON.stringify(snapshot.targetZone))
          : { enabled: false, x: 24, y: 14, radius: 46 }
      };
      explorerTip = { x: Number(snapshot.tip?.x) || 0, y: Number(snapshot.tip?.y) || 0 };
      explorerPower = parseInt(snapshot.power, 10) || 3;
      compensateSquirt = Boolean(snapshot.compensateSquirt);
      explorerActive = true;

      const coachDot = document.getElementById('cueCoachDot');
      if (coachDot) {
        coachDot.style.display = 'block';
        coachDot.style.left = `${50 + explorerTip.x * 32}%`;
        coachDot.style.top = `${50 + explorerTip.y * 32}%`;
      }
      document.querySelectorAll('#sbPocketGrid .sb-pkt-btn').forEach(b => {
        b.classList.toggle('active', b.textContent === sandboxState.pocket);
      });
      positionExplorerDot();
      buildTimeline();
      computeDesiredCameraAngle(true);
      updateHUD();
      render();
    } else {
      currentGame = snapshot.game || '9ball';
      currentSubset = snapshot.subset || 'rot';
      document.getElementById('cueCoachDot').style.display = 'block';

      if (snapshot.kind === 'rack_shot') {
        currentStrokeIdx = 1;
        snapExplorerToCoachStroke(snapshot.strokes?.[0] || null);
      } else {
        currentStrokeIdx = 0;
        snapExplorerToCoachStroke(null);
      }
      buildTimeline();
      computeDesiredCameraAngle(true);
      updateHUD();
      if (!isStudentMode) updateTryUI();
      render();
    }
  }

  window.afterUpdateHUD = function () {
    if (!activeSnapshotOverride || !activeHudContext) return;
    const kickerEl = document.getElementById('shotKicker');
    const titleEl = document.getElementById('shotTitle');
    const calloutEl = document.getElementById('targetCallout');
    const notesEl = document.getElementById('coachNotes');
    const resetExpBtn = document.getElementById('resetExplorerBtn');

    if (activeSnapshotOverride.kind === 'custom_drill' && resetExpBtn) {
      resetExpBtn.textContent = '↺ Snap to Coach';
    }

    if (activeHudContext.kicker && kickerEl) {
      kickerEl.textContent = activeHudContext.kicker;
    }
    if (activeHudContext.title && titleEl && (activeSnapshotOverride.kind !== 'rack' || currentStrokeIdx === 0)) {
      titleEl.textContent = activeHudContext.title;
    }
    if (activeSnapshotOverride.kind === 'custom_drill' && activeSnapshotOverride.targetZone?.enabled && calloutEl) {
      const tzCoord = activeSnapshotOverride.targetZone.coord || formatGridCoord(activeSnapshotOverride.targetZone.x, activeSnapshotOverride.targetZone.y);
      calloutEl.textContent = `Target Zone: ${tzCoord}`;
    } else if (activeHudContext.callout && calloutEl && currentStrokeIdx === 0) {
      calloutEl.textContent = activeHudContext.callout;
    }

    if (notesEl) {
      const coachNote = (activeHudContext.coachNote || '').trim();
      if (activeSnapshotOverride.kind === 'custom_drill') {
        if (coachNote) {
          notesEl.innerHTML = `<strong>Coaching Note:</strong> ${escapeHtml(coachNote)}`;
        } else {
          const tzText = activeSnapshotOverride.targetZone?.enabled
            ? ` Land the cue ball inside <strong>${escapeHtml(activeSnapshotOverride.targetZone.coord || formatGridCoord(activeSnapshotOverride.targetZone.x, activeSnapshotOverride.targetZone.y))}</strong>.`
            : '';
          notesEl.innerHTML = `<strong>Custom Drill:</strong> Pocket the #${activeSnapshotOverride.objBallNum || 1}-Ball in <strong>${escapeHtml(activeSnapshotOverride.pocket)}</strong>.${tzText} Click <strong>▶ Shoot &amp; Roll</strong> to preview the shot.`;
        }
      } else if (coachNote) {
        const existingHtml = notesEl.innerHTML;
        const shotMechanicExtra = (activeSnapshotOverride.kind === 'rack' && currentStrokeIdx > 0)
          ? `<div style="margin-top:6px; font-size:0.82rem; color:var(--text-secondary);">${existingHtml}</div>`
          : '';
        notesEl.innerHTML = `<strong>Coaching Note:</strong> ${escapeHtml(coachNote)}${shotMechanicExtra}`;
      }
    }

    // In 1-shot drills, clarify playback buttons
    if (activeSnapshotOverride.kind === 'rack_shot') {
      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      const stepper = document.getElementById('ballStepper');
      if (stepper) {
        const st = activeSnapshotOverride.strokes?.[0];
        const tz = st?.leave && st.leave !== 'Rack over' ? ` · Target Zone ${st.leave}` : '';
        stepper.innerHTML = `<div class="step-node active">🎯 Assigned Shot: Cue at ${escapeHtml(activeSnapshotOverride.bih)} → #${st?.ball}-Ball into ${escapeHtml(st?.pocket)}${escapeHtml(tz)}</div>`;
      }
    } else {
      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      if (prevBtn) prevBtn.style.display = 'flex';
      if (nextBtn) nextBtn.style.display = 'flex';
    }
  };

  window.onExitPlannerOrPreview = function () {
    activeHudContext = null;
    instructorState.previewReturnActive = false;
    document.getElementById('plannerWorkspace')?.classList.remove('visible');
    document.getElementById('snapshotPreviewBanner')?.classList.remove('visible');
    document.getElementById('arenaTableStage').style.display = 'flex';
    document.getElementById('arenaBentoGrid').style.display = 'grid';
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    if (prevBtn) prevBtn.style.display = 'flex';
    if (nextBtn) nextBtn.style.display = 'flex';
  };

  // ==================== STUDENT PRACTICE MODE ====================
  async function bootStudentMode(token) {
    isStudentMode = true;
    studentToken = token;
    document.body.classList.add('student-mode');

    // Strictly remove instructor & free-play navigation from DOM
    const gameTabs = document.getElementById('gameTabs');
    if (gameTabs) gameTabs.remove();
    const rackNav = document.getElementById('rackNavBox');
    if (rackNav) rackNav.remove();

    document.getElementById('brandIcon').textContent = '🎯';
    const brandSub = document.querySelector('.brand-text span');
    if (brandSub) brandSub.textContent = 'Assigned Practice Session';

    const headerBar = document.getElementById('studentAssignmentHeader');
    headerBar.classList.add('visible');
    headerBar.innerHTML = `<div style="color:var(--text-secondary); font-weight:600;">Loading your assigned practice plan...</div>`;

    try {
      const data = await apiFetch(`/api/student/assignments/${encodeURIComponent(token)}`);
      studentAssignment = data.assignment;

      let startIdx = 0;
      try {
        const savedIdx = parseInt(sessionStorage.getItem(`cuelab_stu_idx_${token}`), 10);
        if (!Number.isNaN(savedIdx) && savedIdx >= 0 && savedIdx < studentAssignment.drills.length) {
          startIdx = savedIdx;
        } else {
          const firstIncomplete = studentAssignment.drills.findIndex(d => !d.isComplete);
          if (firstIncomplete >= 0) startIdx = firstIncomplete;
        }
      } catch (e) {}

      selectStudentDrill(startIdx);
    } catch (err) {
      document.getElementById('arenaTableStage').style.display = 'none';
      document.getElementById('arenaBentoGrid').style.display = 'none';
      headerBar.innerHTML = `
        <div class="student-plan-kicker" style="color:var(--accent-rose);">ASSIGNMENT UNAVAILABLE</div>
        <div class="student-plan-title">Could not open practice link</div>
        <div class="student-plan-desc">${escapeHtml(err.message || 'Please check with your instructor for an updated practice link.')}</div>
      `;
    }
  }

  function selectStudentDrill(idx) {
    if (!studentAssignment || !studentAssignment.drills[idx]) return;
    if (noteDebounceTimer) {
      clearTimeout(noteDebounceTimer);
      noteDebounceTimer = null;
    }
    activeStudentDrillIdx = idx;
    try {
      sessionStorage.setItem(`cuelab_stu_idx_${studentToken}`, String(idx));
    } catch (e) {}

    const drill = studentAssignment.drills[idx];
    renderStudentHeader();
    renderStudentAttemptPanel();

    applySnapshotToArena(drill.layout, {
      mode: 'student',
      locked: true,
      kicker: `DRILL ${idx + 1} OF ${studentAssignment.drills.length} · TARGET: ${drill.targetSuccesses} OF ${drill.targetAttempts} SUCCESSFUL`,
      title: drill.title,
      coachNote: drill.coachNote
    });
  }

  function renderStudentHeader() {
    const headerBar = document.getElementById('studentAssignmentHeader');
    if (!headerBar || !studentAssignment) return;

    const drills = studentAssignment.drills;
    const completedCnt = drills.filter(d => d.isComplete).length;
    const metCnt = drills.filter(d => d.isComplete && d.targetMet).length;
    const allDone = drills.length > 0 && completedCnt === drills.length;

    const overallText = allDone
      ? `✓ Plan Complete · ${metCnt} of ${drills.length} Target${drills.length === 1 ? '' : 's'} Met`
      : `${completedCnt} of ${drills.length} Drill${drills.length === 1 ? '' : 's'} Complete`;

    const tabsHtml = drills.map((d, i) => {
      let badgeCls = 'drill-mini-status';
      let badgeTxt = `${d.attemptsLogged}/${d.targetAttempts}`;
      if (d.isComplete) {
        badgeCls += d.targetMet ? ' met' : ' missed';
        badgeTxt = d.targetMet ? `✓ ${d.successes}/${d.targetAttempts}` : `✗ ${d.successes}/${d.targetAttempts}`;
      }
      return `
        <button class="student-drill-tab ${i === activeStudentDrillIdx ? 'active' : ''}" onclick="window.selectStudentDrill(${i})">
          <span>${i + 1}. ${escapeHtml(d.title)}</span>
          <span class="${badgeCls}">${badgeTxt}</span>
        </button>
      `;
    }).join('');

    headerBar.innerHTML = `
      <div class="student-bar-top">
        <div>
          <div class="student-plan-kicker">PRACTICE ASSIGNMENT · ${escapeHtml(studentAssignment.studentName)}</div>
          <div class="student-plan-title">${escapeHtml(studentAssignment.planName)}</div>
          ${studentAssignment.planDescription ? `<div class="student-plan-desc">${escapeHtml(studentAssignment.planDescription)}</div>` : ''}
        </div>
        <div class="student-overall-pill ${allDone ? 'all-done' : ''}">${overallText}</div>
      </div>
      <div class="student-drill-nav-row">
        <div class="student-drill-pills">${tabsHtml}</div>
        <div style="display:flex; gap:6px;">
          <button class="ctrl-btn" onclick="window.selectStudentDrill(${activeStudentDrillIdx - 1})" ${activeStudentDrillIdx === 0 ? 'disabled' : ''}>◀ Prev Drill</button>
          <button class="ctrl-btn" onclick="window.selectStudentDrill(${activeStudentDrillIdx + 1})" ${activeStudentDrillIdx >= drills.length - 1 ? 'disabled' : ''}>Next Drill ▶</button>
        </div>
      </div>
    `;
  }

  function renderStudentAttemptPanel(syncState = 'saved') {
    const panel = document.getElementById('studentAttemptPanel');
    if (!panel || !studentAssignment) return;

    const drill = studentAssignment.drills[activeStudentDrillIdx];
    const attempts = drill.attempts || [];
    const logged = attempts.length;
    const successes = attempts.filter(Boolean).length;
    const targetAtt = drill.targetAttempts;
    const targetSucc = drill.targetSuccesses;
    const isComplete = logged >= targetAtt;
    const targetMet = isComplete ? successes >= targetSucc : null;

    let bannerCls = 'student-target-banner';
    let bannerHeadline = `Target: ${targetSucc} of ${targetAtt} successful`;
    let bannerSub = logged === 0
      ? `Tap ✓ Success or ✗ Miss below after each attempt (${targetAtt} total)`
      : `${logged} of ${targetAtt} logged · ${successes} successful so far`;

    if (isComplete) {
      if (targetMet) {
        bannerCls += ' complete-met';
        bannerHeadline = `✓ Target Met — ${successes} of ${targetAtt} successful · Target was ${targetSucc}`;
        bannerSub = `Great shooting! You can still tap any slot below if you need to correct an entry.`;
      } else {
        bannerCls += ' complete-missed';
        bannerHeadline = `Target Not Met — ${successes} of ${targetAtt} successful · Target was ${targetSucc}`;
        bannerSub = `Assigned attempts complete. Tap any slot below if you need to correct an accidental entry.`;
      }
    }

    let slotsHtml = '';
    for (let i = 0; i < targetAtt; i++) {
      if (i < logged) {
        const win = attempts[i] === true;
        slotsHtml += `
          <button type="button" class="student-try-slot recorded ${win ? 'win' : 'miss'}"
            onclick="window.flipStudentAttempt(${i})"
            title="Attempt #${i + 1}: ${win ? 'Success' : 'Miss'} — Tap to flip">
            #${i + 1} ${win ? '✓' : '✗'}
          </button>
        `;
      } else if (i === logged) {
        slotsHtml += `<div class="student-try-slot next-up">#${i + 1}</div>`;
      } else {
        slotsHtml += `<div class="student-try-slot">#${i + 1}</div>`;
      }
    }

    const syncLabel = syncState === 'saving'
      ? 'Saving...'
      : (syncState === 'error' ? '⚠️ Save error — retry' : '✓ Progress saved');
    const syncCls = `save-sync-indicator ${syncState === 'saving' ? 'saving' : (syncState === 'error' ? 'error' : '')}`;

    const hasNextDrill = activeStudentDrillIdx < studentAssignment.drills.length - 1;
    const nextDrillCta = (isComplete && hasNextDrill)
      ? `<button type="button" class="ctrl-btn cta-next" style="width:100%; justify-content:center;" onclick="window.selectStudentDrill(${activeStudentDrillIdx + 1})">Continue to Drill ${activeStudentDrillIdx + 2} ▶</button>`
      : '';

    // Preserve active textarea focus/value if user is currently typing
    const existingTextarea = document.getElementById('studentDrillNoteInput');
    const noteFocused = existingTextarea && document.activeElement === existingTextarea;
    const currentNoteVal = noteFocused ? existingTextarea.value : (drill.studentNote || '');

    if (noteFocused) {
      // Update everything except the focused textarea so cursor never jumps!
      const bannerEl = document.getElementById('stuBannerBox');
      if (bannerEl) {
        bannerEl.className = bannerCls;
        bannerEl.innerHTML = `<div class="student-target-headline">${escapeHtml(bannerHeadline)}</div><div class="student-target-sub">${escapeHtml(bannerSub)}</div>`;
      }
      const syncEl = document.getElementById('stuSyncIndicator');
      if (syncEl) {
        syncEl.className = syncCls;
        syncEl.textContent = syncLabel;
      }
      return;
    }

    panel.innerHTML = `
      <div class="${bannerCls}" id="stuBannerBox">
        <div class="student-target-headline">${escapeHtml(bannerHeadline)}</div>
        <div class="student-target-sub">${escapeHtml(bannerSub)}</div>
      </div>

      <div class="tap-record-buttons">
        <button type="button" class="tap-attempt-btn btn-make" onclick="window.recordStudentAttempt(true)" ${isComplete ? 'disabled' : ''}>
          ✓ Success
        </button>
        <button type="button" class="tap-attempt-btn btn-miss" onclick="window.recordStudentAttempt(false)" ${isComplete ? 'disabled' : ''}>
          ✗ Miss
        </button>
      </div>

      <div class="student-attempts-grid" id="studentAttemptsGrid">
        ${slotsHtml}
      </div>

      <div class="attempt-tools-row">
        <button type="button" class="undo-attempt-btn" onclick="window.undoLastStudentAttempt()" ${logged === 0 ? 'disabled' : ''}>
          ↶ Undo Last
        </button>
        <span class="attempt-hint-text">Tap any logged slot to flip ✓/✗</span>
      </div>

      <div class="student-note-wrap">
        <div class="student-note-label-row">
          <label for="studentDrillNoteInput">Note for Instructor (optional)</label>
          <span class="${syncCls}" id="stuSyncIndicator">${syncLabel}</span>
        </div>
        <textarea id="studentDrillNoteInput" class="student-note-textarea"
          placeholder="How did this drill feel? Any speed or spin adjustments?"
          oninput="window.onStudentNoteInput(this.value)"
          onblur="window.flushStudentNoteSave()">${escapeHtml(currentNoteVal)}</textarea>
      </div>

      ${nextDrillCta}
    `;
  }

  function recomputeLocalDrillStats(drill) {
    drill.attemptsLogged = drill.attempts.length;
    drill.successes = drill.attempts.filter(Boolean).length;
    drill.isComplete = drill.attemptsLogged >= drill.targetAttempts;
    drill.targetMet = drill.isComplete ? drill.successes >= drill.targetSuccesses : null;
  }

  async function persistStudentDrill(drill, payload) {
    renderStudentAttemptPanel('saving');
    try {
      const res = await apiFetch(
        `/api/student/assignments/${encodeURIComponent(studentToken)}/drills/${encodeURIComponent(drill.id)}`,
        { method: 'PUT', body: payload }
      );
      if (res?.drill) {
        Object.assign(drill, res.drill);
      }
      if (res?.summary) {
        studentAssignment.summary = res.summary;
      }
      renderStudentHeader();
      renderStudentAttemptPanel('saved');
    } catch (err) {
      renderStudentAttemptPanel('error');
      showToast(err.message || 'Could not save progress');
    }
  }

  window.selectStudentDrill = selectStudentDrill;

  window.recordStudentAttempt = function (isSuccess) {
    if (!studentAssignment) return;
    const drill = studentAssignment.drills[activeStudentDrillIdx];
    if (!drill || drill.attempts.length >= drill.targetAttempts) return;
    drill.attempts = [...drill.attempts, Boolean(isSuccess)];
    recomputeLocalDrillStats(drill);
    renderStudentHeader();
    persistStudentDrill(drill, { attempts: drill.attempts });
  };

  window.flipStudentAttempt = function (attemptIdx) {
    if (!studentAssignment) return;
    const drill = studentAssignment.drills[activeStudentDrillIdx];
    if (!drill || attemptIdx < 0 || attemptIdx >= drill.attempts.length) return;
    const updated = [...drill.attempts];
    updated[attemptIdx] = !updated[attemptIdx];
    drill.attempts = updated;
    recomputeLocalDrillStats(drill);
    renderStudentHeader();
    persistStudentDrill(drill, { attempts: drill.attempts });
  };

  window.undoLastStudentAttempt = function () {
    if (!studentAssignment) return;
    const drill = studentAssignment.drills[activeStudentDrillIdx];
    if (!drill || drill.attempts.length === 0) return;
    drill.attempts = drill.attempts.slice(0, -1);
    recomputeLocalDrillStats(drill);
    renderStudentHeader();
    persistStudentDrill(drill, { attempts: drill.attempts });
  };

  window.onStudentNoteInput = function (val) {
    if (!studentAssignment) return;
    const drill = studentAssignment.drills[activeStudentDrillIdx];
    if (!drill) return;
    drill.studentNote = val;
    const syncEl = document.getElementById('stuSyncIndicator');
    if (syncEl) {
      syncEl.className = 'save-sync-indicator saving';
      syncEl.textContent = 'Saving...';
    }
    clearTimeout(noteDebounceTimer);
    noteDebounceTimer = setTimeout(() => {
      noteDebounceTimer = null;
      persistStudentDrill(drill, { studentNote: drill.studentNote });
    }, 400);
  };

  window.flushStudentNoteSave = function () {
    if (!noteDebounceTimer || !studentAssignment) return;
    clearTimeout(noteDebounceTimer);
    noteDebounceTimer = null;
    const drill = studentAssignment.drills[activeStudentDrillIdx];
    if (drill) persistStudentDrill(drill, { studentNote: drill.studentNote });
  };

  // ==================== INSTRUCTOR AUTH & PRACTICE PLANNER ====================
  async function syncInstructorAuthStatus() {
    instructorState.token = getSavedInstructorToken();
    try {
      const status = await apiFetch('/api/instructor/auth/status', { instructorAuth: true });
      instructorState.serverReachable = true;
      instructorState.configured = Boolean(status.configured);
      instructorState.authenticated = Boolean(status.authenticated);
      if (!instructorState.authenticated && instructorState.token) {
        saveInstructorToken(null);
      }
    } catch (err) {
      instructorState.serverReachable = false;
      instructorState.authenticated = false;
    }
  }

  async function refreshInstructorData() {
    const [plansRes, assignsRes, customRes] = await Promise.all([
      apiFetch('/api/instructor/plans', { instructorAuth: true }),
      apiFetch('/api/instructor/assignments', { instructorAuth: true }),
      apiFetch('/api/instructor/custom-drills', { instructorAuth: true })
    ]);
    instructorState.plans = plansRes.plans || [];
    instructorState.assignments = assignsRes.assignments || [];
    instructorState.customDrills = customRes.customDrills || [];

    if (!instructorState.picker.customDrillId && instructorState.customDrills.length > 0) {
      instructorState.picker.customDrillId = instructorState.customDrills[0].id;
    }

    if (!instructorState.editor.planId && instructorState.editor.drills.length === 0 && !instructorState.editor.dirty && instructorState.plans.length > 0) {
      loadPlanIntoEditor(instructorState.plans[0]);
    }

    if (!instructorState.selectedAssignmentId && instructorState.assignments.length > 0) {
      instructorState.selectedAssignmentId = instructorState.assignments[0].id;
    } else if (
      instructorState.selectedAssignmentId &&
      !instructorState.assignments.some(a => a.id === instructorState.selectedAssignmentId)
    ) {
      instructorState.selectedAssignmentId = instructorState.assignments[0]?.id || null;
    }
  }

  function startNewPlanDraft() {
    instructorState.editor = {
      planId: null,
      name: '',
      description: '',
      drills: [],
      dirty: false
    };
  }

  function loadPlanIntoEditor(plan) {
    instructorState.editor = {
      planId: plan.id,
      name: plan.name,
      description: plan.description || '',
      drills: plan.drills.map(d => ({
        localKey: d.id || `k_${Math.random().toString(36).slice(2)}`,
        drillType: d.drillType,
        sourceRef: JSON.parse(JSON.stringify(d.sourceRef)),
        title: d.title,
        targetAttempts: d.targetAttempts,
        targetSuccesses: d.targetSuccesses,
        coachNote: d.coachNote || '',
        fallbackLayout: JSON.parse(JSON.stringify(d.layout))
      })),
      dirty: false
    };
  }

  window.openPracticePlannerTab = async function (btnEl) {
    if (isStudentMode) return;
    stopAutoPlay();
    cancelAnim();

    activeSnapshotOverride = null;
    sandboxLocked = false;
    activeHudContext = null;
    instructorState.previewReturnActive = false;
    currentGame = 'planner';

    document.querySelectorAll('#gameTabs button').forEach(b => b.classList.remove('active'));
    const tabBtn = btnEl || document.getElementById('plannerTabBtn');
    if (tabBtn) tabBtn.classList.add('active');

    document.getElementById('brandIcon').textContent = '📋';
    document.getElementById('rackNavBox').style.display = 'none';
    document.getElementById('snapshotPreviewBanner').classList.remove('visible');
    document.getElementById('arenaTableStage').style.display = 'none';
    document.getElementById('arenaBentoGrid').style.display = 'none';

    const ws = document.getElementById('plannerWorkspace');
    ws.classList.add('visible');

    await syncInstructorAuthStatus();
    if (instructorState.authenticated) {
      try {
        await refreshInstructorData();
      } catch (e) {
        showToast(e.message || 'Failed to load Practice Planner data');
      }
    }
    renderPlannerWorkspace();
  };

  window.exitSnapshotTablePreview = function () {
    if (isStudentMode) return;
    window.openPracticePlannerTab(document.getElementById('plannerTabBtn'));
  };

  function previewSnapshotFromPlanner(snapshot, labelTitle, coachNote) {
    if (!snapshot) {
      showToast('Drill layout unavailable for preview');
      return;
    }
    instructorState.previewReturnActive = true;
    const banner = document.getElementById('snapshotPreviewBanner');
    document.getElementById('previewBannerKicker').textContent = 'INSTRUCTOR DRILL PREVIEW';
    document.getElementById('previewBannerTitle').textContent = labelTitle || snapshot.title || 'Drill Layout';
    banner.classList.add('visible');

    applySnapshotToArena(snapshot, {
      mode: 'preview',
      locked: true,
      kicker: 'INSTRUCTOR LAYOUT PREVIEW',
      title: labelTitle || snapshot.title,
      coachNote: coachNote || ''
    });
  }

  function renderPlannerWorkspace() {
    const ws = document.getElementById('plannerWorkspace');
    if (!ws || currentGame !== 'planner') return;

    if (!instructorState.serverReachable) {
      ws.innerHTML = `
        <div class="auth-gate-card">
          <h3>Start Local CueLab Server</h3>
          <p>Practice Planner shares assignments and syncs student results through the built-in Node + SQLite server.</p>
          <div class="share-url-code">cd app &amp;&amp; npm start</div>
          <p>Then open <strong>http://localhost:3000</strong> in your browser.</p>
          <button class="ctrl-btn cta-next" style="justify-content:center;" onclick="window.openPracticePlannerTab()">↻ Retry Connection</button>
        </div>
      `;
      return;
    }

    if (!instructorState.authenticated) {
      const isSetup = !instructorState.configured;
      ws.innerHTML = `
        <form class="auth-gate-card" onsubmit="window.submitInstructorAuth(event)">
          <div class="shot-kicker">${isSetup ? 'FIRST-TIME SETUP' : 'INSTRUCTOR ACCESS'}</div>
          <h3>${isSetup ? 'Set Instructor Passcode' : 'Unlock Practice Planner'}</h3>
          <p>${
            isSetup
              ? 'Create an instructor passcode to protect your practice plans and student results. Students never need a passcode to open their individual assignment links.'
              : 'Enter your instructor passcode to manage practice plans, generate student links, and review student results.'
          }</p>
          <div class="field-group">
            <label class="field-label" for="instPasscodeInput">${isSetup ? 'New Passcode (4+ characters)' : 'Instructor Passcode'}</label>
            <input id="instPasscodeInput" type="password" class="planner-input" placeholder="Enter passcode..." required minlength="4" autocomplete="current-password">
          </div>
          <div id="instAuthError" style="color:var(--accent-rose); font-size:0.82rem; font-weight:700; display:none;"></div>
          <button type="submit" class="ctrl-btn cta-next" style="justify-content:center;">
            ${isSetup ? '🔐 Save Passcode & Open Planner' : '🔓 Unlock Practice Planner'}
          </button>
        </form>
      `;
      setTimeout(() => document.getElementById('instPasscodeInput')?.focus(), 30);
      return;
    }

    ws.innerHTML = `
      <div class="planner-topbar">
        <div class="planner-topbar-left">
          <h2>📋 Instructor Practice Planner</h2>
          <p>Build ordered drill plans, share isolated student links, and review results before the next lesson.</p>
        </div>
        <div class="planner-topbar-actions">
          <div class="planner-subtabs">
            <button type="button" class="${instructorState.subtab === 'plans' ? 'active' : ''}" onclick="window.setPlannerSubtab('plans')">
              Practice Plans (${instructorState.plans.length})
            </button>
            <button type="button" class="${instructorState.subtab === 'assignments' ? 'active' : ''}" onclick="window.setPlannerSubtab('assignments')">
              Student Assignments (${instructorState.assignments.length})
            </button>
          </div>
          <button type="button" class="utility-btn" onclick="window.refreshPlannerNow()" title="Refresh student progress">↻ Refresh</button>
          <button type="button" class="utility-btn" onclick="window.logoutInstructor()" title="Lock Instructor Planner">🔒 Lock</button>
        </div>
      </div>

      ${instructorState.subtab === 'plans' ? renderPlansSubtabHtml() : renderAssignmentsSubtabHtml()}
    `;
  }

  function renderPlansSubtabHtml() {
    const plansListHtml = instructorState.plans.length === 0
      ? `<div class="empty-state-box">No practice plans saved yet.<br>Build your first plan on the right!</div>`
      : instructorState.plans.map(p => {
          const isSel = instructorState.editor.planId === p.id;
          return `
            <div class="list-item-card ${isSel ? 'selected' : ''}" onclick="window.selectPlanForEditing('${escapeHtml(p.id)}')">
              <div class="list-item-title">${escapeHtml(p.name)}</div>
              <div class="list-item-meta">
                <span>${p.drills.length} drill${p.drills.length === 1 ? '' : 's'}</span>
                <span>${p.assignmentCount} student${p.assignmentCount === 1 ? '' : 's'} assigned</span>
              </div>
            </div>
          `;
        }).join('');

    const ed = instructorState.editor;
    const pk = instructorState.picker;
    const { game, subset } = parseGameKey(pk.gameKey);
    const rData = PUZZLE_DATA.games?.[game]?.racks?.[pk.rackNum];
    const strokes = rData
      ? (game === '8ball' ? (subset === 'stripes' ? rData.stripesStrokes : rData.solidsStrokes) : rData.strokes)
      : [];
    if (pk.strokeNum > strokes.length) pk.strokeNum = 1;

    let pickerFieldsHtml = '';
    if (pk.sourceType === 'rack_shot' || pk.sourceType === 'rack') {
      let rackOpts = '';
      for (let r = 1; r <= 25; r++) {
        rackOpts += `<option value="${r}" ${Number(pk.rackNum) === r ? 'selected' : ''}>Rack ${r}</option>`;
      }
      let strokeField = '';
      if (pk.sourceType === 'rack_shot') {
        const strokeOpts = strokes.map((s, idx) => {
          const sNum = idx + 1;
          const lv = s.leave && s.leave !== 'Rack over' ? ` → Zone ${s.leave}` : '';
          return `<option value="${sNum}" ${Number(pk.strokeNum) === sNum ? 'selected' : ''}>Shot ${sNum}: #${s.ball}-Ball → ${s.pocket}${lv}</option>`;
        }).join('');
        strokeField = `
          <div class="field-group">
            <label class="field-label">Shot &amp; Leave Zone</label>
            <select class="planner-select" onchange="window.updatePickerField('strokeNum', parseInt(this.value, 10))">${strokeOpts}</select>
          </div>
        `;
      }
      pickerFieldsHtml = `
        <div class="picker-controls-grid">
          <div class="field-group">
            <label class="field-label">Discipline</label>
            <select class="planner-select" onchange="window.updatePickerField('gameKey', this.value)">
              <option value="9ball_rot" ${pk.gameKey === '9ball_rot' ? 'selected' : ''}>9-Ball</option>
              <option value="10ball_rot" ${pk.gameKey === '10ball_rot' ? 'selected' : ''}>10-Ball</option>
              <option value="8ball_solids" ${pk.gameKey === '8ball_solids' ? 'selected' : ''}>8-Ball Solids</option>
              <option value="8ball_stripes" ${pk.gameKey === '8ball_stripes' ? 'selected' : ''}>8-Ball Stripes</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Pattern Rack</label>
            <select class="planner-select" onchange="window.updatePickerField('rackNum', parseInt(this.value, 10))">${rackOpts}</select>
          </div>
          ${strokeField}
        </div>
      `;
    } else {
      if (instructorState.customDrills.length === 0) {
        pickerFieldsHtml = `
          <div class="empty-state-box" style="padding:14px;">
            No saved Spin Lab custom drills yet. Open <strong>🧪 Spin Lab</strong> to position balls &amp; a target zone, then click <strong>💾 Save Drill</strong>!
            <div style="margin-top:10px;">
              <button type="button" class="ctrl-btn" style="margin:0 auto;" onclick="document.getElementById('spinLabTabBtn').click()">🧪 Open Spin Lab</button>
            </div>
          </div>
        `;
      } else {
        const cdOpts = instructorState.customDrills.map(cd => {
          const tz = cd.layout?.targetZone?.enabled ? ` · Zone ${cd.layout.targetZone.coord}` : '';
          return `<option value="${escapeHtml(cd.id)}" ${pk.customDrillId === cd.id ? 'selected' : ''}>${escapeHtml(cd.title)} (${cd.layout?.pocket || 'P3'}${tz})</option>`;
        }).join('');
        pickerFieldsHtml = `
          <div class="picker-controls-grid">
            <div class="field-group">
              <label class="field-label">Saved Spin Lab Custom Drill</label>
              <select class="planner-select" onchange="window.updatePickerField('customDrillId', this.value)">${cdOpts}</select>
            </div>
            <div style="display:flex; gap:8px;">
              <button type="button" class="ctrl-btn" onclick="document.getElementById('spinLabTabBtn').click()">🧪 New in Spin Lab</button>
            </div>
          </div>
        `;
      }
    }

    const canAddPicked = pk.sourceType !== 'custom_drill' || instructorState.customDrills.length > 0;

    const drillsStackHtml = ed.drills.length === 0
      ? `<div class="empty-state-box">No drills in this plan yet. Choose a drill above and click <strong>+ Add Drill to Plan</strong>.</div>`
      : ed.drills.map((d, idx) => {
          const typeLabel = d.drillType === 'rack_shot'
            ? 'Single Shot'
            : (d.drillType === 'rack' ? 'Full Rack' : 'Spin Lab Drill');
          return `
            <div class="plan-drill-card">
              <div class="plan-drill-header">
                <div class="plan-drill-order-group">
                  <span class="drill-order-badge">${idx + 1}</span>
                  <input type="text" class="planner-input" value="${escapeHtml(d.title)}"
                    placeholder="Drill title..."
                    oninput="window.updatePlanDrillField(${idx}, 'title', this.value)">
                  <span class="drill-type-pill">${typeLabel}</span>
                </div>
                <div class="drill-card-btns">
                  <button type="button" class="mini-action-btn" onclick="window.previewPlanDrill(${idx})" title="Preview table layout">👁 Preview</button>
                  <button type="button" class="mini-action-btn" onclick="window.movePlanDrill(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move Up">↑</button>
                  <button type="button" class="mini-action-btn" onclick="window.movePlanDrill(${idx}, 1)" ${idx === ed.drills.length - 1 ? 'disabled' : ''} title="Move Down">↓</button>
                  <button type="button" class="mini-action-btn danger" onclick="window.removePlanDrill(${idx})" title="Remove Drill">✕</button>
                </div>
              </div>

              <div class="target-config-row">
                <span style="font-size:0.82rem; font-weight:700; color:var(--text-secondary);">Target:</span>
                <input type="number" min="1" max="50" class="target-num-input"
                  value="${d.targetSuccesses}"
                  onchange="window.updatePlanDrillTarget(${idx}, 'targetSuccesses', this.value)">
                <span style="font-size:0.82rem; font-weight:700; color:var(--text-secondary);">successful out of</span>
                <input type="number" min="1" max="50" class="target-num-input"
                  value="${d.targetAttempts}"
                  onchange="window.updatePlanDrillTarget(${idx}, 'targetAttempts', this.value)">
                <span style="font-size:0.82rem; font-weight:700; color:var(--text-secondary);">attempts</span>
                <span class="target-summary-caption" id="targetCap_${idx}">
                  Goal: ${d.targetSuccesses} of ${d.targetAttempts} (${Math.round((d.targetSuccesses / Math.max(1, d.targetAttempts)) * 100)}%)
                </span>
              </div>

              <div class="field-group">
                <label class="field-label">Coaching Note (optional)</label>
                <textarea class="planner-textarea" placeholder="e.g., Land the cue ball in the marked zone on 7 out of 10 attempts..."
                  oninput="window.updatePlanDrillField(${idx}, 'coachNote', this.value)">${escapeHtml(d.coachNote)}</textarea>
              </div>
            </div>
          `;
        }).join('');

    return `
      <div class="planner-split">
        <aside class="planner-sidebar-card">
          <div class="sidebar-header-row">
            <h3>Saved Plans</h3>
            <button type="button" class="ctrl-btn cta-next" style="padding:6px 12px; font-size:0.78rem;" onclick="window.createNewPlanClick()">+ New Plan</button>
          </div>
          <div class="plan-list-items">${plansListHtml}</div>
        </aside>

        <div class="planner-detail-card">
          <div class="shot-top-row">
            <div>
              <div class="shot-kicker">${ed.planId ? 'EDITING PRACTICE PLAN' : 'NEW PRACTICE PLAN'}</div>
              <h3 style="font-size:1.2rem; font-weight:800; color:#fff;">${ed.planId ? escapeHtml(ed.name || 'Untitled Plan') : 'Create Practice Plan'}</h3>
            </div>
            ${
              ed.planId
                ? `<button type="button" class="ctrl-btn cta-next" onclick="window.openAssignModal('${escapeHtml(ed.planId)}')">🔗 Share with Student</button>`
                : ''
            }
          </div>

          <div class="picker-controls-grid">
            <div class="field-group">
              <label class="field-label" for="planNameInput">Practice Plan Name</label>
              <input id="planNameInput" type="text" class="planner-input" placeholder="e.g., Lesson 4 — Position Control &amp; 9-Ball Runout"
                value="${escapeHtml(ed.name)}"
                oninput="window.updatePlanHeaderField('name', this.value)">
            </div>
            <div class="field-group">
              <label class="field-label" for="planDescInput">Plan Summary / Focus (optional)</label>
              <input id="planDescInput" type="text" class="planner-input" placeholder="e.g., Focus on pre-shot routine and cue ball speed..."
                value="${escapeHtml(ed.description)}"
                oninput="window.updatePlanHeaderField('description', this.value)">
            </div>
          </div>

          <div class="drill-picker-box">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
              <span class="field-label" style="color:var(--accent-cyan);">Add Existing Drill or Layout</span>
              <div class="picker-source-tabs">
                <button type="button" class="picker-src-btn ${pk.sourceType === 'rack_shot' ? 'active' : ''}" onclick="window.setPickerSourceType('rack_shot')">🎯 Single Rack Shot</button>
                <button type="button" class="picker-src-btn ${pk.sourceType === 'rack' ? 'active' : ''}" onclick="window.setPickerSourceType('rack')">🎱 Full Pattern Rack</button>
                <button type="button" class="picker-src-btn ${pk.sourceType === 'custom_drill' ? 'active' : ''}" onclick="window.setPickerSourceType('custom_drill')">🧪 Saved Spin Lab Drill</button>
              </div>
            </div>

            ${pickerFieldsHtml}

            <div class="picker-actions-row">
              <button type="button" class="ctrl-btn" onclick="window.previewCurrentlyPickedDrill()" ${!canAddPicked ? 'disabled' : ''}>👁 Preview on Table</button>
              <button type="button" class="ctrl-btn cta-next" onclick="window.addPickedDrillToPlan()" ${!canAddPicked ? 'disabled' : ''}>+ Add Drill to Plan</button>
            </div>
          </div>

          <div class="field-group">
            <label class="field-label">Practice Order (${ed.drills.length} Drill${ed.drills.length === 1 ? '' : 's'})</label>
            <div class="plan-drills-stack">${drillsStackHtml}</div>
          </div>

          <div class="plan-editor-footer">
            <div>
              ${
                ed.planId
                  ? `<button type="button" class="mini-action-btn danger" style="padding:8px 13px;" onclick="window.deleteCurrentPlan()">🗑 Delete Plan</button>`
                  : ''
              }
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button type="button" class="ctrl-btn cta-next" onclick="window.savePracticePlan()">
                💾 ${ed.planId ? 'Save Plan Changes' : 'Save Practice Plan'}
              </button>
              ${
                ed.planId
                  ? `<button type="button" class="ctrl-btn" onclick="window.openAssignModal('${escapeHtml(ed.planId)}')">🔗 Assign &amp; Copy Student Link</button>`
                  : ''
              }
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function formatStatusBadge(summary) {
    if (!summary || summary.status === 'not_started') {
      return `<span class="review-badge idle">Not Started</span>`;
    }
    if (summary.status === 'completed') {
      const allMet = summary.targetsMet === summary.totalDrills;
      return `<span class="review-badge ${allMet ? 'met' : 'progress'}">Completed · ${summary.targetsMet}/${summary.totalDrills} Met</span>`;
    }
    return `<span class="review-badge progress">In Progress (${summary.completedDrills}/${summary.totalDrills})</span>`;
  }

  function renderAssignmentsSubtabHtml() {
    const filtered = instructorState.assignmentPlanFilter
      ? instructorState.assignments.filter(a => a.planId === instructorState.assignmentPlanFilter)
      : instructorState.assignments;

    const selected = filtered.find(a => a.id === instructorState.selectedAssignmentId) || filtered[0] || null;
    if (selected && selected.id !== instructorState.selectedAssignmentId) {
      instructorState.selectedAssignmentId = selected.id;
    }

    const planFilterOpts = `<option value="">All Plans (${instructorState.assignments.length})</option>` +
      instructorState.plans.map(p =>
        `<option value="${escapeHtml(p.id)}" ${instructorState.assignmentPlanFilter === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      ).join('');

    const sidebarItemsHtml = filtered.length === 0
      ? `<div class="empty-state-box">No student assignments yet.<br>Share a Practice Plan with a student to create an assignment link.</div>`
      : filtered.map(a => `
          <div class="list-item-card ${selected && selected.id === a.id ? 'selected' : ''}" onclick="window.selectAssignmentForReview('${escapeHtml(a.id)}')">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
              <span class="list-item-title">${escapeHtml(a.studentName)}</span>
              ${formatStatusBadge(a.summary)}
            </div>
            <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">${escapeHtml(a.planName)}</div>
            <div class="list-item-meta">
              <span>Attempts: ${a.summary.totalAttemptsLogged} / ${a.summary.totalTargetAttempts}</span>
              <span>Targets Met: ${a.summary.targetsMet} / ${a.summary.totalDrills}</span>
            </div>
          </div>
        `).join('');

    let detailHtml = '';
    if (!selected) {
      detailHtml = `
        <div class="empty-state-box" style="padding:48px 20px;">
          Select a student assignment on the left, or click <strong>+ Assign Plan to Student</strong> to generate a unique practice link.
        </div>
      `;
    } else {
      const fullShareUrl = `${window.location.origin}${selected.sharePath}`;
      const drillsReviewHtml = selected.drills.map((d, idx) => {
        let badgeHtml = `<span class="review-badge idle">Not Started · 0 of ${d.targetAttempts} (Target ${d.targetSuccesses})</span>`;
        if (d.isComplete) {
          badgeHtml = d.targetMet
            ? `<span class="review-badge met">✓ Target Met · ${d.successes} of ${d.targetAttempts} successful (Target ${d.targetSuccesses})</span>`
            : `<span class="review-badge missed">✗ Target Not Met · ${d.successes} of ${d.targetAttempts} successful (Target ${d.targetSuccesses})</span>`;
        } else if (d.attemptsLogged > 0) {
          badgeHtml = `<span class="review-badge progress">In Progress · ${d.successes} of ${d.attemptsLogged} successful (${d.attemptsLogged}/${d.targetAttempts} logged · Target ${d.targetSuccesses})</span>`;
        }

        const attemptPills = d.attempts.length === 0
          ? `<span style="font-size:0.78rem; color:var(--text-muted);">No attempts recorded yet.</span>`
          : d.attempts.map((win, aIdx) =>
              `<span class="rev-try-pill ${win ? 'win' : 'miss'}">#${aIdx + 1} ${win ? '✓' : '✗'}</span>`
            ).join('');

        return `
          <div class="review-drill-card">
            <div class="plan-drill-header">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span class="drill-order-badge">${idx + 1}</span>
                <strong style="font-size:1rem; color:#fff;">${escapeHtml(d.title)}</strong>
              </div>
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                ${badgeHtml}
                <button type="button" class="mini-action-btn" onclick="window.previewAssignedDrill('${escapeHtml(selected.id)}', ${idx})">👁 View Layout</button>
              </div>
            </div>

            ${d.coachNote ? `<div style="font-size:0.82rem; color:var(--text-secondary);"><strong>Assigned Note:</strong> ${escapeHtml(d.coachNote)}</div>` : ''}

            <div class="review-attempt-pills">${attemptPills}</div>

            ${
              d.studentNote && d.studentNote.trim()
                ? `<div class="student-note-display"><strong>Student Note:</strong> ${escapeHtml(d.studentNote)}</div>`
                : `<div style="font-size:0.78rem; color:var(--text-muted);">Student note: None</div>`
            }
          </div>
        `;
      }).join('');

      detailHtml = `
        <div class="shot-top-row">
          <div>
            <div class="shot-kicker">STUDENT ASSIGNMENT REVIEW</div>
            <h3 style="font-size:1.3rem; font-weight:800; color:#fff;">${escapeHtml(selected.studentName)} — ${escapeHtml(selected.planName)}</h3>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:3px;">
              Assigned ${new Date(selected.createdAt).toLocaleString()} · Last updated ${new Date(selected.updatedAt).toLocaleString()}
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${formatStatusBadge(selected.summary)}
            <button type="button" class="mini-action-btn danger" onclick="window.deleteAssignment('${escapeHtml(selected.id)}')">🗑 Delete</button>
          </div>
        </div>

        <div class="share-link-callout">
          <div style="display:flex; flex-direction:column; gap:3px;">
            <span style="font-size:0.74rem; font-weight:800; text-transform:uppercase; color:#6ee7b7;">Dedicated Student Link (${escapeHtml(selected.studentName)} only)</span>
            <span style="font-size:0.78rem; color:var(--text-secondary);">Scoped strictly to this assignment's frozen drill layouts &amp; progress.</span>
          </div>
          <code class="share-url-code selectable-text">${escapeHtml(fullShareUrl)}</code>
          <button type="button" class="ctrl-btn cta-next" onclick="window.copyShareLink('${escapeHtml(fullShareUrl)}')">📋 Copy Link</button>
        </div>

        <div class="plan-drills-stack">
          ${drillsReviewHtml}
        </div>
      `;
    }

    return `
      <div class="planner-split">
        <aside class="planner-sidebar-card">
          <div class="sidebar-header-row">
            <h3>Assignments</h3>
            <button type="button" class="ctrl-btn cta-next" style="padding:6px 11px; font-size:0.78rem;"
              onclick="window.openAssignModal()" ${instructorState.plans.length === 0 ? 'disabled' : ''}>+ Assign Plan</button>
          </div>
          <select class="planner-select" onchange="window.setAssignmentPlanFilter(this.value)">
            ${planFilterOpts}
          </select>
          <div class="assign-list-items">${sidebarItemsHtml}</div>
        </aside>

        <div class="planner-detail-card">
          ${detailHtml}
        </div>
      </div>
    `;
  }

  // ==================== INSTRUCTOR EVENT HANDLERS ====================
  window.submitInstructorAuth = async function (e) {
    e.preventDefault();
    const input = document.getElementById('instPasscodeInput');
    const errEl = document.getElementById('instAuthError');
    const passcode = input ? input.value.trim() : '';
    if (!passcode) return;

    try {
      const endpoint = instructorState.configured ? '/api/instructor/auth/login' : '/api/instructor/auth/setup';
      const res = await apiFetch(endpoint, { method: 'POST', body: { passcode } });
      saveInstructorToken(res.token);
      instructorState.configured = true;
      instructorState.authenticated = true;
      await refreshInstructorData();
      renderPlannerWorkspace();
      showToast('Practice Planner unlocked');
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Authentication failed';
        errEl.style.display = 'block';
      }
    }
  };

  window.logoutInstructor = async function () {
    try {
      await apiFetch('/api/instructor/auth/logout', { method: 'POST', instructorAuth: true });
    } catch (e) {}
    saveInstructorToken(null);
    instructorState.authenticated = false;
    renderPlannerWorkspace();
    showToast('Practice Planner locked');
  };

  window.setPlannerSubtab = async function (tab) {
    instructorState.subtab = tab;
    if (tab === 'assignments' && instructorState.authenticated) {
      try {
        const res = await apiFetch('/api/instructor/assignments', { instructorAuth: true });
        instructorState.assignments = res.assignments || [];
      } catch (e) {}
    }
    renderPlannerWorkspace();
  };

  window.refreshPlannerNow = async function () {
    if (!instructorState.authenticated) return;
    try {
      await refreshInstructorData();
      renderPlannerWorkspace();
      showToast('Refreshed latest student results');
    } catch (err) {
      showToast(err.message || 'Refresh failed');
    }
  };

  window.createNewPlanClick = function () {
    startNewPlanDraft();
    renderPlannerWorkspace();
    setTimeout(() => document.getElementById('planNameInput')?.focus(), 20);
  };

  window.selectPlanForEditing = function (planId) {
    const plan = instructorState.plans.find(p => p.id === planId);
    if (!plan) return;
    loadPlanIntoEditor(plan);
    renderPlannerWorkspace();
  };

  window.updatePlanHeaderField = function (field, val) {
    instructorState.editor[field] = val;
    instructorState.editor.dirty = true;
  };

  window.setPickerSourceType = function (srcType) {
    instructorState.picker.sourceType = srcType;
    if (srcType === 'custom_drill' && !instructorState.picker.customDrillId && instructorState.customDrills[0]) {
      instructorState.picker.customDrillId = instructorState.customDrills[0].id;
    }
    renderPlannerWorkspace();
  };

  window.updatePickerField = function (field, val) {
    instructorState.picker[field] = val;
    if (field === 'gameKey' || field === 'rackNum') {
      instructorState.picker.strokeNum = 1;
    }
    renderPlannerWorkspace();
  };

  function getCurrentPickerSpec() {
    const pk = instructorState.picker;
    if (pk.sourceType === 'custom_drill') {
      return {
        drillType: 'custom_drill',
        sourceRef: { customDrillId: pk.customDrillId }
      };
    }
    const { game, subset } = parseGameKey(pk.gameKey);
    if (pk.sourceType === 'rack') {
      return {
        drillType: 'rack',
        sourceRef: { game, subset, rackNum: Number(pk.rackNum) }
      };
    }
    return {
      drillType: 'rack_shot',
      sourceRef: { game, subset, rackNum: Number(pk.rackNum), strokeNum: Number(pk.strokeNum) }
    };
  }

  window.previewCurrentlyPickedDrill = function () {
    const spec = getCurrentPickerSpec();
    const built = buildClientSnapshotFromSource(spec.drillType, spec.sourceRef);
    if (!built) {
      showToast('Select a valid drill first');
      return;
    }
    previewSnapshotFromPlanner(built.layout, built.defaultTitle, built.defaultCoachNote);
  };

  window.addPickedDrillToPlan = function () {
    const spec = getCurrentPickerSpec();
    const built = buildClientSnapshotFromSource(spec.drillType, spec.sourceRef);
    if (!built) {
      showToast('Could not add drill');
      return;
    }
    const defaultAttempts = spec.drillType === 'rack' ? 5 : 10;
    const defaultSuccesses = spec.drillType === 'rack' ? 2 : 7;

    instructorState.editor.drills.push({
      localKey: `k_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      drillType: spec.drillType,
      sourceRef: spec.sourceRef,
      title: built.defaultTitle,
      targetAttempts: defaultAttempts,
      targetSuccesses: defaultSuccesses,
      coachNote: built.defaultCoachNote,
      fallbackLayout: built.layout
    });
    instructorState.editor.dirty = true;
    renderPlannerWorkspace();
    showToast(`Added "${built.defaultTitle}"`);
  };

  window.updatePlanDrillField = function (idx, field, val) {
    const d = instructorState.editor.drills[idx];
    if (!d) return;
    d[field] = val;
    instructorState.editor.dirty = true;
  };

  window.updatePlanDrillTarget = function (idx, field, rawVal) {
    const d = instructorState.editor.drills[idx];
    if (!d) return;
    let num = Math.max(1, Math.min(50, parseInt(rawVal, 10) || 1));
    d[field] = num;
    if (field === 'targetAttempts' && d.targetSuccesses > d.targetAttempts) {
      d.targetSuccesses = d.targetAttempts;
    } else if (field === 'targetSuccesses' && d.targetSuccesses > d.targetAttempts) {
      d.targetAttempts = d.targetSuccesses;
    }
    instructorState.editor.dirty = true;
    renderPlannerWorkspace();
  };

  window.movePlanDrill = function (idx, delta) {
    const arr = instructorState.editor.drills;
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= arr.length) return;
    const tmp = arr[idx];
    arr[idx] = arr[nextIdx];
    arr[nextIdx] = tmp;
    instructorState.editor.dirty = true;
    renderPlannerWorkspace();
  };

  window.removePlanDrill = function (idx) {
    instructorState.editor.drills.splice(idx, 1);
    instructorState.editor.dirty = true;
    renderPlannerWorkspace();
  };

  window.previewPlanDrill = function (idx) {
    const d = instructorState.editor.drills[idx];
    if (!d) return;
    const built = buildClientSnapshotFromSource(d.drillType, d.sourceRef);
    const layout = built ? built.layout : d.fallbackLayout;
    previewSnapshotFromPlanner(layout, d.title, d.coachNote);
  };

  window.savePracticePlan = async function () {
    const ed = instructorState.editor;
    const name = (ed.name || '').trim();
    if (!name) {
      showToast('Please enter a Practice Plan name');
      document.getElementById('planNameInput')?.focus();
      return;
    }
    if (ed.drills.length === 0) {
      showToast('Add at least one drill to the plan');
      return;
    }

    const payload = {
      name,
      description: ed.description || '',
      drills: ed.drills.map(d => ({
        drillType: d.drillType,
        sourceRef: d.sourceRef,
        title: d.title,
        targetAttempts: d.targetAttempts,
        targetSuccesses: d.targetSuccesses,
        coachNote: d.coachNote,
        fallbackLayout: d.fallbackLayout
      }))
    };

    try {
      let saved;
      if (ed.planId) {
        const res = await apiFetch(`/api/instructor/plans/${encodeURIComponent(ed.planId)}`, {
          method: 'PUT',
          instructorAuth: true,
          body: payload
        });
        saved = res.plan;
      } else {
        const res = await apiFetch('/api/instructor/plans', {
          method: 'POST',
          instructorAuth: true,
          body: payload
        });
        saved = res.plan;
      }
      await refreshInstructorData();
      loadPlanIntoEditor(saved);
      renderPlannerWorkspace();
      showToast(`Saved plan "${saved.name}"`);
    } catch (err) {
      showToast(err.message || 'Could not save plan');
    }
  };

  window.deleteCurrentPlan = async function () {
    const planId = instructorState.editor.planId;
    if (!planId) return;
    if (!window.confirm('Delete this practice plan? Existing shared student links will continue to work.')) return;
    try {
      await apiFetch(`/api/instructor/plans/${encodeURIComponent(planId)}`, {
        method: 'DELETE',
        instructorAuth: true
      });
      startNewPlanDraft();
      await refreshInstructorData();
      renderPlannerWorkspace();
      showToast('Practice plan deleted');
    } catch (err) {
      showToast(err.message || 'Failed to delete plan');
    }
  };

  window.setAssignmentPlanFilter = function (planId) {
    instructorState.assignmentPlanFilter = planId;
    renderPlannerWorkspace();
  };

  window.selectAssignmentForReview = async function (assignId) {
    instructorState.selectedAssignmentId = assignId;
    try {
      const res = await apiFetch(`/api/instructor/assignments/${encodeURIComponent(assignId)}`, {
        instructorAuth: true
      });
      const idx = instructorState.assignments.findIndex(a => a.id === assignId);
      if (idx >= 0 && res.assignment) instructorState.assignments[idx] = res.assignment;
    } catch (e) {}
    renderPlannerWorkspace();
  };

  window.previewAssignedDrill = function (assignId, drillIdx) {
    const assign = instructorState.assignments.find(a => a.id === assignId);
    const drill = assign?.drills?.[drillIdx];
    if (!drill) return;
    previewSnapshotFromPlanner(
      drill.layout,
      `${assign.studentName} · Drill ${drillIdx + 1}: ${drill.title}`,
      drill.coachNote
    );
  };

  window.deleteAssignment = async function (assignId) {
    if (!window.confirm('Delete this student assignment and revoke its share link?')) return;
    try {
      await apiFetch(`/api/instructor/assignments/${encodeURIComponent(assignId)}`, {
        method: 'DELETE',
        instructorAuth: true
      });
      await refreshInstructorData();
      renderPlannerWorkspace();
      showToast('Assignment deleted');
    } catch (err) {
      showToast(err.message || 'Could not delete assignment');
    }
  };

  window.copyShareLink = async function (url) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        showToast('Copied student link to clipboard!');
        return;
      }
    } catch (e) {}
    const temp = document.createElement('input');
    temp.value = url;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
    showToast('Copied student link!');
  };

  // ==================== MODALS: ASSIGN TO STUDENT & SPIN LAB CUSTOM DRILLS ====================
  function openModalHtml(html) {
    const backdrop = document.getElementById('cuelabModalBackdrop');
    backdrop.innerHTML = `<div class="cuelab-modal" onclick="event.stopPropagation()">${html}</div>`;
    backdrop.classList.add('open');
    backdrop.onclick = closeModal;
  }

  function closeModal() {
    const backdrop = document.getElementById('cuelabModalBackdrop');
    if (backdrop) {
      backdrop.classList.remove('open');
      backdrop.innerHTML = '';
    }
  }
  window.closeCueLabModal = closeModal;

  window.openAssignModal = async function (preselectedPlanId) {
    if (instructorState.editor.dirty && instructorState.editor.planId === preselectedPlanId) {
      await window.savePracticePlan();
    }
    const chosenId = preselectedPlanId || instructorState.plans[0]?.id || '';
    const planOpts = instructorState.plans.map(p =>
      `<option value="${escapeHtml(p.id)}" ${p.id === chosenId ? 'selected' : ''}>${escapeHtml(p.name)} (${p.drills.length} drills)</option>`
    ).join('');

    openModalHtml(`
      <div class="cuelab-modal-top">
        <h3>🔗 Share Practice Plan with Student</h3>
        <button type="button" class="icon-btn" onclick="window.closeCueLabModal()">✕</button>
      </div>
      <p style="font-size:0.84rem; color:var(--text-secondary); line-height:1.45;">
        Creates an isolated assignment snapshot and a unique practice link for one student. Later edits to the plan won't alter what this student was assigned.
      </p>
      <form onsubmit="window.submitCreateAssignment(event)" style="display:flex; flex-direction:column; gap:13px;">
        <div class="field-group">
          <label class="field-label" for="modalAssignPlanSelect">Practice Plan</label>
          <select id="modalAssignPlanSelect" class="planner-select" required>${planOpts}</select>
        </div>
        <div class="field-group">
          <label class="field-label" for="modalStudentNameInput">Student Name</label>
          <input id="modalStudentNameInput" type="text" class="planner-input" placeholder="e.g., Alex Rivera" required maxlength="120">
        </div>
        <div id="modalCreatedLinkArea"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px;" id="modalAssignFooterBtns">
          <button type="button" class="ctrl-btn" onclick="window.closeCueLabModal()">Cancel</button>
          <button type="submit" class="ctrl-btn cta-next">Create Student Link</button>
        </div>
      </form>
    `);
    setTimeout(() => document.getElementById('modalStudentNameInput')?.focus(), 30);
  };

  window.submitCreateAssignment = async function (e) {
    e.preventDefault();
    const planId = document.getElementById('modalAssignPlanSelect')?.value;
    const studentName = document.getElementById('modalStudentNameInput')?.value.trim();
    if (!planId || !studentName) return;

    try {
      const res = await apiFetch(`/api/instructor/plans/${encodeURIComponent(planId)}/assignments`, {
        method: 'POST',
        instructorAuth: true,
        body: { studentName }
      });
      const assign = res.assignment;
      const fullUrl = `${window.location.origin}${assign.sharePath}`;
      await refreshInstructorData();
      instructorState.selectedAssignmentId = assign.id;
      if (currentGame === 'planner') renderPlannerWorkspace();

      const linkArea = document.getElementById('modalCreatedLinkArea');
      if (linkArea) {
        linkArea.innerHTML = `
          <div class="share-link-callout" style="margin-top:4px;">
            <div style="font-size:0.8rem; font-weight:700; color:#6ee7b7; width:100%;">
              ✓ Link ready for ${escapeHtml(assign.studentName)}:
            </div>
            <code class="share-url-code selectable-text">${escapeHtml(fullUrl)}</code>
            <button type="button" class="ctrl-btn cta-next" onclick="window.copyShareLink('${escapeHtml(fullUrl)}')">📋 Copy</button>
          </div>
        `;
      }
      const footer = document.getElementById('modalAssignFooterBtns');
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="ctrl-btn" onclick="window.closeCueLabModal(); window.setPlannerSubtab('assignments');">View in Student Assignments</button>
          <button type="button" class="ctrl-btn cta-next" onclick="window.closeCueLabModal()">Done</button>
        `;
      }
      showToast(`Created link for ${assign.studentName}`);
    } catch (err) {
      showToast(err.message || 'Could not create student link');
    }
  };

  // --- Spin Lab Save & Load Custom Drills ---
  window.openSaveCustomDrillModal = async function () {
    if (isStudentMode || sandboxLocked) return;
    await syncInstructorAuthStatus();
    if (!instructorState.serverReachable) {
      showToast('Start local server (npm start) to save custom drills');
      return;
    }

    let existingDrill = null;
    if (instructorState.authenticated && loadedCustomDrillId) {
      try {
        await refreshInstructorData();
        existingDrill = instructorState.customDrills.find(d => d.id === loadedCustomDrillId) || null;
      } catch (e) {}
    }

    const authFields = !instructorState.authenticated
      ? `
        <div class="field-group">
          <label class="field-label" for="sbModalPasscode">${instructorState.configured ? 'Instructor Passcode' : 'Set New Instructor Passcode (4+ chars)'}</label>
          <input id="sbModalPasscode" type="password" class="planner-input" placeholder="Enter passcode..." required minlength="4">
        </div>
      `
      : '';

    const tzDesc = sandboxState.targetZone?.enabled
      ? `Marked Target Zone at ${formatGridCoord(sandboxState.targetZone.x, sandboxState.targetZone.y)}`
      : 'No Marked Target Zone (Tip: toggle 🎯 Target Zone in Spin Lab to mark a leave zone!)';

    openModalHtml(`
      <div class="cuelab-modal-top">
        <h3>💾 Save Spin Lab Layout as Drill</h3>
        <button type="button" class="icon-btn" onclick="window.closeCueLabModal()">✕</button>
      </div>
      <div style="font-size:0.8rem; color:var(--accent-cyan); font-weight:700;">
        Cue ${formatGridCoord(sandboxState.cue.x, sandboxState.cue.y)} → #${sandboxState.objBallNum || 1}-Ball into ${sandboxState.pocket} · ${escapeHtml(tzDesc)}
      </div>
      <form onsubmit="window.submitSaveCustomDrill(event)" style="display:flex; flex-direction:column; gap:12px;">
        ${authFields}
        <div class="field-group">
          <label class="field-label" for="sbDrillTitleInput">Drill Title</label>
          <input id="sbDrillTitleInput" type="text" class="planner-input" required maxlength="140"
            placeholder="e.g., Corner Cut Stun-Draw to Center Zone"
            value="${escapeHtml(existingDrill ? existingDrill.title : '')}">
        </div>
        <div class="field-group">
          <label class="field-label" for="sbDrillNoteInput">Default Coaching Note (optional)</label>
          <textarea id="sbDrillNoteInput" class="planner-textarea" placeholder="e.g., Land the cue ball in the marked zone on 7 out of 10 attempts...">${escapeHtml(existingDrill ? existingDrill.coachNote : '')}</textarea>
        </div>
        ${
          existingDrill
            ? `
              <label style="display:flex; align-items:center; gap:8px; font-size:0.83rem; color:var(--text-secondary); cursor:pointer;">
                <input type="checkbox" id="sbOverwriteExistingChk" checked>
                Update existing "${escapeHtml(existingDrill.title)}" (uncheck to save as a new copy)
              </label>
            `
            : ''
        }
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
          <button type="button" class="ctrl-btn" onclick="window.closeCueLabModal()">Cancel</button>
          <button type="submit" class="ctrl-btn cta-next">💾 Save Custom Drill</button>
        </div>
      </form>
    `);
    setTimeout(() => document.getElementById('sbDrillTitleInput')?.focus(), 30);
  };

  window.submitSaveCustomDrill = async function (e) {
    e.preventDefault();
    try {
      if (!instructorState.authenticated) {
        const pass = document.getElementById('sbModalPasscode')?.value.trim();
        const endpoint = instructorState.configured ? '/api/instructor/auth/login' : '/api/instructor/auth/setup';
        const authRes = await apiFetch(endpoint, { method: 'POST', body: { passcode: pass } });
        saveInstructorToken(authRes.token);
        instructorState.configured = true;
        instructorState.authenticated = true;
      }

      const title = document.getElementById('sbDrillTitleInput')?.value.trim();
      const coachNote = document.getElementById('sbDrillNoteInput')?.value.trim() || '';
      const overwrite = Boolean(document.getElementById('sbOverwriteExistingChk')?.checked);

      const layoutPayload = {
        cue: sandboxState.cue,
        obj: sandboxState.obj,
        objBallNum: sandboxState.objBallNum || 1,
        pocket: sandboxState.pocket,
        blockers: sandboxState.blockers,
        tip: explorerTip,
        power: explorerPower,
        compensateSquirt,
        targetZone: sandboxState.targetZone
      };

      let saved;
      if (overwrite && loadedCustomDrillId) {
        const res = await apiFetch(`/api/instructor/custom-drills/${encodeURIComponent(loadedCustomDrillId)}`, {
          method: 'PUT',
          instructorAuth: true,
          body: { title, coachNote, layout: layoutPayload }
        });
        saved = res.customDrill;
      } else {
        const res = await apiFetch('/api/instructor/custom-drills', {
          method: 'POST',
          instructorAuth: true,
          body: { title, coachNote, layout: layoutPayload }
        });
        saved = res.customDrill;
      }

      loadedCustomDrillId = saved.id;
      await refreshInstructorData();
      instructorState.picker.sourceType = 'custom_drill';
      instructorState.picker.customDrillId = saved.id;
      closeModal();
      showToast(`Saved custom drill "${saved.title}"`);
    } catch (err) {
      showToast(err.message || 'Could not save custom drill');
    }
  };

  window.openSavedDrillsModal = async function () {
    if (isStudentMode) return;
    await syncInstructorAuthStatus();
    if (!instructorState.authenticated) {
      window.openPracticePlannerTab(document.getElementById('plannerTabBtn'));
      showToast('Unlock Instructor Planner first to manage saved drills');
      return;
    }
    await refreshInstructorData();

    const listHtml = instructorState.customDrills.length === 0
      ? `<div class="empty-state-box">No saved Spin Lab drills yet. Position balls on the table and click <strong>💾 Save Drill</strong>.</div>`
      : instructorState.customDrills.map(cd => {
          const tz = cd.layout?.targetZone?.enabled ? ` · Zone ${cd.layout.targetZone.coord}` : '';
          return `
            <div class="list-item-card" style="cursor:default;">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <strong style="color:#fff;">${escapeHtml(cd.title)}</strong>
                <div style="display:flex; gap:6px;">
                  <button type="button" class="mini-action-btn" onclick="window.loadCustomDrillIntoSpinLab('${escapeHtml(cd.id)}')">Load &amp; Edit</button>
                  <button type="button" class="mini-action-btn danger" onclick="window.deleteSavedCustomDrill('${escapeHtml(cd.id)}')">✕</button>
                </div>
              </div>
              <div style="font-size:0.77rem; color:var(--text-muted);">Pocket ${escapeHtml(cd.layout?.pocket || 'P3')}${escapeHtml(tz)}</div>
              ${cd.coachNote ? `<div style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtml(cd.coachNote)}</div>` : ''}
            </div>
          `;
        }).join('');

    openModalHtml(`
      <div class="cuelab-modal-top">
        <h3>📂 Saved Spin Lab Drills</h3>
        <button type="button" class="icon-btn" onclick="window.closeCueLabModal()">✕</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:9px;">${listHtml}</div>
      <div style="display:flex; justify-content:flex-end;">
        <button type="button" class="ctrl-btn" onclick="window.closeCueLabModal()">Close</button>
      </div>
    `);
  };

  window.loadCustomDrillIntoSpinLab = function (drillId) {
    const cd = instructorState.customDrills.find(d => d.id === drillId);
    if (!cd) return;
    loadedCustomDrillId = cd.id;
    const lay = cd.layout;
    sandboxState = {
      cue: { x: Number(lay.cue?.x) || 18, y: Number(lay.cue?.y) || 18 },
      obj: { x: Number(lay.obj?.x) || 34, y: Number(lay.obj?.y) || 9 },
      objBallNum: parseInt(lay.objBallNum, 10) || 1,
      pocket: lay.pocket || 'P3',
      blockers: JSON.parse(JSON.stringify(lay.blockers || [])),
      targetZone: lay.targetZone
        ? JSON.parse(JSON.stringify(lay.targetZone))
        : { enabled: false, x: 24, y: 14, radius: 46 }
    };
    explorerTip = { x: Number(lay.tip?.x) || 0, y: Number(lay.tip?.y) || 0 };
    explorerPower = parseInt(lay.power, 10) || 3;
    compensateSquirt = Boolean(lay.compensateSquirt);
    const tzBtn = document.getElementById('sbTargetZoneBtn');
    if (tzBtn) tzBtn.classList.toggle('active-toggle', Boolean(sandboxState.targetZone?.enabled));
    positionExplorerDot();
    setSandboxPocket(sandboxState.pocket);
    closeModal();
    showToast(`Loaded "${cd.title}" into Spin Lab`);
  };

  window.deleteSavedCustomDrill = async function (drillId) {
    if (!window.confirm('Delete this saved Spin Lab drill? Shared student assignments will remain intact.')) return;
    try {
      await apiFetch(`/api/instructor/custom-drills/${encodeURIComponent(drillId)}`, {
        method: 'DELETE',
        instructorAuth: true
      });
      if (loadedCustomDrillId === drillId) loadedCustomDrillId = null;
      await refreshInstructorData();
      window.openSavedDrillsModal();
    } catch (err) {
      showToast(err.message || 'Could not delete drill');
    }
  };

  // ==================== IN-APP HELP / USER MANUAL VIEWER ====================
  let cachedManualMarkdown = null;
  let activeManualFilter = 'all';

  function formatInlineMarkdown(rawText) {
    const codeTokens = [];
    let s = escapeHtml(rawText).replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code>${code}</code>`);
      return `@@CODE_${idx}@@`;
    });

    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safeHref = href.trim();
      if (/^https?:\/\//i.test(safeHref)) {
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan); text-decoration:underline;">${label}</a>`;
      }
      return label;
    });

    return s.replace(/@@CODE_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] || '');
  }

  function resolveManualImageSrc(rawPath) {
    const clean = String(rawPath || '').trim().replace(/^\.\//, '');
    if (clean.startsWith('screenshots/')) return `/docs/${clean}`;
    if (clean.startsWith('/docs/screenshots/')) return clean;
    return clean;
  }

  function renderMarkdownBlockLines(lines) {
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // Fenced code block
      if (trimmed.startsWith('```')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(escapeHtml(lines[i]));
          i++;
        }
        i++; // skip closing fence
        html.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        html.push('<hr>');
        i++;
        continue;
      }

      // Headings
      const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        html.push(`<h${lvl}>${formatInlineMarkdown(hMatch[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // Standalone Image -> Figure with click-to-zoom lightbox
      const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        const alt = imgMatch[1].trim();
        const src = resolveManualImageSrc(imgMatch[2]);
        const isMobileShot = /mobile/i.test(src);
        html.push(`
          <figure class="manual-figure ${isMobileShot ? 'mobile-shot' : ''}">
            <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"
              onclick="window.openManualLightbox('${escapeHtml(src)}', '${escapeHtml(alt)}')">
            ${alt ? `<figcaption class="manual-figcaption">${escapeHtml(alt)} (click to enlarge)</figcaption>` : ''}
          </figure>
        `);
        i++;
        continue;
      }

      // Markdown Table
      if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|\s*[:\-| ]+\|$/.test(lines[i + 1].trim())) {
        const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const headers = splitRow(trimmed);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          bodyRows.push(splitRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headers.map(h => `<th>${formatInlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${bodyRows.map(r => `<tr>${r.map(c => `<td>${formatInlineMarkdown(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        html.push(`<div class="manual-table-wrap"><table>${thead}${tbody}</table></div>`);
        continue;
      }

      // Blockquote
      if (trimmed.startsWith('>')) {
        const qLines = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          qLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        html.push(`<blockquote><p>${formatInlineMarkdown(qLines.join(' '))}</p></blockquote>`);
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(`<li>${formatInlineMarkdown(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        html.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(`<li>${formatInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        html.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      // Paragraph (accumulate consecutive plain lines)
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,3}\s|```|[-*]\s|\d+\.\s|>|\||!\[|---|\*\*\*|<!--)/.test(lines[i].trim())
      ) {
        pLines.push(lines[i].trim());
        i++;
      }
      if (pLines.length) {
        html.push(`<p>${formatInlineMarkdown(pLines.join(' '))}</p>`);
      } else {
        i++;
      }
    }

    return html.join('\n');
  }

  function renderUserManualMarkdown(mdText) {
    const rawLines = String(mdText || '').split(/\r?\n/);
    const sections = [];
    let currentAudience = 'all';
    let currentLines = [];

    for (const line of rawLines) {
      const audMatch = line.trim().match(/^<!--\s*audience:\s*(all|player|student|instructor)\s*-->$/i);
      if (audMatch) {
        if (currentLines.some(l => l.trim().length > 0)) {
          sections.push({ audience: currentAudience, lines: currentLines });
        }
        currentAudience = audMatch[1].toLowerCase();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.some(l => l.trim().length > 0)) {
      sections.push({ audience: currentAudience, lines: currentLines });
    }

    const rolePillMap = {
      player: '<span class="manual-role-pill role-player">Players &amp; Table</span>',
      student: '<span class="manual-role-pill role-student">Student Feature</span>',
      instructor: '<span class="manual-role-pill role-instructor">Instructor Feature</span>'
    };

    return sections.map((sec) => {
      let bodyHtml = renderMarkdownBlockLines(sec.lines);
      if (rolePillMap[sec.audience]) {
        bodyHtml = bodyHtml.replace(/<h2>([\s\S]*?)<\/h2>/, `<h2><span>$1</span>${rolePillMap[sec.audience]}</h2>`);
      }
      return `<div class="manual-section" data-audience="${sec.audience}">${bodyHtml}</div>`;
    }).join('\n');
  }

  function buildOfflineManualFallbackHtml() {
    return `
      <div class="manual-section" data-audience="all">
        <h1>CueLab Arena — Quick Help (Offline Fallback)</h1>
        <blockquote>
          <p><strong>Local Server Needed for Full Illustrated Manual:</strong> You opened <code>index.html</code> directly via <code>file://</code> (or the local server is not currently running), so browsers block loading <code>docs/USER_MANUAL.md</code> and screenshots directly from disk.</p>
        </blockquote>
        <p>To view the complete illustrated User Manual with screenshots — and to use the Practice Planner and Student Share Links — start the local server:</p>
        <pre><code>cd app
npm start</code></pre>
        <p>Then open <strong>http://127.0.0.1:3000</strong> in your browser and click <strong>? Help</strong>.</p>
        <h2>Quick Table &amp; Keyboard Reference</h2>
        <ul>
          <li><strong>Game Tabs:</strong> Switch between 9-Ball, 10-Ball, 8-Ball Solids, 8-Ball Stripes, and <strong>🧪 Spin Lab</strong>.</li>
          <li><strong>POV Rotation:</strong> Use <code>Auto-Flip ↑</code>, <code>Shooter Line ↑</code>, or <code>Fixed</code> so shots always aim away from you.</li>
          <li><strong>Shortcuts:</strong> <code>→</code> Next Shot · <code>←</code> Prev Shot · <code>R</code> Reset Rack · <code>F</code> Flip Table 180° · <code>E</code> Expand Table.</li>
          <li><strong>Cue-Tip Explorer:</strong> Drag the green dot on the cue ball to preview follow, draw, English, and squirt/throw misses.</li>
          <li><strong>Ball Magnifier:</strong> Hover or tap any ball on the table to see its exact coordinate and number.</li>
        </ul>
      </div>
    `;
  }

  function applyManualFilterToDom(filterKey) {
    activeManualFilter = filterKey;
    document.querySelectorAll('.help-aud-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filterKey);
    });
    const body = document.getElementById('helpManualBody');
    if (!body) return;
    body.querySelectorAll('.manual-section').forEach(sec => {
      const aud = sec.dataset.audience || 'all';
      const show = filterKey === 'all' || aud === 'all' || aud === filterKey;
      sec.classList.toggle('hidden-by-filter', !show);
    });
    body.scrollTop = 0;
  }

  window.setManualAudienceFilter = function (filterKey) {
    applyManualFilterToDom(filterKey);
  };

  window.openManualLightbox = function (src, caption) {
    closeManualLightbox();
    const lb = document.createElement('div');
    lb.className = 'manual-lightbox';
    lb.id = 'manualLightbox';
    lb.onclick = closeManualLightbox;
    lb.innerHTML = `
      <img src="${escapeHtml(src)}" alt="${escapeHtml(caption || '')}">
      <div class="manual-lightbox-caption">${escapeHtml(caption || '')} — Click anywhere or press Esc to close</div>
    `;
    document.body.appendChild(lb);
  };

  function closeManualLightbox() {
    const existing = document.getElementById('manualLightbox');
    if (existing) existing.remove();
  }

  window.openUserManualModal = async function () {
    const defaultFilter = isStudentMode ? 'student' : 'all';
    const backdrop = document.getElementById('cuelabModalBackdrop');
    if (!backdrop) return;

    const tabsHtml = isStudentMode
      ? `
        <button type="button" class="help-aud-tab" data-filter="student" onclick="window.setManualAudienceFilter('student')">🎯 Student Practice</button>
        <button type="button" class="help-aud-tab" data-filter="player" onclick="window.setManualAudienceFilter('player')">🎱 Table &amp; Controls</button>
        <button type="button" class="help-aud-tab" data-filter="all" onclick="window.setManualAudienceFilter('all')">📚 Full Manual</button>
      `
      : `
        <button type="button" class="help-aud-tab" data-filter="all" onclick="window.setManualAudienceFilter('all')">📚 All Guide</button>
        <button type="button" class="help-aud-tab" data-filter="player" onclick="window.setManualAudienceFilter('player')">🎱 Players &amp; Spin Lab</button>
        <button type="button" class="help-aud-tab" data-filter="student" onclick="window.setManualAudienceFilter('student')">🎯 Student Practice</button>
        <button type="button" class="help-aud-tab" data-filter="instructor" onclick="window.setManualAudienceFilter('instructor')">📋 Instructor Guide</button>
      `;

    backdrop.innerHTML = `
      <div class="cuelab-modal help-manual-modal" onclick="event.stopPropagation()">
        <div class="help-modal-header">
          <div class="help-modal-title-row">
            <h3>📖 CueLab Arena — User Manual</h3>
            <button type="button" class="icon-btn" onclick="window.closeCueLabModal()" aria-label="Close User Manual">✕</button>
          </div>
          <div class="help-audience-tabs">${tabsHtml}</div>
        </div>
        <div class="help-manual-body" id="helpManualBody">
          <div style="color:var(--text-secondary); padding:18px 0;">Loading illustrated user manual...</div>
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    backdrop.onclick = closeModal;

    const bodyEl = document.getElementById('helpManualBody');
    if (window.location.protocol === 'file:') {
      if (bodyEl) bodyEl.innerHTML = buildOfflineManualFallbackHtml();
      applyManualFilterToDom('all');
      return;
    }

    try {
      if (!cachedManualMarkdown) {
        const resp = await fetch('/docs/USER_MANUAL.md', { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        cachedManualMarkdown = await resp.text();
      }
      if (bodyEl) bodyEl.innerHTML = renderUserManualMarkdown(cachedManualMarkdown);
      applyManualFilterToDom(defaultFilter);
    } catch (err) {
      if (bodyEl) bodyEl.innerHTML = buildOfflineManualFallbackHtml();
      applyManualFilterToDom('all');
    }
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('manualLightbox')) {
        closeManualLightbox();
      } else if (document.getElementById('cuelabModalBackdrop')?.classList.contains('open')) {
        closeModal();
      }
    }
  });

  // ==================== INITIALIZE ====================
  window.initPracticePlanner = function () {
    const params = new URLSearchParams(window.location.search);
    const tok = params.get('assignment');
    if (tok && tok.trim()) {
      bootStudentMode(tok.trim());
    }
  };
})();
