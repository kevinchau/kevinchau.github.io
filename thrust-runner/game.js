// Thrust Runner — HOLD. A low electric hypercar drives an elevated neon highway at dusk. Hold to
// fire the cold-gas thruster jets and lift off; release to fall back onto the road. Chasms and
// barriers force flight, low overpasses force driving. The thruster tank refills only on the road.
// Clean (soft) landings, energy cells and near-misses score bonuses. Speed rises endlessly.
const CX = 96, ROAD = 500, CAR_H = 26, CAR_W = 84;
const MAG = '#ff3fa4', CYAN = '#3ff0ff', SUN = '#ffb03a', INK = '#140a2e', WHITE = '#f4f0ff';
const G = 1500, THRUST = 2650;

GT.game({
  title: 'Thrust Runner',
  instruction: 'HOLD TO FLY',
  bg: INK,
  post: { bloom: 0.55, vignette: 0.5, grain: 0.03 },
  chrome: { accent: MAG, text: WHITE, panel: INK },
  music: { mood: 'retro', tempo: 128 },
  combo: { window: 4 },
  milestones: [10, 25, 50, 100],
  hint: { x: 180, y: 360, gesture: 'hold' },

  sprites: {
    car: `<svg width="104" height="34" viewBox="0 0 104 34">
      <defs>
        <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#e6e2f2"/><stop offset=".8" stop-color="#9a94b4"/><stop offset="1" stop-color="#3a3454"/></linearGradient>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b0"/><stop offset=".4" stop-color="#d89a2a"/><stop offset="1" stop-color="#4a2a08"/></linearGradient>
      </defs>
      <path d="M2 21 L4 15 L30 12.5 L44 6 L64 6 L80 12 L101 19.5 L102 25 L100 27 L3 27 Z" fill="url(#b)" stroke="#2a2440" stroke-width="1" stroke-linejoin="round"/>
      <path d="M45 7.2 L63 7.2 L76 12.6 L34 12.8 Z" fill="url(#g)" stroke="#2a2440" stroke-width=".7" stroke-linejoin="round"/>
      <path d="M54 7.2 L54 12.8" stroke="#c8c4d8" stroke-width="1.4"/>
      <path d="M84 16.2 L101 20.6" stroke="#e8ffff" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M86 16.8 L72 18.5 L30 18 L6 17.5" stroke="#8a84a4" stroke-width=".8" fill="none"/>
      <path d="M2.5 16.5 L2.5 21" stroke="#ff2a4a" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M58 18 L64 16.5 L66 18 Z" fill="#b8b4c8" stroke="#2a2440" stroke-width=".5"/>
      <path d="M50 12.8 L49 26" stroke="#5a5474" stroke-width=".6" opacity=".7"/>
      <rect x="3" y="26" width="99" height="2.4" rx="1.2" fill="#3ff0ff" opacity=".85"/>
    </svg>`,
    wing: `<svg width="26" height="10" viewBox="0 0 26 10"><path d="M1 3 L25 1 L25 5 L3 6 Z" fill="#e6e2f2" stroke="#2a2440" stroke-width=".8"/><path d="M6 6 L6 10 M20 5 L20 10" stroke="#8a84a4" stroke-width="1.6"/></svg>`,
    cell: `<svg width="22" height="30" viewBox="0 0 22 30">
      <defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0a6a80"/><stop offset=".45" stop-color="#bffcff"/><stop offset="1" stop-color="#0a6a80"/></linearGradient></defs>
      <rect x="2" y="4" width="18" height="24" rx="4" fill="url(#c)" stroke="#05303a" stroke-width="1.2"/>
      <rect x="7" y="0" width="8" height="5" rx="1.5" fill="#d8e6ff"/>
      <path d="M12 8 L7 17 L11 17 L9 25 L15 14 L11 14 Z" fill="#ffffff" stroke="#ff3fa4" stroke-width=".8"/>
    </svg>`,
  },

  setup() {
    return {
      y: ROAD, vy: 0, air: false, tank: 1, dist: 0, spd: 230, obs: [], cells: [], next: 520,
      puffs: [], lines: [], wheel: 0, dead: false, airT: 0, lastClear: 0, hiss: 0,
    };
  },

  update(s, dt, input) {
    s.spd = 230 + GT.ramp(0, 230, 60);
    const dx = s.spd * dt;
    s.dist += dx;
    // World generation.
    while (s.next < s.dist + 700) spawn(s);
    for (const o of s.obs) o.x -= dx;
    for (const c of s.cells) c.x -= dx;
    s.obs = s.obs.filter((o) => o.x + o.w > -80);
    s.cells = s.cells.filter((c) => c.x > -40 && !c.got);
    s.next -= 0; // next is in world distance
    // Thrust.
    const firing = input.down && s.tank > 0;
    if (input.tap && s.tank > 0) { GT.sfx('whoosh', { pitch: 1.4, vol: 0.5 }); GT.spring('car', 1, 320, 12).kick(-0.12); }
    if (firing) {
      s.vy -= THRUST * dt; s.tank = Math.max(0, s.tank - dt * 0.55);
      s.hiss -= dt;
      if (s.hiss <= 0) { s.hiss = 0.09; GT.tone(GT.range(2400, 3200), 0.08, 'noise' in GT ? 'square' : 'sawtooth', 0.025, 1800); }
      for (let i = 0; i < 3; i++) {
        const px = CX + GT.pick([-34, -12, 14, 34]);
        s.puffs.push({ x: px, y: s.y - 2, vx: GT.range(-60, 20) - s.spd * 0.4, vy: GT.range(160, 300), life: 0.5, max: 0.5, r: GT.range(3, 6) });
      }
      if (s.tank === 0) GT.float('EMPTY', CX, s.y - 50, '#ff9f6b', 16);
    } else if (!s.air) s.tank = Math.min(1, s.tank + dt * 0.7);
    s.vy += G * dt; s.vy = GT.clamp(s.vy, -520, 900);
    s.y += s.vy * dt;
    for (const p of s.puffs) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.9; p.r += dt * 20; p.life -= dt; }
    s.puffs = s.puffs.filter((p) => p.life > 0);
    if (s.puffs.length > 140) s.puffs.splice(0, s.puffs.length - 140);
    s.wheel += dx / 9;
    if (s.y < 70) { s.y = 70; s.vy = Math.max(0, s.vy); }

    // Ground under the car?
    const gap = s.obs.find((o) => o.t === 'gap' && CX - 20 > o.x && CX + 20 < o.x + o.w);
    if (!gap && s.y >= ROAD && s.vy >= 0) {
      if (s.air) {
        const v = s.vy;
        s.air = false; GT.shake(v > 600 ? 9 : 4); GT.spring('car', 1, 320, 12).kick(-0.2);
        GT.burst(CX, ROAD, CYAN, 14, 160); GT.sfx('land', { pitch: 0.8 });
        if (s.airT > 0.35) {
          if (v < 520) { const n = GT.combo.hit(); const p = 1 + Math.min(3, n - 1); GT.addScore(p); GT.hitStop(2); GT.float(`CLEAN LANDING +${p}`, CX + 30, ROAD - 60, CYAN, 16); GT.sfx('combo', { n }); }
          else { GT.combo.miss(); GT.float('HARD LANDING', CX + 30, ROAD - 60, '#ff9f6b', 16); GT.sfx('hurt', { vol: 0.5 }); }
        }
      }
      s.y = ROAD; s.vy = 0; s.airT = 0;
    } else if (s.y < ROAD - 1 || gap) { s.air = true; s.airT += dt; }
    if (gap && s.y > ROAD + 30) return crash(s, 'INTO THE CHASM');

    // Collisions.
    const car = { x: CX - CAR_W / 2 + 4, y: s.y - CAR_H, w: CAR_W - 8, h: CAR_H };
    for (const o of s.obs) {
      if (o.t === 'wall') {
        const r = { x: o.x, y: ROAD - o.h, w: o.w, h: o.h };
        if (GT.rectHit(car, r)) return crash(s, 'BARRIER!');
        if (!o.passed && o.x + o.w < car.x) { o.passed = true; score(s, o, (ROAD - o.h) - s.y); }
      } else if (o.t === 'over') {
        const r = { x: o.x, y: 0, w: o.w, h: o.low };
        if (GT.rectHit(car, r)) return crash(s, 'STAY ON THE ROAD!');
        if (!o.passed && o.x + o.w < car.x) { o.passed = true; score(s, o, car.y - o.low); }
      } else if (o.t === 'gap') {
        if (!o.passed && o.x + o.w < car.x) { o.passed = true; score(s, o, 99); }
      }
    }
    for (const c of s.cells) {
      if (GT.circleRectHit(c.x, c.y, 14, car)) {
        c.got = true; c.s = 1; GT.tween(c, { s: 0 }, 0.2); s.tank = Math.min(1, s.tank + 0.45); GT.addScore(1);
        GT.sfx('powerup'); GT.burst(c.x, c.y, CYAN, 18, 200); GT.float('+TANK', c.x, c.y - 20, CYAN, 16);
      }
    }
    // Speed lines.
    if (GT.chance(0.5 + s.spd / 900)) s.lines.push({ x: GT.W + 20, y: GT.range(60, 600), l: GT.range(40, 140), v: GT.range(1.6, 3) });
    for (const l of s.lines) l.x -= s.spd * l.v * dt;
    s.lines = s.lines.filter((l) => l.x + l.l > 0);
    GT.music.set(GT.clamp(0.4 + GT.t / 40, 0.4, 1));
  },

  draw(s, ctx) {
    ctx.drawImage(sky(), 0, 0);
    const d = s.dist;
    tile(ctx, mountains(), d * 0.08, 440);
    tile(ctx, skyline(), d * 0.22, 505);
    // Haze over the city.
    ctx.fillStyle = GT.linear(ctx, 0, 380, 0, 520, ['rgba(255,63,164,0)', 'rgba(255,63,164,0.22)']);
    ctx.fillRect(0, 380, GT.W, 140);
    // Ground far below: neon grid.
    ctx.fillStyle = GT.linear(ctx, 0, 520, 0, GT.H, ['#2a0d4a', INK]); ctx.fillRect(0, 520, GT.W, 120);
    ctx.strokeStyle = 'rgba(63,240,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 6; i++) { const yy = 560 + i * i * 4; ctx.moveTo(0, yy); ctx.lineTo(GT.W, yy); }
    const off = (d * 0.6) % 40;
    for (let x = -off; x < GT.W + 40; x += 40) { ctx.moveTo(x, 556); ctx.lineTo(x + (x - 180) * 0.9, GT.H); }
    ctx.stroke();

    // Road deck (with gaps).
    const gaps = s.obs.filter((o) => o.t === 'gap').sort((a, b) => a.x - b.x);
    let x0 = -20;
    const segs = [];
    for (const g of gaps) { if (g.x > x0) segs.push([x0, g.x]); x0 = Math.max(x0, g.x + g.w); }
    segs.push([x0, GT.W + 20]);
    const deck = GT.material('metal', { w: 128, seed: 5, colors: ['#120a24', '#24163e', '#3a2a5e', '#56447e'] });
    for (const [a, b] of segs) {
      if (b - a < 2) continue;
      GT.fillTex(ctx, deck, a, ROAD, b - a, 22, { offsetX: d, scale: 1 });
      GT.rect(ctx, a, ROAD, b - a, 3, CYAN);
      GT.rect(ctx, a, ROAD + 19, b - a, 3, MAG);
      // Pylons.
      for (let px = Math.ceil((a + d) / 120) * 120 - d; px < b - 10; px += 120) {
        if (px < a + 10) continue;
        GT.rect(ctx, px - 6, ROAD + 22, 12, 140, '#1c1236'); GT.rect(ctx, px - 6, ROAD + 22, 3, 140, '#3a2a5e');
      }
      // Lane dashes.
      ctx.globalAlpha = 0.7;
      for (let lx = Math.ceil((a + d) / 36) * 36 - d; lx < b - 18; lx += 36) GT.rect(ctx, lx, ROAD + 10, 18, 2, SUN);
      ctx.globalAlpha = 1;
    }
    for (const g of gaps) {
      // Broken edges with sparks and warning lights.
      GT.glow(ctx, g.x, ROAD + 6, 22 + Math.sin(GT.t * 12) * 4, SUN, 0.8);
      GT.glow(ctx, g.x + g.w, ROAD + 6, 22 + Math.sin(GT.t * 12 + 2) * 4, SUN, 0.8);
      GT.rect(ctx, g.x - 4, ROAD, 4, 22, SUN); GT.rect(ctx, g.x + g.w, ROAD, 4, 22, SUN);
    }
    // Walls and overpasses.
    const wallTex = GT.material('metal', { w: 128, seed: 8, colors: ['#2a0a22', '#5a1446', '#8a2066', '#c03a8a'] });
    for (const o of s.obs) {
      if (o.t === 'wall') {
        GT.glow(ctx, o.x + o.w / 2, ROAD - o.h, 34, MAG, 0.7);
        GT.panel(ctx, o.x, ROAD - o.h, o.w, o.h, '#8a2066', { tex: wallTex, radius: 3 });
        for (let yy = ROAD - o.h + 8; yy < ROAD - 6; yy += 16) GT.rect(ctx, o.x + 3, yy, o.w - 6, 4, (Math.floor(yy / 16) % 2) ? SUN : INK);
        GT.rect(ctx, o.x, ROAD - o.h, o.w, 3, '#ffd0ea');
      } else if (o.t === 'over') {
        GT.panel(ctx, o.x, -10, o.w, o.low + 10, '#3a2a5e', { tex: deck, radius: 4 });
        GT.rect(ctx, o.x, o.low - 4, o.w, 4, CYAN);
        GT.glow(ctx, o.x + o.w / 2, o.low, 40, CYAN, 0.5);
        for (let lx = o.x + 14; lx < o.x + o.w - 10; lx += 28) GT.circle(ctx, lx, o.low - 10, 3, '#fff6c8');
        GT.text(ctx, 'LOW', o.x + o.w / 2, o.low - 30, 14, SUN, 'center', '900');
      }
    }
    // Energy cells.
    for (const c of s.cells) { GT.glow(ctx, c.x, c.y, 26, CYAN, 0.8); GT.drawSprite(ctx, 'cell', c.x, c.y + Math.sin(GT.t * 5 + c.x * 0.02) * 4); }

    // Speed lines.
    ctx.globalCompositeOperation = 'lighter';
    for (const l of s.lines) { ctx.globalAlpha = 0.35; GT.rect(ctx, l.x, l.y, l.l, 1.5, l.y < 300 ? SUN : CYAN); }
    // Thruster puffs (cold gas: white).
    for (const p of s.puffs) { ctx.globalAlpha = 0.55 * GT.clamp(p.life / p.max, 0, 1); GT.circle(ctx, p.x, p.y, p.r, WHITE); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    // The car.
    if (!s.air || s.y > ROAD - 40) GT.shadow(ctx, CX, ROAD + 2, 40, 5, 0.5 * GT.clamp(1 - (ROAD - s.y) / 200, 0, 1));
    const k = GT.spring('car', 1, 320, 12).v;
    const tilt = s.air ? GT.clamp(s.vy / 2400, -0.18, 0.18) : 0;
    ctx.save(); ctx.translate(CX, s.y); ctx.rotate(tilt); ctx.scale(2 - k, k);
    GT.glow(ctx, -52, -18, 18, '#ff2a4a', 0.7);
    GT.glow(ctx, 50, -11, 30, '#e8ffff', 0.5);
    if (s.air) GT.glow(ctx, 0, 2, 50, CYAN, 0.45);
    GT.drawSprite(ctx, 'car', 0, -17);
    if (s.air) GT.drawSprite(ctx, 'wing', -40, -32);
    for (const wx of [-30, 32]) wheel(ctx, wx, -4, s.wheel, s.air);
    ctx.restore();
    // Headlight beam.
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = GT.linear(ctx, CX + 46, 0, CX + 220, 0, ['rgba(232,255,255,0.28)', 'rgba(232,255,255,0)']);
    ctx.beginPath(); ctx.moveTo(CX + 46, s.y - 12); ctx.lineTo(CX + 230, s.y - 40); ctx.lineTo(CX + 230, s.y + 14); ctx.closePath(); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // HUD: thruster tank.
    const tx = GT.W - 132, ty = 78;
    GT.roundRect(ctx, tx - 4, ty - 4, 124, 18, 9, 'rgba(20,10,46,0.75)');
    GT.roundRect(ctx, tx, ty, 116 * s.tank, 10, 5, s.tank < 0.25 ? '#ff9f6b' : CYAN);
    GT.text(ctx, 'THRUST', GT.W - 12, ty + 30, 14, WHITE, 'right', '900');
    GT.text(ctx, `${Math.round(s.spd * 0.9)} KM/H`, GT.W - 12, GT.H - 22, 16, SUN, 'right', '900');
  },

  autopilot(s) {
    const err = GT.t > 18 ? (GT.t - 18) * 4 : 0;
    let target = 0;
    for (const o of s.obs) {
      const ahead = o.x - CX;
      if (o.t === 'over' && ahead < 90 && o.x + o.w > CX - 50) { target = -1; break; }
      if (o.t === 'wall' && ahead < 150 - err && o.x + o.w > CX - 50) target = Math.max(target, o.h + 34);
      if (o.t === 'gap' && ahead < 50 - err * 0.5 && o.x + o.w > CX - 10) target = Math.max(target, 50);
    }
    const alt = ROAD - s.y;
    const down = target > 0 && alt < target + (s.vy > 0 ? 20 : -10) && s.tank > 0;
    return { down, x: 180, y: 360 };
  },
});

function score(s, o, clear) {
  GT.addScore(1); GT.sfx('coin', { pitch: 1 + Math.min(0.5, GT.t / 120) });
  if (clear >= 0 && clear < 22 && o.t !== 'gap') { GT.addScore(2); GT.nearMiss(CX, s.y - 20, { text: 'CLOSE +2', color: SUN }); }
}

function crash(s, why) {
  GT.burst(CX, s.y - 12, MAG, 50, 300); GT.burst(CX, s.y - 12, WHITE, 30, 220); GT.burst(CX, s.y - 12, CYAN, 20, 260);
  GT.shake(18); GT.hitStop(6); GT.flash(MAG); GT.sfx('explode');
  GT.float(why, 180, 260, '#ff9f6b', 22); GT.over();
}

function spawn(s) {
  const t = GT.t, lv = GT.clamp(s.dist / 6000, 0, 1);
  const base = s.next - s.dist + 0; // screen-space offset from car's world
  const x = CX + (s.next - s.dist) + 300;
  const r = GT.rand();
  let len;
  if (s.dist < 50 && s.obs.length === 0) { // first: a barrier ~3s in
    s.obs.push({ t: 'wall', x, w: 26, h: 60 }); len = 26;
  } else if (r < 0.34) {
    const w = GT.range(110, 150 + 90 * lv); s.obs.push({ t: 'gap', x, w });
    s.cells.push({ x: x + w / 2, y: ROAD - GT.range(80, 140) }); len = w;
  } else if (r < 0.62) {
    const h = GT.range(50, 80 + 50 * lv); s.obs.push({ t: 'wall', x, w: 26, h }); len = 26;
    if (GT.chance(0.4)) s.cells.push({ x: x + 13, y: ROAD - h - 50 });
  } else if (r < 0.85) {
    const w = GT.range(140, 220); s.obs.push({ t: 'over', x, w, low: ROAD - CAR_H - 22 }); len = w;
    if (lv > 0.25 && GT.chance(0.55)) { const gw = GT.range(100, 140); s.obs.push({ t: 'gap', x: x + w + 70, w: gw }); len += 70 + gw; }
  } else {
    const h = GT.range(40, 60); s.obs.push({ t: 'wall', x, w: 26, h });
    const gw = GT.range(100, 130); s.obs.push({ t: 'gap', x: x + 150, w: gw }); len = 150 + gw;
  }
  s.next += len + GT.range(260, 380) - 90 * lv;
}

function wheel(ctx, x, y, a, air) {
  GT.circle(ctx, x, y, 11, '#0a0614');
  if (air) GT.glow(ctx, x, y, 14, CYAN, 0.8);
  GT.circle(ctx, x, y, 7.5, air ? CYAN : '#5a4a7e');
  ctx.strokeStyle = air ? WHITE : '#c8c0e8'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < 5; i++) { const t = a + i * 1.2566; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(t) * 7.5, y + Math.sin(t) * 7.5); }
  ctx.stroke(); GT.circle(ctx, x, y, 1.6, WHITE);
}

function tile(ctx, img, off, y) {
  const w = img.width, o = ((off % w) + w) % w;
  ctx.drawImage(img, -o, y - img.height); ctx.drawImage(img, w - o, y - img.height);
}

function sky() {
  return GT.bake('sky', GT.W, GT.H, (c) => {
    c.fillStyle = GT.linear(c, 0, 0, 0, 520, ['#0c0628', '#3a0f5e', '#a8227a', '#ff6a5a', '#ffb03a']);
    c.fillRect(0, 0, GT.W, GT.H);
    for (let i = 0; i < 70; i++) { c.globalAlpha = GT.range(0.2, 0.9) * (1 - i / 90); c.fillStyle = '#ffffff'; c.fillRect(GT.range(0, GT.W), GT.range(0, 220), 1.4, 1.4); }
    c.globalAlpha = 1;
    // The sun, with synthwave bands.
    const sx = 230, sy = 300, r = 110;
    c.fillStyle = GT.radial(c, sx, sy, r * 0.8, r * 2, ['rgba(255,120,90,0.5)', 'rgba(255,120,90,0)']); c.fillRect(0, 100, GT.W, 400);
    c.save(); c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.clip();
    c.fillStyle = GT.linear(c, 0, sy - r, 0, sy + r, ['#fff3a0', '#ffb03a', '#ff3fa4']); c.fillRect(sx - r, sy - r, r * 2, r * 2);
    c.fillStyle = '#a8227a';
    for (let i = 0; i < 7; i++) { const yy = sy + 6 + i * 15, h = 2 + i * 1.6; c.fillRect(sx - r, yy, r * 2, h); }
    c.restore();
  });
}

function mountains() {
  return GT.bake('mtn', 360, 120, (c) => {
    c.fillStyle = GT.linear(c, 0, 0, 0, 120, ['#5a1a6e', '#2a0d4a']);
    c.beginPath(); c.moveTo(0, 120);
    for (let x = 0; x <= 360; x += 20) c.lineTo(x, 50 + Math.sin(x * 0.0349) * 26 + Math.sin(x * 0.1047) * 14);
    c.lineTo(360, 120); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(255,63,164,0.6)'; c.lineWidth = 1.5; c.beginPath();
    for (let x = 0; x <= 360; x += 20) c.lineTo(x, 50 + Math.sin(x * 0.0349) * 26 + Math.sin(x * 0.1047) * 14);
    c.stroke();
  });
}

function skyline() {
  return GT.bake('city', 360, 200, (c) => {
    let x = 0, i = 0;
    while (x < 360) {
      const w = 18 + ((i * 37) % 24), h = 40 + ((i * 53) % 110);
      c.fillStyle = GT.linear(c, 0, 200 - h, 0, 200, ['#2e1252', '#160a30']);
      c.fillRect(x, 200 - h, w - 2, h);
      c.fillStyle = i % 3 ? 'rgba(63,240,255,0.55)' : 'rgba(255,176,58,0.6)';
      for (let yy = 200 - h + 6; yy < 196; yy += 9) for (let xx = x + 3; xx < x + w - 5; xx += 5) if (((xx * 7 + yy * 3 + i) % 5) < 2) c.fillRect(xx, yy, 2, 3);
      c.fillStyle = i % 2 ? '#ff3fa4' : '#3ff0ff'; c.fillRect(x, 200 - h, w - 2, 1.5);
      x += w; i++;
    }
  });
}
