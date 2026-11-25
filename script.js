/* ===========================================================
   LAGOA KOI
   Deslize entre a superfície e o fundo da lagoa, colete
   pérolas e desvie das folhas e pedras. Colete o bastante
   para florescer e limpar a lagoa por um instante.
   =========================================================== */

(() => {
  'use strict';

  /* ---------- DOM ---------- */
  const shell = document.getElementById('game-shell');
  const canvas = document.getElementById('pond');
  const ctx = canvas.getContext('2d');

  const hud = document.getElementById('hud');
  const scoreValueEl = document.getElementById('score-value');
  const bloomBtn = document.getElementById('bloom-btn');
  const bloomFillEl = document.getElementById('bloom-fill');
  const comboBadge = document.getElementById('combo-badge');
  const comboValueEl = document.getElementById('combo-value');

  const startScreen = document.getElementById('start-screen');
  const gameoverScreen = document.getElementById('gameover-screen');
  const pauseScreen = document.getElementById('pause-screen');
  const resumeBtn = document.getElementById('resume-btn');
  const startBtn = document.getElementById('start-btn');
  const restartBtn = document.getElementById('restart-btn');
  const finalScoreEl = document.getElementById('final-score-value');
  const bestScoreEl = document.getElementById('best-score-value');
  const newRecordEl = document.getElementById('new-record');

  const prefersReducedMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------- constants ---------- */
  const HS_KEY = 'lagoaKoiHighScore';
  const PLAYER_R = 15;
  const BASE_SPEED = 230;
  const SPEED_RAMP = 4;
  const MAX_SPEED = 520;
  const FLIP_LERP = 9;
  const BLOCK_RATIO = 0.54;
  const BLOOM_CIRC = 2 * Math.PI * 17;

  /* ---------- mutable world state ---------- */
  const view = { w: 0, h: 0 };
  let playerX = 0;
  let blockH = 0;
  let worldScale = 1;

  let state = 'start'; // start | playing | dying | gameover
  let elapsed = 0;
  let speed = BASE_SPEED;
  let score = 0;
  let spawnTimer = 1.2;
  let pearlTimer = 0.8;
  let comboCount = 1;
  let comboTimer = 0;
  let abilityMeter = 0;
  let bloomFlash = 0;
  let shakeTime = 0;
  let shakeMag = 0;
  let dyingTimer = 0;

  const obstacles = [];
  const pearls = [];
  const particles = [];
  const decor = [];
  const fireflies = [];

  const player = { lane: 0, y: 0, angle: 0, invincible: false, invincibleTimer: 0 };

  /* ---------- helpers ---------- */
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function laneY(lane) { return lane === 0 ? view.h * 0.32 : view.h * 0.72; }

  function circleRectCollide(cx, cy, r, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw);
    const ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function getHighScore() {
    try { return parseInt(localStorage.getItem(HS_KEY), 10) || 0; }
    catch (e) { return 0; }
  }
  function setHighScore(v) {
    try { localStorage.setItem(HS_KEY, String(v)); } catch (e) { /* ignore */ }
  }

  /* ---------- audio (synthesized, no external files) ---------- */
  let audioCtx = null;
  function unlockAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep(freq, duration, type, gainLevel, delay) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(gainLevel, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  function playSound(name) {
    if (!audioCtx) return;
    if (name === 'flip') {
      beep(520, 0.09, 'sine', 0.12, 0);
    } else if (name === 'collect') {
      beep(880, 0.12, 'triangle', 0.14, 0);
      beep(1320, 0.1, 'triangle', 0.08, 0.05);
    } else if (name === 'crash') {
      beep(120, 0.35, 'sawtooth', 0.16, 0);
      beep(70, 0.4, 'square', 0.12, 0.05);
    } else if (name === 'bloom') {
      beep(660, 0.5, 'triangle', 0.12, 0);
      beep(990, 0.45, 'sine', 0.1, 0.08);
      beep(1320, 0.4, 'sine', 0.08, 0.16);
    }
  }

  /* ---------- particles ---------- */
  function spawnBurst(x, y, colors, count, speedMax) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * speedMax;
      const life = 0.35 + Math.random() * 0.5;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life, maxLife: life,
        size: 2 + Math.random() * 3,
        color: colors[Math.floor(Math.random() * colors.length)]
      });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.93;
      p.vy *= 0.93;
      p.vy -= 8 * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- decorative background ---------- */
  function initDecor() {
    decor.length = 0;
    for (let i = 0; i < 5; i++) {
      decor.push({
        x: Math.random() * view.w,
        laneBias: Math.random() < 0.5 ? 0 : 1,
        scale: 0.6 + Math.random() * 0.8,
        speedMul: 0.2 + Math.random() * 0.15,
        kind: Math.random() < 0.5 ? 'lily' : 'rock'
      });
    }
  }

  function initFireflies() {
    fireflies.length = 0;
    for (let i = 0; i < 10; i++) {
      fireflies.push({
        x: Math.random() * view.w,
        y: Math.random() * view.h,
        phase: Math.random() * Math.PI * 2,
        drift: 3 + Math.random() * 5
      });
    }
  }

  function updateDecor(dt) {
    if (prefersReducedMotion) return;
    const amb = (state === 'playing' ? speed * 0.3 : 40) * worldScale;
    for (const d of decor) {
      d.x -= amb * d.speedMul * dt;
      if (d.x < -60) d.x = view.w + 60 + Math.random() * 120;
    }
  }

  function updateFireflies(dt) {
    if (prefersReducedMotion) return;
    for (const f of fireflies) {
      f.y -= f.drift * 0.15 * dt;
      if (f.y < -10) { f.y = view.h + 10; f.x = Math.random() * view.w; }
    }
  }

  function drawJaggedBlob(cx, cy, r, points, seed) {
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const rr = r * (0.75 + 0.25 * Math.sin(a * 3 + seed * 5));
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.6;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawDecor(time) {
    ctx.save();
    ctx.globalAlpha = 0.32;
    for (const d of decor) {
      const y = d.laneBias === 0 ? view.h * 0.07 : view.h * 0.95;
      if (d.kind === 'lily') {
        ctx.fillStyle = '#3B6B4E';
        ctx.beginPath();
        ctx.ellipse(d.x, y, 18 * d.scale, 9 * d.scale, 0.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#6C6355';
        drawJaggedBlob(d.x, y, 14 * d.scale, 6, d.x * 0.01 + time * 0.05);
      }
    }
    ctx.restore();
  }

  function drawFireflies(time) {
    ctx.save();
    for (const f of fireflies) {
      const tw = 0.25 + 0.75 * Math.abs(Math.sin(time * 2 + f.phase));
      ctx.globalAlpha = tw * 0.75;
      ctx.fillStyle = '#FDF6E8';
      ctx.beginPath();
      ctx.arc(f.x + Math.sin(time * 1.1 + f.phase) * 8, f.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, view.h);
    grad.addColorStop(0, '#1F6E68');
    grad.addColorStop(0.45, '#123F44');
    grad.addColorStop(1, '#0B2E33');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  function drawGlow() {
    const gx = view.w * 0.86, gy = view.h * 0.16, r = view.h * 0.38;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    grad.addColorStop(0, 'rgba(232,163,61,0.22)');
    grad.addColorStop(1, 'rgba(232,163,61,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSurfaceShimmer(time) {
    ctx.save();
    ctx.strokeStyle = 'rgba(253,246,232,0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = 16;
    for (let x = 0; x <= view.w; x += step) {
      const yy = view.h * 0.5 + Math.sin(x * 0.03 + time * 1.5) * 4;
      if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- obstacles ---------- */
  function spawnObstacle() {
    const type = Math.random() < 0.5 ? 'top' : 'bottom';
    const width = 46 + Math.random() * 30;
    obstacles.push({ x: view.w + width, width, type, passed: false, wobble: Math.random() * Math.PI * 2 });
  }

  function randSpawnInterval() {
    const minI = Math.max(0.95, 1.7 - elapsed * 0.01);
    return minI + Math.random() * 0.5;
  }

  function updateObstacles(dt) {
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.x -= speed * worldScale * dt;
      if (!o.passed && o.x + o.width < playerX) { o.passed = true; score += 4; }
      if (o.x + o.width < -20) obstacles.splice(i, 1);
    }
  }

  function drawLilyCluster(o, time) {
    ctx.save();
    const x = o.x, w = o.width;
    ctx.strokeStyle = 'rgba(59,107,78,0.5)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const sx = x + w * (0.2 + i * 0.3);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.quadraticCurveTo(sx + 6, blockH * 0.4, sx - 4, blockH * 0.82);
      ctx.stroke();
    }
    const padColors = ['#3B6B4E', '#4C7F5C', '#345F44'];
    for (let i = 0; i < 4; i++) {
      const px = x + (i % 2 === 0 ? w * 0.25 : w * 0.72) + Math.sin(time * 0.6 + i + o.wobble) * 3;
      const py = blockH * (0.32 + i * 0.15);
      const pr = 16 + (i % 3) * 4;
      ctx.fillStyle = padColors[i % padColors.length];
      ctx.beginPath();
      ctx.ellipse(px, py, pr, pr * 0.68, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#E893A3';
    ctx.beginPath();
    ctx.ellipse(x + w * 0.5, blockH * 0.5, 5, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawRockCluster(o, time) {
    ctx.save();
    const x = o.x, w = o.width, baseY = view.h;
    ctx.strokeStyle = 'rgba(59,107,78,0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const sx = x + w * (0.15 + i * 0.35);
      const sway = Math.sin(time * 1.4 + o.wobble + i) * 8;
      ctx.beginPath();
      ctx.moveTo(sx, baseY);
      ctx.quadraticCurveTo(sx + sway, baseY - blockH * 0.55, sx + sway * 1.4, baseY - blockH * 0.9);
      ctx.stroke();
    }
    const rockColors = ['#6C6355', '#544E43', '#7A7062'];
    for (let i = 0; i < 3; i++) {
      const rx = x + w * (0.2 + i * 0.3);
      const ry = baseY - (10 + i * 6);
      const rr = 14 + (i % 2) * 6;
      ctx.fillStyle = rockColors[i % rockColors.length];
      drawJaggedBlob(rx, ry, rr, 6, i + o.wobble);
    }
    ctx.restore();
  }

  /* ---------- pearls ---------- */
  function spawnPearl() {
    const lane = Math.random() < 0.5 ? 0 : 1;
    pearls.push({ x: view.w + 20, lane, y: laneY(lane), bob: Math.random() * Math.PI * 2, r: 9 });
  }

  function randPearlInterval() { return 0.9 + Math.random() * 0.9; }

  function updatePearls(dt, time) {
    for (let i = pearls.length - 1; i >= 0; i--) {
      const p = pearls[i];
      p.x -= speed * worldScale * dt;
      p.y = laneY(p.lane) + Math.sin(time * 3 + p.bob) * 6;
      if (p.x < -20) pearls.splice(i, 1);
    }
  }

  function drawPearl(p) {
    ctx.save();
    const grad = ctx.createRadialGradient(p.x - 2, p.y - 2, 0, p.x, p.y, p.r);
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(0.5, '#FDF6E8');
    grad.addColorStop(1, 'rgba(253,246,232,0.12)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---------- koi ---------- */
  function drawKoi(x, y, angle, time, invincible) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (invincible) {
      ctx.save();
      ctx.globalAlpha = 0.3 + 0.15 * Math.sin(time * 8);
      ctx.fillStyle = '#E893A3';
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const tw = Math.sin(time * 11) * 0.3;
    ctx.save();
    ctx.rotate(tw);
    ctx.fillStyle = '#C9852A';
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(-30, -10);
    ctx.lineTo(-25, 0);
    ctx.lineTo(-30, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#E8A33D';
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#F6EFE1';
    ctx.beginPath();
    ctx.ellipse(-2, 4, 10, 4, 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0B2E33';
    ctx.beginPath();
    ctx.ellipse(4, -3, 3, 2.4, 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(201,133,42,0.9)';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, -15);
    ctx.lineTo(9, -7);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#0B2E33';
    ctx.beginPath();
    ctx.arc(11, -2, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#F6EFE1';
    ctx.beginPath();
    ctx.arc(11.6, -2.6, 0.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawIdleKoi(time) {
    const t = time * 0.35;
    const x = ((t * 140) % (view.w + 140)) - 70;
    const y = view.h * 0.5 + Math.sin(t * 2.3) * view.h * 0.16;
    const angle = Math.cos(t * 2.3) * 0.3;
    drawKoi(x, y, angle, time, false);
  }

  function updatePlayer(dt) {
    const target = laneY(player.lane);
    const prevY = player.y;
    player.y += (target - player.y) * Math.min(1, dt * FLIP_LERP);
    const vy = (player.y - prevY) / Math.max(dt, 0.0001);
    player.angle = clamp(vy * 0.0035, -0.5, 0.5);
  }

  function flipPlayer() {
    if (state !== 'playing') return;
    player.lane = player.lane === 0 ? 1 : 0;
    playSound('flip');
  }

  /* ---------- combo / bloom UI ---------- */
  function updateComboUI() {
    if (comboCount > 1) {
      comboValueEl.textContent = 'x' + comboCount;
      comboBadge.classList.remove('hidden');
      comboBadge.style.animation = 'none';
      // eslint-disable-next-line no-unused-expressions
      comboBadge.offsetHeight;
      comboBadge.style.animation = '';
    } else {
      comboBadge.classList.add('hidden');
    }
  }

  function updateBloomUI() {
    bloomFillEl.style.strokeDashoffset = String(BLOOM_CIRC * (1 - abilityMeter));
    bloomBtn.disabled = abilityMeter < 1;
  }

  function updateHUD() {
    scoreValueEl.textContent = Math.floor(score);
  }

  /* ---------- collisions & game actions ---------- */
  function collectPearl(p) {
    comboCount = Math.min(comboCount + 1, 9);
    comboTimer = 2.4;
    score += 10 * comboCount;
    abilityMeter = Math.min(1, abilityMeter + 1 / 6);
    spawnBurst(p.x, p.y, ['#FDF6E8', '#E8A33D'], 10, 90);
    playSound('collect');
    updateComboUI();
    updateBloomUI();
  }

  function checkCollisions() {
    if (!player.invincible) {
      for (const o of obstacles) {
        const rect = o.type === 'top'
          ? { x: o.x, y: 0, w: o.width, h: blockH }
          : { x: o.x, y: view.h - blockH, w: o.width, h: blockH };
        if (circleRectCollide(playerX, player.y, PLAYER_R, rect.x, rect.y, rect.w, rect.h)) {
          crash();
          return;
        }
      }
    }
    for (let i = pearls.length - 1; i >= 0; i--) {
      const p = pearls[i];
      const dx = playerX - p.x, dy = player.y - p.y;
      if (dx * dx + dy * dy < (PLAYER_R + p.r) * (PLAYER_R + p.r)) {
        collectPearl(p);
        pearls.splice(i, 1);
      }
    }
  }

  function crash() {
    state = 'dying';
    dyingTimer = 0.55;
    playSound('crash');
    spawnBurst(playerX, player.y, ['#E8A33D', '#F6EFE1', '#6C6355'], 22, 160);
    if (!prefersReducedMotion) { shakeTime = 0.4; shakeMag = 9; }
    hud.classList.add('hidden');
  }

  function triggerBloom() {
    if (state !== 'playing' || abilityMeter < 1) return;
    abilityMeter = 0;
    player.invincible = true;
    player.invincibleTimer = 1.5;
    let bonus = 0;
    for (const o of obstacles) {
      const cx = o.x + o.width / 2;
      const cy = o.type === 'top' ? blockH * 0.5 : view.h - blockH * 0.5;
      spawnBurst(cx, cy, o.type === 'top' ? ['#3B6B4E', '#E893A3'] : ['#6C6355', '#3B6B4E'], 12, 140);
      bonus += 15;
    }
    score += bonus;
    obstacles.length = 0;
    bloomFlash = 1;
    if (!prefersReducedMotion) { shakeTime = 0.25; shakeMag = 5; }
    playSound('bloom');
    updateBloomUI();
  }

  /* ---------- state transitions ---------- */
  function resetState() {
    obstacles.length = 0;
    pearls.length = 0;
    particles.length = 0;
    score = 0;
    elapsed = 0;
    speed = BASE_SPEED;
    spawnTimer = 1.2;
    pearlTimer = 0.8;
    comboCount = 1;
    comboTimer = 0;
    abilityMeter = 0;
    bloomFlash = 0;
    shakeTime = 0;
    player.lane = 0;
    player.y = laneY(0);
    player.invincible = false;
    player.invincibleTimer = 0;
    updateHUD();
    updateBloomUI();
    updateComboUI();
  }

  function pauseGame() {
    if (state !== 'playing') return;
    state = 'paused';
    pauseScreen.classList.remove('hidden');
  }

  function resumeGame() {
    if (state !== 'paused') return;
    pauseScreen.classList.add('hidden');
    lastTime = performance.now();
    state = 'playing';
  }

  function startGame() {
    resetState();
    pauseScreen.classList.add('hidden');
    startScreen.classList.add('hidden');
    gameoverScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    state = 'playing';
  }

  function enterGameOver() {
    state = 'gameover';
    const finalScore = Math.floor(score);
    const best = getHighScore();
    let isNew = false;
    if (finalScore > best) { setHighScore(finalScore); isNew = true; }
    finalScoreEl.textContent = finalScore;
    bestScoreEl.textContent = isNew ? finalScore : best;
    newRecordEl.classList.toggle('hidden', !isNew);
    gameoverScreen.classList.remove('hidden');
  }

  /* ---------- layout ---------- */
  function onResize() {
    const rect = shell.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.w = rect.width;
    view.h = rect.height;
    canvas.width = Math.round(view.w * dpr);
    canvas.height = Math.round(view.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    playerX = view.w * 0.22;
    blockH = view.h * BLOCK_RATIO;
    worldScale = clamp(view.w / 900, 0.62, 1);
    if (state !== 'playing') player.y = laneY(player.lane);
  }

  /* ---------- main loop ---------- */
  function update(dt, time) {
    updateDecor(dt);
    updateFireflies(dt);
    updateParticles(dt);
    bloomFlash = Math.max(0, bloomFlash - dt * 1.6);
    if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt);

    if (state === 'playing') {
      elapsed += dt;
      speed = Math.min(BASE_SPEED + elapsed * SPEED_RAMP, MAX_SPEED);
      score += dt * speed * 0.05;

      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnObstacle(); spawnTimer = randSpawnInterval(); }

      pearlTimer -= dt;
      if (pearlTimer <= 0) { spawnPearl(); pearlTimer = randPearlInterval(); }

      if (comboTimer > 0) {
        comboTimer -= dt;
        if (comboTimer <= 0 && comboCount > 1) { comboCount = 1; updateComboUI(); }
      }

      if (player.invincible) {
        player.invincibleTimer -= dt;
        if (player.invincibleTimer <= 0) player.invincible = false;
      }

      updatePlayer(dt);
      updateObstacles(dt);
      updatePearls(dt, time);
      checkCollisions();
      updateHUD();
    } else if (state === 'dying') {
      dyingTimer -= dt;
      if (dyingTimer <= 0) enterGameOver();
    }
  }

  function applyShake() {
    if (shakeTime > 0) {
      const mag = shakeMag * (shakeTime / 0.4);
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }
  }

  function draw(time) {
    ctx.save();
    applyShake();

    drawBackground();
    drawGlow();
    drawSurfaceShimmer(prefersReducedMotion ? 0 : time);
    drawDecor(time);
    drawFireflies(prefersReducedMotion ? 0 : time);

    if (state === 'playing' || state === 'dying' || state === 'paused') {
      for (const o of obstacles) {
        if (o.type === 'top') drawLilyCluster(o, time); else drawRockCluster(o, time);
      }
      for (const p of pearls) drawPearl(p);
      if (state === 'playing' || state === 'paused') drawKoi(playerX, player.y, player.angle, time, player.invincible);
    } else {
      drawIdleKoi(time);
    }

    drawParticles();

    if (bloomFlash > 0) {
      ctx.fillStyle = `rgba(232,147,163,${bloomFlash * 0.3})`;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    ctx.restore();
  }

  let lastTime = performance.now();
  function loop(now) {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 0.05);
    const time = now / 1000;
    update(dt, time);
    draw(time);
    requestAnimationFrame(loop);
  }

  /* ---------- input ---------- */
  startBtn.addEventListener('click', () => { unlockAudio(); startGame(); });
  restartBtn.addEventListener('click', () => { unlockAudio(); startGame(); });

  bloomBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  bloomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unlockAudio();
    triggerBloom();
  });
  startBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  restartBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

  resumeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  resumeBtn.addEventListener('click', () => { unlockAudio(); resumeGame(); });

  shell.addEventListener('pointerdown', () => {
    if (state === 'playing') flipPlayer();
  });

  // Evita menu de segurar, zoom por pinça e pausa automática ao sair do app
  shell.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (state === 'playing') flipPlayer();
      else if (state === 'paused') resumeGame();
      else if (state === 'start' || state === 'gameover') { unlockAudio(); startGame(); }
    } else if (e.code === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame();
    } else if (e.key === 'x' || e.key === 'X') {
      if (state === 'playing') { unlockAudio(); triggerBloom(); }
    }
  });

  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) { new ResizeObserver(onResize).observe(shell); }

  /* ---------- boot ---------- */
  function init() {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      const hintEl = document.getElementById('hint');
      if (hintEl) {
        hintEl.innerHTML = 'Toque na tela para mudar de profundidade.<br>Quando a flor encher no canto, toque nela para florescer.';
      }
    }
    onResize();
    initDecor();
    initFireflies();
    player.y = laneY(0);
    updateBloomUI();
    requestAnimationFrame(loop);
  }

  init();
})();
