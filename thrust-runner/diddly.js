/*
 * diddly.js — the runtime contract every diddly microgame runs on.
 *
 * A game is one call to GT.game({...}). The SDK owns everything else: the 9:16
 * canvas, input normalization, the fixed-timestep loop, the attract/play/over
 * lifecycle, HUD, juice (particles, shake, floaters, sfx), seeded RNG, and
 * telemetry to the host feed via postMessage.
 *
 * URL params: ?seed=N (deterministic RNG), ?qa (manual stepping via window.__gt),
 * ?speed=N (sim speed multiplier), ?mute, ?best=N (the host's remembered best score),
 * ?debug (diagnostics overlay), ?gl=flags (3D feature switches), ?inthread (see below).
 *
 * Two roles, one file (v11+). On a page this file is the SHELL; in a Worker it is the RUNTIME,
 * which loads the game's code (the data-game URL) and owns everything the game touches, drawing
 * into the page's canvas transferred as an OffscreenCanvas. A game that spins its thread then
 * freezes only its worker; the shell's watchdog terminates it and draws a crash screen. The shell
 * keeps what must stay on the page: the <canvas>, input, WebAudio, sprite rasterizing (SVG needs
 * <img>), the host bridge, the watchdog and window.__gt for QA.
 *
 * Shell and runtime (specs/sdk-shell/00-README.md). The site serves the working copy's shell at its
 * latest as /sdk/shell.js (stamped SHELL_BUILD) and each frozen release as a runtime at
 * /sdk/v<N>/diddly.js. The page's tag: <script src="/sdk/shell.js" data-game="<game.js>"
 * data-sdk="<N>|dev">. The shell picks a mode before it touches the page (window.__gtShell =
 * { build, mode, runtime }):
 *   host     data-sdk ≥ 11 or dev, with Worker and OffscreenCanvas: a blob Worker whose bootstrap
 *            importScripts the runtime URL (dev: /sdk/diddly.js), bracketed by `loading`, and
 *            posts `fail` if the import throws. init's sdkSrc is that URL.
 *   handoff  data-sdk ≤ 10, no OffscreenCanvas, ?inthread, or a Worker refused before hello: the
 *            pinned file goes on the page as a script (then game.js, for files before v11) and its
 *            own shell runs everything; this one attaches nothing (or takes back what it had).
 *   self     no data-sdk (old pages, the gallery, the compile harness): this file's own source in
 *            the Worker, or in-thread, as before the split.
 * The few per-version differences are the RT table in shellMain; otherwise the shell handles the
 * union of every hosted runtime's messages. Rules: shell → runtime is additive only (runtimes drop
 * unknown messages and fields); the shell leads (a runtime sends something new only once a deployed
 * shell handles it, and the shell keeps every handler a hosted version needs); init only grows;
 * SHELL_PROTOCOL (1) is bumped only for a change the additive rule can't express, and a runtime
 * declaring a higher protocol is refused with a visible reason.
 *
 * Messages, shell → runtime (all URLs absolute):
 *   init { canvas, url, sdkSrc, search, baseSeed, embedded, timeOrigin, vw, vh, dpr, shell }
 *   size { vw, vh, dpr } · input { k: down|move|up, x, y } | { k: key, code, down }
 *   host { cmd: pause|resume|best|tap, value } · sprites { bitmaps: [[name, bitmap, w, h] | [name, null, error]] }
 *   vis { hidden } (v15: the page was hidden or shown; the runtime stops its frame loop while hidden.
 *      For v11–v14 the bootstrap takes it instead and holds the runtime's frames while hidden)
 *   ping { id, at } · audioLine { text, state } (?debug) · music { lv }
 *   clips { token, ok: [[name, seconds]], failed: [[name, reason]] } (v12: the answer to the runtime's clips,
 *      once every clip is decoded or refused, echoing its token; a refused clips gets no answer)
 *   qa { op, id?, ... } (?qa: step n · overlay show · fingerprint grid · screenshot · inject src ·
 *      call name args, replied to; input k x y · swipe dir · autoplay on, not replied to)
 * runtime → shell (untrusted: game code can post too; unknown messages are dropped):
 *   hello { sdk, protocol } (both from v16; the shell kills a runtime that answers as another version or
 *      a newer protocol) · fail { message } (host mode's bootstrap, before hello only: the runtime didn't load)
 *   pong { id, wait, frameAgo, frameMs, frameGap } · loading { on } · emit { ev } · game { title, bg, music, kind }
 *   sprites { list: [[name, svg]] } · stats { stats } (?debug) · state { state } (?qa)
 *   qa { id, ok, value | error, state }
 *   audio { ops: [{ op: sfx|tone|phase|clock|music.set|music.mood, ..., qa? }] } (at most one per frame; under
 *      ?qa every op carries qa: true and the shell only records it, as window.__gt.audioLog)
 *   clips { token, list: [[name, ArrayBuffer, { seconds, channels, rate, loop? }]] } (v12, transferred: a bundle's audio
 *      for the page to decode. Taken once, before ready, at most 32 clips, 2 MiB each and 4 MiB together,
 *      after the shell's own WAV/MP3 header walk; anything else is dropped and counts toward the flood kill)
 * The `game` message's music may name bundle clips (v12): { loop } or { layers, over }, with the mood fields.
 * The `ready` event gains bundle: { files, bytes, ms } when the game has a bundle (v12; files and bytes
 * count the manifest).
 * The shell adds shell: SHELL_BUILD to every `ready` event it forwards, over whatever the event carried.
 *
 * Bundles (v12): GT.game({ bundle: 'sha256-<hex>' }) makes the runtime fetch b/<hex>.json and the files it
 * names from the game's own folder, check each (cap, hash, magic bytes, header against the manifest),
 * decode images into the sprite map, keep meshes for GT.asset(name).geometry(), and send audio to the
 * shell (clips, above). Any problem fails the load with a 'bundle: …' error and the crash screen.
 *
 * Stages (v13): a round is endless unless the game declares GT.game({ stages: { count } }) (0 or
 * absent: endless stages). GT.stage.index (1-based) · GT.stage.t (seconds in this stage) ·
 * GT.stage.next({ title ≤ 24, subtitle ≤ 40 }). In play, next() leads, after the step, to the
 * phase 'stage' (boot | attract | play | stage | over | crashed): the last frame frozen under an
 * intermission card until a tap (press and release) or the host's `tap`, then setup() for the
 * next stage in the same round. On the declared last stage next() is GT.win(). In attract it is a
 * 0.6 s banner and the next setup(), no intermission. Events: stage { stage: n (the stage cleared),
 * title, score, duration (s in that stage, 2 dp) }; over gains stage (the stage reached). No
 * start/retry at a stage; the next input in play emits activity at once. The audio op `phase`
 * carries 'stage', which the page's music treats as play; the sting is sfx 'stage'. Under ?qa
 * the state gains stage, stageT and stages (the count), the intermission continues by itself
 * after 30 steps (and its iris closes over 12 more), and __gt.call('stage') → { index, t, count }.
 *
 * Kinds and turns (v14): GT.game({ kind }) is 'arcade' (the default, and anything unknown), 'puzzle' or
 * 'turns'; the `game` message, the `ready` event, GT.kind and the ?qa state carry the word. A turns game
 * declares turns: { count 0..1000 (0: uncounted, the game ends the round), unit: 'shot' | [singular,
 * plural] (≤ 12 each), settle: 0..8 s (0.6) } and may give a settled(state) hook. GT.turns.count · .left
 * (count again at every round and stage) · .used (the round's, across stages) · .finishing ·
 * .use(n = 1) · .add(n = 1) · .set(n) (play and attract only; whole numbers, 0..1000). The step that takes
 * left to 0 by use() or set() starts finishing: from the next step update() gets blank input, and once
 * `settle` seconds have passed and settled(state) is true (an exception counts as true), or after 8 s
 * regardless, the round ends as GT.over() would and the over screen says OUT OF <PLURAL>. add()/set()
 * leaving turns cancel finishing; GT.over(), GT.win() and GT.stage.next() work during it. The HUD draws
 * "3 shots left" under the score (16 px at y 76) and toasts move down 24 px. puzzle: { solutions:
 * 'unique' | 'many' } is validated. Under ?qa the state gains turns (the count), turnsLeft, turnsUsed,
 * finishing, settleCapped (the 8 s cap ended this round), outOfTurns and solutions (null unless a
 * puzzle), and __gt.call('turns') → { count, left, used, finishing, unit }.
 */
(function diddly() {
  'use strict';

  // The platform functions the SDK itself calls, captured as this file starts: before any game code
  // runs, in the worker and on the page. Game code shares the worker's global (in-thread, the page's)
  // and can redefine any of them; the SDK's own messages, fetches, hashes, decodes, script loads,
  // timers and clocks use these copies, so a game can't interpose on them.
  const NATIVE = (() => {
    const g = typeof self !== 'undefined' ? self : globalThis;
    const bind = (o, k) => (o && typeof o[k] === 'function' ? o[k].bind(o) : null);
    return {
      postMessage: bind(g, 'postMessage'), fetch: bind(g, 'fetch'), createImageBitmap: bind(g, 'createImageBitmap'),
      importScripts: bind(g, 'importScripts'), setTimeout: bind(g, 'setTimeout'), clearTimeout: bind(g, 'clearTimeout'),
      digest: bind(g.crypto && g.crypto.subtle, 'digest'), randomValues: bind(g.crypto, 'getRandomValues'), random: Math.random,
    };
  })();
  const perfNow = performance.now.bind(performance);

  // Stamped by `npm run sdk:release` in the frozen copy at sdk/v<N>/diddly.js; 'dev' in the working copy.
  const SDK_VERSION = 'dev';
  // Stamped by the build in /sdk/shell.js (the git commit); 'v<N>' in a frozen copy; 'dev' here.
  const SHELL_BUILD = '58e3e931079a';
  const SHELL_PROTOCOL = 1; // design §4.2 rule 4: the shell↔runtime protocol this file speaks
  const W = 360, H = 640, STEP = 1 / 60;
  const THREE_REV = 186; // /sdk/three/r<rev>.js, loaded by 3D games (`three: true`)

  // ---------- seeded RNG (mulberry32) ----------
  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // GT.text, also used by the shell for its own crash screen.
  function drawText(c, str, x, y, size, color, align, weight, outline) {
    c.font = (weight || '800') + ' ' + (size || 24) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    c.textAlign = align || 'center'; c.textBaseline = 'middle';
    if (outline) { c.lineWidth = Math.max(3, (size || 24) / 7); c.strokeStyle = 'rgba(0,0,0,0.7)'; c.strokeText(str, x, y); }
    c.fillStyle = color || '#fff'; c.fillText(str, x, y);
  }

  // A game's kind (v14): 'puzzle', 'turns', or 'arcade' (the default, and the word for anything else).
  function kindOf(def) {
    const k = def && def.kind;
    return k === 'puzzle' || k === 'turns' ? k : 'arcade';
  }

  // ---------- audio engine ----------
  // Sound is synthesized, or (v12) comes from a bundle's clips, decoded by the shell. One AudioContext
  // on the page, created on the first user gesture (or earlier, suspended, to decode a bundle's clips)
  // and never under ?qa or ?mute; the runtime sends it commands (the
  // shell's audio section). The graph:
  //   voices ─► sfx bus ───────────────┐
  //   voices ─► filter per instrument ─► music bus ─► duck ─┴─► master ─► highpass 90 Hz ─► limiter
  // The highpass drops sub-bass a phone speaker can't play; the limiter stops layered sounds from
  // clipping. Music is a step sequencer: a mood preset plus the seed generate an 8-bar song (key,
  // chords, bass, drums, arp, lead) and a 50 ms timer schedules it 160 ms ahead, so the page's
  // thread does a little work 20 times a second and nothing per frame. The engine takes its
  // AudioContext as an argument, so ?debug can render the same music offline (GT.audio.render).
  // What follows is pure (engine state in, sound out); the shell holds the live engine.
  const TICK_MS = 50, AHEAD = 0.16;
  const quiet = (p) => { if (p && p.catch) p.catch(() => {}); };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // opts.limiter === false (offline renders only): the master chain is master gain → highpass →
  // destination, without the compressor or the 0.7 output trim, for stems that will pass the live
  // chain once when they play.
  function makeEngine(ac, seed, opts) {
    // cap: live voices before new ones are dropped (music thins out at 55% of it). Offline renders
    // schedule everything up front, so they lift it. solo: null, or the Set of music groups that
    // play (MUSIC_GROUPS); an offline render's stem.
    const E = { ac, voices: 0, cap: 90, rand: mulberry(seed), last: {}, log: null, m: null, held: false, err: '', solo: null };
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 3; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.15;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
    const out = ac.createGain();
    out.gain.value = 0.7;
    E.master = ac.createGain();
    if (opts && opts.limiter === false) { E.master.connect(hp); hp.connect(ac.destination); }
    else { E.master.connect(hp); hp.connect(comp); comp.connect(out); out.connect(ac.destination); }
    E.sfxBus = ac.createGain(); E.sfxBus.gain.value = 1; E.sfxBus.connect(E.master);
    E.duck = ac.createGain(); E.duck.connect(E.master);
    E.musicBus = ac.createGain(); E.musicBus.gain.value = 0.15; E.musicBus.connect(E.duck);
    E.buses = {};
    // One second of seeded white noise, looped from a random offset by every noise voice.
    const nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), nd = nb.getChannelData(0), nr = mulberry(0x5eed);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    E.noise = nb;
    // A 25% pulse wave for chiptune voices.
    const re = new Float32Array(32), im = new Float32Array(32);
    for (let k = 1; k < 32; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    E.pulse = ac.createPeriodicWave(re, im);
    return E;
  }

  // One synth voice: oscillator(s) → optional lowpass → ADSR gain → out. Fields of p:
  //   f Hz · t start · dur held seconds · v peak gain · w 'sine'|'square'|'sawtooth'|'triangle'|'pulse'
  //   a d s r envelope (s is a fraction of v) · to: slide to this Hz over st seconds (default dur)
  //   uni: cents, adds a detuned twin · detune: cents · lp: lowpass Hz, swept from lpA over lpT · q
  //   fm: [ratio, index] sine modulator · vib: [rate Hz, depth cents]
  function voice(E, out, p) {
    if (E.voices > E.cap || !(p.v > 0)) return;
    const ac = E.ac, t = Math.max(p.t, ac.currentTime);
    const a = p.a || 0.003, d = p.d || 0.08, r = p.r || 0.05, s = p.s == null ? 0.6 : p.s;
    const peak = p.v * (p.uni ? 0.7 : 1), sus = Math.max(peak * s, 0.0001), end = Math.max(t + p.dur, t + a + d);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(sus, t + a + d);
    g.gain.setValueAtTime(sus, end);
    g.gain.exponentialRampToValueAtTime(0.0001, end + r);
    g.connect(out);
    let dest = g;
    if (p.lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = p.q || 0.7;
      f.frequency.value = p.lpA || p.lp; f.frequency.setValueAtTime(p.lpA || p.lp, t);
      if (p.lpA) f.frequency.exponentialRampToValueAtTime(p.lp, t + (p.lpT || a + d));
      f.connect(g); dest = f;
    }
    // A voice with no sustain is silent once it decays, so its oscillators stop there.
    const oscs = [], mods = [], stop = (s === 0 ? Math.min(end + r, t + a + d) : end + r) + 0.02;
    const mk = (cents) => {
      const o = ac.createOscillator();
      if (p.w === 'pulse') o.setPeriodicWave(E.pulse); else o.type = p.w || 'square';
      // The value first, then the automation: an oscillator whose frequency sits at its 440 Hz default
      // until a setValueAtTime at its start begins at a phase that depends on the absolute time, so
      // the same note never rendered the same twice (and a rendered loop's periods didn't match).
      o.frequency.value = p.f; o.frequency.setValueAtTime(p.f, t);
      if (p.to) o.frequency.exponentialRampToValueAtTime(Math.max(20, p.to), t + (p.st || p.dur));
      o.detune.value = cents + (p.detune || 0);
      o.connect(dest); oscs.push(o);
    };
    mk(p.uni ? -p.uni : 0);
    if (p.uni) mk(p.uni);
    if (p.fm) {
      const m = ac.createOscillator(), mg = ac.createGain(), depth = p.f * p.fm[1];
      m.frequency.value = p.f * p.fm[0];
      mg.gain.setValueAtTime(depth, t);
      mg.gain.exponentialRampToValueAtTime(depth * 0.15 + 0.01, end + r);
      m.connect(mg);
      for (const o of oscs) mg.connect(o.frequency);
      mods.push(m);
    }
    if (p.vib) {
      const l = ac.createOscillator(), lg = ac.createGain();
      l.frequency.value = p.vib[0]; lg.gain.value = p.vib[1];
      l.connect(lg);
      for (const o of oscs) lg.connect(o.detune);
      mods.push(l);
    }
    for (const o of oscs.concat(mods)) { o.start(t); o.stop(stop); }
    E.voices++;
    oscs[0].onended = () => { E.voices--; };
  }

  // A noise burst: seeded white noise → optional filter (swept from f to fTo) → attack a, then an
  // exponential decay to silence at dur.
  function noise(E, out, p) {
    if (E.voices > E.cap || !(p.v > 0)) return;
    const ac = E.ac, t = Math.max(p.t, ac.currentTime), a = p.a || 0.002, end = t + Math.max(p.dur, a + 0.005);
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = E.noise; src.loop = true;
    let node = src;
    if (p.type) {
      const f = ac.createBiquadFilter();
      f.type = p.type; f.Q.value = p.q || 0.7;
      f.frequency.value = p.f; f.frequency.setValueAtTime(p.f, t);
      if (p.fTo) f.frequency.exponentialRampToValueAtTime(p.fTo, end);
      src.connect(f); node = f;
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(p.v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    node.connect(g); g.connect(out);
    src.start(t, E.rand() * 0.9); src.stop(end + 0.02);
    E.voices++;
    src.onended = () => { E.voices--; };
  }

  // One fixed filter per music instrument, shared by all its notes: a filter per note (worse, a
  // swept one, which recomputes its coefficients every sample) is the audio thread's biggest cost.
  function bus(E, key, type, f, q) {
    let b = E.buses[key];
    if (!b) {
      b = E.buses[key] = E.ac.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q || 0.7;
      b.connect(E.musicBus);
    }
    return b;
  }

  // Music dips under big hits so they punch through, then swells back.
  function duck(E, t, depth, hold) {
    const g = E.duck.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
    g.setTargetAtTime(depth, t, 0.012);
    g.setTargetAtTime(1, t + hold, 0.18);
  }

  // Sound effects: (engine, time, pitch multiplier, volume multiplier, opts). playSfx adds a little
  // random detune and level to every play, so repeats never sound machine-gunned.
  const PENTA = [0, 2, 4, 7, 9];
  const SFX = {
    tap(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 540 * p, w: 'square', dur: 0.02, v: 0.26 * v, a: 0.001, d: 0.06, s: 0, lp: 3200 });
      noise(E, E.sfxBus, { t, dur: 0.015, v: 0.1 * v, type: 'highpass', f: 3000 });
    },
    point(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 660 * p, w: 'square', dur: 0.05, v: 0.18 * v, d: 0.06, s: 0.4, lp: 4000 });
      voice(E, E.sfxBus, { t: t + 0.06, f: 990 * p, w: 'square', dur: 0.08, v: 0.18 * v, d: 0.1, s: 0.35, r: 0.08, lp: 4000 });
      voice(E, E.sfxBus, { t: t + 0.06, f: 1980 * p, w: 'sine', dur: 0.05, v: 0.07 * v, d: 0.15, s: 0 });
    },
    power(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 300 * p, to: 1200 * p, dur: 0.35, v: 0.2 * v, w: 'sawtooth', uni: 8, a: 0.01, d: 0.3, s: 0.6, r: 0.1, lp: 4000, lpA: 600, lpT: 0.3 });
      [1, 1.26, 1.5, 2].forEach((k, j) => voice(E, E.sfxBus, { t: t + 0.12 + j * 0.06, f: 1046 * p * k, w: 'sine', dur: 0.04, v: 0.08 * v, d: 0.12, s: 0 }));
    },
    hit(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 190 * p, to: 55 * p, dur: 0.16, v: 0.28 * v, w: 'sawtooth', a: 0.001, d: 0.18, s: 0.3, lp: 1800 });
      noise(E, E.sfxBus, { t, dur: 0.12, v: 0.34 * v, type: 'lowpass', f: 2500, fTo: 300 });
    },
    lose(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 400 * p, to: 70 * p, dur: 0.6, v: 0.3 * v, w: 'triangle', a: 0.005, d: 0.6, s: 0.5, r: 0.15 });
      voice(E, E.sfxBus, { t, f: 200 * p, to: 50 * p, dur: 0.5, v: 0.14 * v, w: 'square', a: 0.005, d: 0.5, s: 0.4, lp: 900 });
      noise(E, E.sfxBus, { t, dur: 0.35, v: 0.32 * v, type: 'lowpass', f: 900, fTo: 120 });
    },
    whoosh(E, t, p, v) {
      noise(E, E.sfxBus, { t, dur: 0.2, a: 0.05, v: 0.34 * v, type: 'bandpass', f: 2600 * p, fTo: 500 * p, q: 1.4 });
      voice(E, E.sfxBus, { t, f: 900 * p, to: 300 * p, dur: 0.12, v: 0.05 * v, w: 'sine', d: 0.12, s: 0 });
    },
    jump(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 220 * p, to: 660 * p, st: 0.1, dur: 0.08, v: 0.18 * v, w: 'square', d: 0.14, s: 0.25, r: 0.04, lp: 2600 });
    },
    land(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 150 * p, to: 50, st: 0.08, dur: 0.06, v: 0.4 * v, w: 'sine', a: 0.001, d: 0.12, s: 0 });
      voice(E, E.sfxBus, { t, f: 300 * p, to: 100, st: 0.06, dur: 0.04, v: 0.12 * v, w: 'triangle', a: 0.001, d: 0.08, s: 0 });
      noise(E, E.sfxBus, { t, dur: 0.07, v: 0.22 * v, type: 'lowpass', f: 900 });
    },
    coin(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 988 * p, w: 'square', dur: 0.06, v: 0.15 * v, d: 0.07, s: 0.7, r: 0.02, lp: 5000 });
      voice(E, E.sfxBus, { t: t + 0.065, f: 1319 * p, w: 'square', dur: 0.2, v: 0.15 * v, d: 0.25, s: 0.35, r: 0.12, lp: 5000 });
    },
    powerup(E, t, p, v) {
      [0, 4, 7, 12, 16, 19, 24].forEach((k, j) => {
        const f = 392 * p * Math.pow(2, k / 12);
        voice(E, E.sfxBus, { t: t + j * 0.045, f, w: 'square', dur: 0.04, v: 0.12 * v, d: 0.08, s: 0.4, r: 0.05, lp: 4000 });
        voice(E, E.sfxBus, { t: t + j * 0.045, f: f / 2, w: 'triangle', dur: 0.04, v: 0.08 * v, d: 0.08, s: 0.4, r: 0.05 });
      });
    },
    hurt(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 330 * p, to: 130 * p, dur: 0.2, v: 0.26 * v, w: 'sawtooth', uni: 25, d: 0.22, s: 0.4, lp: 2400, fm: [0.5, 1.2] });
      noise(E, E.sfxBus, { t, dur: 0.1, v: 0.24 * v, type: 'bandpass', f: 900 });
    },
    explode(E, t, p, v) {
      noise(E, E.sfxBus, { t, dur: 0.9, a: 0.003, v: 0.6 * v, type: 'lowpass', f: 4000 * p, fTo: 120 });
      noise(E, E.sfxBus, { t, dur: 0.25, v: 0.14 * v, type: 'highpass', f: 3000 });
      voice(E, E.sfxBus, { t, f: 110 * p, to: 30, st: 0.5, dur: 0.3, v: 0.55 * v, w: 'sine', a: 0.002, d: 0.5, s: 0 });
      voice(E, E.sfxBus, { t, f: 220 * p, to: 60, st: 0.3, dur: 0.2, v: 0.16 * v, w: 'triangle', a: 0.002, d: 0.3, s: 0 });
    },
    click(E, t, p, v) {
      noise(E, E.sfxBus, { t, dur: 0.018, v: 0.35 * v, type: 'bandpass', f: 3500 * p, q: 2 });
      voice(E, E.sfxBus, { t, f: 1500 * p, w: 'sine', dur: 0.01, v: 0.08 * v, a: 0.001, d: 0.03, s: 0 });
    },
    tick(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 1800 * p, w: 'sine', dur: 0.01, v: 0.14 * v, a: 0.001, d: 0.035, s: 0 });
      voice(E, E.sfxBus, { t, f: 3600 * p, w: 'triangle', dur: 0.01, v: 0.03 * v, a: 0.001, d: 0.02, s: 0 });
    },
    swoosh(E, t, p, v) {
      noise(E, E.sfxBus, { t, dur: 0.3, a: 0.14, v: 0.6 * v, type: 'bandpass', f: 500 * p, fTo: 3200 * p, q: 1.2 });
    },
    win(E, t, p, v) {
      [0, 4, 7, 12].forEach((k, j) => {
        const f = 523 * p * Math.pow(2, k / 12), last = j === 3;
        voice(E, E.sfxBus, { t: t + j * 0.08, f, w: 'square', dur: last ? 0.3 : 0.06, v: 0.13 * v, d: 0.1, s: 0.5, r: last ? 0.2 : 0.04, lp: 4500 });
        voice(E, E.sfxBus, { t: t + j * 0.08, f, w: 'triangle', dur: last ? 0.3 : 0.06, v: 0.1 * v, d: 0.1, s: 0.5, r: last ? 0.2 : 0.04 });
      });
      voice(E, E.sfxBus, { t: t + 0.3, f: 2093 * p, w: 'sine', dur: 0.05, v: 0.06 * v, d: 0.3, s: 0 });
    },
    // v13: a stage cleared (GT.stage.next). Two bell-like notes rising a fifth: lighter than `win`'s
    // four-note square fanfare, so a stage never sounds like the end of the round.
    stage(E, t, p, v) {
      [0, 7].forEach((k, j) => {
        const f = 784 * p * Math.pow(2, k / 12), last = j === 1;
        voice(E, E.sfxBus, { t: t + j * 0.1, f, w: 'triangle', dur: last ? 0.2 : 0.07, v: 0.17 * v, a: 0.003, d: 0.12, s: 0.45, r: last ? 0.3 : 0.05 });
        voice(E, E.sfxBus, { t: t + j * 0.1, f: f * 2, w: 'sine', dur: 0.02, v: 0.07 * v, a: 0.002, d: last ? 0.4 : 0.14, s: 0 });
      });
    },
    // opts.n: the combo count. Each step climbs the pentatonic scale (in the music's key when a
    // song is playing), up to two octaves.
    combo(E, t, p, v, o) {
      const n = Math.max(1, Math.floor(Number(o.n) || 1)), S = E.m && E.m.song;
      let base = S ? S.root : 72;
      while (base < 72) base += 12;
      const k = Math.min(24, PENTA[(n - 1) % 5] + 12 * Math.floor((n - 1) / 5)), f = mtof(base + k) * p;
      voice(E, E.sfxBus, { t, f, w: 'square', dur: 0.07, v: 0.15 * v, d: 0.1, s: 0.4, r: 0.06, lp: 5000 });
      voice(E, E.sfxBus, { t, f: f * 2, w: 'sine', dur: 0.05, v: 0.06 * v, d: 0.15, s: 0 });
      if (n >= 5) voice(E, E.sfxBus, { t: t + 0.05, f: f * 1.5, w: 'triangle', dur: 0.08, v: 0.08 * v, d: 0.12, s: 0.3 });
    },
    splash(E, t, p, v) {
      noise(E, E.sfxBus, { t, dur: 0.3, a: 0.004, v: 0.5 * v, type: 'bandpass', f: 1600 * p, fTo: 500 * p, q: 0.8 });
      for (let j = 0; j < 4; j++) {
        const f = (700 + E.rand() * 1300) * p;
        voice(E, E.sfxBus, { t: t + 0.02 + j * 0.035, f, to: f * 1.8, st: 0.05, dur: 0.03, v: 0.12 * v, w: 'sine', d: 0.06, s: 0 });
      }
    },
    bounce(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 170 * p, to: 340 * p, st: 0.07, dur: 0.12, v: 0.3 * v, w: 'triangle', d: 0.2, s: 0.2, r: 0.06, vib: [22, 45] });
    },
    select(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 660 * p, w: 'triangle', dur: 0.04, v: 0.18 * v, d: 0.06, s: 0.4 });
      voice(E, E.sfxBus, { t: t + 0.05, f: 990 * p, w: 'triangle', dur: 0.06, v: 0.18 * v, d: 0.1, s: 0.3 });
    },
    error(E, t, p, v) {
      voice(E, E.sfxBus, { t, f: 233 * p, w: 'square', dur: 0.08, v: 0.13 * v, uni: 18, d: 0.1, s: 0.7, lp: 1400 });
      voice(E, E.sfxBus, { t: t + 0.11, f: 185 * p, w: 'square', dur: 0.16, v: 0.13 * v, uni: 18, d: 0.1, s: 0.7, lp: 1400 });
    },
  };
  const DUCK = { hit: [0.5, 0.12], hurt: [0.5, 0.15], lose: [0.25, 0.8], explode: [0.3, 0.45] };

  function playSfx(E, name, o, t) {
    const fn = SFX[name];
    if (!fn) return;
    // The same sound within 30 ms plays once: 30 coins collected in one frame make one coin sound.
    if (t - (E.last[name] == null ? -1 : E.last[name]) < 0.03) return;
    E.last[name] = t;
    o = o || {};
    const p = (o.pitch > 0 ? o.pitch : 1) * (1 + (E.rand() - 0.5) * 0.06);
    const v = Math.min(2, o.vol >= 0 ? o.vol : 1) * (0.88 + E.rand() * 0.24);
    fn(E, t, p, v, o);
    if (DUCK[name] && E.m) duck(E, t, DUCK[name][0], DUCK[name][1]);
  }

  // ----- music -----
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], harmonic: [0, 2, 3, 5, 7, 8, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  };
  const semi = (sc, d) => Math.floor(d / 7) * 12 + sc[((d % 7) + 7) % 7];
  // Instrument patches for voice(); g scales the track's level.
  const PATCH = {
    square: { w: 'square', uni: 7, lp: 2400, lpA: 4200, lpT: 0.15, a: 0.004, d: 0.1, s: 0.55, r: 0.06, g: 0.8 },
    pluck: { w: 'triangle', a: 0.002, d: 0.22, s: 0.25, r: 0.08, g: 1.2 },
    bell: { w: 'sine', fm: [2, 1.2], a: 0.003, d: 0.5, s: 0.2, r: 0.35, g: 1.1 },
    saw: { w: 'sawtooth', uni: 9, lp: 1500, lpA: 3200, lpT: 0.12, q: 2.5, a: 0.004, d: 0.1, s: 0.7, r: 0.05, g: 0.7 },
    ghost: { w: 'triangle', vib: [5.2, 22], a: 0.05, d: 0.2, s: 0.85, r: 0.2, g: 1.1 },
    chip: { w: 'pulse', a: 0.001, d: 0.06, s: 0.6, r: 0.02, g: 0.55 },
    brass: { w: 'sawtooth', uni: 7, lp: 2000, lpA: 450, lpT: 0.07, q: 1.2, a: 0.03, d: 0.15, s: 0.8, r: 0.08, g: 0.75 },
    // Pads play one oscillator per note, each note detuned a little differently (see playStep):
    // a chorus for a third of the cost of a detuned twin per note.
    padSaw: { w: 'sawtooth', lp: 1100, a: 0.25, d: 0.4, s: 0.7, r: 0.4, g: 0.6 },
    padTri: { w: 'triangle', a: 0.12, d: 0.3, s: 0.7, r: 0.3, g: 0.9 },
    padWarm: { w: 'triangle', lp: 1400, a: 0.5, d: 0.5, s: 0.8, r: 0.8, g: 1 },
    padDark: { w: 'sawtooth', lp: 650, a: 0.4, d: 0.5, s: 0.8, r: 0.6, g: 0.7 },
    padChip: { w: 'pulse', lp: 2500, a: 0.01, d: 0.25, s: 0.3, r: 0.1, g: 0.45 },
    bassSaw: { w: 'sawtooth', lp: 700, lpA: 1600, lpT: 0.12, q: 2, a: 0.004, d: 0.12, s: 0.6, r: 0.04, g: 1 },
    bassSq: { w: 'square', lp: 900, a: 0.004, d: 0.1, s: 0.7, r: 0.04, g: 0.8 },
    bassTri: { w: 'triangle', a: 0.006, d: 0.3, s: 0.7, r: 0.1, g: 1.4 },
    bassChip: { w: 'triangle', a: 0.001, d: 0.05, s: 0.9, r: 0.02, g: 1.4 },
    arpPluck: { w: 'square', lp: 1800, lpA: 5000, lpT: 0.08, a: 0.002, d: 0.09, s: 0, r: 0.04, g: 0.6 },
    arpBell: { w: 'sine', fm: [3, 0.8], a: 0.002, d: 0.35, s: 0, r: 0.2, g: 1 },
    arpChip: { w: 'pulse', a: 0.001, d: 0.05, s: 0.3, r: 0.02, g: 0.5 },
  };
  // One bar of 16th notes per drum: x = hit, o = soft hit. X is an extra layer for high
  // intensity, played on kit piece `x`. `open`: offbeat hats ring open. `clap`: clap for snare.
  const GROOVES = {
    four: { K: 'x...x...x...x...', S: '....x.......x...', H: '..x...x...x...x.', X: 'o.o.o.o.o.o.o.o.', x: 'H', open: true },
    bouncy: { K: 'x.....x...x.....', S: '....x.......x...', H: 'x.o.x.o.x.o.x.o.', X: '..........o....o', x: 'S', clap: true },
    soft: { K: 'x.........x.....', S: '........o.......', H: '..o...o...o...o.', X: 'o.o.o.o.o.o.o.o.', x: 'H' },
    drive: { K: 'x..x..x.x..x..x.', S: '....x.......x...', H: 'oooooooooooooooo', X: 'x.....x.....x.x.', x: 'T' },
    sparse: { K: 'x.........x.....', S: '........x.......', H: '....o.......o...', X: '..o...o...o...o.', x: 'H' },
    chip: { K: 'x...x...x...x...', S: '....x.......x...', H: 'x.x.x.x.x.x.x.x.', X: '.o.o.o.o.o.o.o.o', x: 'H' },
    march: { K: 'x.......x.......', S: '....x..o....x.oo', H: '..x...x...x...x.', X: 'o.oo....o.oo....', x: 'S' },
  };
  // progs: 4-bar chord loops as scale degrees (0 = I). dens: the lead's odds of a note on beats,
  // 8ths and 16ths. arp: 1 = 16ths, 2 = 8ths. leadAt: the intensity the lead comes in at.
  const MOODS = {
    arcade: { bpm: [122, 134], scales: ['major', 'mixolydian'], progs: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 5, 4]], groove: 'four', bass: 'octave', arp: 1, lead: 'square', pad: 'padSaw', bassP: 'bassSaw', arpP: 'arpPluck', dens: [0.85, 0.55, 0.2] },
    playful: { bpm: [108, 120], scales: ['major'], progs: [[0, 3, 4, 0], [0, 5, 1, 4], [0, 3, 0, 4], [3, 4, 0, 5]], groove: 'bouncy', bass: 'bounce', arp: 2, lead: 'pluck', pad: 'padTri', bassP: 'bassSq', arpP: 'arpBell', dens: [0.8, 0.45, 0.06], swing: 0.16 },
    calm: { bpm: [70, 82], scales: ['major'], progs: [[0, 3, 5, 4], [0, 5, 3, 1], [3, 0, 5, 4], [0, 2, 3, 4]], groove: 'soft', bass: 'long', arp: 2, lead: 'bell', pad: 'padWarm', bassP: 'bassTri', arpP: 'arpBell', dens: [0.5, 0.15, 0], swing: 0.1, sevenths: true, leadAt: 0.55, drumVol: 0.55 },
    tense: { bpm: [134, 148], scales: ['minor'], progs: [[0, 5, 6, 4], [0, 0, 5, 6], [0, 3, 5, 4], [0, 6, 5, 6]], groove: 'drive', bass: 'pulse', arp: 1, lead: 'saw', pad: 'padDark', bassP: 'bassSaw', arpP: 'arpPluck', dens: [0.75, 0.5, 0.3] },
    spooky: { bpm: [80, 94], scales: ['harmonic'], progs: [[0, 5, 3, 4], [0, 3, 5, 4], [0, 1, 0, 4], [0, 5, 1, 4]], groove: 'sparse', bass: 'long', arp: 2, lead: 'ghost', pad: 'padDark', bassP: 'bassTri', arpP: 'arpBell', dens: [0.5, 0.2, 0.05], leadAt: 0.55, drumVol: 0.8 },
    retro: { bpm: [140, 156], scales: ['major', 'minor'], progs: [[0, 5, 3, 4], [0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 0, 4]], groove: 'chip', bass: 'octave', arp: 1, lead: 'chip', pad: 'padChip', bassP: 'bassChip', arpP: 'arpChip', dens: [0.85, 0.6, 0.25], chip: true },
    heroic: { bpm: [100, 112], scales: ['major'], progs: [[0, 4, 5, 3], [0, 3, 4, 0], [5, 3, 0, 4], [0, 5, 3, 4]], groove: 'march', bass: 'gallop', arp: 2, lead: 'brass', pad: 'padSaw', bassP: 'bassSaw', arpP: 'arpPluck', dens: [0.85, 0.35, 0.12] },
  };
  const fold = (m, lo, hi) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };
  // Key and tempo follow the game's seed; chords, bass, drums and melody follow the round's.
  const songSeeds = (seed, round) => [(seed ^ 0x3c6ef372) >>> 0, ((seed + round * 7919) ^ 0x2545f491) >>> 0];

  // An 8-bar song: bars 1–4 are the mood's chord loop, bars 5–8 repeat its start and end on the
  // dominant (V, with a raised leading tone in minor keys) so the loop resolves as it restarts.
  function genSong(def, keySeed, seed) {
    const P = MOODS[def.mood];
    if (!P) return null;
    const kr = mulberry(keySeed), r = mulberry(seed);
    const scale = P.scales[Math.floor(kr() * P.scales.length)], root = 52 + Math.floor(kr() * 12);
    const bpm = Math.round(Math.max(50, Math.min(200, Number(def.tempo) || P.bpm[0] + kr() * (P.bpm[1] - P.bpm[0]))));
    const minor = SCALES[scale][2] === 3, prog = P.progs[Math.floor(r() * P.progs.length)];
    const S = {
      mood: def.mood, P, bpm, root, scale, bars: 8, step: 0, t: 0, swing: P.swing || 0, leadAt: P.leadAt || 0.7,
      groove: GROOVES[P.groove], arpPat: Math.floor(r() * 3), arpSeq: [], kick14: r() < 0.5, bass: [], lead: [],
    };
    for (let k = 0; k < 16; k++) S.arpSeq.push(Math.floor(r() * 4));
    S.chords = prog.concat([prog[0], prog[1], prog[2], 4]).map((c, bar) => {
      const sc = minor && c === 4 && bar === 7 ? SCALES.harmonic : SCALES[scale];
      const pad = (P.sevenths ? [0, 2, 4, 6] : [0, 2, 4]).map((k) => fold(root + semi(sc, c + k), 55, 74)).sort((x, y) => x - y);
      const arp = pad.map((m) => fold(m + 12, 64, 83)).sort((x, y) => x - y);
      return { c, sc, pad, arp, bass: fold(root - 12 + semi(sc, c), 45, 56), fifth: semi(sc, c + 4) - semi(sc, c) };
    });
    S.chords.forEach((ch, b) => bassLine(S, P, b, ch, S.chords[(b + 1) % 8], r));
    genLead(S, P, r);
    return S;
  }
  function bassLine(S, P, bar, ch, next, r) {
    const R = ch.bass, F = R + ch.fifth, O = R + 12;
    const add = (s, m, len, v) => { S.bass[bar * 16 + s] = { m, len, v }; };
    if (P.bass === 'octave') for (let s = 0; s < 16; s += 2) add(s, s % 4 ? O : R, 1.5, s % 4 ? 0.75 : 1);
    else if (P.bass === 'bounce') {
      add(0, R, 3, 1); add(6, F, 2, 0.8); add(8, R, 3, 0.9); add(12, r() < 0.5 ? O : F, 2, 0.8);
      if (r() < 0.6) add(14, next.bass - 1, 1.5, 0.6); // a chromatic step into the next chord
    } else if (P.bass === 'long') { add(0, R, 12, 1); if (r() < 0.5) add(12, F, 4, 0.7); }
    else if (P.bass === 'pulse') for (let s = 0; s < 16; s += 2) add(s, s === 14 && r() < 0.5 ? F : R, 1.6, s % 4 ? 0.7 : 1);
    else [0, 3, 4, 6, 8, 11, 12, 14].forEach((s) => add(s, s === 12 ? F : R, s % 4 === 3 ? 1 : 1.6, s % 4 ? 0.75 : 1)); // gallop
  }
  // The lead: a 2-bar motif (rhythm by metrical weight; chord tones on beats, steps between),
  // stated, sequenced over the next chords, restated, then a cadence phrase that lands on a long
  // chord tone of V at bar 8.
  function genLead(S, P, r) {
    const lead = S.lead = new Array(S.bars * 16).fill(null), dn = P.dens, maxLen = dn[1] < 0.3 ? 8 : 4;
    const rhythm = (len) => {
      const on = [];
      for (let s = 0; s < len; s++) if (r() < (s % 16 === 0 ? 0.95 : s % 4 === 0 ? dn[0] : s % 2 === 0 ? dn[1] : dn[2])) on.push(s);
      return on;
    };
    let cur = 2 + Math.floor(r() * 3), dir = 1;
    const pitch = (i) => {
      const ch = S.chords[i >> 4];
      if (i % 4 === 0 || r() < 0.2) {
        let bd = 99;
        for (let o = -7; o <= 14; o += 7) for (let k = 0; k < 5; k += 2) {
          const dg = ch.c + k + o, dist = Math.abs(dg - cur) + r() * 1.5;
          if (dg >= -3 && dg <= 9 && dist < bd) { bd = dist; cur = dg; }
        }
      } else {
        const x = r();
        if (x > 0.12) cur += x > 0.88 ? 2 * dir : dir;
        if (cur >= 8) dir = -1; else if (cur <= -2) dir = 1; else if (r() < 0.25) dir = -dir;
        cur = Math.max(-3, Math.min(9, cur));
      }
      return S.root + 12 + semi(ch.sc, cur);
    };
    const place = (bar0, onsets, span) => onsets.forEach((s, k) => {
      const nx = k + 1 < onsets.length ? onsets[k + 1] : span;
      lead[bar0 * 16 + s] = { m: pitch(bar0 * 16 + s), len: Math.max(1, Math.min(maxLen, nx - s)) };
    });
    const A = rhythm(32).filter((s) => s < 26 || r() < 0.25); // the motif breathes before it repeats
    place(0, A, 32);
    place(2, A, 32);
    for (let i = 0; i < 32; i++) lead[64 + i] = lead[i];
    place(6, rhythm(16).concat([16]), 26);
    lead[112].len = 10;
  }

  function inst(E, name, m, t, dur, v, extra) {
    const P = PATCH[name];
    const out = P.lp ? bus(E, name, 'lowpass', P.lp, P.q) : E.musicBus;
    voice(E, out, Object.assign({}, P, { lp: 0, lpA: 0, f: mtof(m), t, dur, v: v * (P.g || 1) }, extra));
    if (E.log) E.log.push(m);
  }
  const hitAt = (str, s) => (str[s] === 'x' ? 1 : str[s] === 'o' ? 0.5 : 0);
  // The instrument groups an offline render can solo (GT.audio.render's `solo`): each scheduled note
  // belongs to exactly one, so the groups' renders sum to the whole song.
  const MUSIC_GROUPS = ['pad', 'bass', 'drums', 'arp', 'lead', 'fills', 'perc'];
  function playStep(E, S, i, t, lv) {
    const P = S.P, G = S.groove, bar = i >> 4, s = i & 15, sd = 15 / S.bpm, ch = S.chords[bar];
    const vel = 0.75 + 0.25 * lv, dv = (P.drumVol || 1) * vel, chip = !!P.chip, busy = E.voices > E.cap * 0.55;
    const on = (g) => !E.solo || E.solo.has(g);
    if (s === 0 && on('pad')) ch.pad.forEach((m, k) => inst(E, P.pad, m, t, 16 * sd * 0.98, 0.07 * (0.5 + 0.5 * lv), { uni: 0, detune: (k - 1) * 9 }));
    const b = S.bass[i];
    if (lv >= 0.15 && b && on('bass')) inst(E, P.bassP, b.m, t, b.len * sd, 0.3 * b.v * vel);
    if (lv >= 0.3) {
      let k = hitAt(G.K, s);
      if (!k && S.kick14 && s === 14 && bar % 2 === 1) k = 0.5;
      if (k && on('drums')) drum(E, 'K', t, k * dv, chip);
      const h = hitAt(G.H, s);
      if (h && !busy && on('drums')) drum(E, G.open && s % 4 === 2 ? 'O' : 'H', t, h * dv, chip);
      if (lv >= 0.45) {
        // A fill replaces the snare in its steps: the fill is 'fills', the snare 'drums'.
        if (lv >= 0.7 && bar % 4 === 3 && s >= 12) { if (on('fills')) drum(E, G.x === 'T' ? 'T' : 'S', t, (0.45 + (s - 12) * 0.15) * dv, chip, s); }
        else { const sn = hitAt(G.S, s); if (sn && on('drums')) drum(E, G.clap ? 'C' : 'S', t, sn * dv, chip); }
      }
      const xh = lv >= 0.85 && !busy && hitAt(G.X, s);
      if (xh && on('perc')) drum(E, G.x, t, xh * 0.7 * dv, chip, s);
    }
    if (lv >= 0.55 && !busy && s % P.arp === 0 && on('arp')) {
      const n = ch.arp.length, k = s / P.arp, per = 2 * n - 2;
      const j = S.arpPat === 0 ? k % n : S.arpPat === 1 ? (k % per < n ? k % per : per - (k % per)) : S.arpSeq[k % 16] % n;
      inst(E, P.arpP, ch.arp[j], t, sd * P.arp * 0.9, 0.09);
    }
    const n = S.lead[i];
    if (lv >= S.leadAt && n && on('lead')) inst(E, P.lead, n.m, t, n.len * sd * 0.92, 0.22);
  }
  function drum(E, kind, t, v, chip, s) {
    const o = E.musicBus;
    if (kind === 'K') {
      if (chip) return voice(E, o, { t, f: 160, to: 55, st: 0.08, w: 'square', dur: 0.04, v: 0.3 * v, a: 0.001, d: 0.08, s: 0 });
      voice(E, o, { t, f: 180, to: 60, st: 0.09, w: 'sine', dur: 0.02, v: 0.6 * v, a: 0.001, d: 0.18, s: 0 });
      voice(E, o, { t, f: 360, to: 120, st: 0.05, w: 'triangle', dur: 0.01, v: 0.15 * v, a: 0.001, d: 0.06, s: 0 });
    } else if (kind === 'S') {
      noise(E, chip ? o : bus(E, 'snare', 'bandpass', 1800, 0.6), { t, dur: chip ? 0.08 : 0.16, v: (chip ? 0.25 : 0.45) * v });
      if (!chip) voice(E, o, { t, f: 200, to: 150, st: 0.05, w: 'triangle', dur: 0.02, v: 0.25 * v, a: 0.001, d: 0.06, s: 0 });
    } else if (kind === 'C') {
      const c = bus(E, 'clap', 'bandpass', 1300, 1.2);
      for (let k = 0; k < 3; k++) noise(E, c, { t: t + k * 0.011, dur: 0.02, v: 0.35 * v });
      noise(E, c, { t: t + 0.033, dur: 0.14, v: 0.35 * v });
    } else if (kind === 'H' || kind === 'O') {
      noise(E, bus(E, 'hat', 'bandpass', chip ? 9000 : 8000, 0.9), { t, dur: kind === 'O' ? 0.2 : chip ? 0.02 : 0.035, v: (kind === 'O' ? 0.1 : 0.13) * v });
    } else if (kind === 'T') {
      const f = 200 - ((s || 0) % 4) * 25;
      voice(E, o, { t, f, to: f * 0.6, st: 0.18, w: 'sine', dur: 0.05, v: 0.45 * v, a: 0.001, d: 0.18, s: 0 });
      voice(E, o, { t, f: f * 2, to: f * 1.2, st: 0.1, w: 'triangle', dur: 0.03, v: 0.1 * v, a: 0.001, d: 0.1, s: 0 });
    }
  }

  // Game over: a short falling phrase in the song's key, or a brass fanfare for GT.win(). The loop
  // is held until it finishes, then plays on quietly (pad only) behind the retry screen.
  function sting(E, win) {
    const M = E.m, S = M.song, t = E.ac.currentTime + (win ? 0.05 : 0.22);
    const root = S ? fold(S.root + 12, 64, 75) : 72, lead = S ? S.P.lead : 'square';
    if (win) {
      [0, 4, 7].forEach((k, j) => inst(E, 'brass', root + k, t + j * 0.1, 0.09, 0.3));
      [0, 4, 7, 12].forEach((k) => inst(E, 'brass', root + k, t + 0.3, 0.8, 0.18));
      inst(E, 'bassSaw', fold(root - 24, 45, 56), t + 0.3, 0.8, 0.3);
      noise(E, E.musicBus, { t: t + 0.3, dur: 1.2, v: 0.08, type: 'highpass', f: 6000 });
      M.hold = t + 1.7;
    } else {
      [7, 5, 3].forEach((k, j) => inst(E, lead, root + k, t + j * 0.16, 0.12, 0.26));
      inst(E, lead, root, t + 0.48, 0.6, 0.26, { to: mtof(root - 1), st: 0.7, vib: [5, 25] });
      [0, 3, 7].forEach((k) => inst(E, 'padDark', root - 12 + k, t + 0.48, 0.9, 0.08));
      M.hold = t + 1.3;
    }
  }

  function normMusic(m) {
    if (!m) return null;
    const o = typeof m === 'string' ? { mood: m } : Object.assign({}, m);
    if (!MOODS[o.mood]) o.mood = 'arcade';
    if (o.intensity != null) o.intensity = Math.max(0, Math.min(1, Number(o.intensity) || 0));
    return o;
  }

  // ================================================================ bundles (v12)
  // A bundle is a game's art and sound as files: GT.game({ bundle: 'sha256-<hex>' }) names a JSON
  // manifest in the game's own folder (b/<hex>.json), which lists images, audio clips and meshes,
  // each a file named by its own SHA-256 (CONTRACT.md, "Bundles"). The helpers below are pure and
  // shared: the runtime checks every file before anything decodes it, and the shell re-checks the
  // audio it is handed (game code shares the runtime's Worker, so the shell trusts none of it).
  // They mirror lib/bundle.ts (sniff, pngHeader, webpHeader, wavHeader, mp3Info, meshHeader,
  // checkMeshValues, parseManifest): a rule changed in one changes in the other.
  const MiB = 1048576;
  // lib/bundle.ts's DEFAULT_LIMITS at the hard maximum transfer (trust budgets are enforced before
  // publish; the SDK enforces the most any game may be granted).
  const BUNDLE_LIMITS = {
    bytes: 8 * MiB, fileBytes: 2 * MiB, files: 64, manifestBytes: 16384, imageSide: 2048, imagePixels: 16 * MiB,
    audioClips: 32, audioChannelSeconds: 120, audioClipSeconds: 60, audioRate: 48000, meshes: 16,
    meshVertices: 65535, meshVerticesTotal: 262144, meshIndicesTotal: 1048576,
  };
  const CLIP_BYTES = 4 * MiB; // the audio files of one bundle together: what the page takes in one `clips` message
  const BUNDLE_MS = 15000; // the whole load, manifest to decoded clips
  const BUNDLE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  const BUNDLE_FILE_RE = /^[0-9a-f]{64}\.(png|webp|mp3|wav|bin)$/;
  const BUNDLE_KEY_RE = /^sha256-([0-9a-f]{64})$/;
  const BUNDLE_TYPES = { png: 'image/png', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', bin: 'application/octet-stream', json: 'application/json' };
  const BUNDLE_EXT = { image: ['png', 'webp'], audio: ['mp3', 'wav'], mesh: ['bin'] };
  const MESH_ATTRS = ['position', 'normal', 'uv', 'color']; // DMB1 flags: bit0 normal, bit1 uv, bit2 color
  const MAX_FRAMES = 1024, MAX_ATLAS = 256, MAX_SCALE = 8;

  const tagAt = (b, o, s) => { if (o < 0 || o + s.length > b.length) return false; for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false; return true; };
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  // What a file's first bytes say it is ('bin' = a DMB1 mesh), or null.
  function sniff(b) {
    if (b.length >= 8 && b[0] === 0x89 && tagAt(b, 1, 'PNG\r\n\x1a\n')) return 'png';
    if (b.length >= 12 && tagAt(b, 0, 'RIFF') && tagAt(b, 8, 'WEBP')) return 'webp';
    if (b.length >= 12 && tagAt(b, 0, 'RIFF') && tagAt(b, 8, 'WAVE')) return 'wav';
    if (b.length >= 4 && tagAt(b, 0, 'DMB1')) return 'bin';
    if (b.length >= 3 && tagAt(b, 0, 'ID3')) return 'mp3';
    if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) === 1) return 'mp3'; // a Layer III frame sync
    return null;
  }
  // PNG: the signature, then IHDR (length 13) with big-endian width and height.
  function pngHeader(b) {
    if (b.length < 33 || sniff(b) !== 'png' || u32be(b, 8) !== 13 || !tagAt(b, 12, 'IHDR')) return null;
    const w = u32be(b, 16), h = u32be(b, 20);
    if (!w || !h || w > 0x7fffffff || h > 0x7fffffff) return null;
    return { w, h };
  }
  // WebP: RIFF/WEBP (its size inside the file), then the first chunk (inside the file): VP8 (a
  // lossy key frame), VP8L (lossless) or VP8X (extended).
  function webpHeader(b) {
    if (b.length < 20 || !tagAt(b, 0, 'RIFF') || !tagAt(b, 8, 'WEBP') || u32le(b, 4) + 8 > b.length) return null;
    const size = u32le(b, 16), o = 20;
    if (o + size > b.length) return null;
    let w = 0, h = 0;
    if (tagAt(b, 12, 'VP8 ')) {
      if (size < 10 || (b[o] & 1) !== 0 || b[o + 3] !== 0x9d || b[o + 4] !== 0x01 || b[o + 5] !== 0x2a) return null;
      w = u16le(b, o + 6) & 0x3fff; h = u16le(b, o + 8) & 0x3fff;
    } else if (tagAt(b, 12, 'VP8L')) {
      if (size < 5 || b[o] !== 0x2f) return null;
      w = 1 + (((b[o + 2] & 0x3f) << 8) | b[o + 1]);
      h = 1 + (((b[o + 4] & 0x0f) << 10) | (b[o + 3] << 2) | ((b[o + 2] & 0xc0) >> 6));
    } else if (tagAt(b, 12, 'VP8X')) {
      if (size < 10) return null;
      w = 1 + u24le(b, o + 4); h = 1 + u24le(b, o + 7);
    } else return null;
    return w && h ? { w, h } : null;
  }
  // WAV: RIFF/WAVE chunks; integer PCM (format 1, or 0xFFFE with the PCM sub-format GUID), 8/16/24/32
  // bits, 1–2 channels, a block size that matches; the data chunk's whole blocks give the duration.
  // Float, compressed, no data chunk, or a chunk running past the end: null.
  const PCM_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
  function wavHeader(b) {
    if (b.length < 12 || !tagAt(b, 0, 'RIFF') || !tagAt(b, 8, 'WAVE')) return null;
    let o = 12, fmt = null;
    while (o + 8 <= b.length) {
      const size = u32le(b, o + 4), body = o + 8;
      if (tagAt(b, o, 'fmt ')) {
        if (size < 16 || body + size > b.length) return null;
        const format = u16le(b, body), channels = u16le(b, body + 2), rate = u32le(b, body + 4), block = u16le(b, body + 12), bits = u16le(b, body + 14);
        if (format === 0xfffe) {
          if (size < 40 || u16le(b, body + 16) < 22) return null;
          if (u16le(b, body + 24) !== 1 || !PCM_GUID_TAIL.every((v, i) => b[body + 26 + i] === v)) return null;
        } else if (format !== 1) return null;
        if (![8, 16, 24, 32].includes(bits) || channels < 1 || channels > 2 || !rate || block !== (channels * bits) / 8) return null;
        fmt = { channels, rate, bits, block };
      } else if (tagAt(b, o, 'data')) {
        if (!fmt || body + size > b.length) return null;
        return { channels: fmt.channels, rate: fmt.rate, bits: fmt.bits, seconds: Math.floor(size / fmt.block) / fmt.rate };
      }
      o = body + size + (size & 1);
    }
    return null;
  }
  // MP3: skip an ID3v2 tag (and an ID3v1 tail), then walk Layer III frame headers from there to the
  // end, each following the last, all of one MPEG version, rate and channel mode. A first frame
  // holding the encoder's Xing/Info/VBRI metadata (decoders don't play it) isn't counted. A final
  // partial frame is tolerated; a sync loss, free-format or reserved values are null.
  const MP3_KBPS = [[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]];
  const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mp3Info(b) {
    let o = 0, end = b.length;
    if (tagAt(b, 0, 'ID3')) {
      if (b.length < 10) return null;
      for (let i = 6; i < 10; i++) if (b[i] & 0x80) return null;
      o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
    }
    if (end - 128 >= o && tagAt(b, end - 128, 'TAG')) end -= 128;
    let frames = 0, samples = 0, rate = 0, channels = 0, version = -1, first = true;
    while (o + 4 <= end) {
      const b1 = b[o + 1], b2 = b[o + 2], b3 = b[o + 3];
      if (b[o] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
      const v = (b1 >> 3) & 3, bri = b2 >> 4, sri = (b2 >> 2) & 3;
      if (v === 1 || ((b1 >> 1) & 3) !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
      const r = MP3_RATES[v][sri], ch = b3 >> 6 === 3 ? 1 : 2;
      if (version === -1) { version = v; rate = r; channels = ch; } else if (v !== version || r !== rate || ch !== channels) return null;
      const len = Math.floor(((v === 3 ? 144000 : 72000) * MP3_KBPS[v === 3 ? 1 : 0][bri]) / r) + ((b2 >> 1) & 1);
      if (o + len > end) break; // a final partial frame
      let tag = false;
      if (first) {
        const x = o + 4 + ((b1 & 1) === 0 ? 2 : 0) + (v === 3 ? (ch === 1 ? 17 : 32) : ch === 1 ? 9 : 17);
        tag = tagAt(b, x, 'Xing') || tagAt(b, x, 'Info') || tagAt(b, o + 36, 'VBRI');
        first = false;
      }
      if (!tag) { frames++; samples += v === 3 ? 1152 : 576; }
      o += len;
    }
    return frames ? { seconds: samples / rate, rate, channels, frames } : null;
  }
  // DMB1: magic, u32 vertices, u32 indices, u32 flags (bit0 normal, bit1 uv, bit2 color), then the
  // Float32 arrays and Uint16 indices, no padding: the byte length is exactly determined.
  function meshHeader(b) {
    if (b.length < 16 || !tagAt(b, 0, 'DMB1')) return null;
    const vertices = u32le(b, 4), indices = u32le(b, 8), flags = u32le(b, 12);
    if (flags & ~7) return null;
    const per = 12 + (flags & 1 ? 12 : 0) + (flags & 2 ? 8 : 0) + (flags & 4 ? 12 : 0);
    return { vertices, indices, flags, byteLength: 16 + per * vertices + 2 * indices };
  }
  // Problems with a DMB1 file's values (empty when it is fine): non-finite or huge floats, indices
  // outside the vertices, a count of indices that isn't whole triangles.
  function checkMeshValues(b) {
    const m = meshHeader(b), out = [];
    if (!m) return ['not a DMB1 mesh'];
    if (b.length !== m.byteLength) return ['it is ' + b.length + ' bytes, its header needs ' + m.byteLength];
    if (m.indices % 3) out.push(m.indices + ' indices is not a whole number of triangles');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), fEnd = m.byteLength - 2 * m.indices;
    for (let o = 16; o < fEnd; o += 4) {
      const x = dv.getFloat32(o, true);
      if (!isFinite(x)) { out.push('a non-finite value at byte ' + o); break; }
      if (Math.abs(x) > 1e4) { out.push('a value of ' + x + ' at byte ' + o + ' (max ±10000)'); break; }
    }
    for (let o = fEnd; o < m.byteLength; o += 2) {
      const i = dv.getUint16(o, true);
      if (i >= m.vertices) { out.push('index ' + i + ' at byte ' + o + ' is not below ' + m.vertices + ' vertices'); break; }
    }
    return out;
  }

  // SHA-256 as hex. crypto.subtle where it exists; otherwise (an insecure context) this compact
  // implementation of FIPS 180-4.
  let SHA_K = null, SHA_H = null;
  function sha256Js(bytes) {
    if (!SHA_K) {
      const primes = [];
      for (let c = 2; primes.length < 64; c++) { let p = true; for (let d = 2; d * d <= c; d++) if (c % d === 0) { p = false; break; } if (p) primes.push(c); }
      SHA_K = primes.map((p) => (Math.cbrt(p) % 1) * 4294967296 | 0);
      SHA_H = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1) * 4294967296 | 0);
    }
    const n = bytes.length, words = new Int32Array(((n + 9 + 63) >> 6) << 4);
    for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
    words[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
    words[words.length - 1] = n * 8;
    words[words.length - 2] = Math.floor(n / 0x20000000);
    const H = SHA_H.slice(), w = new Int32Array(64), K = SHA_K;
    for (let j = 0; j < words.length; j += 16) {
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[j + i];
        else {
          const x = w[i - 15], y = w[i - 2];
          w[i] = (((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10)) + w[i - 16]) | 0;
        }
        const t1 = (h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  async function sha256Hex(bytes) {
    if (NATIVE.digest) {
      try {
        const d = new Uint8Array(await NATIVE.digest('SHA-256', bytes));
        let s = '';
        for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
        return s;
      } catch (_) { /* fall back */ }
    }
    return sha256Js(bytes);
  }

  // The manifest, read field by field into fresh objects (own enumerable keys only; anything
  // unknown is refused). `taken`: names already in use (the game's inline SVG sprites). Returns
  // { assets: Map(name -> asset), totals }, or throws 'bundle: manifest: <reason>'.
  function parseManifest(bytes, taken) {
    const L = BUNDLE_LIMITS;
    const bad = (why) => { throw new Error('bundle: manifest: ' + why); };
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    const keys = (o, allowed, where) => {
      const ks = Object.keys(o);
      for (const k of ks) if (!allowed.includes(k)) bad(where + 'unknown key "' + k.slice(0, 40) + '"');
      return ks;
    };
    if (bytes.length > L.manifestBytes) bad('it is ' + bytes.length + ' bytes (max ' + L.manifestBytes + ')');
    let root;
    try { root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { bad('it is not valid JSON'); }
    if (!isObj(root)) bad('it is not a JSON object');
    keys(root, ['diddly', 'assets'], '');
    if (root.diddly !== 1) bad('"diddly" must be 1 (this SDK reads bundle format 1)');
    if (!isObj(root.assets)) bad('"assets" must be an object');
    const names = Object.keys(root.assets);
    if (!names.length) bad('it lists no assets');
    if (names.length > L.files) bad(names.length + ' assets (max ' + L.files + ')');
    const used = new Set(taken || []);
    const claim = (name, where) => {
      if (!BUNDLE_NAME_RE.test(name)) bad(where + 'the name "' + name.slice(0, 40) + '" must match ' + BUNDLE_NAME_RE.source);
      if (used.has(name)) bad(where + 'the name "' + name + '" is already used (by another asset, an atlas sprite or GT.game({ sprites }))');
      used.add(name);
    };
    const assets = new Map(), t = { pixels: 0, channelSeconds: 0, clips: 0, meshes: 0, vertices: 0, indices: 0 };
    for (const name of names) {
      claim(name, '');
      const a = root.assets[name], at = name + ': ';
      if (!isObj(a)) bad(at + 'must be an object');
      if (!['image', 'audio', 'mesh'].includes(a.type)) bad(at + '"type" must be image, audio or mesh');
      if (typeof a.file !== 'string' || !BUNDLE_FILE_RE.test(a.file)) bad(at + '"file" must be <64 hex>.<png|webp|mp3|wav|bin>, nothing else');
      const ext = a.file.slice(65);
      if (!BUNDLE_EXT[a.type].includes(ext)) bad(at + 'a .' + ext + ' file can\'t be an ' + a.type);
      if (a.type === 'image') {
        keys(a, ['type', 'file', 'w', 'h', 'scale', 'tile', 'frames', 'sprites'], at);
        if (!int(a.w, 1, L.imageSide) || !int(a.h, 1, L.imageSide)) bad(at + '"w" and "h" must be whole pixels, 1–' + L.imageSide);
        if (a.scale !== undefined && !(typeof a.scale === 'number' && a.scale >= 1 && a.scale <= MAX_SCALE)) bad(at + '"scale" must be a number from 1 to ' + MAX_SCALE);
        if (a.tile !== undefined && typeof a.tile !== 'boolean') bad(at + '"tile" must be true or false');
        if (a.frames !== undefined && a.sprites !== undefined) bad(at + 'an image has "frames" or "sprites", not both');
        const img = { type: 'image', file: a.file, w: a.w, h: a.h, scale: a.scale === undefined ? 1 : a.scale, tile: a.tile === true };
        if (a.frames !== undefined) {
          const f = a.frames;
          if (!isObj(f)) bad(at + '"frames" must be { w, h, n }');
          keys(f, ['w', 'h', 'n'], at + 'frames: ');
          if (!int(f.w, 1, a.w) || !int(f.h, 1, a.h) || !int(f.n, 1, MAX_FRAMES)) bad(at + '"frames" needs whole w (1–' + a.w + '), h (1–' + a.h + ') and n (1–' + MAX_FRAMES + ')');
          for (let i = 0; i < f.n; i++) {
            const x = (i * f.w) % a.w, y = Math.floor((i * f.w) / a.w) * f.h;
            if (x + f.w > a.w || y + f.h > a.h) bad(at + 'frame ' + i + ' lies outside the ' + a.w + '×' + a.h + ' image');
          }
          img.frames = { w: f.w, h: f.h, n: f.n };
        }
        if (a.sprites !== undefined) {
          if (!isObj(a.sprites)) bad(at + '"sprites" must be { name: [x, y, w, h] }');
          const subs = Object.keys(a.sprites);
          if (!subs.length || subs.length > MAX_ATLAS) bad(at + '"sprites" must list 1 to ' + MAX_ATLAS + ' atlas sprites');
          img.sprites = {};
          for (const s of subs) {
            claim(s, at + 'sprites: ');
            const r = a.sprites[s];
            if (!Array.isArray(r) || r.length !== 4 || !int(r[0], 0, a.w - 1) || !int(r[1], 0, a.h - 1) || !int(r[2], 1, a.w) || !int(r[3], 1, a.h) || r[0] + r[2] > a.w || r[1] + r[3] > a.h) {
              bad(at + 'sprite "' + s + '" must be [x, y, w, h] in whole pixels inside the ' + a.w + '×' + a.h + ' image');
            }
            img.sprites[s] = [r[0], r[1], r[2], r[3]];
          }
        }
        t.pixels += a.w * a.h;
        assets.set(name, img);
      } else if (a.type === 'audio') {
        keys(a, ['type', 'file', 'seconds', 'channels', 'rate', 'loop'], at);
        if (!(typeof a.seconds === 'number' && a.seconds > 0 && a.seconds <= L.audioClipSeconds)) bad(at + '"seconds" must be more than 0 and at most ' + L.audioClipSeconds);
        if (a.channels !== 1 && a.channels !== 2) bad(at + '"channels" must be 1 or 2');
        if (!int(a.rate, 8000, L.audioRate)) bad(at + '"rate" must be a whole number of Hz, 8000–' + L.audioRate);
        const clip = { type: 'audio', file: a.file, seconds: a.seconds, channels: a.channels, rate: a.rate };
        if (a.loop !== undefined) {
          const l = a.loop;
          if (!Array.isArray(l) || l.length !== 2 || typeof l[0] !== 'number' || typeof l[1] !== 'number' || !(l[0] >= 0) || !(l[1] > l[0]) || !(l[1] <= a.seconds)) bad(at + '"loop" must be [start, end] seconds inside the clip');
          clip.loop = [l[0], l[1]];
        }
        t.clips++; t.channelSeconds += a.seconds * a.channels;
        assets.set(name, clip);
      } else {
        keys(a, ['type', 'file', 'vertices', 'indices', 'attributes'], at);
        if (!int(a.vertices, 1, L.meshVertices)) bad(at + '"vertices" must be a whole number, 1–' + L.meshVertices);
        if (!int(a.indices, 3, L.meshIndicesTotal) || a.indices % 3) bad(at + '"indices" must be a whole number of triangles (a multiple of 3)');
        const at2 = a.attributes;
        if (!Array.isArray(at2) || !at2.includes('position') || at2.some((x) => !MESH_ATTRS.includes(x)) || new Set(at2).size !== at2.length) {
          bad(at + '"attributes" must list position and any of normal, uv, color, once each');
        }
        t.meshes++; t.vertices += a.vertices; t.indices += a.indices;
        assets.set(name, { type: 'mesh', file: a.file, vertices: a.vertices, indices: a.indices, attributes: MESH_ATTRS.filter((x) => at2.includes(x)) });
      }
    }
    if (t.pixels > L.imagePixels) bad('images total ' + t.pixels + ' pixels (max ' + L.imagePixels + ')');
    if (t.clips > L.audioClips) bad(t.clips + ' audio clips (max ' + L.audioClips + ')');
    if (t.channelSeconds > L.audioChannelSeconds) bad('audio totals ' + +t.channelSeconds.toFixed(2) + ' channel-seconds (max ' + L.audioChannelSeconds + ')');
    if (t.meshes > L.meshes) bad(t.meshes + ' meshes (max ' + L.meshes + ')');
    if (t.vertices > L.meshVerticesTotal) bad('meshes total ' + t.vertices + ' vertices (max ' + L.meshVerticesTotal + ')');
    if (t.indices > L.meshIndicesTotal) bad('meshes total ' + t.indices + ' indices (max ' + L.meshIndicesTotal + ')');
    return { assets, totals: t };
  }
  // A clip's duration and channels from its own bytes (the shell's independent check), or null.
  function clipInfo(b) {
    const kind = sniff(b);
    const h = kind === 'wav' ? wavHeader(b) : kind === 'mp3' ? mp3Info(b) : null;
    return h ? { kind, seconds: h.seconds, channels: h.channels, rate: h.rate } : null;
  }

  // ================================================================ shell
  // The page's side (see the header): canvas, input, audio, sprites, host bridge, watchdog, QA.
  function shellMain() {
    const script = document.currentScript;
    const SDK_SRC = (script && script.src) || location.href;
    const params = new URLSearchParams(location.search);
    const QA = params.has('qa');
    const DEBUG = params.has('debug');
    const embedded = window.parent !== window;
    const baseSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
    // The game's code, named on this script's tag by the page (play.html, a game's index.html).
    const dataGame = script && script.dataset ? script.dataset.game || '' : '';
    const gameUrl = dataGame ? new URL(dataGame, location.href).href : '';
    // ?inthread (and browsers without OffscreenCanvas) run the runtime on this thread, as v10 did.
    const workerOk = !params.has('inthread') && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';

    // ---------- mode (see the header: host, handoff or self) ----------
    // Decided before this shell touches the page: in handoff the pinned file's own shell runs it.
    const sdkAttr = script && script.hasAttribute('data-sdk') ? script.getAttribute('data-sdk') : null;
    const N = sdkAttr == null ? null : sdkAttr === 'dev' ? 'dev' : /^[1-9][0-9]{0,3}$/.test(sdkAttr) ? Number(sdkAttr) : NaN;
    const newest = N === null || N === 'dev'; // self mode runs this file's own runtime
    // What the shell does differently per runtime version; everything else is the union (design §4).
    const RT = {
      worker: newest || N >= 11, // v1–10 have no runtime role: handoff
      qaAudioLog: newest || N >= 12, // the runtime tags its audio ops `qa` under ?qa; before that __gt.audioLog must be undefined
      hello: newest || N >= 16, // hello carries { sdk, protocol } (checked by their presence, so nothing branches on this)
      stopsHidden: newest || N >= 15, // the runtime stops its own frame loop on `vis`; before v15 the bootstrap holds its frames
    };
    const mode = N === null ? 'self' : Number.isNaN(N) ? null : RT.worker && workerOk ? 'host' : 'handoff';
    const shellInfo = { build: SHELL_BUILD, mode, runtime: N === null || Number.isNaN(N) ? null : N };
    // A newer frozen file that an older page's shell handed off to runs here in self mode: the record
    // of the handoff stays.
    if (!(N === null && window.__gtShell && window.__gtShell.mode === 'handoff')) window.__gtShell = shellInfo;
    // The runtime this page runs: the pinned one in host mode, this file's own in self mode.
    const RUNTIME = mode === 'host' ? N : SDK_VERSION;
    const runtimeUrl = mode === 'self' || mode === null ? '' : new URL(N === 'dev' ? '/sdk/diddly.js' : '/sdk/v' + N + '/diddly.js', SDK_SRC).href;
    function failPage(why) {
      const show = () => { document.body.textContent = 'this game could not be loaded (' + why + ')'; };
      // After parsing, so the rest of the page's markup doesn't follow the line.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true }); else show();
    }
    // Hand the page to the pinned file (design §3.3): its own shell runs the page, as before the split,
    // and makes its own worker or in-thread choice. Shell fixes don't reach it; play.html's do. No
    // data-sdk on its tag: a newer file runs in self mode there instead of deciding again.
    function handOff(why) {
      shellInfo.mode = 'handoff';
      shellInfo.reason = why;
      const s = document.createElement('script');
      s.src = runtimeUrl;
      if (gameUrl) s.setAttribute('data-game', gameUrl);
      s.onload = () => { if (gameUrl && !(window.GT && window.GT.loadsGame === true)) loadLegacyGame(gameUrl); };
      s.onerror = () => failPage('sdk v' + N);
      (document.body || document.head || document.documentElement).appendChild(s);
    }
    // A pre-v11 file doesn't load the game itself: insert game.js after it, as play.html did. If the
    // browser refuses its content type (Storage), fetch the text and run it from a typed blob.
    function loadLegacyGame(url) {
      const s = document.createElement('script');
      s.src = url;
      s.onerror = () => NATIVE.fetch(url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then((code) => {
          const b = document.createElement('script');
          b.src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          b.onerror = () => failPage('game code');
          document.body.appendChild(b);
        })
        .catch(() => failPage('game code'));
      document.body.appendChild(s);
    }
    if (mode === null) return failPage('bad sdk version');
    if (mode === 'handoff') return handOff(N <= 10 ? 'legacy' : params.has('inthread') ? 'inthread' : 'no-offscreencanvas');

    // Everything this shell attaches to the page, so a late handoff (a Worker refused after the
    // fact) can take it all back before the pinned file's shell starts.
    const attached = [], timers = [];
    function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); attached.push([target, type, fn, opts]); }

    const HOST_KEYS = ['j', 'l', 'h', 'x']; // feed shortcuts: next / like / love / nope
    const WATCHDOG_MS = 4000, PING_MS = 500, LOAD_GRACE_MS = 20000;
    // Messages a worker may send per second. A real game sends a few dozen (events, sounds, the
    // round clock); handling 3000 costs the page (and the feed sharing its process) ~50–75 ms.
    const FLOOD_MAX = 3000;

    // ---------- telemetry ----------
    // Every event the runtime emits is kept here (QA reads it as __gt.events) and forwarded to
    // the host. Hosts validate what they receive (parseGameEvent): game code can post events too.
    const events = [];
    function forward(ev) {
      // `ready` says which shell hosted the game. Set after the copy: game code can post its own.
      if (ev.type === 'ready') ev = Object.assign({}, ev, { shell: SHELL_BUILD });
      events.push(ev);
      if (embedded) {
        try { window.parent.postMessage(ev, '*'); } catch (_) { /* host gone */ }
      }
    }
    function emit(type, data) { forward(Object.assign({ diddly: true, type, at: Math.round(perfNow()) }, data || {})); }

    // ---------- page and canvas ----------
    const style = document.createElement('style');
    style.textContent =
      'html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}' +
      'body{display:flex;align-items:center;justify-content:center}canvas{display:block;touch-action:none}';
    (document.head || document.documentElement).appendChild(style);
    let canvas = null;
    const view = () => ({ vw: window.innerWidth || W, vh: window.innerHeight || H, dpr: window.devicePixelRatio || 1 });
    function styleCanvas(c) {
      const v = view(), s = Math.min(v.vw / W, v.vh / H);
      c.style.width = W * s + 'px';
      c.style.height = H * s + 'px';
    }
    // A fresh <canvas> in the page (replacing the last one: a transferred canvas can't be drawn
    // on from here again).
    function newCanvas() {
      const c = document.createElement('canvas');
      styleCanvas(c);
      const old = canvas;
      canvas = c;
      const mount = () => {
        if (old && old.parentNode) old.parentNode.replaceChild(c, old);
        else if (!c.parentNode) document.body.appendChild(c);
      };
      if (document.body) mount(); else on(window, 'DOMContentLoaded', mount, { once: true });
      return c;
    }
    on(window, 'resize', () => {
      if (!canvas) return;
      styleCanvas(canvas);
      send(Object.assign({ t: 'size' }, view()));
    });

    // ---------- the runtime: a worker, or in-thread ----------
    let worker = null, rt = null, dead = false, inthread = false, started = false, ready = false;
    let hostQueue = []; // host commands that arrive before the runtime exists
    function send(msg, transfer) {
      if (dead) return;
      if (worker) worker.postMessage(msg, transfer || []);
      else if (rt) rt.handle(msg);
      else if (msg.t === 'host' && hostQueue.length < 16) hostQueue.push(msg);
    }
    // v15: then whether the page is hidden. A Worker's frames don't stop with a hidden page the way
    // the page's own do, so the runtime is told, and stops its loop until the page is shown again.
    function flushHost() { const q = hostQueue; hostQueue = []; q.forEach((m) => send(m)); if (document.hidden) send({ t: 'vis', hidden: true }); }
    on(document, 'visibilitychange', () => send({ t: 'vis', hidden: document.hidden }));

    // Host mode's worker source: it imports the pinned runtime by URL (design §3.1). The import
    // blocks the worker on the network, so it is bracketed by `loading` for the watchdog's grace,
    // and a failed one says so with `fail` before any `hello`.
    // v11–v14 ask for a frame on every refresh, with or without anything to draw, and a hidden page
    // doesn't stop a Worker's frames: a background tab kept the GPU busy. Their files are frozen and
    // ignore `vis`, so the bootstrap wraps the Worker's requestAnimationFrame (which they look up on
    // every call) before importing them: while the page is hidden the frame asked for is held, and
    // it runs when the page is shown. Pongs come from their message handlers, not their frames, so
    // the watchdog still hears them. Game code could undo the wrapper, but only to burn its own GPU.
    function holdFrames() {
      if (RT.stopsHidden) return '';
      return '  var raf = typeof self.requestAnimationFrame === \'function\' ? self.requestAnimationFrame.bind(self) : null, hidden = false, held = null;\n' +
        '  if (raf) {\n' +
        '    self.requestAnimationFrame = function (f) { if (hidden) { held = f; return 0; } return raf(f); };\n' +
        "    self.addEventListener('message', function (e) { var d = e.data; if (!d || d.t !== 'vis') return; hidden = d.hidden === true; if (!hidden && held) { var f = held; held = null; raf(f); } });\n" +
        '  }\n';
    }
    function bootstrap() {
      const label = N === 'dev' ? 'the working-copy SDK' : 'SDK v' + N;
      return '(function () {\n' +
        '  var post = self.postMessage.bind(self);\n' +
        holdFrames() +
        "  post({ t: 'loading', on: true });\n" +
        '  try { importScripts(' + JSON.stringify(runtimeUrl) + '); }\n' +
        "  catch (e) { post({ t: 'fail', message: " + JSON.stringify('could not load ' + label + ' (') + " + ((e && e.message) || e) + ')' }); }\n" +
        "  finally { post({ t: 'loading', on: false }); }\n" +
        '})();\n';
    }
    // Start the worker: in host mode from the bootstrap, in self mode from this file's own source.
    // Returns false if the page can't have one (its CSP refuses blob: workers, say): the caller
    // then hands off (host) or runs the game in-thread (self).
    function spawn(url) {
      let w, off, blobUrl;
      try {
        const src = mode === 'host' ? bootstrap() : '(' + diddly.toString() + ')()';
        blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        w = new Worker(blobUrl);
      } catch (_) { return false; }
      try { off = newCanvas().transferControlToOffscreen(); } catch (_) { w.terminate(); newCanvas(); return false; }
      worker = w;
      w.onmessage = (e) => { if (worker === w) fromWorker(e.data); };
      w.onerror = (e) => {
        if (worker !== w) return;
        e.preventDefault();
        // Never started (refused by a CSP that only reports asynchronously): hand off or run in-thread.
        if (!started) { w.terminate(); worker = null; URL.revokeObjectURL(blobUrl); noWorker(null, url); }
      };
      const sdkSrc = mode === 'host' ? runtimeUrl : SDK_SRC;
      w.postMessage(Object.assign({ t: 'init', canvas: off, url, sdkSrc, search: location.search, baseSeed, embedded, timeOrigin: performance.timeOrigin, shell: SHELL_BUILD }, view()), [off]);
      flushHost();
      pongAt = perfNow();
      if (!QA) watchdog = setInterval(watch, PING_MS);
      w.revoke = blobUrl;
      return true;
    }

    // No worker after all. Self mode runs its runtime in-thread. Host mode can't (this file's runtime
    // isn't the pinned one): it takes back everything it attached and hands off (design §3.3).
    function noWorker(def, url, scriptUrl) {
      if (mode !== 'host') return startInThread(def, url, scriptUrl);
      dead = true;
      clearInterval(watchdog);
      timers.forEach(clearInterval);
      for (const [target, type, fn, opts] of attached.splice(0)) target.removeEventListener(type, fn, opts);
      if (audio) { audio.dead = true; quiet(audio.ac.close()); }
      if (earlyAc) quiet(earlyAc.close());
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      if (style.parentNode) style.parentNode.removeChild(style);
      for (const k of ['GT', '__gt', '__gtStats', '__gtPings']) delete window[k];
      handOff('worker-refused');
    }

    // In-thread: the same runtime on this page, drawing into the <canvas> element directly.
    function startInThread(def, url, scriptUrl) {
      inthread = true;
      const c = newCanvas();
      const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error('could not load ' + src));
        (document.body || document.head || document.documentElement).appendChild(s);
      });
      rt = runtime(Object.assign({
        canvas: c, post: fromRuntime, search: location.search, baseSeed, embedded, inthread: true, sdkSrc: SDK_SRC, timeOffset: 0, shell: SHELL_BUILD,
        url: url || scriptUrl || '',
        offscreen(w, h) { const o = document.createElement('canvas'); o.width = w; o.height = h; return o; },
        raf: (f) => requestAnimationFrame(f),
        loadScript,
        dataUrl: (o) => Promise.resolve(o.toDataURL('image/png')),
        runScript(src) {
          const u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          return loadScript(u).finally(() => URL.revokeObjectURL(u));
        },
        onError(report) {
          window.addEventListener('error', (e) => report(e.error || e.message));
          window.addEventListener('unhandledrejection', (e) => report(e.reason));
        },
        audio: DEBUG ? audioApi : null,
      }, view()));
      flushHost();
      if (def) {
        try { rt.GT.game(def); } catch (err) { rt.fail(err); }
      } else if (url) {
        // Storage may serve game.js with a type the browser won't run: fetch it into a blob then.
        const done = () => { if (!rt.hasGame() && rt.GT.phase !== 'crashed') rt.fail(new Error('the game code did not call GT.game()')); };
        loadScript(url).then(done, () => NATIVE.fetch(url)
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then((code) => {
            const u = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            return loadScript(u);
          })
          .then(done, (err) => rt.fail(new Error('could not load the game code (' + ((err && err.message) || err) + ')'))));
      }
    }

    // ---------- messages from the runtime ----------
    // Untrusted when they come from a worker: game code there can call postMessage too. Only the
    // names below are acted on, and a worker that floods the page is stopped like a stuck one.
    let floodAt = 0, floodCount = 0;
    function fromWorker(d) {
      if (!QA) {
        const now = perfNow();
        if (now - floodAt > 1000) { floodAt = now; floodCount = 0; }
        if (++floodCount > FLOOD_MAX) return kill('the game flooded the page with messages');
      }
      fromRuntime(d);
    }
    let game = null, gameBg = ''; // what the audio engine and the crash screen need to know
    let lastStats = null, loadingAt = 0;
    function fromRuntime(d) {
      if (!d || typeof d !== 'object' || dead) return;
      switch (d.t) {
        case 'hello':
          if (started) return;
          started = true;
          if (worker && worker.revoke) { URL.revokeObjectURL(worker.revoke); worker.revoke = null; }
          // From v16 the runtime says which release it is and its protocol (design §3.2); v11–v15 say nothing.
          if (typeof d.sdk === 'number' && typeof N === 'number' && d.sdk !== N) return kill('the runtime answered as v' + d.sdk + ', not v' + N);
          if (typeof d.protocol === 'number' && d.protocol > SHELL_PROTOCOL) return kill('this page is older than the game: reload');
          return;
        case 'fail':
          // The bootstrap's: the pinned runtime could not be loaded. After hello, game code's, ignored.
          if (!started) kill(String(d.message || 'the game runtime failed to start').slice(0, 200));
          return;
        case 'pong':
          pongAt = perfNow(); pingAt = 0;
          note({ k: 'pong', id: d.id, wait: d.wait, frameAgo: d.frameAgo, frameMs: d.frameMs, frameGap: d.frameGap });
          return;
        case 'loading': loadingAt = d.on ? perfNow() : 0; return;
        case 'emit':
          if (d.ev && typeof d.ev === 'object') { if (d.ev.type === 'ready') ready = true; forward(d.ev); }
          return;
        case 'game':
          document.title = String(d.title || 'diddly').slice(0, 200);
          gameBg = String(d.bg || '');
          game = { music: d.music, kind: kindOf(d) };
          return;
        case 'sprites': return rasterize(d.list);
        case 'clips': return onClips(d);
        case 'audio':
          // The runtime's sound commands for one frame (or one message), in order. Under ?qa they
          // come tagged `qa` and are only recorded (__gt.audioLog): nothing plays.
          if (Array.isArray(d.ops)) {
            for (const op of d.ops.slice(0, 64)) {
              if (!op || typeof op !== 'object') continue;
              if (QA && op.qa === true) logAudio(op);
              audioOp(op);
            }
          }
          return;
        case 'stats': lastStats = d.stats && typeof d.stats === 'object' ? d.stats : null; return;
        case 'state': if (d.state && typeof d.state === 'object') lastState = d.state; return;
        case 'qa': return settle(d);
      }
    }

    // ---------- the watchdog ----------
    // The runtime answers pings from its message handler, so a game stuck in a loop can't. With
    // no answer for 4 s, the worker is terminated and the card shows why. Not under ?qa (a step
    // may take seconds there), not while the page is hidden (its timers are throttled), and not
    // while the runtime is loading a script by URL before the game is ready (importScripts blocks
    // the worker on the network; at most 20 s). In production that is only three.js, from the
    // site (its connect-src doesn't list the site, so it can't be fetched); game.js is fetched
    // from Storage and run from a blob, which doesn't block. Only a page whose CSP refuses that
    // fetch (no connect-src for the games folder) loads game.js by URL inside the allowance.
    let watchdog = 0, pingId = 0, pingAt = 0, pongAt = 0, lastTick = 0;
    // The last 20 pings, pongs and watchdog decisions, for diagnosing a kill (window.__gtPings()
    // under ?debug). Each pong says how long the ping waited in the worker's queue, and how long
    // ago the runtime's last frame began, how long it took and how late it was.
    const pings = [];
    function note(e) {
      e.at = Math.round(perfNow());
      pings.push(e);
      if (pings.length > 20) pings.shift();
    }
    if (DEBUG) window.__gtPings = () => pings.slice();
    function watch() {
      const now = perfNow(), gap = now - (lastTick || now);
      lastTick = now;
      if (dead || !worker) return;
      // This page was hidden, or its own thread was busy: don't blame the game for the gap.
      if (document.hidden || gap > 2 * PING_MS + 500) { note({ k: 'reset', gap: Math.round(gap), hidden: document.hidden }); pongAt = now; pingAt = 0; return; }
      if (!ready && loadingAt && now - loadingAt < LOAD_GRACE_MS) { pongAt = now; return; }
      if (pingAt && now - pingAt >= 1000 && now - pongAt >= WATCHDOG_MS) { note({ k: 'kill', since: Math.round(now - pongAt) }); return kill('the game stopped responding'); }
      if (!pingAt) pingAt = now;
      worker.postMessage({ t: 'ping', id: ++pingId, at: now });
      note({ k: 'ping', id: pingId });
    }
    // Stop the worker for good and show a crash screen on a fresh canvas.
    function kill(why) {
      if (dead) return;
      dead = true;
      clearInterval(watchdog);
      try { worker.terminate(); } catch (_) { /* already gone */ }
      for (const p of qaWaiting.values()) p.reject(new Error(why));
      qaWaiting.clear();
      if (audio) { audio.dead = true; audio.m = null; quiet(audio.ac.suspend()); }
      const c = newCanvas(), v = view(), s = Math.min(v.vw / W, v.vh / H), dpr = Math.min(v.dpr, 3);
      c.width = Math.round(W * s * dpr); c.height = Math.round(H * s * dpr);
      const x = c.getContext('2d');
      x.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      x.fillStyle = '#111'; x.fillStyle = gameBg || '#111'; x.fillRect(0, 0, W, H);
      drawText(x, 'this game stopped responding', W / 2, H / 2, 20, '#f66', 'center', '700', true);
      lastState = Object.assign({}, lastState, { phase: 'crashed', errors: (lastState.errors || 0) + 1 });
      emit('error', { message: why });
      emit('crash');
    }

    // ---------- input ----------
    // Pointer and key events become logical coordinates for the runtime. Audio unlocks here, in
    // the gesture itself.
    function logical(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)),
        y: Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)),
      };
    }
    function pointer(k, e) {
      if (!canvas || dead) return;
      const p = logical(e);
      send({ t: 'input', k, x: p.x, y: p.y });
    }
    on(window, 'pointerdown', (e) => { unlockAudio(); pointer('down', e); e.preventDefault(); }, { passive: false });
    on(window, 'pointermove', (e) => pointer('move', e));
    on(window, 'pointerup', (e) => pointer('up', e));
    on(window, 'pointercancel', (e) => pointer('up', e));
    on(window, 'touchmove', (e) => e.preventDefault(), { passive: false });
    // Desktop keyboard: space = press, arrows = swipe; the feed's shortcuts go to the host.
    const GAME_KEYS = ['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    on(window, 'keydown', (e) => {
      if (e.repeat) return;
      if (embedded && HOST_KEYS.includes(String(e.key).toLowerCase())) { emit('key', { key: e.key }); return; }
      if (!GAME_KEYS.includes(e.code)) return;
      if (e.code === 'Space' || e.code === 'Enter') unlockAudio();
      send({ t: 'input', k: 'key', code: e.code, down: true });
      e.preventDefault();
    });
    on(window, 'keyup', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') send({ t: 'input', k: 'key', code: e.code, down: false });
    });

    // ---------- host commands ----------
    let paused = false;
    on(window, 'message', (e) => {
      const d = e.data;
      if (!d || d.diddlyHost !== true) return;
      if (!['pause', 'resume', 'best', 'tap'].includes(d.cmd)) return;
      if (d.cmd === 'pause') paused = true;
      if (d.cmd === 'resume') paused = false;
      if (d.cmd === 'tap') unlockAudio(); // the app's web view allows audio without a gesture inside the game frame
      if (d.cmd === 'pause' || d.cmd === 'resume') audioTick();
      send({ t: 'host', cmd: d.cmd, value: typeof d.value === 'number' ? d.value : undefined });
    });

    // ---------- sprites ----------
    // The runtime asks once, before setup(); each SVG is rasterized at 3x through an <img> and
    // sent back as an ImageBitmap (a canvas in-thread).
    const SPRITE_SUPERSAMPLE = 3;
    let spritesAsked = false;
    function rasterize(list) {
      if (spritesAsked || !Array.isArray(list)) return;
      spritesAsked = true;
      Promise.all(list.slice(0, 1024).map(loadSprite)).then((res) => {
        const transfer = res.map((r) => r[1]).filter((b) => b && typeof ImageBitmap !== 'undefined' && b instanceof ImageBitmap);
        send({ t: 'sprites', bitmaps: res }, transfer);
      });
    }
    function loadSprite(item) {
      const name = String(Array.isArray(item) ? item[0] : ''), src = String(Array.isArray(item) ? item[1] : '');
      const bad = [name, null, 'sprite "' + name + '" is not valid SVG (it needs width/height attributes and well-formed markup)'];
      return new Promise((resolve) => {
        let svg = src.trim();
        if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
        const img = new Image();
        img.onload = () => {
          const w = img.width || 64, h = img.height || 64;
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.ceil(w * SPRITE_SUPERSAMPLE)); c.height = Math.max(1, Math.ceil(h * SPRITE_SUPERSAMPLE));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          if (!worker) return resolve([name, c, w, h]);
          NATIVE.createImageBitmap(c).then((b) => resolve([name, b, w, h]), () => resolve(bad));
        };
        img.onerror = () => resolve(bad);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }

    // ---------- audio ----------
    // The live engine, driven by the runtime's commands. It mirrors the little game state the
    // music follows: phase, round, win and the round clock.
    let audio = null; // the live engine, once unlocked
    const muted = params.has('mute') || QA;
    let phase = 'boot', rounds = 0, won = false, roundTime = 0;
    let musicMood = null; // GT.music.mood(name), overriding the game's `music`
    let musicUser = null; // GT.music.set(v) for the current round: { round, v }
    let sentLv = -1;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const fin = (v) => typeof v === 'number' && isFinite(v);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // At most 240 sounds (sfx and tones) a second reach the engine, whatever the runtime sends:
    // a real game never comes near it (the runtime itself sends at most 24 a frame).
    const SOUNDS_PER_SECOND = 240;
    let soundWindow = 0, soundCount = 0;
    function soundBudget() {
      const now = perfNow();
      if (now - soundWindow >= 1000) { soundWindow = now; soundCount = 0; }
      return ++soundCount <= SOUNDS_PER_SECOND;
    }

    // ----- bundle clips (v12) -----
    // The runtime fetches a bundle's audio, checks it, and hands the bytes over in one `clips`
    // message before 'ready', for WebAudio to decode here. Game code shares the runtime's Worker and
    // can post that message too, so the page trusts none of it: it is taken once, before 'ready',
    // within the caps, after this page's own walk of each clip's header; anything else is dropped
    // and counts heavily toward the flood budget. Decoding uses the context that will play the
    // sound, created now and left suspended until the first gesture resumes it (unlockAudio). A
    // muted page (?mute, ?qa) decodes on an OfflineAudioContext instead, so QA checks the same
    // decode without ever playing anything.
    const clips = new Map(); // name -> AudioBuffer
    const clipLoops = new Map(); // name -> [loopStart, loopEnd] seconds, checked against the decoded buffer
    let clipsTaken = false, clipsRefused = 0, earlyAc = null;
    function refuseClips() {
      clipsRefused++;
      if (QA || !worker) return;
      floodCount += FLOOD_MAX / 10;
      if (floodCount > FLOOD_MAX) kill('the game flooded the page with messages');
    }
    function decodeContext() {
      if (muted) return new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
      if (audio) return audio.ac;
      if (!earlyAc) earlyAc = new (window.AudioContext || window.webkitAudioContext)();
      return earlyAc;
    }
    function onClips(d) {
      const L = BUNDLE_LIMITS, list = d.list;
      if (clipsTaken || ready || !Array.isArray(list) || list.length > L.audioClips) return refuseClips();
      let total = 0;
      const names = new Set();
      for (const e of list) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || !BUNDLE_NAME_RE.test(e[0]) || names.has(e[0]) ||
          !(e[1] instanceof ArrayBuffer) || e[1].byteLength > L.fileBytes || !e[2] || typeof e[2] !== 'object') return refuseClips();
        names.add(e[0]);
        total += e[1].byteLength;
      }
      if (total > CLIP_BYTES) return refuseClips();
      clipsTaken = true;
      const token = typeof d.token === 'string' ? d.token.slice(0, 64) : '';
      const ok = [], failed = [];
      let ac = null, channelSeconds = 0;
      try { ac = decodeContext(); } catch (_) { /* no WebAudio: every clip fails below */ }
      const jobs = list.map((e) => {
        const name = e[0], buf = e[1], m = e[2];
        const seconds = fin(m.seconds) ? m.seconds : NaN, channels = m.channels, rate = m.rate;
        const fail = (why) => { failed.push([name, why]); };
        if (!(seconds > 0 && seconds <= L.audioClipSeconds) || (channels !== 1 && channels !== 2) || !fin(rate) || rate < 1 || rate > L.audioRate) return fail('bad clip metadata');
        const info = clipInfo(new Uint8Array(buf));
        if (!info) return fail('not a PCM WAV or MP3 file');
        if (info.rate > L.audioRate || info.channels > 2) return fail('more than 2 channels or ' + L.audioRate + ' Hz');
        if (info.seconds > seconds + 0.1) return fail('it plays for ' + info.seconds.toFixed(2) + ' s, more than the ' + seconds + ' s declared');
        channelSeconds += info.seconds * info.channels;
        if (channelSeconds > L.audioChannelSeconds) return fail('over ' + L.audioChannelSeconds + ' channel-seconds of audio');
        if (!ac) return fail('this browser has no WebAudio');
        const loop = Array.isArray(m.loop) && m.loop.length === 2 && fin(m.loop[0]) && fin(m.loop[1]) && m.loop[0] >= 0 && m.loop[1] > m.loop[0] ? [m.loop[0], m.loop[1]] : null;
        return new Promise((resolve, reject) => {
          // Both forms: older Safari has only the callback one.
          const p = ac.decodeAudioData(buf, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        }).then((ab) => {
          if (ab.duration > seconds + 0.1 || ab.numberOfChannels > 2) return fail('it decoded to ' + ab.duration.toFixed(2) + ' s');
          clips.set(name, ab);
          if (loop) clipLoops.set(name, [Math.min(loop[0], ab.duration), Math.min(loop[1], ab.duration)]);
          ok.push([name, Math.round(ab.duration * 1000) / 1000]);
        }, (err) => fail('the browser could not decode it' + (err && err.message ? ' (' + String(err.message).slice(0, 80) + ')' : '')));
      });
      Promise.all(jobs).then(() => send({ t: 'clips', token, ok, failed }));
    }
    // A clip as a sound effect: like playSfx (the 30 ms repeat guard, a little random pitch and level,
    // ducking for the heavy names), through the sfx bus, so the highpass and limiter still apply.
    function playClip(E, name, o, t) {
      const buf = clips.get(name);
      if (!buf || E.voices > E.cap) return;
      if (t - (E.last[name] == null ? -1 : E.last[name]) < 0.03) return;
      E.last[name] = t;
      const p = (o.pitch > 0 ? o.pitch : 1) * (1 + (E.rand() - 0.5) * 0.06);
      const v = Math.min(2, o.vol >= 0 ? o.vol : 1) * (0.88 + E.rand() * 0.24);
      const src = E.ac.createBufferSource(), g = E.ac.createGain();
      src.buffer = buf; src.playbackRate.value = clamp(p, 0.25, 4); g.gain.value = clamp(v, 0, 2);
      src.connect(g); g.connect(E.sfxBus);
      src.start(t);
      E.voices++; E.clipPlays = (E.clipPlays || 0) + 1;
      src.onended = () => { E.voices--; g.disconnect(); };
      if (has(DUCK, name) && E.m) duck(E, t, DUCK[name][0], DUCK[name][1]);
    }
    // ?qa: every audio op the runtime sends, for QA's sound-per-event checks (__gt.audioLog).
    const audioLog = [];
    const AUDIO_LOG_MAX = 10000;
    function logAudio(op) {
      const name = op.op === 'sfx' || op.op === 'music.mood' ? String(op.name) : op.op === 'phase' ? String(op.phase) : null;
      audioLog.push({ at: Math.round(perfNow()), op: String(op.op), name, qa: true });
      if (audioLog.length > AUDIO_LOG_MAX) audioLog.splice(0, audioLog.length - AUDIO_LOG_MAX);
    }
    function audioOp(d) {
      switch (d.op) {
        case 'sfx': {
          // A bundled clip wins over the synth sound of the same name.
          if (!audio || audio.held || typeof d.name !== 'string' || (!clips.has(d.name) && !has(SFX, d.name)) || !soundBudget()) return;
          // From v11 these come from the worker: clamp what reaches the engine (the limiter is not
          // a brick wall). In-range values play exactly as before; playSfx itself caps vol at 2.
          const o = d.o && typeof d.o === 'object' ? d.o : {};
          const safe = {
            pitch: fin(o.pitch) && o.pitch > 0 ? clamp(o.pitch, 0.25, 4) : undefined,
            vol: fin(o.vol) && o.vol >= 0 ? clamp(o.vol, 0, 2) : undefined,
            n: fin(o.n) ? clamp(o.n, 1, 1000) : undefined,
          };
          try {
            if (clips.has(d.name)) playClip(audio, d.name, safe, audio.ac.currentTime);
            else playSfx(audio, d.name, safe, audio.ac.currentTime);
          } catch (_) { /* audio is best-effort */ }
          return;
        }
        case 'tone': {
          if (!audio || audio.held || !fin(d.f) || !soundBudget()) return;
          const dur = fin(d.dur) && d.dur > 0 ? Math.min(10, d.dur) : 0.1;
          try {
            voice(audio, audio.sfxBus, { t: audio.ac.currentTime, f: clamp(d.f, 20, 20000), w: typeof d.type === 'string' ? d.type : 'square', dur: 0.001, v: fin(d.vol) ? clamp(d.vol, 0, 1) : 0.15, a: 0.002, d: dur, s: 0, r: 0.02, to: fin(d.slideTo) ? clamp(d.slideTo, 20, 20000) : undefined, st: dur });
          } catch (_) { /* audio is best-effort */ }
          return;
        }
        case 'phase':
          // v13: a stage intermission is still the round being played: the song keeps going at the
          // play level (no new song when play resumes, no sting).
          phase = d.phase === 'stage' ? 'play' : String(d.phase); rounds = Number(d.rounds) || 0; won = !!d.won; roundTime = Number(d.time) || 0;
          audioTick(); // start the new song (or the sting) now, not on the next tick
          return;
        case 'clock': roundTime = Number(d.time) || 0; return;
        case 'music.set': musicUser = { round: Number(d.round) || 0, v: Math.max(0, Math.min(1, Number(d.v) || 0)) }; return;
        case 'music.mood': musicMood = String(d.name); return;
      }
    }
    // Schedule every 16th step that starts before `until`. Layers enter with intensity: pad always,
    // bass 0.15, kick and hats 0.3, snare 0.45, arp 0.55, lead 0.7 (0.55 for slow moods), fills
    // 0.7, extra percussion 0.85.
    function pump(E, until) {
      const M = E.m;
      let S = M.song;
      if (S.t < E.ac.currentTime - 0.1) S.t = E.ac.currentTime + 0.02; // the timer stalled: skip ahead, don't burst
      while (S.t < until) {
        if (M.next && S.step % 16 === 0) { M.next.t = S.t; S = M.song = M.next; M.next = null; }
        const lv = M.lv = musicLevel(M);
        if (S.t >= M.hold) playStep(E, S, S.step, S.t, lv);
        const sd = 15 / S.bpm;
        S.t += S.step % 2 === 0 ? sd * (1 + S.swing) : sd * (1 - S.swing);
        S.step = (S.step + 1) % (S.bars * 16);
      }
    }
    // Attract plays quietly (bass and pad), play at the game's intensity: 70% for the first seconds,
    // full by 15 s, unless the game sets it (GT.music.set) this round. Over: the pad alone.
    function musicLevel(M) {
      if (M.fixed != null) return M.fixed;
      if (M.phase === 'play') {
        if (musicUser && musicUser.round === rounds) return musicUser.v;
        return (M.def.intensity == null ? 1 : M.def.intensity) * (0.7 + 0.3 * Math.min(1, roundTime / 15));
      }
      return M.phase === 'over' ? 0.08 : 0.25;
    }
    const DEFAULT_MOOD = { arcade: 'arcade', puzzle: 'calm', turns: 'playful' };
    // Follow the game's phase: a new song for each round played, the sting when it ends.
    function musicSync(E) {
      if (!E.m) {
        // No `music` key: a default mood by kind, so no game is silent. `music: false` opts out.
        const def = game && normMusic(game.music === undefined ? DEFAULT_MOOD[kindOf(game)] : game.music);
        if (!def) return;
        E.m = { def, mood: def.mood, song: null, next: null, phase: '', round: -1, hold: 0, lv: 0, fixed: null };
        const names = clipNames(game.music);
        if (names) Object.assign(E.m, { clip: true, names, over: game.music.over, layers: null });
      }
      if (E.m.clip) return clipSync(E, E.m);
      const M = E.m, now = E.ac.currentTime, conf = () => Object.assign({}, M.def, { mood: M.mood });
      if (musicMood && musicMood !== M.mood && (MOODS[musicMood] || musicMood === 'off')) {
        M.mood = musicMood;
        const S = genSong(conf(), ...songSeeds(baseSeed, rounds));
        if (!S) M.song = M.next = null;
        else if (M.song) M.next = S; // switch on the next bar line
        else { M.song = S; S.t = now + 0.05; }
      }
      if (phase !== M.phase || rounds !== M.round) {
        const was = M.phase;
        M.phase = phase; M.round = rounds;
        if (phase === 'play' || (phase === 'attract' && !M.song)) {
          M.song = genSong(conf(), ...songSeeds(baseSeed, rounds));
          M.next = null; M.hold = 0;
          if (M.song) M.song.t = now + 0.05;
        } else if (phase === 'over' && was === 'play' && M.song) sting(E, won);
      }
    }
    // Bundled music (v12): music: { loop: name } or { layers: [names], over: name }. One looping
    // buffer per layer, all started together at their loop start, each under its own gain. Layers
    // enter with the level at the synth's thresholds (a single loop is layer 0, always on); attract
    // and over use the synth's levels, a new round restarts the loops in sync, and `over` plays its
    // clip once in place of the synth's sting. GT.music.mood() doesn't apply. The layers bypass the
    // synth's music trim (stems are mixed at their final level) but still duck under heavy sfx.
    const LAYER_AT = [0, 0.15, 0.3, 0.45, 0.55, 0.7, 0.85];
    function clipNames(m) {
      if (!m || typeof m !== 'object') return null;
      const names = Array.isArray(m.layers) ? m.layers.slice(0, LAYER_AT.length) : typeof m.loop === 'string' ? [m.loop] : null;
      return names && names.length && names.every((n) => typeof n === 'string') ? names : null;
    }
    function clipSync(E, M) {
      const now = E.ac.currentTime;
      if (phase !== M.phase || rounds !== M.round) {
        const was = M.phase;
        M.phase = phase; M.round = rounds;
        if (phase === 'play' || (phase === 'attract' && !M.layers)) startLayers(E, M, now + 0.05);
        else if (phase === 'over' && was === 'play') {
          if (typeof M.over === 'string' && clips.has(M.over)) {
            const src = E.ac.createBufferSource();
            src.buffer = clips.get(M.over); src.connect(clipBus(E)); src.start(now + 0.05);
          } else sting(E, won);
        }
      }
      if (!M.layers) return;
      const lv = M.lv = musicLevel(M);
      M.layers.forEach((L, i) => {
        if (!L) return;
        const target = lv >= LAYER_AT[i] ? 0.5 + 0.5 * lv : 0;
        if (Math.abs(target - L.target) < 0.001) return;
        L.target = target;
        L.g.gain.setTargetAtTime(target, now, 0.1); // ~0.3 s to settle
      });
    }
    function clipBus(E) {
      if (!E.clipBus) { E.clipBus = E.ac.createGain(); E.clipBus.connect(E.duck); }
      return E.clipBus;
    }
    function startLayers(E, M, t) {
      const out = clipBus(E);
      for (const L of M.layers || []) {
        if (!L) continue;
        L.g.gain.cancelScheduledValues(t - 0.05); L.g.gain.setTargetAtTime(0, t - 0.05, 0.01);
        try { L.src.stop(t); } catch (_) { /* already stopped */ }
      }
      const lv = musicLevel(M);
      M.layers = M.names.map((name, i) => {
        const buf = clips.get(name);
        if (!buf) return null;
        const lp = clipLoops.get(name) || [0, buf.duration];
        const src = E.ac.createBufferSource(), g = E.ac.createGain(), target = lv >= LAYER_AT[i] ? 0.5 + 0.5 * lv : 0;
        src.buffer = buf; src.loop = true; src.loopStart = lp[0]; src.loopEnd = lp[1];
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(target, t + 0.03);
        src.connect(g); g.connect(out);
        src.start(t, lp[0]);
        return { src, g, target };
      });
    }
    // The lookahead timer. Also suspends the context while the host has paused this card or the
    // page is hidden, so nothing plays (or burns battery) off screen.
    function audioTick() {
      const E = audio;
      if (!E || E.dead) return;
      const hold = paused || document.hidden;
      if (hold !== E.held) { E.held = hold; quiet(hold ? E.ac.suspend() : E.ac.resume()); }
      if (hold) return;
      try {
        musicSync(E);
        if (E.m && E.m.song) pump(E, E.ac.currentTime + AHEAD);
        // The runtime shows GT.music.intensity.
        const lv = E.m ? E.m.lv : 0;
        if (Math.abs(lv - sentLv) > 0.005) { sentLv = lv; send({ t: 'music', lv }); }
      } catch (err) {
        E.err = String((err && err.message) || err); // audio is best-effort: stop the music, keep the game
        if (E.m) E.m.song = E.m.next = null;
      }
    }
    function unlockAudio() {
      if (muted || dead) return;
      if (audio) { if (!audio.held && audio.ac.state !== 'running') quiet(audio.ac.resume()); return; }
      try {
        // A bundle's clips were decoded on a context made before the first gesture: resume that one.
        const ac = earlyAc || new (window.AudioContext || window.webkitAudioContext)();
        if (earlyAc) quiet(ac.resume());
        audio = makeEngine(ac, baseSeed ^ 0x27d4eb2f);
      } catch (_) { audio = null; return; }
      timers.push(setInterval(audioTick, TICK_MS));
      on(document, 'visibilitychange', audioTick);
      // Not at once: the tap that unlocked audio starts a round in the runtime, whose 'phase' command
      // (about a millisecond away) ticks too; ticking first would start the attract song for a beat.
      setTimeout(audioTick, 30);
    }
    function audioState() {
      const M = audio && audio.m, S = M && M.song;
      return { ctx: audio ? audio.ac.state : muted ? 'muted' : 'locked', voices: audio ? audio.voices : 0, held: !!(audio && audio.held),
        mood: S ? S.mood : null, bpm: S ? S.bpm : 0, level: M ? M.lv : 0, hold: M ? M.hold : 0, time: audio ? audio.ac.currentTime : 0, err: audio ? audio.err : '',
        // v12: decoded bundle clips, and for bundled music the layers playing and their gains.
        clips: clips.size, clipPlays: audio ? audio.clipPlays || 0 : 0, layers: M && M.layers ? M.layers.map((L) => (L ? +L.g.gain.value.toFixed(3) : null)) : null };
    }
    function audioDebugLine() {
      if (muted) return 'audio muted';
      if (!audio) return 'audio locked until the first tap';
      const M = audio.m, S = M && M.song;
      return 'audio ' + audio.ac.state + (S ? ' · ' + S.mood + ' i' + M.lv.toFixed(2) + ' ' + S.bpm + 'bpm' : M ? ' · music off' : ' · no music') +
        ' · ' + audio.voices + ' voices' + (audio.err ? ' · err ' + audio.err : '');
    }
    // ?debug only: render music (and optional sfx) through an OfflineAudioContext, for tests with no
    // speakers and for the compile step's stems. o: { music: 'playful' | { mood, tempo, intensity },
    // intensity, seed, round, sfx: [[seconds, name, opts], …], rate, solo, limiter }. Resolves to
    // { buffer, ms, notes, song: { mood, bpm, root, scale, bars, swing, steps, seconds }, solo, limiter }.
    // It schedules in 0.1 s chunks with the live lookahead (suspending the render between them), so
    // the graph holds what it would live and `ms` is a fair measure of the audio thread's cost.
    //   solo: an array of MUSIC_GROUPS names (pad, bass, drums = kick, hats and snare, arp, lead,
    //     fills, perc): only those music notes are scheduled; [] renders no music. Unknown names
    //     throw. Groups still enter at their intensity thresholds, so render stems at intensity 1.
    //   limiter: false: no compressor and no 0.7 output trim (see makeEngine). Default true.
    // The song starts at 0.02 s and repeats every bars × 4 × 60 / bpm seconds (swing moves notes
    // within a pair of 16ths, never the bar line); render two periods and keep the second, so the
    // first period's missing release tails don't matter.
    async function renderOffline(seconds, o) {
      o = o || {};
      let solo = null;
      if (o.solo != null) {
        if (!Array.isArray(o.solo)) throw new Error('GT.audio.render: solo must be an array of ' + MUSIC_GROUPS.join(', '));
        for (const g of o.solo) if (!MUSIC_GROUPS.includes(g)) throw new Error('GT.audio.render: unknown solo group "' + g + '" (' + MUSIC_GROUPS.join(', ') + ')');
        solo = new Set(o.solo);
      }
      const limiter = o.limiter !== false;
      const rate = o.rate || 44100, seed = o.seed == null ? baseSeed : o.seed >>> 0;
      const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.ceil(rate * seconds), rate);
      const E = makeEngine(ac, seed ^ 0x27d4eb2f, { limiter });
      E.log = []; E.cap = Infinity; E.solo = solo;
      const def = o.music === false ? null : normMusic(o.music || (game && game.music) || 'arcade');
      const S = def && genSong(def, ...songSeeds(seed, o.round || 0));
      if (S) {
        E.m = { def, mood: def.mood, song: S, next: null, phase: 'play', round: 0, hold: 0, lv: 0, fixed: o.intensity != null ? o.intensity : def.intensity != null ? def.intensity : 1 };
        S.t = 0.02;
      }
      const sfxs = (o.sfx || []).slice().sort((x, y) => x[0] - y[0]);
      let si = 0;
      const chunk = (at) => {
        if (S) pump(E, Math.min(seconds, at + AHEAD));
        while (si < sfxs.length && sfxs[si][0] < at + 0.1) { const x = sfxs[si++]; playSfx(E, x[1], x[2], x[0]); }
      };
      chunk(0);
      for (let k = 1; k * 0.1 < seconds; k++) {
        const at = k * 0.1;
        ac.suspend(at).then(() => { chunk(ac.currentTime); ac.resume(); });
      }
      const t0 = perfNow();
      const buffer = await ac.startRendering();
      return {
        buffer, ms: perfNow() - t0, notes: E.log.slice(),
        song: S && { mood: S.mood, bpm: S.bpm, root: S.root, scale: S.scale, bars: S.bars, swing: S.swing, steps: S.bars * 16, seconds: (S.bars * 4 * 60) / S.bpm },
        solo: solo ? Array.from(solo) : null, limiter,
      };
    }
    // soloGroups (v12): what render's `solo` takes; its presence says render takes solo and limiter.
    const audioApi = { render: renderOffline, moods: Object.keys(MOODS), sfx: Object.keys(SFX), state: audioState, soloGroups: MUSIC_GROUPS.slice() };
    if (DEBUG) timers.push(setInterval(() => send({ t: 'audioLine', text: audioDebugLine(), state: audioState() }), 1000));

    // ---------- QA and debug surfaces ----------
    let lastState = {
      phase: 'boot', score: 0, t: 0, rounds: 0, won: false, kind: 'arcade', three: false, errors: 0,
      turns: 0, turnsLeft: 0, turnsUsed: 0, finishing: false, settleCapped: false, solutions: null, outOfTurns: false,
    };
    const qaWaiting = new Map();
    let qaId = 0;
    function qa(op, extra) {
      if (dead) return Promise.reject(new Error('the game was stopped'));
      if (!worker && !rt) return Promise.reject(new Error('the game has not started'));
      const id = ++qaId;
      return new Promise((resolve, reject) => {
        qaWaiting.set(id, { resolve, reject });
        send(Object.assign({ t: 'qa', op, id }, extra));
      });
    }
    function settle(d) {
      const p = qaWaiting.get(d.id);
      if (d.state && typeof d.state === 'object') lastState = d.state;
      if (!p) return;
      qaWaiting.delete(d.id);
      if (d.ok) p.resolve(d.value); else p.reject(new Error(String(d.error)));
    }
    function clearAudioLog() { const n = audioLog.length; audioLog.length = 0; return n; }
    if (QA) {
      window.__gt = {
        events,
        get inthread() { return inthread; },
        // Who is running: this shell's build and the runtime version it hosts (design §3.5).
        shell: SHELL_BUILD,
        runtime: RUNTIME,
        state: () => lastState,
        step: (n) => qa('step', { n }),
        down(x, y) { send({ t: 'qa', op: 'input', k: 'down', x, y }); },
        move(x, y) { send({ t: 'qa', op: 'input', k: 'move', x, y }); },
        up(x, y) { send({ t: 'qa', op: 'input', k: 'up', x, y }); },
        swipe(dir) { send({ t: 'qa', op: 'swipe', dir }); },
        overlay: (show) => qa('overlay', { show: !!show }),
        // Play a real round with the game's own autopilot instead of human input.
        autoplay(on) { send({ t: 'qa', op: 'autoplay', on: !!on }); },
        fingerprint: (grid) => qa('fingerprint', { grid: !!grid }),
        screenshot: () => qa('screenshot'),
        inject: (src) => qa('inject', { src: String(src) }),
        // clearAudioLog is the shell's own: the log lives here.
        call: (name, ...args) => (RT.qaAudioLog && String(name) === 'clearAudioLog' ? Promise.resolve(clearAudioLog()) : qa('call', { name: String(name), args })),
      };
      // v12+ runtimes only: QA reads an audioLog as "this SDK records sound", and v11 never tags its ops.
      if (RT.qaAudioLog) {
        Object.assign(window.__gt, {
          // v12: the audio ops the runtime sent ({ at, op, name, qa: true }, oldest first, at most 10,000).
          audioLog,
          clearAudioLog,
          // v12: the clips this page decoded, and how many `clips` messages it refused.
          clips: () => ({ names: Array.from(clips.keys()), refused: clipsRefused }),
        });
      }
    }
    if (DEBUG) {
      // sdk and shell are the page's word (after the runtime's stats, which game code could forge).
      window.__gtStats = () => Object.assign({ phase: lastState.phase, fps: 0 }, lastStats, { dpr: window.devicePixelRatio || 1, sdk: RUNTIME, shell: SHELL_BUILD });
    }

    // ---------- window.GT on the page ----------
    // Game code runs in the worker, so the page's GT is a stand-in. It exists for pages that still
    // insert game.js themselves (an old index.html, a third-party embedder): that code then also
    // runs here, once, and must not throw at its top level. GT.game() starts the worker with that
    // script's URL; every other property is `stub`, which absorbs any use (call it, construct it,
    // read or set anything on it, do arithmetic with it: 0, print it: '').
    const stub = new Proxy(function () {}, {
      get(_, k) {
        if (k === Symbol.toPrimitive || k === 'valueOf') return () => 0;
        if (k === 'toString') return () => '';
        if (k === 'then') return undefined;
        if (k === Symbol.iterator) return function* () {};
        return stub;
      },
      set: () => true,
      apply: () => stub,
      construct: () => stub,
    });
    let legacyWarned = false;
    function legacyGame(def) {
      if (gameUrl || worker || rt) {
        console.warn('diddly: GT.game() on the page was ignored; the SDK loads the game from its script tag (data-game)');
        return;
      }
      const src = document.currentScript && document.currentScript.src;
      if (!legacyWarned) { legacyWarned = true; console.warn('diddly: this page inserts game.js itself; put its URL on the SDK script tag as data-game instead'); }
      if (!src) { console.warn('diddly: GT.game() must be called while game.js loads'); return; }
      if (!spawn(src)) noWorker(def, '', src);
    }
    const pageGT = new Proxy({ W, H, version: RUNTIME, t: 0, loadsGame: true, game: legacyGame, audio: DEBUG ? audioApi : undefined }, {
      get: (o, k) => (has(o, k) ? o[k] : stub),
      set: () => true,
    });

    // ---------- start ----------
    if (workerOk) {
      window.GT = pageGT;
      // Game code that still runs on the page (the legacy path) doesn't crash the game: the
      // worker's run is the one that counts.
      on(window, 'error', (e) => { if (!inthread) console.warn('diddly: error on the page, ignored (the game runs in a worker):', e.message); });
      if (gameUrl && !spawn(gameUrl)) noWorker(null, gameUrl);
    } else {
      startInThread(null, gameUrl);
    }
  }

  // ================================================================ runtime
  // Everything that runs the game: the fixed step, lifecycle, juice, feel kit, art kit, fluids,
  // 3D, HUD and QA hooks. It never touches the DOM. `env`, from the worker or the in-thread
  // adapter, supplies the frame canvas, the page's query string, a post(msg) to the shell, and
  // the few things that differ between a Worker and a page (loading scripts, new canvases).
  function runtime(env) {
    const params = new URLSearchParams(env.search);
    const QA = params.has('qa');
    // Field debugging on phones. ?debug draws live diagnostics over the game. ?gl=a,b switches 3D
    // features off one at a time, to find what a device can't handle:
    //   noshadow · noadapt (fixed resolution) · dpr1 (1x density) · aa / noaa (force antialias)
    //   nocomposite (render the 3D scene but don't copy it onto the screen)
    //   basic (Lambert shading instead of toon/standard) · noback (hide back-face outline meshes)
    //   shadow (force shadow maps on GPUs where the SDK refuses them, currently PowerVR)
    //   nopost (skip the 2D post-fx pass: bloom, vignette, grain, tint)
    const DEBUG = params.has('debug');
    const GL_FLAGS = new Set((params.get('gl') || '').split(',').map((f) => f.trim()).filter(Boolean));
    const BOOT_AT = perfNow();
    const SPEED = Math.max(1, Number(params.get('speed')) || 1);
    // ?mute: no sound commands are sent at all. ?qa (v12+) sends them tagged `qa`: the shell records
    // them for QA (__gt.audioLog) and plays nothing.
    const muted = params.has('mute') && !QA;
    // three.js for 3D games (`three: true`): a vendored build next to the SDK releases, at
    // /sdk/three/r<rev>.js on whichever site served this file. Only loaded by games that ask.
    const SDK_SRC = env.sdkSrc;
    // Event times are the page's (performance.now() in a worker counts from the worker's start).
    const pageNow = () => perfNow() + env.timeOffset;

    // ---------- telemetry ----------
    // Every event goes to the shell, which keeps the list QA reads and forwards it to the host.
    let errorCount = 0;
    function post(msg, transfer) {
      try { env.post(msg, transfer); } catch (_) {
        // A game can put anything in its title or instruction; send what survives JSON instead.
        try { env.post(JSON.parse(JSON.stringify(msg))); } catch (_) { /* nothing to send */ }
      }
    }
    function emit(type, data) {
      const ev = Object.assign({ diddly: true, type, at: Math.round(pageNow()) }, data || {});
      if (type === 'error') errorCount++;
      post({ t: 'emit', ev });
    }
    let lastError = ''; // shown small on the crash screen, so a tester on a phone can see what broke
    function reportError(err) {
      const message = String((err && err.message) || err);
      lastError = message;
      emit('error', { message, stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined });
    }
    env.onError((err) => { reportError(err); crash(); if (phase === 'crashed') render(); });

    // ---------- seeded RNG streams ----------
    const baseSeed = env.baseSeed >>> 0;
    let rounds = 0;
    // Three independent streams so the attract bot and visual effects never perturb game RNG.
    let rand = mulberry(baseSeed);
    let botRand = mulberry(baseSeed ^ 0x9e3779b9);
    let fxRand = mulberry(baseSeed ^ 0x85ebca6b);

    // ---------- canvas ----------
    // The frame canvas: the page's <canvas> transferred to this worker as an OffscreenCanvas (or
    // the element itself, in-thread). The shell sizes it on the page; its bitmap is sized here,
    // from the viewport and pixel ratio the shell sends ('size').
    // Under ?qa in a worker, frames are drawn into a private canvas of the same size, and the page's
    // canvas is only updated by __gt.overlay() and __gt.screenshot() (present()). Chrome paces a
    // worker that commits frames to the page to the compositor (~10 ms before its next message, and
    // stalls of 100 ms+ every few dozen frames): nothing at 60 fps, but 20-30x the cost of a QA
    // step, and QA steps one at a time. Even a copy 4 times a second still slowed steps measurably.
    // QA reads frames through __gt (fingerprint, screenshot), from this canvas; `self.__gtFrame`
    // names it for QA's text watch.
    const screen = env.canvas;
    const canvas = QA && !env.inthread ? env.offscreen(screen.width || 1, screen.height || 1) : screen;
    const ctx = canvas.getContext('2d');
    if (QA) self.__gtFrame = canvas;
    let screenCtx = null;
    function present() {
      if (canvas === screen) return;
      if (screen.width !== canvas.width || screen.height !== canvas.height) { screen.width = canvas.width; screen.height = canvas.height; }
      if (!screenCtx) screenCtx = screen.getContext('2d');
      screenCtx.drawImage(canvas, 0, 0);
    }
    let scale = 1, viewW = env.vw || W, viewH = env.vh || H, DPR = env.dpr || 1;
    // 3D games under load also shed 2D pixels (see adapt()): the WebGL composite and the post-fx
    // pass each cost a full-screen blit, and on a 3x phone that is most of the frame budget.
    let density = 1, densityPending = false;
    // Last rung of the ladder: with density at its floor and frames still slow, drop the post-fx
    // passes nobody misses at speed (grain, vignette, tint), keeping bloom.
    let postLite = false;
    function resize() {
      scale = Math.min(viewW / W, viewH / H);
      // 3D games cap the 2D layer at the 3D layer's density: no upscaling the 3D frame, and far
      // fewer pixels for every full-screen 2D pass (sky, post-fx) on 3x phones.
      const dpr = Math.min(DPR || 1, game && game.three ? max3dDpr() : 3) * density;
      canvas.width = Math.round(W * scale * dpr);
      canvas.height = Math.round(H * scale * dpr);
    }
    function onSize(d) {
      viewW = Number(d.vw) || W; viewH = Number(d.vh) || H; DPR = Number(d.dpr) || 1;
      resize();
      if (game) render(); // resizing clears the canvas
    }

    // ---------- input ----------
    // The shell turns pointer and key events into logical coordinates and posts them here.
    function blankInput() {
      return { down: false, tap: false, release: false, x: W / 2, y: H / 2, dx: 0, dy: 0, swipe: null, holdTime: 0, stick: idleStick(W / 2, H / 2) };
    }
    // ---------- v17: the virtual stick ----------
    // A floating joystick for drag games: input.stick is the vector from where the press began to
    // the finger, in units of the stick's radius (-1..1 a side, length ≤ 1), past a dead zone. With
    // `follow` (default) the origin trails a finger that goes beyond the radius, so reversing is
    // instant. Every input carries it; a game that declares `stick` also gets it drawn.
    function idleStick(x, y) { return { x: 0, y: 0, mag: 0, angle: 0, active: false, ox: x, oy: y }; }
    let stickCfg = null;
    function stickOpts() {
      if (stickCfg && stickCfg.game === game) return stickCfg;
      const o = game && game.stick && typeof game.stick === 'object' ? game.stick : {};
      const n = (v, d, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
      stickCfg = { game, radius: n(o.radius, 64, 16, 200), dead: n(o.deadZone, 0.12, 0, 0.9), follow: o.follow !== false, show: !!(game && game.stick) && o.show !== false };
      return stickCfg;
    }
    const pressAt = { human: null, bot: null }; // where the current press began, per input source
    const stickOrg = { human: null, bot: null }; // the stick's (possibly trailing) origin
    const stickKnob = { x: 0, y: 0, active: false, ox: 0, oy: 0 }; // what the SDK draws: the last step's stick
    function applyStick(inp, who) {
      const o = stickOpts();
      if (!inp.down) { stickOrg[who] = null; inp.stick = idleStick(inp.x, inp.y); return inp; }
      if (inp.tap || !stickOrg[who]) {
        const p = pressAt[who] || { x: inp.x, y: inp.y };
        stickOrg[who] = { x: p.x, y: p.y };
      }
      const org = stickOrg[who], R = o.radius;
      let vx = (inp.x - org.x) / R, vy = (inp.y - org.y) / R, m = Math.hypot(vx, vy);
      if (m > 1) {
        if (o.follow) { org.x = inp.x - (vx / m) * R; org.y = inp.y - (vy / m) * R; }
        vx /= m; vy /= m; m = 1;
      }
      const mag = m <= o.dead ? 0 : (m - o.dead) / (1 - o.dead), k = m > 0 ? mag / m : 0;
      inp.stick = { x: vx * k, y: vy * k, mag, angle: Math.atan2(vy, vx), active: true, ox: org.x, oy: org.y };
      stickKnob.x = org.x + vx * R; stickKnob.y = org.y + vy * R; stickKnob.ox = org.x; stickKnob.oy = org.y;
      return inp;
    }
    const human = blankInput();
    const pending = { tap: false, release: false, swipe: null, dx: 0, dy: 0 };
    let gesture = null; // {x, y, t}
    let gotFirstInput = false;

    function onDown(x, y) {
      human.down = true; human.x = x; human.y = y; human.holdTime = 0;
      pending.tap = true;
      pressAt.human = { x, y };
      gesture = { x, y, t: perfNow() };
      if (!gotFirstInput) { gotFirstInput = true; emit('input'); }
      if (phase === 'stage') stageDown = true; // v13: a press and release in the intermission continues
      handleMeta();
    }
    function onMove(x, y) {
      if (human.down) { pending.dx += x - human.x; pending.dy += y - human.y; }
      human.x = x; human.y = y;
    }
    function onUp(x, y) {
      if (!human.down) return;
      onMove(x, y);
      human.down = false;
      pending.release = true;
      if (phase === 'stage' && stageDown) { stageDown = false; stageContinue(x, y); }
      if (gesture) {
        const gx = x - gesture.x, gy = y - gesture.y, dist = Math.hypot(gx, gy);
        if (dist >= 36 && perfNow() - gesture.t < 600) {
          pending.swipe = Math.abs(gx) > Math.abs(gy) ? (gx > 0 ? 'right' : 'left') : (gy > 0 ? 'down' : 'up');
        }
      }
      gesture = null;
    }
    // Desktop keyboard: space = press, arrows = swipe. (The feed's own shortcut keys never get here.)
    const arrowDir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    function onKey(code, down) {
      if (code === 'Space' || code === 'Enter') { if (down) onDown(human.x, human.y); else onUp(human.x, human.y); }
      else if (down && arrowDir[code]) {
        pending.swipe = arrowDir[code];
        if (!gotFirstInput) { gotFirstInput = true; emit('input'); }
        handleMeta();
      }
    }
    function onInput(d) {
      const x = Math.max(0, Math.min(W, Number(d.x) || 0)), y = Math.max(0, Math.min(H, Number(d.y) || 0));
      if (d.k === 'down') onDown(x, y);
      else if (d.k === 'move') onMove(x, y);
      else if (d.k === 'up') onUp(x, y);
      else if (d.k === 'key') onKey(String(d.code), !!d.down);
    }

    let lastActivityAt = -Infinity;
    function consumeHuman() {
      human.tap = pending.tap; human.release = pending.release; human.swipe = pending.swipe;
      human.dx = pending.dx; human.dy = pending.dy;
      human.holdTime = human.down ? human.holdTime + STEP : 0;
      pending.tap = pending.release = false; pending.swipe = null; pending.dx = pending.dy = 0;
      // 'activity': the player is still playing (a press, hold or swipe), at most once a second.
      // Hosts hide their controls during a round and use it to tell a stuck player from a busy one.
      if (phase === 'play' && (human.down || human.tap || human.swipe)) {
        const now = perfNow();
        if (now - lastActivityAt >= 1000) { lastActivityAt = now; emit('activity'); }
      }
      return human;
    }

    // Attract-mode driver: the game's autopilot if it has one, else a random bot.
    const bot = blankInput();
    let botHoldLeft = 0, botIdleLeft = 0.3;
    function botStep(s) {
      const prevDown = bot.down, px = bot.x, py = bot.y;
      bot.swipe = null;
      if (game.autopilot) {
        let a = null;
        try { a = game.autopilot(s) || {}; } catch (err) { reportError(err); return crash(); }
        // v17: an autopilot may steer the stick directly: { stick: { x, y } } (-1..1), anchored at
        // its own x/y (default: lower middle) when the press begins.
        const st = a.stick && typeof a.stick === 'object' ? a.stick : null;
        if (st) {
          bot.down = a.down !== false;
          if (bot.down && !prevDown) pressAt.bot = { x: typeof a.x === 'number' ? a.x : W / 2, y: typeof a.y === 'number' ? a.y : H * 0.72 };
          const R = stickOpts().radius, p = pressAt.bot || { x: W / 2, y: H * 0.72 };
          let sx = Number(st.x) || 0, sy = Number(st.y) || 0;
          const m = Math.hypot(sx, sy);
          if (m > 1) { sx /= m; sy /= m; }
          bot.x = p.x + sx * R; bot.y = p.y + sy * R;
        } else {
          bot.down = !!a.down;
          if (typeof a.x === 'number') bot.x = a.x;
          if (typeof a.y === 'number') bot.y = a.y;
          if (bot.down && !prevDown) pressAt.bot = { x: bot.x, y: bot.y };
        }
        if (a.swipe) bot.swipe = a.swipe;
      } else {
        if (bot.down) {
          botHoldLeft -= STEP;
          bot.x += (botRand() - 0.5) * 12; bot.y += (botRand() - 0.5) * 12;
          if (botHoldLeft <= 0) {
            bot.down = false;
            if (botRand() < 0.3) bot.swipe = ['left', 'right', 'up', 'down'][Math.floor(botRand() * 4)];
            botIdleLeft = 0.1 + botRand() * 0.7;
          }
        } else if ((botIdleLeft -= STEP) <= 0) {
          bot.down = true; bot.x = 40 + botRand() * (W - 80); bot.y = 120 + botRand() * (H - 200);
          pressAt.bot = { x: bot.x, y: bot.y };
          botHoldLeft = 0.05 + botRand() * 0.6;
        }
      }
      bot.x = Math.max(0, Math.min(W, bot.x)); bot.y = Math.max(0, Math.min(H, bot.y));
      bot.tap = bot.down && !prevDown;
      bot.release = !bot.down && prevDown;
      bot.dx = bot.down && prevDown ? bot.x - px : 0;
      bot.dy = bot.down && prevDown ? bot.y - py : 0;
      bot.holdTime = bot.down ? bot.holdTime + STEP : 0;
      return bot;
    }

    // ---------- sound, as commands to the shell ----------
    // The audio engine lives on the page (WebAudio needs the page and the player's gesture); the
    // runtime sends it what to play. Muted pages send nothing; under ?qa every op is tagged `qa`.
    let musicLv = 0; // the music's current intensity, reported back by the shell
    // Sound commands go out together, one message at the end of the task that made them (a frame,
    // or a message from the shell): a game playing sounds every step can't flood the page.
    let audioQueue = null;
    function audioOut(op) {
      if (!audioQueue) { audioQueue = []; Promise.resolve().then(flushAudio); }
      if (QA) op.qa = true;
      audioQueue.push(op);
    }
    function flushAudio() {
      const ops = audioQueue;
      audioQueue = null;
      if (ops && ops.length) post({ t: 'audio', ops });
    }
    let audioLine = 'audio locked until the first tap', audioInfo = null; // ?debug, from the shell
    let sentPhase = '', sentRound = -1, sentWon = false;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
    // The page drops a repeat of the same sound within 30 ms anyway, and a phone plays ~90 voices
    // at most: don't send what can't be heard (and keep the page's message rate low).
    const SOUNDS_PER_FRAME = 24;
    let soundsSent = 0;
    const lastSfx = new Map();
    let qaClock = 0; // ?qa: ms of game steps run (1000/60 each)
    function sfx(name, o) {
      name = String(name);
      if (QA && assets.has(name)) used(name);
      if (muted || (phase !== 'play' && phase !== 'over') || soundsSent >= SOUNDS_PER_FRAME) return;
      // ?qa steps faster than real time, so the 30 ms merge runs on the step clock there (QA counts
      // sounds against score steps; a wall-clock merge would drop repeats real play keeps).
      const now = QA ? qaClock : perfNow(), prev = lastSfx.get(name);
      if (prev != null && now - prev < 30) return;
      lastSfx.set(name, now); soundsSent++;
      o = o || {};
      audioOut({ op: 'sfx', name, o: { pitch: num(o.pitch), vol: num(o.vol), n: num(o.n) } });
    }
    function tone(freq, dur, type, vol, slideTo) {
      if (muted || (phase !== 'play' && phase !== 'over') || soundsSent >= SOUNDS_PER_FRAME) return;
      soundsSent++;
      audioOut({ op: 'tone', f: num(freq), dur: num(dur), type: type == null ? undefined : String(type), vol: num(vol), slideTo: num(slideTo) });
    }
    // The music follows the phase: a new song each round played, a sting when it ends.
    function audioPhase() {
      if (muted || (phase === sentPhase && rounds === sentRound && won === sentWon)) return;
      sentPhase = phase; sentRound = rounds; sentWon = won;
      audioOut({ op: 'phase', phase, rounds, won, time: roundTime });
    }
    // The round clock, for the music's build-up over the first 15 s of a round.
    function audioClock() {
      if (!muted && phase === 'play') audioOut({ op: 'clock', time: roundTime });
    }
    const musicApi = {
      /** Intensity 0..1 for the rest of this round (layers enter as it rises). */
      set(v) { if (!muted) audioOut({ op: 'music.set', round: rounds, v: Math.max(0, Math.min(1, Number(v) || 0)) }); },
      /** Switch mood at the next bar line; 'off' stops the music. */
      mood(name) { if (!muted) audioOut({ op: 'music.mood', name: name ? String(name) : 'off' }); },
      get intensity() { return musicLv; },
      moods: Object.keys(MOODS),
    };
    // What the page's audio engine needs to know about the game's music. v12: `loop` (a bundled
    // clip's name), `layers` (clip names, quietest first) and `over` (a clip in place of the sting);
    // loadBundle checks the names against the bundle.
    function musicDef(m) {
      if (m === undefined || m === false || m === null) return m;
      if (typeof m === 'string') return m;
      if (typeof m !== 'object') return String(m);
      const o = { mood: m.mood == null ? undefined : String(m.mood), tempo: num(Number(m.tempo)), intensity: m.intensity == null ? undefined : num(Number(m.intensity)) };
      if (m.loop != null) o.loop = String(m.loop);
      if (m.layers != null) o.layers = Array.isArray(m.layers) ? m.layers.slice(0, 16).map(String) : [];
      if (m.over != null) o.over = String(m.over);
      return o;
    }

    // ---------- juice ----------
    // Particles and floaters marked `ui` belong to the SDK's own screens (the new-best celebration):
    // they draw above the game-over dimming instead of under it.
    let particles = [], floaters = [];
    let shakeAmt = 0, flashColor = null, flashT = 0;
    function burst(x, y, color, n, speed) { spray(x, y, color, n, speed, false); }
    function spray(x, y, color, n, speed, ui) {
      n = n || 12; speed = speed || 160;
      for (let i = 0; i < n; i++) {
        const a = fxRand() * Math.PI * 2, v = speed * (0.3 + fxRand() * 0.7);
        particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + fxRand() * 0.4, max: 0.8, color: color || '#fff', r: 2 + fxRand() * 3, ui });
      }
      if (particles.length > 400) particles.splice(0, particles.length - 400);
    }
    function stepJuice() {
      for (const p of particles) { p.x += p.vx * STEP; p.y += p.vy * STEP; p.vy += 300 * STEP; p.vx *= 0.98; p.life -= STEP; }
      particles = particles.filter((p) => p.life > 0);
      for (const f of floaters) { f.y -= 40 * STEP; f.life -= STEP; }
      floaters = floaters.filter((f) => f.life > 0);
      shakeAmt = Math.max(0, shakeAmt - 40 * STEP);
      flashT = Math.max(0, flashT - STEP);
      stepFeel();
    }
    function drawJuice(ui) {
      for (const p of particles) {
        if (!p.ui !== !ui) continue;
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      // QA's text watch skips its counter-growth check for floater text (a floater's number never grows).
      if (QA) self.__gtFloat = true;
      for (const f of floaters) {
        if (!f.ui !== !ui) continue;
        ctx.globalAlpha = Math.min(1, f.life / 0.4);
        GT.text(ctx, f.text, f.x, f.y, f.size, f.color, 'center', '800', !!(ui || f.outline));
      }
      if (QA) self.__gtFloat = false;
      ctx.globalAlpha = 1;
      if (!ui && rings.length) drawRings();
      if (!ui && flashT > 0 && flashColor) {
        ctx.globalAlpha = flashT / 0.25 * 0.6; ctx.fillStyle = flashColor; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      }
    }

    // ---------- feel kit: hit-stop, slow motion, tweens, springs, transitions, coaching ----------
    // Everything here advances with the fixed step, never wall-clock time, so QA's replays of a
    // seeded round stay frame-identical.
    const HITSTOP_MAX = 8, HITSTOP_COOL = 12; // steps
    let hitStopLeft = 0, hitStopCool = 0;
    function hitStop(steps) {
      if (phase !== 'play' && phase !== 'attract') return;
      const n = Math.round(Math.min(HITSTOP_MAX, Math.max(0, steps == null ? 4 : Number(steps) || 0)));
      // A cooldown after each stop, so a game calling this on every hit can't lock itself up.
      if (n > 0 && hitStopCool <= 0) hitStopLeft = Math.max(hitStopLeft, n);
    }
    // True while a hit-stop holds the game still: step() then skips update() and the round clock.
    function frozenStep() {
      if (hitStopLeft > 0) { if (--hitStopLeft === 0) hitStopCool = HITSTOP_COOL; return true; }
      if (hitStopCool > 0) hitStopCool--;
      return false;
    }

    let slowFactor = 1, slowSteps = 0, slowAt = 0;
    function slowmo(factor, seconds) {
      if (phase !== 'play' && phase !== 'attract') return;
      const f = Math.min(1, Math.max(0.2, factor == null ? 0.35 : Number(factor) || 1));
      const n = Math.round(Math.min(3, Math.max(0, seconds == null ? 0.5 : Number(seconds) || 0)) / STEP);
      if (f >= 1 || n <= 0 || f > timeScale()) return; // a milder request never cuts a deeper one short
      slowFactor = f; slowSteps = n; slowAt = 0;
    }
    // The game's time scale this step: holds near the requested factor, then eases back to 1.
    function timeScale() {
      if (slowAt >= slowSteps) return 1;
      const p = slowAt / slowSteps;
      return slowFactor + (1 - slowFactor) * p * p;
    }

    const EASE = Object.freeze({
      linear: (t) => t,
      outCubic: (t) => 1 - (1 - t) ** 3,
      outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
      outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
      outBounce(t) {
        const n = 7.5625, d = 2.75;
        if (t < 1 / d) return n * t * t;
        if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
        if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
        return n * (t -= 2.625 / d) * t + 0.984375;
      },
      inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    });

    // Tweens animate numeric properties of any object from their current values, one fixed step
    // at a time. A newer tween on the same property takes it over; the pool is capped, and when
    // full the oldest tween jumps to its end.
    const MAX_TWEENS = 256;
    let tweens = [];
    function tween(obj, props, seconds, ease, onDone) {
      if (!obj || typeof obj !== 'object' || !props) return null;
      const from = {}, to = {};
      for (const k of Object.keys(props)) {
        const v = Number(props[k]);
        if (!Number.isFinite(v)) continue;
        const cur = Number(obj[k]);
        from[k] = Number.isFinite(cur) ? cur : v;
        to[k] = v;
      }
      for (const tw of tweens) if (tw.obj === obj) for (const k in to) delete tw.to[k];
      if (tweens.length >= MAX_TWEENS) endTween(tweens.shift(), true);
      const tw = {
        obj, from, to, i: 0, n: Math.max(1, Math.round((Number(seconds) || 0) / STEP)),
        ease: typeof ease === 'function' ? ease : EASE[ease] || EASE.outCubic,
        cb: typeof onDone === 'function' ? onDone : null, done: false,
        stop() { this.to = {}; this.cb = null; this.done = true; },
      };
      tweens.push(tw);
      return tw;
    }
    function endTween(tw, snap) {
      if (tw.done) return;
      tw.done = true;
      if (snap) for (const k in tw.to) tw.obj[k] = tw.to[k];
      if (!tw.cb || !Object.keys(tw.to).length) return; // taken over entirely: no callback
      try { tw.cb(tw.obj); } catch (err) { reportError(err); crash(); }
    }
    function stepTweens() {
      const n = tweens.length; // tweens started from an onDone begin on the next step
      for (let i = 0; i < n; i++) {
        const tw = tweens[i];
        if (tw.done) continue;
        if (++tw.i >= tw.n) { endTween(tw, true); continue; }
        const e = tw.ease(tw.i / tw.n);
        for (const k in tw.to) tw.obj[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      }
      if (tweens.some((tw) => tw.done)) tweens = tweens.filter((tw) => !tw.done);
    }

    // Named value springs for squash-and-stretch, pops and smoothed followers. GT.spring(name)
    // returns the same spring every call; passing a target moves its rest point.
    const springs = new Map();
    function spring(name, target, stiffness, damping) {
      const key = String(name);
      let s = springs.get(key);
      if (!s) {
        const v = Number.isFinite(Number(target)) ? Number(target) : 1;
        s = {
          v, vel: 0, target: v, k: 300, c: 16,
          kick(a) { this.v += Number(a) || 0; return this; },
          set(x) { if (Number.isFinite(Number(x))) { this.v = this.target = Number(x); this.vel = 0; } return this; },
        };
        if (springs.size >= 128) springs.delete(springs.keys().next().value);
        springs.set(key, s);
      }
      if (target != null && Number.isFinite(Number(target))) s.target = Number(target);
      if (stiffness != null) s.k = Math.min(2000, Math.max(1, Number(stiffness) || 300)); // stays stable at 60 Hz
      if (damping != null) s.c = Math.min(60, Math.max(0, Number(damping) || 0));
      return s;
    }
    function stepSprings() {
      for (const s of springs.values()) {
        s.vel += (-s.k * (s.v - s.target) - s.c * s.vel) * STEP;
        s.v += s.vel * STEP;
        if (Math.abs(s.v - s.target) < 1e-4 && Math.abs(s.vel) < 1e-3) { s.v = s.target; s.vel = 0; }
      }
    }

    // Phase transitions: an iris opening from the tap point as a round starts (12 steps, 200 ms),
    // and the game-over card fading and popping in. Both finish long before QA's first play
    // fingerprint (60 steps in), and QA never fingerprints the over screen.
    const IRIS_STEPS = 12, OVER_FADE = 0.2;
    let irisAt = IRIS_STEPS, irisX = W / 2, irisY = H / 2;
    let newBest = false, celebrateIn = 0, prevBest = 0;
    // First-input coaching: steps spent waiting for the player, per round.
    let hintSteps = 0, roundInput = false;

    function resetFeel(mode) {
      hitStopLeft = hitStopCool = 0; slowSteps = slowAt = 0;
      tweens = []; newBest = false; celebrateIn = 0;
      for (const s of springs.values()) { s.v = s.target; s.vel = 0; }
      if (mode === 'play') { irisAt = 0; irisX = human.x; irisY = human.y; hintSteps = 0; roundInput = false; }
      resetRetry();
    }
    function stepFeel() {
      if (slowAt < slowSteps) slowAt++;
      if (irisAt < IRIS_STEPS) irisAt++;
      if (phase === 'attract' || phase === 'play') hintSteps++;
      if (celebrateIn > 0 && --celebrateIn === 0) celebrate();
      stepRetry();
      stepTweens();
      stepSprings();
    }
    // Called by step() with the player's input: a fresh press, a swipe, a drag or a real hold.
    function noteInput(inp) {
      if (inp.tap || inp.swipe || inp.dx || inp.dy || (inp.down && inp.holdTime >= 0.3)) roundInput = true;
    }

    // Called by step() when a real round ends. A new best (the over screen says NEW BEST) gets a
    // celebration timed to the label's pop.
    function roundOver(before) {
      hitStopLeft = 0; slowSteps = 0; prevBest = before;
      newBest = game.kind === 'puzzle' ? won && rounds > 1 && overAt <= bestTime + 1e-6 : score > 0 && score > prevBest;
      if (newBest) celebrateIn = 9;
    }
    function celebrate() {
      const puzzle = game.kind === 'puzzle', y = (puzzle ? H * 0.5 : H * 0.47) + H * stageLineShift();
      for (const c of ['#ffe066', '#ffffff', '#ff9f43', '#9bf6ff']) spray(W / 2, y, c, 14, 300, true);
      haptic('success');
      shakeAmt = Math.max(shakeAmt, 10);
      if (!puzzle && prevBest > 0) floaters.push({ text: '+' + (score - prevBest), x: W / 2 + 90, y: H * 0.38, color: '#ffe066', size: 22, life: 1.1, ui: true });
      GT.sfx('power');
    }

    function drawIris() {
      if (irisAt >= IRIS_STEPS) return;
      irisShape(EASE.outCubic(irisAt / IRIS_STEPS));
    }
    // p: 0 closed (a small ring at the tap point, the frame dimmed), 1 open.
    function irisShape(p) {
      const far = Math.hypot(Math.max(irisX, W - irisX), Math.max(irisY, H - irisY));
      const r = 18 + (far - 18) * p;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(irisX, irisY, r, 0, Math.PI * 2, true);
      ctx.fillStyle = cc('panel', 0.7 * (1 - p), 'rgba(0,0,0,' + (0.7 * (1 - p)).toFixed(3) + ')'); ctx.fill();
      ctx.beginPath(); ctx.arc(irisX, irisY, r, 0, Math.PI * 2);
      ctx.strokeStyle = cc('text', 0.55 * (1 - p), 'rgba(255,255,255,' + (0.55 * (1 - p)).toFixed(3) + ')'); ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
    }
    // The over card: dimming fades in, the text block pops in about the score.
    function overIn(since) { return EASE.outCubic(Math.min(1, since / OVER_FADE)); }
    function popOverCard(since) {
      const p = Math.min(1, since / 0.3), s = 0.8 + 0.2 * EASE.outBack(p);
      ctx.globalAlpha = overIn(since);
      ctx.translate(W / 2, H * 0.42); ctx.scale(s, s); ctx.translate(-W / 2, -H * 0.42);
    }
    // The best line under the score: NEW BEST springs in and glows; otherwise plain text.
    function bestLine(text, y, since) {
      if (!newBest) { GT.text(ctx, text, W / 2, y, 20, cc('accent', 1, '#ffe066'), 'center', '800', true); return; }
      const p = Math.min(1, Math.max(0, (since - 0.15) / 0.7));
      const s = EASE.outElastic(p) * (1 + 0.04 * Math.sin(Math.max(0, since - 0.85) * 6));
      if (s <= 0.02) return;
      ctx.save();
      ctx.translate(W / 2, y); ctx.scale(s, s);
      ctx.shadowColor = cc('accent', 1, '#ffb000'); ctx.shadowBlur = 14;
      GT.text(ctx, 'NEW BEST', 0, 0, 24, cc('accent', 1, '#ffe066'), 'center', '900', true);
      ctx.restore();
    }

    // The coaching hint: a pointing hand drawn by the SDK. On the first attract screen until the
    // first input, and in the first play round until the player does something, after 1.2 s of
    // waiting. Games move it with GT.game({ hint: { x, y, gesture } }) or turn it off with
    // hint: false. Never drawn under QA.
    function drawHint() {
      const h = game.hint;
      if (QA || h === false || autoplay) return;
      let gesture = 'tap';
      if (phase === 'play') {
        if (rounds !== 1 || roundInput) return;
        const ins = String(game.instruction || '');
        gesture = (h && h.gesture) || (/hold|press/i.test(ins) ? 'hold' : /swipe|drag|slide|flick|steer/i.test(ins) ? 'swipe' : 'tap');
      } else if (phase !== 'attract' || gotFirstInput) return;
      const t = hintSteps * STEP - 1.2;
      if (t < 0) return;
      const x = h && Number.isFinite(h.x) ? h.x : W / 2;
      const y = h && Number.isFinite(h.y) ? h.y : phase === 'attract' ? H * 0.8 : H * 0.74;
      drawHand(x, y, gesture, t, Math.min(1, t / 0.25));
    }
    function drawHand(x, y, gesture, t, alpha) {
      const c = ctx;
      let press = 0, px = x, ring = -1, fillR = 0, trail = null;
      if (gesture === 'hold') {
        const u = t % 1.6;
        press = u < 0.15 ? u / 0.15 : u < 1.1 ? 1 : u < 1.25 ? 1 - (u - 1.1) / 0.15 : 0;
        if (u >= 0.15 && u < 1.1) fillR = 6 + 20 * ((u - 0.15) / 0.95);
      } else if (gesture === 'swipe') {
        const u = t % 1.3, k = Math.min(1, Math.max(0, (u - 0.15) / 0.5));
        press = u < 0.15 ? u / 0.15 : u < 0.65 ? 1 : u < 0.8 ? 1 - (u - 0.65) / 0.15 : 0;
        px = x - 44 + 88 * EASE.inOutSine(k);
        if (u >= 0.15 && u < 0.9) trail = [x - 44, px];
        if (u >= 0.8) alpha *= Math.max(0, 1 - (u - 0.8) / 0.2) + (u > 1.1 ? (u - 1.1) / 0.2 : 0);
      } else {
        const u = t % 1;
        press = u < 0.12 ? u / 0.12 : u < 0.24 ? 1 - (u - 0.12) / 0.12 : 0;
        if (u >= 0.12 && u < 0.62) ring = (u - 0.12) / 0.5;
      }
      c.save();
      c.globalAlpha = alpha;
      c.lineCap = 'round'; c.lineJoin = 'round';
      if (trail) {
        c.strokeStyle = cc('text', 0.45, 'rgba(255,255,255,0.45)'); c.lineWidth = 8;
        c.beginPath(); c.moveTo(trail[0], y); c.lineTo(trail[1], y); c.stroke();
      }
      if (fillR > 0) { c.fillStyle = cc('text', 0.3, 'rgba(255,255,255,0.3)'); c.beginPath(); c.arc(px, y, fillR, 0, Math.PI * 2); c.fill(); }
      if (ring >= 0) {
        c.strokeStyle = cc('text', 0.85 * (1 - ring), 'rgba(255,255,255,' + (0.85 * (1 - ring)).toFixed(3) + ')'); c.lineWidth = 3;
        c.beginPath(); c.arc(px, y, 8 + 24 * ring, 0, Math.PI * 2); c.stroke();
      }
      // Hovering, the hand sits a little below-right of its target and larger (nearer the viewer).
      const s = 1.08 - 0.08 * press;
      c.translate(px + (1 - press) * 6, y + (1 - press) * 12);
      c.rotate(-0.35); c.scale(s, s);
      const shape = () => {
        c.beginPath();
        roundedRect(c, -6.5, 0, 13, 38, 6.5); // index finger, tip at the origin
        roundedRect(c, -9, 22, 33, 34, 10); // palm and curled fingers
        c.moveTo(-9 + 5.5 * Math.cos(-0.6), 40 + 5.5 * Math.sin(-0.6)); c.ellipse(-9, 40, 5.5, 10, -0.6, 0, Math.PI * 2); // thumb
      };
      c.translate(3, 4); shape(); c.fillStyle = cc('panel', 0.25, 'rgba(0,0,0,0.25)'); c.fill(); c.translate(-3, -4);
      shape(); c.strokeStyle = cc('panel', 0.6, 'rgba(0,0,0,0.6)'); c.lineWidth = 4; c.stroke();
      c.fillStyle = cc('text', 1, '#fff'); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 1.5; // knuckle creases
      c.beginPath(); c.moveTo(6.5, 30); c.lineTo(6.5, 38); c.moveTo(14, 30); c.lineTo(14, 38); c.stroke();
      c.restore();
    }
    function roundedRect(c, x, y, w, h, r) {
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    // Everything the feel kit draws over the finished frame, after the HUD and SDK screens.
    function drawFeel() {
      if (phase === 'play') { drawIris(); drawRetryHud(); }
      if (phase === 'stage' && stageClose >= 0) irisShape(1 - EASE.outCubic(Math.min(1, stageClose / IRIS_STEPS))); // closing on the next stage
      if (phase === 'over') drawJuice(true);
      if (phase === 'attract' || phase === 'play') drawHint();
      if (phase === 'attract' && stageBanner) drawStageBanner();
    }

    // ---------- stage screens (v13) ----------
    const FONT = 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    // One line shrunk to fit maxW, never below 14 px (QA's smallest readable size).
    function fitLine(str, y, size, maxW, color, weight) {
      ctx.font = weight + ' ' + size + FONT;
      const w = ctx.measureText(str).width;
      GT.text(ctx, str, W / 2, y, w > maxW ? Math.max(14, Math.floor(size * maxW / w)) : size, color, 'center', weight, true);
    }
    // Words onto lines of at most maxW at this size; a word wider than a line breaks anywhere.
    function wrapLines(str, size, maxW, weight) {
      ctx.font = weight + ' ' + size + FONT;
      const fits = (t) => ctx.measureText(t).width <= maxW, lines = [''];
      for (const word of str.split(/\s+/).filter(Boolean)) {
        let rest = word;
        while (rest) {
          const cur = lines[lines.length - 1], pre = cur ? cur + ' ' : '';
          if (fits(pre + rest)) { lines[lines.length - 1] = pre + rest; break; }
          if (cur) { lines.push(''); continue; }
          let n = 1;
          while (n < rest.length && fits(rest.slice(0, n + 1))) n++;
          lines[lines.length - 1] = rest.slice(0, n); rest = rest.slice(n);
          if (rest) lines.push('');
        }
      }
      return lines.filter(Boolean);
    }
    // The intermission card: over the frozen frame, in the chrome colours, popping in like the over card.
    function drawIntermission() {
      const I = stageInfo;
      if (!I) return;
      const since = stageSteps * STEP, puzzle = game.kind === 'puzzle';
      ctx.save();
      ctx.fillStyle = cc('panel', 0.45 * overIn(since), 'rgba(0,0,0,' + (0.45 * overIn(since)).toFixed(3) + ')'); ctx.fillRect(0, 0, W, H);
      popOverCard(since);
      fitLine(I.title, H * 0.27, 32, W - 40, cc('accent', 1, '#9bf6a0'), '900');
      if (I.subtitle) {
        // 18 px, on up to two lines; smaller (to 14 px) before a third.
        let size = 18, lines = wrapLines(I.subtitle, size, W - 40, '700');
        while (lines.length > 2 && size > 14) lines = wrapLines(I.subtitle, --size, W - 40, '700');
        lines.slice(0, 3).forEach((l, i) => GT.text(ctx, l, W / 2, H * 0.33 + i * (size + 4), size, cc('text', 1, '#fff'), 'center', '700', true));
      }
      if (puzzle) GT.text(ctx, clock(roundTime), W / 2, H * 0.44, 56, cc('text', 1, '#fff'), 'center', '900', true);
      else GT.text(ctx, String(score), W / 2, H * 0.44, 72, cc('text', 1, '#fff'), 'center', '900', true);
      GT.text(ctx, 'stage time ' + clock(I.duration), W / 2, H * 0.52, 18, cc('accent', 1, '#ffe066'), 'center', '800', true);
      // "tap to continue": fades in as the accidental-tap guard ends, then breathes (as "tap to retry").
      if (since > RETRY_GUARD && stageClose < 0) {
        const u = since - RETRY_GUARD;
        ctx.globalAlpha *= Math.min(1, u / 0.15) * (0.88 + 0.12 * Math.cos(u * 4));
        GT.text(ctx, 'tap to continue', W / 2, H * 0.66, 16, cc('text', 1, '#fff'), 'center', '700', true);
      }
      ctx.restore();
    }
    function takeStageShot() {
      if (!stageShot || stageShot.width !== canvas.width || stageShot.height !== canvas.height) stageShot = offscreen(canvas.width, canvas.height);
      const s = stageShot.getContext('2d');
      s.clearRect(0, 0, stageShot.width, stageShot.height);
      s.drawImage(canvas, 0, 0);
      stageShotOk = true;
    }
    // The over screen's "stage n" line: for games that declare stages or got past the first.
    function stageLineShift() { return stageCount > 0 || stageIndex > 1 ? 0.045 : 0; }
    function stageLine(y) {
      GT.text(ctx, 'stage ' + stageIndex, W / 2, y, 18, cc('text', 0.85, 'rgba(255,255,255,0.85)'), 'center', '800', true);
    }
    // Attract: the next stage's banner, shaped like a toast, for 0.6 s.
    function drawStageBanner() {
      const b = stageBanner;
      ctx.font = '900 26' + FONT;
      const w = ctx.measureText(b.text).width, size = w > W - 80 ? Math.max(14, Math.floor(26 * (W - 80) / w)) : 26;
      drawToast({ text: b.text, i: b.i, size, color: cc('accent', 1, '#ffe066'), glow: false }, STAGE_BANNER - TOAST_IN - TOAST_OUT);
    }

    // ---------- retry loop: instant retry, combo meter, near misses, milestone toasts ----------
    // Like the feel kit, everything here counts fixed steps (never the wall clock) and resets each
    // round, so QA's seeded replays stay frame-identical. The meter and toasts draw in play only,
    // in the HUD band above the game and below the ?debug overlay.

    // A tap within this long of a round ending is the tap that died, not a retry. After it, the
    // retry tap starts the next round at once (newRound runs inside the tap handler).
    const RETRY_GUARD = 0.35; // s

    // Combo meter. The count and the round's best combo live here; the chip is drawn top-left in
    // the HUD band (the feed's menu button owns top-right).
    const CHIP_X = 40, CHIP_Y = 42, COMBO_OUT = 12, COMBO_BREAK = 27; // steps
    let comboN = 0, comboMax = 0, comboUsed = false, comboLeft = 0, comboSpan = 2;
    let chipN = 0, chipOut = -1, breakN = 0, breakAt = -1;
    function comboWindow() {
      const c = game && game.combo;
      const w = c && typeof c === 'object' ? Number(c.window) : NaN;
      if (w === 0) return Infinity; // window: 0: the combo lasts until miss(), e.g. perfect drops in a row
      return Number.isFinite(w) && w > 0 ? Math.min(10, w) : 2;
    }
    // With chrome, the combo takes the accent at every count (one palette); without, the tiers.
    function comboColor(n) { return chrome ? cc('accent', 1, '') : n >= 20 ? '#ff5d8f' : n >= 10 ? '#ff9f43' : n >= 5 ? '#ffe066' : '#9bf6ff'; }
    const combo = {
      /** Bump the combo by n (default 1). Returns the new count. */
      hit(n) {
        if (phase !== 'play' && phase !== 'attract') return comboN;
        comboN += Math.max(1, Math.floor(Number(n) || 1));
        comboMax = Math.max(comboMax, comboN); comboUsed = true;
        comboLeft = comboSpan = comboWindow();
        chipN = comboN; chipOut = -1;
        if (comboN >= 2) {
          spring('diddly:combo', 1, 520, 13).kick(0.5);
          GT.sfx('combo', { n: comboN, count: comboN });
          if (comboN % 5 === 0) haptic('success');
        }
        return comboN;
      },
      /** Break the combo, for a failure. A combo of 3 or more breaks visibly, with a small shake. */
      miss() {
        if (phase !== 'play' && phase !== 'attract') return;
        if (comboN >= 3) {
          breakN = comboN; breakAt = 0;
          if (phase === 'play' && game.combo !== false) spray(CHIP_X, CHIP_Y, comboColor(comboN), 14, 140, false);
          shakeAmt = Math.max(shakeAmt, 5);
          haptic('light');
        }
        comboN = 0; comboLeft = 0; chipOut = -1; chipN = 0;
      },
      /** End the combo quietly, for a chain that finishes in success (a bank, a cascade): no break, shake or sound. */
      end() {
        if (phase !== 'play' && phase !== 'attract') return;
        // The chip fades out as when the window runs out.
        comboN = 0; comboLeft = 0;
        if (chipN >= 2) chipOut = 0; else chipN = 0;
      },
      get count() { return comboN; },
      /** The round's highest combo so far. */
      get max() { return comboMax; },
    };

    // Near misses: a slow-motion pulse, a radial flash, "close!", a swoosh and a light buzz.
    const NEAR_COOL = 30, RING_STEPS = 16; // steps
    let nearCool = 0, rings = [];
    function nearMiss(x, y, o) {
      if ((phase !== 'play' && phase !== 'attract') || nearCool > 0) return false;
      o = o || {};
      x = Number.isFinite(Number(x)) ? Number(x) : W / 2; y = Number.isFinite(Number(y)) ? Number(y) : H / 2;
      nearCool = NEAR_COOL;
      if (o.hitStop) hitStop(o.hitStop); else slowmo(0.4, 0.3);
      const color = o.color || '#9bf6ff';
      rings.push({ x, y, i: 0, color });
      if (rings.length > 8) rings.shift();
      if (o.text !== false) floaters.push({ text: typeof o.text === 'string' ? o.text.slice(0, 16) : 'close!', x, y: y - 26, color, size: 18, life: 0.7, outline: true });
      GT.sfx('swoosh');
      haptic('light');
      return true;
    }
    // True when two circles don't touch but come within `margin` of each other.
    function nearMissCheck(ax, ay, ar, bx, by, br, margin) {
      const m = margin == null ? 16 : Number(margin) || 0, r = ar + br, d2 = (ax - bx) ** 2 + (ay - by) ** 2;
      return d2 > r * r && d2 <= (r + m) * (r + m);
    }
    function drawRings() {
      for (const g of rings) {
        const p = g.i / RING_STEPS, a = 1 - p;
        ctx.globalAlpha = 0.55 * a * a;
        ctx.fillStyle = radial(ctx, g.x, g.y, 0, 34 + 30 * p, [[0, g.color], [1, 'rgba(0,0,0,0)']]);
        ctx.beginPath(); ctx.arc(g.x, g.y, 34 + 30 * p, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.9 * a;
        ctx.strokeStyle = g.color; ctx.lineWidth = 3 * a + 1;
        ctx.beginPath(); ctx.arc(g.x, g.y, 10 + 44 * EASE.outCubic(p), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Toasts: one banner at a time under the score, queued. A waiting toast cuts the current
    // one's hold short so a burst of milestones never lags far behind play.
    const TOAST_IN = 10, TOAST_HOLD = 60, TOAST_SHORT = 30, TOAST_OUT = 14, TOAST_Y = 94; // steps; px
    // v14: toasts move down under a turns game's resource line.
    const toastY = () => TOAST_Y + (turnsLineShown() ? 24 : 0);
    let toasts = [], mileAt = 0, bestToasted = false;
    function toast(text, o) {
      if (phase !== 'play') return;
      o = o || {};
      if (toasts.length >= 4) toasts.splice(1, 1); // drop the oldest waiting one
      toasts.push({ text: String(text).slice(0, 24), color: o.color || cc('accent', 1, '#ffe066'), size: Math.min(40, Math.max(12, Number(o.size) || 26)), glow: !!o.glow, i: 0 });
    }
    function milestones() {
      const m = game && game.milestones;
      return Array.isArray(m) ? m : [];
    }

    function resetRetry() {
      comboN = comboMax = 0; comboUsed = false; comboLeft = 0; chipN = 0; chipOut = breakAt = -1;
      nearCool = 0; rings = []; toasts = []; mileAt = 0;
      bestToasted = false;
    }
    function stepRetry() {
      const live = phase === 'play' || phase === 'attract';
      if (nearCool > 0) nearCool--;
      for (const g of rings) g.i++;
      if (rings.length && rings[0].i >= RING_STEPS) rings = rings.filter((g) => g.i < RING_STEPS);
      if (breakAt >= 0 && ++breakAt > COMBO_BREAK) breakAt = -1;
      if (chipOut >= 0 && ++chipOut > COMBO_OUT) { chipOut = -1; chipN = 0; }
      // The combo runs out after its window with no hits (game time: frozen by hit-stop, slowed by slow-mo).
      if (live && comboN > 0 && hitStopLeft === 0 && (comboLeft -= STEP * timeScale()) <= 0) {
        comboN = 0; comboLeft = 0; if (chipN >= 2) chipOut = 0; else chipN = 0;
      }
      if (phase !== 'play') return;
      // Milestones: toast the highest one crossed this step, once.
      const ms = milestones();
      let hit = 0;
      while (mileAt < ms.length && score >= Number(ms[mileAt])) hit = ms[mileAt++];
      if (hit) {
        toast(hit + '!');
        spray(W / 2, toastY(), cc('accent', 1, '#ffe066'), 16, 200, false);
        GT.sfx('point'); haptic('light');
      }
      // Passing the previous best mid-round: one NEW BEST toast now; the over screen celebrates again.
      // (`best` only takes this round's score when it ends, so during play it is the best to beat.)
      if (!bestToasted && game.kind !== 'puzzle' && best > 0 && score > best) {
        bestToasted = true;
        toast('NEW BEST', { glow: true });
        for (const c of ['#ffe066', '#ff9f43', '#ffffff']) spray(W / 2, toastY(), c, 8, 240, false);
        GT.sfx('power'); haptic('success');
      }
      if (toasts.length) {
        const t = toasts[0];
        if (++t.i >= TOAST_IN + (toasts.length > 1 ? TOAST_SHORT : TOAST_HOLD) + TOAST_OUT) toasts.shift();
      }
    }

    function drawRetryHud() {
      if (game.combo !== false) drawChip();
      if (toasts.length) drawToast(toasts[0], toasts.length > 1 ? TOAST_SHORT : TOAST_HOLD);
    }
    function drawChip() {
      const c = ctx;
      if (chipN >= 2) {
        const out = chipOut >= 0 ? chipOut / COMBO_OUT : 0;
        const s = Math.max(0.2, spring('diddly:combo').v) * (1 - 0.3 * out), col = comboColor(chipN);
        const frac = comboSpan === Infinity ? 1 : comboSpan > 0 ? Math.max(0, Math.min(1, comboLeft / comboSpan)) : 0;
        c.save();
        c.globalAlpha = 1 - out;
        c.translate(CHIP_X, CHIP_Y); c.scale(s, s);
        c.fillStyle = cc('panel', 0.5, 'rgba(0,0,0,0.5)'); c.beginPath(); c.arc(0, 0, 22, 0, Math.PI * 2); c.fill();
        c.lineWidth = 4; c.lineCap = 'round';
        c.strokeStyle = cc('text', 0.18, 'rgba(255,255,255,0.18)'); c.beginPath(); c.arc(0, 0, 19, 0, Math.PI * 2); c.stroke();
        if (frac > 0) { c.strokeStyle = col; c.beginPath(); c.arc(0, 0, 19, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); c.stroke(); }
        // Left-anchored inside the ring so a growing count runs right, away from the screen edge
        // (QA's counter check reads anchors; the font also shrinks at 10 and 100 to stay inside).
        GT.text(c, 'x' + chipN, -12, 1, chipN >= 100 ? 13 : chipN >= 10 ? 16 : 19, col, 'left', '900', true);
        c.restore();
      }
      if (breakAt >= 0) {
        // The broken count drops away, tilting and reddening.
        const p = breakAt / COMBO_BREAK;
        c.save();
        c.globalAlpha = 1 - p;
        c.translate(CHIP_X + 6 * p, CHIP_Y + 34 * p * p); c.rotate(0.5 * p);
        c.strokeStyle = 'rgba(255,93,93,' + (0.8 * (1 - p)).toFixed(3) + ')'; c.lineWidth = 3;
        c.beginPath(); c.arc(0, 0, 19 + 14 * p, 0, Math.PI * 2); c.stroke();
        GT.text(c, 'x' + breakN, -12, 1, breakN >= 100 ? 13 : breakN >= 10 ? 16 : 19, '#ff5d5d', 'left', '900', true);
        c.restore();
      }
    }
    function drawToast(t, hold) {
      const c = ctx, end = TOAST_IN + hold;
      const pin = Math.min(1, t.i / TOAST_IN), pout = t.i > end ? (t.i - end) / TOAST_OUT : 0;
      const s = 0.6 + 0.4 * EASE.outBack(pin), y = toastY() - 22 * (1 - EASE.outCubic(pin)) - 10 * pout;
      const a = Math.min(1, pin * 2) * (1 - pout);
      c.save();
      c.globalAlpha = a;
      c.translate(W / 2, y); c.scale(s, s);
      c.font = '900 ' + t.size + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
      const w = Math.min(W - 40, c.measureText(t.text).width + 30), h = t.size + 14;
      c.fillStyle = cc('panel', 0.55, 'rgba(0,0,0,0.55)'); c.beginPath(); roundedRect(c, -w / 2, -h / 2, w, h, h / 2); c.fill();
      c.globalAlpha = 0.7 * a; c.strokeStyle = t.color; c.lineWidth = 2; c.stroke();
      c.globalAlpha = a;
      if (t.glow) { c.shadowColor = cc('accent', 1, '#ffb000'); c.shadowBlur = 14; }
      GT.text(c, t.text, 0, 1, t.size, t.color, 'center', '900', true);
      c.restore();
    }
    // The over screen's retry prompt: fades in as the accidental-tap guard ends, then breathes.
    function retryPrompt(text, since) {
      if (since <= RETRY_GUARD) return;
      const u = since - RETRY_GUARD, a = ctx.globalAlpha;
      ctx.globalAlpha = a * Math.min(1, u / 0.15) * (0.88 + 0.12 * Math.cos(u * 4));
      GT.text(ctx, text, W / 2, H * 0.66, 20, cc('text', 1, '#fff'), 'center', '700', true);
      ctx.globalAlpha = a;
    }
    // The over screen's extra line: the round's best combo, when the game used the combo API.
    function comboLine(y) {
      if (!comboUsed || comboMax < 2) return;
      GT.text(ctx, 'best combo x' + comboMax, W / 2, y, 17, comboColor(comboMax), 'center', '800', true);
    }

    // ---------- art kit: color, noise, materials, sprites, post-fx ----------
    // Everything expensive is baked once into offscreen canvases and cached by key,
    // so games call these freely from setup() or draw().

    function parseColor(c) {
      if (Array.isArray(c)) return c;
      let s = String(c).trim();
      if (s[0] === '#') {
        if (s.length === 4 || s.length === 5) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('');
        const n = parseInt(s.slice(1, 7), 16);
        const a = s.length === 9 ? parseInt(s.slice(7, 9), 16) / 255 : 1;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
      }
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
      return [255, 0, 255, 1];
    }
    const toCss = (c) => 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (+c[3].toFixed(3)) + ')';
    function mixColor(a, b, t) {
      a = parseColor(a); b = parseColor(b);
      return toCss([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
    }
    function shadeColor(c, amt) { return amt >= 0 ? mixColor(c, '#ffffff', amt) : mixColor(c, '#000000', -amt); }
    function withAlpha(c, a) { const p = parseColor(c); return toCss([p[0], p[1], p[2], a]); }

    // v12: GT.game({ chrome: { accent, text, panel } }) colours what the SDK draws itself: the HUD
    // score, the attract and over screens, the combo chip, toasts and milestone banners, the hint
    // hand and the iris. text replaces white, accent the yellow highlights, panel the black dimming
    // and backings (at the alpha each already uses). Each is a hex or rgb()/rgba() colour; a missing
    // or invalid one keeps today's, and a game without chrome draws exactly as before.
    const CHROME_RE = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*(,\s*[0-9.]+\s*)?\))$/i;
    let chrome = null;
    function chromeDef(c) {
      if (!c || typeof c !== 'object') return null;
      const out = { text: [255, 255, 255, 1], accent: [255, 224, 102, 1], panel: [0, 0, 0, 1] };
      let any = false;
      for (const k of ['accent', 'text', 'panel']) {
        const v = c[k];
        if (typeof v !== 'string' || !CHROME_RE.test(v.trim())) continue;
        const p = parseColor(v);
        if (!p.slice(0, 3).every((x) => x >= 0 && x <= 255) || !(p[3] >= 0 && p[3] <= 1)) continue;
        out[k] = p; any = true;
      }
      return any ? out : null;
    }
    // A chrome colour at an alpha, or `dflt` (today's exact colour) when the game sets no chrome.
    function cc(key, alpha, dflt) {
      if (!chrome) return dflt;
      const p = chrome[key];
      return toCss([p[0], p[1], p[2], p[3] * alpha]);
    }

    // Tileable gradient noise. Periods are in lattice cells, so textures wrap seamlessly.
    function makeNoise(seed) {
      const r = mulberry(seed), p = [];
      for (let i = 0; i < 256; i++) p[i] = i;
      for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      const perm = new Uint8Array(512);
      for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
      const G = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
      const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
      const wrap = (i, per) => (per ? ((i % per) + per) % per : i) & 255;
      const hash = (x, y) => perm[perm[x] + y];
      function perlin(x, y, px, py) {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const x0 = wrap(xi, px), x1 = wrap(xi + 1, px), y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
        const d = (h, dx, dy) => { const g = G[h & 7]; return g[0] * dx + g[1] * dy; };
        const u = fade(xf), v = fade(yf);
        const a = d(hash(x0, y0), xf, yf) + u * (d(hash(x1, y0), xf - 1, yf) - d(hash(x0, y0), xf, yf));
        const b = d(hash(x0, y1), xf, yf - 1) + u * (d(hash(x1, y1), xf - 1, yf - 1) - d(hash(x0, y1), xf, yf - 1));
        return a + v * (b - a); // ~[-1, 1]
      }
      // Fractal noise in [0, 1].
      function fbm(x, y, oct, px, py) {
        let sum = 0, amp = 0.5, f = 1, norm = 0;
        for (let o = 0; o < (oct || 5); o++) {
          sum += amp * perlin(x * f, y * f, px ? px * f : 0, py ? py * f : 0);
          norm += amp; amp *= 0.5; f *= 2;
        }
        return Math.max(0, Math.min(1, 0.5 + (sum / norm) * 0.75));
      }
      // Cellular noise: distance to nearest (f1) and second-nearest (f2) feature point.
      function worley(x, y, px, py) {
        const xi = Math.floor(x), yi = Math.floor(y);
        let f1 = 9, f2 = 9;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const cx = xi + i, cy = yi + j, h = hash(wrap(cx, px), wrap(cy, py));
          const fx = cx + perm[h] / 255, fy = cy + perm[h + 1] / 255;
          const dd = Math.hypot(fx - x, fy - y);
          if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
        }
        return [f1, f2];
      }
      return { perlin, fbm, worley };
    }

    const bakeCache = new Map();
    // An OffscreenCanvas in the worker; a <canvas> element in-thread.
    function offscreen(w, h) {
      return env.offscreen(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    }
    function bake(key, w, h, fn) {
      const k = key + '@' + w + 'x' + h;
      let c = bakeCache.get(k);
      if (!c) { c = offscreen(w, h); fn(c.getContext('2d'), w, h); bakeCache.set(k, c); }
      return c;
    }

    // Color ramp lookup: colors spread evenly over t in [0, 1].
    function ramp(stops) {
      const cs = stops.map(parseColor);
      return (t, out) => {
        t = Math.max(0, Math.min(0.9999, t)) * (cs.length - 1);
        const i = Math.floor(t), f = t - i, a = cs[i], b = cs[i + 1] || a;
        out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f;
        out[2] = a[2] + (b[2] - a[2]) * f; out[3] = (a[3] + (b[3] - a[3]) * f) * 255;
      };
    }
    const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const fract = (x) => x - Math.floor(x);

    // Each recipe maps a pixel (u, v in cell units, with periods P) to a ramp position.
    // Recipes may also return an [r,g,b,a] override for special features (e.g. stars).
    const MATERIALS = {
      stone: { colors: ['#2e2f36', '#55575f', '#7d8089', '#a3a6ae'], scale: 6,
        f: (n, u, v, P) => { const w = n.worley(u * 1.5, v * 1.5, P * 1.5, P * 1.5); return n.fbm(u, v, 5, P, P) * 0.8 + smooth(0, 0.08, w[1] - w[0]) * 0.25 - 0.05; } },
      rock: { colors: ['#3b2f2a', '#6b5646', '#9a8069', '#c2a98d'], scale: 5,
        f: (n, u, v, P) => { const w = n.worley(u, v, P, P); return n.fbm(u * 2, v * 2, 6, P * 2, P * 2) * 0.7 + (1 - w[0]) * 0.35; } },
      wood: { colors: ['#4a2912', '#7a4a24', '#a8703d', '#c99661'], scale: 3,
        f: (n, u, v, P) => fract(v * 2 + n.fbm(u, v * 2, 4, P, P * 2) * 3) * 0.6 + n.fbm(u * 8, v, 3, P * 8, P) * 0.4 },
      water: { colors: ['#06325a', '#0c5a93', '#1f8ac8', '#7fd3ff'], scale: 4,
        f: (n, u, v, P) => { const w = n.worley(u + n.fbm(u, v, 3, P, P), v, P, P); return n.fbm(u, v, 4, P, P) * 0.55 + (1 - smooth(0, 0.12, w[1] - w[0])) * 0.5; } },
      lava: { colors: ['#1a0604', '#4a0f06', '#b3300a', '#ff7a18', '#ffe08a'], scale: 4,
        f: (n, u, v, P) => { const w = n.worley(u, v, P, P); const crack = 1 - smooth(0, 0.18, w[1] - w[0]); return Math.max(crack, n.fbm(u * 2, v * 2, 4, P * 2, P * 2) * 0.45); } },
      grass: { colors: ['#1d3b12', '#2f6019', '#4c8a26', '#7cb342'], scale: 8,
        f: (n, u, v, P) => n.fbm(u * 3, v * 0.5, 4, P * 3, P * 0.5) * 0.65 + n.fbm(u, v, 3, P, P) * 0.35 },
      sand: { colors: ['#b8864b', '#d4a86a', '#e8c58e', '#f6dfb2'], scale: 5,
        f: (n, u, v, P) => 0.5 + 0.28 * Math.sin((v * 2 + n.fbm(u, v, 3, P, P) * 4) * Math.PI) + (n.fbm(u * 6, v * 6, 2, P * 6, P * 6) - 0.5) * 0.4 },
      dirt: { colors: ['#2b1d12', '#4a3322', '#6b4c33', '#8a6a4c'], scale: 6,
        f: (n, u, v, P) => { const w = n.worley(u * 2, v * 2, P * 2, P * 2); return n.fbm(u, v, 5, P, P) * 0.75 + (w[0] < 0.18 ? 0.3 : 0); } },
      metal: { colors: ['#4b5058', '#7b818b', '#a9afb8', '#d6dbe2'], scale: 4,
        f: (n, u, v, P) => 0.5 + (n.fbm(u, v * 20, 3, P, P * 20) - 0.5) * 0.6 + (n.fbm(u, v, 2, P, P) - 0.5) * 0.3 },
      ice: { colors: ['#6fa8d6', '#9dcbef', '#cfe8fa', '#ffffff'], scale: 4,
        f: (n, u, v, P) => { const w = n.worley(u, v, P, P); return n.fbm(u, v, 4, P, P) * 0.6 + (1 - smooth(0, 0.05, w[1] - w[0])) * 0.45; } },
      marble: { colors: ['#e9e4dc', '#d7cfc3', '#a89e90', '#5d554c'], scale: 3,
        f: (n, u, v, P) => Math.pow(Math.abs(Math.sin((u + v + n.fbm(u, v, 5, P, P) * 4) * Math.PI)), 0.25) * -1 + 1 },
      clouds: { colors: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.75)', '#ffffff'], scale: 3,
        f: (n, u, v, P) => smooth(0.42, 0.85, n.fbm(u, v, 6, P, P)) },
      nebula: { colors: ['#05040d', '#1b0f3a', '#4a1d6e', '#b3408f', '#ff9f6b'], scale: 3,
        f: (n, u, v, P, px) => {
          const h = n.perlin(u * 40, v * 40, P * 40, P * 40);
          if (h > 0.62) { const b = 160 + (h - 0.62) * 900; px[0] = px[1] = px[2] = Math.min(255, b); px[3] = 255; return null; }
          return Math.pow(n.fbm(u + n.fbm(u, v, 3, P, P) * 1.5, v, 6, P, P), 1.6);
        } },
      bricks: { colors: ['#3a1f18', '#7a3a26', '#9c4d31', '#b8653f'], scale: 1,
        f: (n, u, v, P, px, x, y, w, h) => {
          const rows = 8, cols = 4, bh = h / rows, bw = w / cols;
          const row = Math.floor(y / bh), off = row % 2 ? bw / 2 : 0;
          const bx = ((x + off) % bw + bw) % bw, by = y % bh;
          if (bx < 2 || by < 2) return 0.02; // mortar
          const brick = Math.floor((x + off) / bw) + row * 17;
          return 0.35 + ((brick * 0.618) % 1) * 0.35 + n.fbm(u * 6, v * 6, 3, P * 6, P * 6) * 0.3;
        } },
      fabric: { colors: ['#2a3d66', '#3f5a91', '#5b78b4', '#8aa5d8'], scale: 32,
        f: (n, u, v, P) => 0.5 + 0.25 * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI * 2) * (fract(u) < 0.5 ? 1 : -1) + (n.fbm(u / 8, v / 8, 3, P / 8, P / 8) - 0.5) * 0.4 },
    };

    // A tileable w×h material texture, optionally re-coloured to fit the game's theme.
    function material(name, opts) {
      const m = MATERIALS[name];
      if (!m) throw new Error('GT.material: unknown material "' + name + '" (have ' + Object.keys(MATERIALS).join(', ') + ')');
      opts = opts || {};
      const w = opts.w || 256, h = opts.h || opts.w || 256;
      const colors = opts.colors || m.colors;
      const key = 'mat:' + name + ':' + JSON.stringify([colors, opts.scale, opts.seed, opts.contrast]);
      return bake(key, w, h, (c) => {
        const n = makeNoise(opts.seed || 1), look = ramp(colors);
        const P = Math.max(1, Math.round(opts.scale || m.scale)), contrast = opts.contrast || 1;
        const img = c.createImageData(w, h), d = img.data, px = [0, 0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = (x / w) * P, v = (y / h) * P;
          let t = m.f(n, u, v, P, px, x, y, w, h);
          if (t != null) look((t - 0.5) * contrast + 0.5, px);
          const i = (y * w + x) * 4;
          d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
        }
        c.putImageData(img, 0, 0);
      });
    }

    // Custom noise texture: fn(noise, u, v) -> 0..1, mapped through `colors`.
    function noiseTexture(key, opts, fn) {
      const w = opts.w || 256, h = opts.h || opts.w || 256;
      return bake('noise:' + key, w, h, (c) => {
        const n = makeNoise(opts.seed || 1), look = ramp(opts.colors || ['#000', '#fff']);
        const P = Math.max(1, Math.round(opts.scale || 4));
        const img = c.createImageData(w, h), d = img.data, px = [0, 0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          look(fn(n, (x / w) * P, (y / h) * P, P), px);
          const i = (y * w + x) * 4;
          d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
        }
        c.putImageData(img, 0, 0);
      });
    }

    // Fill a rect with a tiling texture; offsetX/Y scroll it (parallax, conveyor belts, water flow).
    const patternCache = new WeakMap();
    function fillTex(c, tex, x, y, w, h, opts) {
      opts = opts || {};
      let pat = patternCache.get(tex);
      if (!pat) { pat = c.createPattern(tex, 'repeat'); patternCache.set(tex, pat); }
      const s = opts.scale || 1;
      pat.setTransform(new DOMMatrix([s, 0, 0, s, (opts.offsetX || 0) % (tex.width * s), (opts.offsetY || 0) % (tex.height * s)]));
      c.save();
      if (opts.alpha != null) c.globalAlpha *= opts.alpha;
      c.fillStyle = pat;
      c.fillRect(x, y, w, h);
      c.restore();
    }

    // A textured sphere (planets, balls, fruit, boulders) with light from the top-left.
    function texBall(c, tex, x, y, r, opts) {
      opts = opts || {};
      c.save();
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.clip();
      fillTex(c, tex, x - r, y - r, r * 2, r * 2, { offsetX: (opts.spin || 0) + x - r, offsetY: y - r, scale: opts.scale });
      const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.05);
      g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.45, 'rgba(255,255,255,0)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0.65)');
      c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
      c.restore();
      if (opts.rim) { c.strokeStyle = withAlpha(opts.rim, 0.6); c.lineWidth = Math.max(1, r * 0.06); c.beginPath(); c.arc(x, y, r - c.lineWidth / 2, 0, Math.PI * 2); c.stroke(); }
    }

    // A shaded sphere from a flat colour: base, highlight, core shadow, specular glint.
    function ball(c, x, y, r, color, opts) {
      opts = opts || {};
      const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
      g.addColorStop(0, shadeColor(color, 0.55)); g.addColorStop(0.35, color);
      g.addColorStop(0.85, shadeColor(color, -0.35)); g.addColorStop(1, shadeColor(color, -0.55));
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      if (opts.glint !== false) {
        c.fillStyle = 'rgba(255,255,255,0.8)';
        c.beginPath(); c.ellipse(x - r * 0.38, y - r * 0.42, r * 0.18, r * 0.11, -0.6, 0, Math.PI * 2); c.fill();
      }
    }

    // Additive light blob: lasers, magic, lamps, engine exhaust, pickups.
    function glow(c, x, y, r, color, intensity) {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, withAlpha(color, Math.min(1, intensity == null ? 0.8 : intensity)));
      g.addColorStop(0.4, withAlpha(color, (intensity == null ? 0.8 : intensity) * 0.35));
      g.addColorStop(1, withAlpha(color, 0));
      c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
    }

    // Soft contact shadow under an object.
    function shadow(c, x, y, rx, ry, alpha) {
      const g = c.createRadialGradient(x, y, 0, x, y, rx);
      g.addColorStop(0, 'rgba(0,0,0,' + (alpha == null ? 0.35 : alpha) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.save(); c.translate(x, y); c.scale(1, (ry || rx * 0.35) / rx); c.translate(-x, -y);
      c.fillStyle = g; c.beginPath(); c.arc(x, y, rx, 0, Math.PI * 2); c.fill(); c.restore();
    }

    // A texture multiplied by a colour, baked once per (texture, colour, tint). Drawing it is a
    // plain source-over pattern fill. Panels used to 'multiply' the colour on per frame, under their
    // rounded clip: on a Pixel 8 Pro each such draw cost ~2.6 ms (15 panels: 60 → 21 fps).
    // A texture's first 32 tints are kept; after that the oldest is dropped, so a colour animated
    // every frame still works, re-baking a small canvas instead of blending the whole screen.
    const tintCache = new WeakMap();
    function tintedTex(tex, color, tint) {
      tint = Math.max(0, Math.min(1, Number.isFinite(tint) ? tint : 1));
      if (tint === 0) return tex;
      let m = tintCache.get(tex);
      if (!m) { m = new Map(); tintCache.set(tex, m); }
      const key = color + '|' + tint;
      let out = m.get(key);
      if (!out) {
        out = offscreen(tex.width, tex.height);
        const t = out.getContext('2d');
        t.drawImage(tex, 0, 0);
        t.globalCompositeOperation = 'multiply'; t.globalAlpha = tint;
        t.fillStyle = color; t.fillRect(0, 0, out.width, out.height);
        t.globalCompositeOperation = 'destination-in'; t.globalAlpha = 1; // keep the texture's alpha
        t.drawImage(tex, 0, 0);
        if (m.size >= 32) m.delete(m.keys().next().value);
        m.set(key, out);
      }
      return out;
    }

    // Bevelled panel/block: gradient body, top highlight, bottom shade. With a material (opts.tex)
    // the texture is multiplied by `color` (opts.tint 0..1 sets how strongly) so one texture
    // serves many colours.
    function panel(c, x, y, w, h, color, opts) {
      opts = opts || {};
      const r = opts.radius == null ? Math.min(10, w / 4, h / 4) : opts.radius;
      const path = () => { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); };
      c.save();
      path(); c.clip();
      if (opts.tex) {
        const tex = tintedTex(opts.tex, color, opts.tint == null ? 0.9 : opts.tint);
        fillTex(c, tex, x, y, w, h, { offsetX: opts.texOffsetX == null ? x : opts.texOffsetX, offsetY: opts.texOffsetY == null ? y : opts.texOffsetY });
        c.globalAlpha = 1; // as before the bake: the shading below ignores the caller's alpha
        const g = c.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
        c.fillStyle = g; c.fillRect(x, y, w, h);
      } else {
        const g = c.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, shadeColor(color, 0.25)); g.addColorStop(1, shadeColor(color, -0.25));
        c.fillStyle = g; c.fillRect(x, y, w, h);
      }
      const bevel = opts.bevel == null ? Math.max(2, Math.min(w, h) * 0.12) : opts.bevel;
      c.fillStyle = 'rgba(255,255,255,0.28)'; c.fillRect(x, y, w, bevel);
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x, y + h - bevel, w, bevel);
      c.restore();
      if (opts.outline) { c.strokeStyle = opts.outline; c.lineWidth = 2; path(); c.stroke(); }
    }

    function linear(c, x0, y0, x1, y1, stops) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      stops.forEach((s, i) => g.addColorStop(Array.isArray(s) ? s[0] : i / Math.max(1, stops.length - 1), Array.isArray(s) ? s[1] : s));
      return g;
    }
    function radial(c, x, y, r0, r1, stops) {
      const g = c.createRadialGradient(x, y, r0, x, y, r1);
      stops.forEach((s, i) => g.addColorStop(Array.isArray(s) ? s[0] : i / Math.max(1, stops.length - 1), Array.isArray(s) ? s[1] : s));
      return g;
    }

    // ----- SVG sprites: declared in GT.game({ sprites }), rasterized once before the game starts -----
    // Rasterizing SVG needs an <img>, so the shell does it on the page (3x supersampled) and sends
    // back ImageBitmaps (canvases, in-thread). Invalid SVGs come back as an error message.
    const sprites = new Map(); // name -> { canvas, w, h }
    let spritesDone = null;
    function loadSprites(defs) {
      const list = Object.entries(defs || {}).map(([name, src]) => [String(name), String(src)]);
      if (!list.length) return Promise.resolve(0);
      return new Promise((resolve) => {
        spritesDone = (res) => {
          for (const r of Array.isArray(res) ? res : []) {
            if (!Array.isArray(r)) continue;
            if (r[1]) sprites.set(String(r[0]), { canvas: r[1], w: Number(r[2]) || 64, h: Number(r[3]) || 64 });
            else reportError(new Error(String(r[2])));
          }
          resolve(list.length);
        };
        post({ t: 'sprites', list });
      });
    }
    function getSprite(name) {
      const s = sprites.get(name);
      if (!s) throw new Error('GT.sprite: no sprite named "' + name + '" (declare it in GT.game({ sprites }) or the bundle)');
      if (QA && s.bundle) { used(name); if (s.atlas) used(s.atlas); }
      return s;
    }
    // Draw a sprite centred on (x, y). opts: w/h or scale, rot (radians), alpha, flipX, flipY,
    // anchorX/anchorY (0..1, default 0.5), sx/sy (extra squash & stretch), frame (a bundle strip's
    // frame index, wrapping). Bundle atlas sprites and strip frames draw their own rect.
    function drawSprite(c, name, x, y, opts) {
      const s = getSprite(name);
      opts = opts || {};
      const k = opts.scale || 1;
      const w = (opts.w || (opts.h ? s.w * (opts.h / s.h) : s.w * k)) * (opts.sx || 1);
      const h = (opts.h || (opts.w ? s.h * (opts.w / s.w) : s.h * k)) * (opts.sy || 1);
      let r = s.rect;
      if (s.rects) {
        const n = s.rects.length, f = Math.floor(Number(opts.frame)) || 0;
        r = s.rects[((f % n) + n) % n];
      }
      c.save();
      c.translate(x, y);
      if (opts.rot) c.rotate(opts.rot);
      if (opts.flipX || opts.flipY) c.scale(opts.flipX ? -1 : 1, opts.flipY ? -1 : 1);
      if (opts.alpha != null) c.globalAlpha *= opts.alpha;
      const dx = -w * (opts.anchorX == null ? 0.5 : opts.anchorX), dy = -h * (opts.anchorY == null ? 0.5 : opts.anchorY);
      if (r) c.drawImage(s.canvas, r[0], r[1], r[2], r[3], dx, dy, w, h);
      else c.drawImage(s.canvas, dx, dy, w, h);
      c.restore();
    }

    // ----- bundles (v12): GT.game({ bundle: 'sha256-<hex>' }) -----
    // Loaded next to the sprites, before setup(): the manifest from the game's own folder
    // (b/<hex>.json), then every file it names, each fetched with a byte cap, hashed against its
    // name, sniffed and its header compared with the manifest before anything decodes it. Images
    // decode here (createImageBitmap from a Blob) into the sprite map; meshes stay bytes until
    // geometry(); audio goes to the page in one `clips` message. Any problem fails the whole load
    // (the crash screen says why): a game never runs with half its bundle.
    const assets = new Map(); // name -> what GT.asset(name) returns
    // ?qa: how often the game used each sprite and asset (drawn, GT.sprite, GT.asset, GT.sfx, music),
    // read by QA's unused-asset warning as __gt.call('assetUse') → { name: count }.
    const assetUse = new Map();
    function used(name) { assetUse.set(name, (assetUse.get(name) || 0) + 1); }
    if (QA) self.__qaCalls = Object.assign(self.__qaCalls || {}, { assetUse: () => Object.fromEntries(assetUse) });
    let bundleInfo = null; // 'ready''s bundle: { files, bytes, ms }
    let clipsDone = null;
    let clipsStray = false; // the page answered a `clips` before the runtime sent one: game code's
    function loadBundle(def) {
      const key = def.bundle;
      const music = musicDef(def.music);
      const wantsClips = music && typeof music === 'object' && (music.loop != null || music.layers != null || music.over != null);
      if (key == null) return wantsClips ? Promise.reject(new Error('bundle: music.loop, music.layers and music.over name clips in a bundle, and this game has none')) : Promise.resolve(null);
      const m = typeof key === 'string' ? BUNDLE_KEY_RE.exec(key) : null;
      if (!m) return Promise.reject(new Error("bundle: the bundle key must be 'sha256-<64 hex>'"));
      const ctl = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
      const made = []; // bitmaps to release if the load fails
      const progress = { files: 1 };
      let timer = 0;
      const deadline = new Promise((_, reject) => {
        timer = NATIVE.setTimeout(() => { ctl.abort(); reject(new Error('bundle: timed out loading ' + progress.files + ' files')); }, BUNDLE_MS);
      });
      return Promise.race([bundleFiles(m[1], def, music, ctl, made, progress), deadline]).then((info) => {
        NATIVE.clearTimeout(timer);
        bundleInfo = info;
        if (QA && music && typeof music === 'object') for (const n of [music.loop, music.over].concat(music.layers || [])) if (n != null) used(n);
        return info;
      }, (err) => {
        NATIVE.clearTimeout(timer);
        progress.dead = true; // anything still decoding is dropped, not added
        ctl.abort();
        for (const b of made) { try { if (b.close) b.close(); } catch (_) { /* gone */ } }
        for (const [name, s] of Array.from(sprites)) if (s.bundle) sprites.delete(name);
        assets.clear(); clipsDone = null;
        throw err;
      });
    }
    async function bundleFiles(hex, def, music, ctl, made, progress) {
      const L = BUNDLE_LIMITS, t0 = perfNow();
      if (!env.url) throw new Error('bundle: manifest: the SDK does not know where the game was loaded from');
      const folder = new URL('b/', new URL('.', env.url)).href;
      let total = 0;
      // GET one file of the bundle, reading the body against its cap and the bundle's.
      async function fetchBounded(file, cap, label) {
        const ext = file.slice(file.lastIndexOf('.') + 1);
        let r;
        try { r = await NATIVE.fetch(folder + file, { signal: ctl.signal }); } catch (_) { throw new Error(label + 'it could not be fetched'); }
        if (!r.ok) throw new Error(label + 'HTTP ' + r.status);
        const ct = String(r.headers.get('content-type') || '').toLowerCase().trim();
        const want = BUNDLE_TYPES[ext], types = ext === 'wav' ? [want, 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'] : [want];
        if (!types.some((t) => ct === t || ct.startsWith(t + ';'))) throw new Error(label + 'it was served as "' + ct.slice(0, 60) + '", not ' + want);
        const declared = Number(r.headers.get('content-length'));
        if (declared > cap) { ctl.abort(); throw new Error(label + 'it is ' + declared + ' bytes (max ' + cap + ')'); }
        const chunks = [];
        let n = 0;
        if (r.body && r.body.getReader) {
          const reader = r.body.getReader();
          for (;;) {
            let step;
            try { step = await reader.read(); } catch (_) { throw new Error(label + 'the download failed'); }
            if (step.done) break;
            n += step.value.length; total += step.value.length;
            if (n > cap) { ctl.abort(); throw new Error(label + 'it is more than ' + cap + ' bytes'); }
            if (total > L.bytes) { ctl.abort(); throw new Error('bundle: the bundle is more than ' + L.bytes + ' bytes'); }
            chunks.push(step.value);
          }
        } else {
          const all = new Uint8Array(await r.arrayBuffer());
          n = all.length; total += n;
          if (n > cap) throw new Error(label + 'it is more than ' + cap + ' bytes');
          if (total > L.bytes) throw new Error('bundle: the bundle is more than ' + L.bytes + ' bytes');
          chunks.push(all);
        }
        const out = new Uint8Array(n); // a fresh buffer of its own (transferable, aligned for the mesh views)
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      }

      const mbytes = await fetchBounded(hex + '.json', L.manifestBytes, 'bundle: manifest: ');
      if ((await sha256Hex(mbytes)) !== hex) throw new Error('bundle: manifest: its SHA-256 is not the one game.js names');
      const man = parseManifest(mbytes, Object.keys(def.sprites || {}));
      checkMusic(music, man.assets);
      const list = Array.from(man.assets);
      progress.files = 1 + new Set(list.map((e) => e[1].file)).size;

      // Every file at once, each checked before anything decodes it.
      const got = await Promise.all(list.map(async ([name, a]) => {
        const label = 'bundle: ' + name + ' (' + a.file + '): ', ext = a.file.slice(65);
        const bytes = await fetchBounded(a.file, L.fileBytes, label);
        if ((await sha256Hex(bytes)) !== a.file.slice(0, 64)) throw new Error(label + 'its SHA-256 does not match its name');
        const kind = sniff(bytes);
        if (kind !== ext) throw new Error(label + 'its bytes are ' + (kind ? 'a .' + kind + ' file' : 'not a ' + ext + ' file'));
        checkHeader(a, bytes, label);
        return [name, a, bytes, label];
      }));
      const bytes = total;

      // Audio to the page, all in one message; it answers when every clip is decoded (or not).
      const audioList = got.filter((g) => g[1].type === 'audio');
      let clipBytes = 0;
      for (const g of audioList) clipBytes += g[2].length;
      if (clipBytes > CLIP_BYTES) throw new Error('bundle: audio files total ' + clipBytes + ' bytes (max ' + CLIP_BYTES + ')');
      // The page answers with the token it was sent. Game code can't read it (the request goes out
      // through the captured postMessage), so an answer to a `clips` the game posted itself, which the
      // page took first, can't pass for this one: the load fails instead of playing other audio.
      const token = loadToken();
      if (audioList.length && clipsStray) throw new Error('bundle: the page took another clips message first');
      const decoded = audioList.length ? new Promise((resolve, reject) => {
        clipsDone = (reply) => {
          if (reply && reply.token === token) resolve(reply);
          else reject(new Error('bundle: the page took another clips message first'));
        };
        const msg = audioList.map((g) => {
          const a = g[1], meta = { seconds: a.seconds, channels: a.channels, rate: a.rate };
          if (a.loop) meta.loop = a.loop.slice();
          return [g[0], g[2].slice().buffer, meta];
        });
        post({ t: 'clips', token, list: msg }, msg.map((e) => e[1]));
      }) : null;

      // Images decode here, in parallel with the page's audio decodes.
      await Promise.all(got.filter((g) => g[1].type === 'image').map(async ([name, a, b, label]) => {
        let bmp;
        try { bmp = await NATIVE.createImageBitmap(new Blob([b], { type: BUNDLE_TYPES[a.file.slice(65)] })); } catch (_) { throw new Error(label + 'the browser could not decode it'); }
        made.push(bmp);
        if (progress.dead) { bmp.close(); return; }
        if (bmp.width !== a.w || bmp.height !== a.h) throw new Error(label + 'it decoded to ' + bmp.width + '×' + bmp.height + ', not ' + a.w + '×' + a.h);
        addImage(name, a, bmp);
      }));
      if (progress.dead) return null;
      for (const [name, a, b] of got) if (a.type === 'mesh') addMesh(name, a, b);
      for (const [name, a] of audioList) {
        const rec = { type: 'audio', seconds: a.seconds, channels: a.channels, rate: a.rate };
        if (a.loop) rec.loop = a.loop.slice();
        assets.set(name, rec);
      }
      if (decoded) {
        const reply = await decoded;
        const ok = new Set(Array.isArray(reply.ok) ? reply.ok.map((e) => Array.isArray(e) ? String(e[0]) : '') : []);
        const failed = Array.isArray(reply.failed) ? reply.failed : [];
        for (const [name, a] of audioList) {
          if (ok.has(name)) continue;
          const f = failed.find((e) => Array.isArray(e) && e[0] === name);
          throw new Error('bundle: ' + name + ' (' + a.file + '): ' + (f ? String(f[1]).slice(0, 200) : 'the page did not decode it'));
        }
      }
      // GT.assets() lists them in the manifest's order, whatever order they decoded in.
      const done = new Map(assets);
      assets.clear();
      for (const [name] of list) assets.set(name, done.get(name));
      return { files: progress.files, bytes, ms: Math.round(perfNow() - t0) };
    }
    // The manifest's declarations against the file's own header, before anything decodes it.
    function loadToken() {
      const a = new Uint32Array(4);
      if (NATIVE.randomValues) NATIVE.randomValues(a); else for (let i = 0; i < 4; i++) a[i] = (NATIVE.random() * 4294967296) >>> 0;
      let s = '';
      for (let i = 0; i < 4; i++) s += a[i].toString(16).padStart(8, '0');
      return s;
    }
    function checkHeader(a, b, label) {
      const L = BUNDLE_LIMITS, fail = (why) => { throw new Error(label + why); };
      if (a.type === 'image') {
        const hd = a.file.endsWith('.png') ? pngHeader(b) : webpHeader(b);
        if (!hd) fail('its image header is not valid');
        if (hd.w !== a.w || hd.h !== a.h) fail('its header says ' + hd.w + '×' + hd.h + ', the manifest ' + a.w + '×' + a.h);
      } else if (a.type === 'audio') {
        const wav = a.file.endsWith('.wav'), hd = wav ? wavHeader(b) : mp3Info(b);
        if (!hd) fail(wav ? 'it is not a PCM WAV file' : 'it is not an MP3 stream of Layer III frames');
        if (hd.seconds > L.audioClipSeconds + 0.1) fail('it plays for ' + hd.seconds.toFixed(1) + ' s (max ' + L.audioClipSeconds + ')');
        if (hd.channels !== a.channels || hd.rate !== a.rate) fail('it is ' + hd.channels + ' channel(s) at ' + hd.rate + ' Hz, the manifest says ' + a.channels + ' at ' + a.rate);
        if (Math.abs(hd.seconds - a.seconds) > 0.1) fail('it plays for ' + hd.seconds.toFixed(2) + ' s, the manifest says ' + a.seconds);
      } else {
        const hd = meshHeader(b);
        if (!hd) fail('its DMB1 header is not valid');
        if (hd.vertices !== a.vertices || hd.indices !== a.indices) fail('its header says ' + hd.vertices + ' vertices and ' + hd.indices + ' indices, the manifest ' + a.vertices + ' and ' + a.indices);
        const flags = (a.attributes.includes('normal') ? 1 : 0) | (a.attributes.includes('uv') ? 2 : 0) | (a.attributes.includes('color') ? 4 : 0);
        if (hd.flags !== flags) fail('its attributes (flags ' + hd.flags + ') are not the manifest\'s ' + a.attributes.join(', '));
        const problems = checkMeshValues(b);
        if (problems.length) fail(problems[0]);
      }
    }
    function checkMusic(m, man) {
      if (!m || typeof m !== 'object') return;
      const isLoop = (n) => { const a = man.get(n); return !!(a && a.type === 'audio' && a.loop); };
      if (m.loop != null && m.layers != null) throw new Error('bundle: music takes loop or layers, not both');
      if (m.loop != null && !isLoop(m.loop)) throw new Error('bundle: music.loop needs a clip with loop points');
      if (m.layers != null) {
        if (!m.layers.length || m.layers.length > 7) throw new Error('bundle: music.layers takes 1 to 7 clips');
        if (!m.layers.every(isLoop)) throw new Error('bundle: music.layers needs clips with loop points');
      }
      if (m.over != null) { const a = man.get(m.over); if (!a || a.type !== 'audio') throw new Error('bundle: music.over must name an audio clip'); }
    }
    function addImage(name, a, bmp) {
      const sc = a.scale, rec = { type: 'image', bitmap: bmp, w: a.w, h: a.h, scale: sc, tile: a.tile };
      const spr = { canvas: bmp, w: a.w / sc, h: a.h / sc, scale: sc, bundle: true };
      if (a.frames) {
        const f = a.frames;
        rec.frames = { w: f.w, h: f.h, n: f.n };
        spr.w = f.w / sc; spr.h = f.h / sc; spr.frames = rec.frames;
        spr.rects = [];
        for (let i = 0; i < f.n; i++) spr.rects.push([(i * f.w) % a.w, Math.floor((i * f.w) / a.w) * f.h, f.w, f.h]);
      }
      if (a.sprites) {
        rec.sprites = {};
        for (const sub of Object.keys(a.sprites)) {
          const r = a.sprites[sub];
          rec.sprites[sub] = r.slice();
          sprites.set(sub, { canvas: bmp, w: r[2] / sc, h: r[3] / sc, scale: sc, rect: r.slice(), atlas: name, bundle: true });
        }
        spr.sprites = rec.sprites;
      }
      sprites.set(name, spr);
      assets.set(name, rec);
    }
    function addMesh(name, a, b) {
      let geo = null;
      const buf = b.buffer, v = a.vertices;
      assets.set(name, {
        type: 'mesh', vertices: v, indices: a.indices, attributes: a.attributes.slice(),
        /** A THREE.BufferGeometry over the file's bytes, built once (three: true games). */
        geometry() {
          if (geo) return geo;
          const T = self.THREE;
          if (!T || typeof T.BufferGeometry !== 'function') throw new Error('GT.asset("' + name + '").geometry() needs three.js: declare three: true in GT.game');
          const g = new T.BufferGeometry();
          let o = 16;
          const attr = (key, size) => { g.setAttribute(key, new T.BufferAttribute(new Float32Array(buf, o, size * v), size)); o += 4 * size * v; };
          attr('position', 3);
          if (a.attributes.includes('normal')) attr('normal', 3);
          if (a.attributes.includes('uv')) attr('uv', 2);
          if (a.attributes.includes('color')) attr('color', 3);
          g.setIndex(new T.BufferAttribute(new Uint16Array(buf, o, a.indices), 1));
          g.computeBoundingBox(); g.computeBoundingSphere();
          return (geo = g);
        },
      });
    }
    function getAsset(name) {
      const a = assets.get(String(name));
      if (a) { if (QA) used(String(name)); return a; }
      const have = Array.from(assets.keys());
      throw new Error('GT.asset: no asset named "' + name + '" (' + (have.length ? 'the bundle has ' + have.join(', ') : 'this game has no bundle') + ')');
    }

    // ----- post-processing, configured by GT.game({ post: {...} }) -----
    let bloomA = null, bloomB = null, vignetteTex = null, scanTex = null, postFrame = 0;
    let gradeTex = null, gradePat = null, colorProbe = null, gradeMemo = { key: null, tex: null };
    // Tint and grain as one 128 px 'overlay' texture, baked once per (grain, tint). Overlay moves a
    // pixel by alpha·(2s-1)·min(d, 1-d), linear in the source s, so grain + tint add per texel:
    // the grain is exactly the old overlay grain, and the tint is the old soft-light grade
    // re-expressed for overlay (0.573 is the least-squares fit; within ~5/255 for the tints games
    // use). Like soft-light it leaves black and white untouched. Returns null when there is nothing
    // to draw; the canvas carries the globalAlpha to draw it with.
    function gradeTexture(post) {
      const grain = Math.max(0, Math.min(1, Number(post.grain) || 0));
      const [color, amt] = !post.tint ? ['#808080', 0] : Array.isArray(post.tint) ? post.tint : [post.tint, 0.15];
      const memoKey = grain + '|' + color + '|' + amt;
      if (gradeMemo.key === memoKey) return gradeMemo.tex;
      gradeMemo.key = memoKey; gradeMemo.tex = null;
      if (!colorProbe) colorProbe = offscreen(1, 1).getContext('2d', { willReadFrequently: true });
      colorProbe.clearRect(0, 0, 1, 1); colorProbe.fillStyle = '#808080'; colorProbe.fillStyle = color; colorProbe.fillRect(0, 0, 1, 1);
      const t = colorProbe.getImageData(0, 0, 1, 1).data;
      const k = 0.573 * Math.max(0, Math.min(1, Number(amt) || 0)) * (t[3] / 255);
      const shift = [0, 1, 2].map((i) => k * (2 * t[i] / 255 - 1));
      const span = grain + Math.max(...shift.map(Math.abs));
      if (span <= 0) return null;
      return gradeMemo.tex = bake('post:grade:' + JSON.stringify([grain, t[0], t[1], t[2], t[3], k]), 128, 128, (g) => {
        const img = g.createImageData(128, 128), r = mulberry(99), d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = grain * (r() * 2 - 1);
          for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.max(0, Math.min(255, Math.round((0.5 + (n + shift[ch]) / (2 * span)) * 255)));
          d[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        g.canvas.gradeAlpha = Math.min(1, span);
      });
    }
    function applyPost(c, post) {
      if (!post) return;
      postFrame++;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      const cw = canvas.width, ch = canvas.height;
      if (post.bloom) {
        // Downsample twice for a wide blur, push contrast so mostly highlights survive, add back.
        if (!bloomA) { bloomA = offscreen(W / 4, H / 4); bloomB = offscreen(W / 12, H / 12); }
        const a = bloomA.getContext('2d'), b = bloomB.getContext('2d');
        a.clearRect(0, 0, bloomA.width, bloomA.height);
        a.filter = 'contrast(2.4) brightness(0.75) saturate(1.3)';
        a.drawImage(canvas, 0, 0, bloomA.width, bloomA.height);
        a.filter = 'none';
        b.clearRect(0, 0, bloomB.width, bloomB.height);
        b.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
        c.globalCompositeOperation = 'screen';
        c.globalAlpha = Math.min(1, post.bloom);
        c.imageSmoothingEnabled = true;
        c.drawImage(bloomA, 0, 0, cw, ch);
        c.drawImage(bloomB, 0, 0, cw, ch);
      }
      if (post.vignette && !postLite) {
        if (!vignetteTex) vignetteTex = bake('post:vignette', W, H, (v) => {
          const g = v.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
          g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
          v.fillStyle = g; v.fillRect(0, 0, W, H);
        });
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = Math.min(1, post.vignette);
        c.drawImage(vignetteTex, 0, 0, cw, ch);
      }
      // Tint and grain share one full-canvas pass (see gradeTexture): each advanced-blend pass is
      // an extra full-canvas pass on phone GPUs, and this used to be two.
      const grade = !postLite && (post.grain || post.tint) ? gradeTexture(post) : null;
      if (grade) {
        if (grade !== gradeTex) { gradeTex = grade; gradePat = c.createPattern(grade, 'repeat'); }
        gradePat.setTransform(new DOMMatrix([1, 0, 0, 1, (postFrame * 37) % 128, (postFrame * 71) % 128]));
        c.globalCompositeOperation = 'overlay'; c.globalAlpha = grade.gradeAlpha;
        c.fillStyle = gradePat; c.fillRect(0, 0, cw, ch);
      }
      if (post.scanlines) {
        if (!scanTex) scanTex = bake('post:scan', 4, 4, (s) => { s.fillStyle = '#000'; s.fillRect(0, 2, 4, 2); });
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = Math.min(1, post.scanlines);
        c.fillStyle = c.createPattern(scanTex, 'repeat'); c.fillRect(0, 0, cw, ch);
      }
      c.restore();
    }

    // ---------- lifecycle ----------
    let game = null, state = null;
    let phase = 'boot'; // boot | attract | play | stage (v13: a stage intermission) | over | crashed
    let roundTime = 0, overAt = 0, score = 0, best = 0, overPending = false, paused = false;
    // A remembered best from the host. The game frame has no storage of its own, so the viewer or
    // app keeps each game's best and hands it back: ?best=N at boot, or the 'best' host command
    // until the first round ends (it only ever raises the best). Ignored under ?qa, so QA runs
    // don't depend on what a host has stored.
    let roundEnded = false;
    function hostBest(v) {
      const n = typeof v === 'string' ? (/^[0-9]{1,15}$/.test(v) ? Number(v) : NaN) : v;
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    }
    if (!QA) best = hostBest(params.get('best'));
    let attractRestart = 0;
    // Wins: GT.win() ends a round as solved/cleared. Puzzles track their best (lowest) solve time.
    let winPending = false, won = false, bestTime = 0;
    let autoplay = false; // QA: drive a real round with the game's own autopilot
    let hideOverlay = false; // QA: capture the attract demo without title text or dimming

    // ---------- stages (v13) ----------
    // A round is endless unless the game declares stages: GT.game({ stages: { count } }) (0 or
    // absent: as many as the game likes). GT.stage.next() clears the current stage. In play the
    // transition waits for the end of the step (like GT.over()), then the phase is 'stage': the game
    // is neither updated nor drawn, its last frame stays under the intermission, and the player's
    // tap (or the host's) continues: the iris closes, setup() runs for the next stage, the iris
    // opens and play resumes in the same round (score, GT.t and milestones carry on). In attract
    // the demo flows on: a short banner and the next stage's setup(), no intermission. Clearing
    // the declared last stage is GT.win(). The round clock stands still during an intermission.
    const STAGE_QA_CONTINUE = 30; // ?qa: steps before the intermission continues by itself
    const STAGE_BANNER = 36; // attract: the banner's steps (0.6 s)
    let stageCount = 0, stageIndex = 1, stageT = 0, stagePending = null;
    let stageInfo = null; // the intermission: { n, title, subtitle, duration }
    let stageSteps = 0, stageClose = -1, stageDown = false; // steps shown; iris-close step (-1: not closing); a press began in it
    let stageShot = null, stageShotOk = false; // the frozen last frame
    let stageBanner = null; // attract: a toast-shaped banner, { text, size, color, i }
    function stageText(v, max) { return v == null ? '' : String(v).trim().slice(0, max); }
    function resetStages() {
      stageIndex = 1; stageT = 0; stagePending = null; stageInfo = null;
      stageSteps = 0; stageClose = -1; stageDown = false; stageShotOk = false; stageBanner = null;
    }
    function stageNext(o) {
      if (phase !== 'play' && phase !== 'attract') return;
      if (overPending || stagePending || (phase === 'attract' && attractRestart)) return;
      if (stageCount > 0 && stageIndex >= stageCount) { winPending = true; overPending = true; return; }
      o = o && typeof o === 'object' ? o : {};
      stagePending = { title: stageText(o.title, 24), subtitle: stageText(o.subtitle, 40) };
    }
    // Called by step() after the game's update, once GT.over() has had its say.
    function takeStage() {
      const o = stagePending;
      stagePending = null;
      if (phase === 'attract') {
        // The demo keeps flowing: the next stage at once, under a 0.6 s banner.
        stageBanner = { text: o.title || 'STAGE ' + (stageIndex + 1), i: 0 };
        advanceStage();
        return;
      }
      const n = stageIndex, duration = Math.round(stageT * 100) / 100;
      stageInfo = { n, title: o.title || 'STAGE ' + n + ' CLEARED', subtitle: o.subtitle, duration };
      sfx('stage'); // while still in play: sounds play in play and over only
      phase = 'stage';
      stageSteps = 0; stageClose = -1; stageDown = false; stageShotOk = false;
      hitStopLeft = 0; slowSteps = 0;
      lastActivityAt = -Infinity; // the first input after the intermission reports activity at once
      emit('stage', { stage: n, title: stageInfo.title, score, duration });
      audioPhase();
    }
    // The intermission's continue: a tap after the accidental-tap guard, the host's tap, or ?qa's timer.
    function stageContinue(x, y) {
      if (phase !== 'stage' || stageClose >= 0 || stageSteps * STEP <= RETRY_GUARD) return;
      stageClose = 0; irisX = x; irisY = y;
    }
    // The next stage of the same round (attract, or once the intermission's iris has closed).
    function advanceStage() {
      stageIndex++; stageT = 0;
      comboN = 0; comboLeft = 0; chipN = 0; chipOut = -1; breakAt = -1; // GT.combo.end(), without the fade
      particles = particles.filter((p) => p.ui); floaters = floaters.filter((f) => f.ui); shakeAmt = 0; flashT = 0;
      hitStopLeft = hitStopCool = 0; slowSteps = slowAt = 0; tweens = [];
      bot.down = false; botHoldLeft = 0; botIdleLeft = 0.3;
      resetTurns(true);
      try { state = game.setup() || {}; } catch (err) { reportError(err); crash(); }
    }
    function stageStep() {
      stageSteps++;
      if (stageClose >= 0) {
        if (++stageClose < IRIS_STEPS) return;
        stageClose = -1; stageInfo = null; stageShotOk = false;
        phase = 'play';
        irisAt = 0; // the round's iris opens from where the continue tap was
        audioPhase();
        advanceStage();
        return;
      }
      if (QA && stageSteps >= STAGE_QA_CONTINUE) stageContinue(W / 2, H / 2);
    }

    // ---------- turns (v14) ----------
    // kind: 'turns' games end the round when a resource runs out: GT.game({ turns: { count, unit,
    // settle } }) and GT.turns.use() as each shot is fired. The step that spends the last turn starts
    // "finishing": from the next step update() gets blank input while the shot plays out, and once
    // `settle` seconds have passed and game.settled(state) says so (or TURNS_SETTLE_MAX has), the SDK
    // ends the round as GT.over() would, with "OUT OF <UNITS>" on the over screen. add()/set() that
    // leave turns cancel it. Each stage starts with the full count again; `used` counts the round.
    const TURNS_SETTLE_MAX = 8; // s
    let turnsDef = null; // { count, unit: [singular, plural], settle }, for kind 'turns' only
    let solutionsDef = 'unique'; // kind 'puzzle': 'unique' | 'many'
    let turnsLeft = 0, turnsUsed = 0, turnsShown = false, turnsPending = false;
    let turnsFinishing = false, turnsFinishAt = 0, turnsCapped = false, outOfTurns = false;
    function turnsConf(t) {
      t = t == null ? {} : t;
      const n = typeof t === 'object' ? (t.count == null ? 0 : t.count) : NaN;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000) throw new Error('GT.game: turns.count must be a whole number');
      const cut = (v) => String(v).trim().slice(0, 12);
      let unit = ['turn', 'turns'];
      if (typeof t.unit === 'string' && t.unit.trim()) unit = [cut(t.unit), cut(t.unit.trim() + 's')];
      else if (Array.isArray(t.unit) && t.unit.length === 2 && cut(t.unit[0]) && cut(t.unit[1])) unit = [cut(t.unit[0]), cut(t.unit[1])];
      const settle = typeof t.settle === 'number' && t.settle >= 0 && t.settle <= TURNS_SETTLE_MAX ? t.settle : 0.6;
      return { count: n, unit, settle };
    }
    function resetTurns(stage) {
      const count = turnsDef ? turnsDef.count : 0;
      turnsLeft = count;
      if (stage) turnsShown = turnsShown || count > 0;
      else { turnsUsed = 0; turnsShown = count > 0; turnsCapped = false; outOfTurns = false; }
      turnsPending = turnsFinishing = false; turnsFinishAt = 0;
    }
    // The resource's write calls: live rounds of turns games only, never once the round has ended.
    function turnsArg(n, dflt) {
      if (!turnsDef || (phase !== 'play' && phase !== 'attract') || (phase === 'attract' && attractRestart)) return NaN;
      const v = n === undefined ? dflt : Number(n);
      return isFinite(v) ? v : NaN;
    }
    const clampTurns = (v) => Math.max(0, Math.min(1000, Math.round(v)));
    function turnsLeftTo(v, by) {
      const was = turnsLeft;
      turnsLeft = clampTurns(v);
      if (was > 0 && turnsLeft === 0 && by !== 'add') turnsPending = true;
      if (turnsLeft > 0 && by !== 'use') { turnsPending = turnsFinishing = false; turnsFinishAt = 0; }
    }
    function turnsUse(n) {
      const v = turnsArg(n, 1);
      if (isNaN(v)) return;
      turnsUsed = clampTurns(turnsUsed + v);
      if (turnsLeft > 0) turnsLeftTo(turnsLeft - v, 'use');
    }
    function turnsAdd(n) { const v = turnsArg(n, 1); if (!isNaN(v)) turnsLeftTo(turnsLeft + v, 'add'); }
    function turnsSet(n) {
      const v = turnsArg(n, NaN);
      if (isNaN(v)) return;
      turnsShown = true;
      turnsLeftTo(v, 'set');
    }
    // Called by step() before the game's update while finishing: is the last turn done with?
    function turnsSettled() {
      const since = roundTime - turnsFinishAt + 1e-9;
      if (since >= TURNS_SETTLE_MAX) { turnsCapped = true; return true; }
      if (since < turnsDef.settle) return false;
      if (typeof game.settled !== 'function') return true;
      try { return !!game.settled(state); } catch (err) { reportError(err); return true; }
    }
    // What update() sees once the last turn is spent: nothing pressed, the pointer where it was.
    function blankFrom(inp) {
      const b = blankInput();
      b.x = inp.x; b.y = inp.y;
      return b;
    }
    function turnsLine() {
      const u = turnsDef.unit;
      return turnsLeft === 0 ? 'no ' + u[1] + ' left' : turnsLeft + ' ' + (turnsLeft === 1 ? u[0] : u[1]) + ' left';
    }
    // The HUD's resource line is drawn (and toasts sit under it).
    function turnsLineShown() { return !!turnsDef && turnsShown && game.hud !== false; }

    function newRound(mode) {
      const roundSeed = (baseSeed + rounds * 7919) >>> 0;
      rand = mulberry(roundSeed);
      botRand = mulberry(roundSeed ^ 0x9e3779b9);
      fxRand = mulberry(roundSeed ^ 0x85ebca6b);
      score = 0; roundTime = 0; overPending = false; winPending = false; won = false;
      resetStages();
      resetTurns(false);
      particles = []; floaters = []; shakeAmt = 0; flashT = 0;
      resetFeel(mode);
      GT.t = 0;
      phase = mode;
      audioPhase();
      bot.down = false; botHoldLeft = 0; botIdleLeft = 0.3;
      try { state = game.setup() || {}; } catch (err) { reportError(err); crash(); }
    }

    function handleMeta() {
      // A press during attract starts play; a press on the game-over screen retries.
      if (phase === 'attract') {
        pending.tap = false; pending.swipe = null;
        rounds++;
        newRound('play');
        emit('start', { round: rounds });
      } else if (phase === 'over' && roundTime - overAt > RETRY_GUARD) {
        pending.tap = false; pending.swipe = null;
        rounds++;
        newRound('play');
        emit('retry', { round: rounds });
      }
    }

    function crash() {
      if (phase === 'crashed') return;
      phase = 'crashed';
      emit('crash');
      audioPhase();
    }

    function step() {
      if (QA) qaClock += 1000 / 60;
      if (phase === 'crashed' || phase === 'boot') return;
      // A stage intermission: the game, its clock and its effects hold still; only a tap moves on.
      if (phase === 'stage') { consumeHuman(); return stageStep(); }
      const live = phase === 'attract' || phase === 'play';
      // Hit-stop: the game and its clock hold still (input waits) while effects keep playing.
      if (live && frozenStep()) return stepJuice();
      const dt = live ? STEP * timeScale() : STEP; // slow motion shrinks the game's dt
      roundTime += dt;
      if (live) stageT += dt;
      if (stageBanner && ++stageBanner.i >= STAGE_BANNER) stageBanner = null;
      GT.t = phase === 'over' ? overAt : roundTime;
      if (live) {
        const fromHuman = phase === 'play' && !autoplay;
        let inp = fromHuman ? consumeHuman() : botStep(state);
        if (phase === 'crashed') return;
        applyStick(inp, fromHuman ? 'human' : 'bot');
        stickKnob.active = inp.stick.active;
        // v14: after the last turn (and in attract until the demo restarts) the game gets no input.
        if (turnsFinishing || (turnsDef && outOfTurns)) {
          inp = blankFrom(inp);
          if (turnsFinishing && !overPending && turnsSettled()) { outOfTurns = true; overPending = true; }
        } else if (phase === 'play' && !autoplay) noteInput(inp);
        try { game.update(state, dt, inp); } catch (err) { reportError(err); return crash(); }
        if (overPending) {
          overPending = false;
          turnsPending = turnsFinishing = false;
          if (phase === 'play') {
            phase = 'over'; overAt = roundTime; won = winPending; roundEnded = true;
            const before = best;
            best = Math.max(best, score);
            if (won) bestTime = bestTime ? Math.min(bestTime, roundTime) : roundTime;
            emit('over', { score, duration: Math.round(roundTime * 1000) / 1000, round: rounds, win: won, stage: stageIndex });
            audioPhase();
            roundOver(before);
          } else {
            attractRestart = roundTime + 1.2;
          }
          stagePending = null; // the round ended in the same step: no stage after it
        } else if (stagePending) takeStage(); // a stage cleared with the last turn wins: it resets the turns
        else if (turnsPending) { turnsPending = false; turnsFinishing = true; turnsFinishAt = roundTime; }
        if (phase === 'attract' && attractRestart && roundTime >= attractRestart) {
          attractRestart = 0; newRound('attract');
        }
      } else {
        consumeHuman();
      }
      stepJuice();
      if (++clockSteps >= 30) { clockSteps = 0; audioClock(); }
    }
    let clockSteps = 0;

    function render() {
      soundsSent = 0;
      if (densityPending) { densityPending = false; resize(); } // between frames, since resizing clears the canvas
      renderFrame();
      if (DEBUG) drawDebug();
    }

    // v17: the stick a game declared, drawn at the press point: a ring and a knob under the finger.
    function drawStick() {
      const R = stickOpts().radius, k = stickKnob;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = cc('panel', 0.22, 'rgba(0,0,0,0.22)');
      ctx.beginPath(); ctx.arc(k.ox, k.oy, R, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = cc('text', 0.55, 'rgba(255,255,255,0.55)');
      ctx.beginPath(); ctx.arc(k.ox, k.oy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = cc('text', 0.85, 'rgba(255,255,255,0.85)');
      ctx.beginPath(); ctx.arc(k.x, k.y, R * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = cc('accent', 0.9, 'rgba(255,224,102,0.9)');
      ctx.beginPath(); ctx.arc(k.x, k.y, R * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function renderFrame() {
      const dpr = canvas.width / (W * scale || 1);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      ctx.fillStyle = (game && game.bg) || '#111';
      ctx.fillRect(0, 0, W, H);
      if (phase === 'boot') return;
      // A stage intermission draws the frozen last frame (taken below on its first render) under the card.
      if (phase === 'stage' && stageShotOk && stageShot.width === canvas.width && stageShot.height === canvas.height) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(stageShot, 0, 0); ctx.restore();
        ctx.globalAlpha = 1; ctx.textBaseline = 'middle';
        if (!hideOverlay) drawIntermission();
        return drawFeel();
      }
      ctx.save();
      if (shakeAmt > 0) ctx.translate((fxRand() - 0.5) * shakeAmt, (fxRand() - 0.5) * shakeAmt);
      if (phase !== 'crashed') {
        // Under ?qa: the game's own draw() time, less the WebGL render and composite inside
        // view.draw (headless renders those on the CPU), so QA can judge a 3D game's JavaScript.
        const d0 = QA ? perfNow() : 0, gl0 = glMs;
        try { game.draw(state, ctx); } catch (err) { reportError(err); crash(); }
        if (QA) qaDrawMs = perfNow() - d0 - (glMs - gl0);
      }
      ctx.restore();
      ctx.save();
      drawJuice();
      ctx.restore();
      if (phase !== 'crashed' && !GL_FLAGS.has('nopost')) applyPost(ctx, game.post);
      ctx.globalAlpha = 1; ctx.textBaseline = 'middle';
      if ((phase === 'play' || phase === 'attract') && stickKnob.active && stickOpts().show) drawStick();
      if (hideOverlay) return;
      const puzzle = !!game && game.kind === 'puzzle';
      if ((phase === 'play' || phase === 'stage') && game.hud !== false) {
        // Puzzles show the clock; arcade games show the score.
        GT.text(ctx, puzzle ? clock(roundTime) : String(score), W / 2, 44, puzzle ? 30 : 40, cc('text', 1, '#fff'), 'center', '900', true);
        // v14: turns games show what's left under the score.
        if (turnsLineShown()) GT.text(ctx, turnsLine(), W / 2, 76, 16, cc('accent', 1, '#ffe066'), 'center', '800', true);
      } else if (phase === 'attract') {
        ctx.fillStyle = cc('panel', 0.45, 'rgba(0,0,0,0.45)'); ctx.fillRect(0, 0, W, H);
        GT.text(ctx, game.title || '', W / 2, H * 0.36, 34, cc('text', 1, '#fff'), 'center', '900', true);
        GT.text(ctx, (game.instruction || 'TAP').toUpperCase(), W / 2, H * 0.46, 22, cc('accent', 1, '#ffe066'), 'center', '800', true);
        // Puzzles list their rules under the instruction: up to 3 short lines.
        (Array.isArray(game.rules) ? game.rules.slice(0, 3) : []).forEach((line, i) => {
          fitText(String(line), W / 2, H * 0.53 + i * 24, 16, W - 40, cc('text', 0.9, 'rgba(255,255,255,0.9)'), '700');
        });
        const pulse = 0.55 + 0.45 * Math.sin(perfNow() / 260);
        ctx.globalAlpha = pulse;
        GT.text(ctx, 'tap to play', W / 2, H * 0.72, 18, cc('text', 1, '#fff'), 'center', '600', true);
        ctx.globalAlpha = 1;
      } else if (phase === 'over') {
        const since = roundTime - overAt;
        ctx.fillStyle = cc('panel', 0.55 * overIn(since), 'rgba(0,0,0,' + (0.55 * overIn(since)).toFixed(3) + ')'); ctx.fillRect(0, 0, W, H);
        ctx.save();
        popOverCard(since);
        // v13: the stage reached, under the score, for games with stages; the lines below it move down.
        const sy = stageLineShift();
        if (puzzle && won) {
          const time = overAt;
          GT.text(ctx, 'SOLVED', W / 2, H * 0.33, 44, cc('accent', 1, '#9bf6a0'), 'center', '900', true);
          GT.text(ctx, clock(time), W / 2, H * 0.42, 56, cc('text', 1, '#fff'), 'center', '900', true);
          if (sy) stageLine(H * 0.485);
          bestLine('best ' + clock(bestTime), H * (0.5 + sy), since);
          comboLine(H * (0.56 + sy));
          retryPrompt('tap for the next puzzle', since);
        } else if (puzzle) {
          GT.text(ctx, 'NOT SOLVED', W / 2, H * 0.4, 40, cc('text', 1, '#fff'), 'center', '900', true);
          if (sy) stageLine(H * 0.47);
          retryPrompt('tap to try another', since);
        } else {
          if (won) GT.text(ctx, 'CLEARED', W / 2, H * 0.29, 32, cc('accent', 1, '#9bf6a0'), 'center', '900', true);
          else if (turnsDef && outOfTurns) fitLine('OUT OF ' + turnsDef.unit[1].toUpperCase(), H * 0.29, 22, W - 40, cc('accent', 1, '#9bf6a0'), '900');
          GT.text(ctx, String(score), W / 2, H * 0.38, 72, cc('text', 1, '#fff'), 'center', '900', true);
          if (sy) stageLine(H * 0.455);
          bestLine('best ' + best, H * (0.47 + sy), since);
          comboLine(H * (0.53 + sy));
          retryPrompt('tap to retry', since);
        }
        ctx.restore();
      } else if (phase === 'crashed') {
        GT.text(ctx, 'this game crashed', W / 2, H / 2, 20, '#f66', 'center', '700', true);
        if (lastError) {
          // The reason, wrapped onto up to 4 lines of the frame's width. A word wider than a line (a
          // bundle file's 64-hex name) breaks anywhere; text that doesn't fit ends in an ellipsis.
          ctx.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
          const maxW = W - 40, fits = (s) => ctx.measureText(s).width <= maxW, MAX_LINES = 4;
          const lines = [''];
          let cut = lastError.length > 300;
          words: for (const word of lastError.slice(0, 300).split(/\s+/)) {
            let rest = word;
            while (rest) {
              const cur = lines[lines.length - 1], pre = cur ? cur + ' ' : '';
              if (fits(pre + rest)) { lines[lines.length - 1] = pre + rest; break; }
              if (cur && fits(rest)) {
                if (lines.length === MAX_LINES) { cut = true; break words; }
                lines.push(rest); break;
              }
              // Too wide even for a line of its own: as many characters as fit here, the rest on the next line.
              let n = 0;
              while (n < rest.length && fits(pre + rest.slice(0, n + 1))) n++;
              if (n) { lines[lines.length - 1] = pre + rest.slice(0, n); rest = rest.slice(n); }
              if (rest) {
                if (lines.length === MAX_LINES) { cut = true; break words; }
                lines.push('');
              }
            }
          }
          if (cut) {
            let last = lines[lines.length - 1];
            while (last && !fits(last + '…')) last = last.slice(0, -1);
            lines[lines.length - 1] = last + '…';
          }
          lines.forEach((l, i) => fitText(l, W / 2, H / 2 + 30 + i * 16, 12, W - 40, 'rgba(255,255,255,0.8)', '500'));
        }
      }
      if (phase === 'stage') {
        // The intermission's first render: the cleared stage's final frame, with the HUD, kept for the rest of it.
        drawRetryHud();
        takeStageShot();
        drawIntermission();
      }
      drawFeel();
    }

    function clock(t) {
      const secs = Math.floor(t);
      return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    }
    // Text shrunk to fit a width (rules lines are written by the game, so their length varies).
    function fitText(str, x, y, size, maxW, color, weight) {
      ctx.font = weight + ' ' + size + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
      const w = ctx.measureText(str).width;
      GT.text(ctx, str, x, y, w > maxW ? Math.max(10, Math.floor(size * maxW / w)) : size, color, 'center', weight, true);
    }

    let last = 0, acc = 0;
    // v15: the loop runs only while there is something to show. Paused (a preloaded card, or the
    // host's menu) or with the page hidden, the last frame stays on the canvas and no frame is
    // scheduled; resuming or showing the page schedules one (loop). Nothing else needs frames
    // while paused: resizing and crashes draw at once, and sprites and bundles load before ready.
    let looping = false, running = false, pageHidden = false;
    function loop() {
      if (!running || looping || paused || pageHidden) return;
      looping = true;
      env.raf(frame);
    }
    // The last frame's start, duration and lateness (ms since the frame before), for the pongs.
    const frameStat = { at: 0, ms: 0, gap: 0 };
    function frame(now) {
      looping = false;
      const began = perfNow();
      frameStat.gap = frameStat.at ? Math.round(began - frameStat.at) : 0;
      frameStat.at = began;
      try { frameBody(now); } finally { frameStat.ms = Math.round(perfNow() - began); }
    }
    function frameBody(now) {
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      let n = 0;
      if (!paused) {
        acc += dt * SPEED;
        while (acc >= STEP && n < 12 * SPEED) { step(); acc -= STEP; n++; }
        if (n >= 12 * SPEED) acc = 0;
      }
      // Draw only when the simulation moved. On 90/120/144 Hz screens most refreshes have no new
      // step, and redrawing them would be identical frames at double the GPU cost. A paused card
      // keeps its last frame (until v15, paused 2D cards redrew it on every refresh).
      if (n > 0) render();
      if (n > 0 && !paused && !(game && game.three)) adapt2d(now);
      if (DEBUG && now - statsAt >= 500) { statsAt = now; post({ t: 'stats', stats: stats() }); }
      loop();
    }
    let statsAt = 0;
    // 2D games have no 3D layer to shrink, so under load they only shed 2D pixels (density,
    // see resize()). Same thresholds as the 3D adapt(): 20 slow rendered frames step down,
    // a long fast run steps back up.
    let slow2d = 0, fast2d = 0, lastRender2d = 0;
    function adapt2d(now) {
      const gap = now - lastRender2d;
      lastRender2d = now;
      if (QA || gap > 400 || GL_FLAGS.has('noadapt')) return;
      if (gap > 20) { slow2d++; fast2d = 0; } else if (gap < 18) { fast2d++; slow2d = Math.max(0, slow2d - 1); }
      if (slow2d >= 20 && density > 0.65) { density = Math.max(0.65, density - 0.15); densityPending = true; slow2d = 0; }
      else if (slow2d >= 20 && !postLite) { postLite = true; slow2d = 0; }
      else if (fast2d >= 300 && postLite) { postLite = false; fast2d = 0; }
      else if (fast2d >= 300 && density < 1) { density = Math.min(1, density + 0.15); densityPending = true; fast2d = 0; }
    }

    // Host commands, forwarded by the shell from the feed or app.
    function onHost(d) {
      if (d.cmd === 'pause') paused = true;
      if (d.cmd === 'resume') { paused = false; last = 0; loop(); }
      // 'best': the host's remembered best for this game (see hostBest). Raises only, and only
      // until the first round ends; after that the SDK's own best already includes this visit.
      if (d.cmd === 'best' && !QA && !roundEnded && typeof d.value === 'number') best = Math.max(best, hostBest(d.value));
      // 'tap': the host's own gesture layer was tapped (the app keeps swipes for navigation while
      // the demo or game-over screen shows). Same effect as tapping the canvas: start or retry.
      // (The shell unlocks audio for it: the app's web view allows audio without a gesture.)
      // v13: in a stage intermission it continues to the next stage.
      if (d.cmd === 'tap') {
        if (!gotFirstInput) { gotFirstInput = true; emit('input'); }
        if (phase === 'stage') stageContinue(W / 2, H / 2); else handleMeta();
      }
    }

    // Haptics are requested from the host (the native app plays them; browsers ignore them).
    // Throttled so a burst of hits doesn't turn into a buzz.
    const HAPTICS = ['selection', 'light', 'medium', 'heavy', 'success', 'warning', 'error'];
    let lastHaptic = 0;
    function haptic(style) {
      if (phase !== 'play' && phase !== 'over') return;
      if (HAPTICS.indexOf(style) === -1) style = 'light';
      const now = perfNow();
      if (now - lastHaptic < 60) return;
      lastHaptic = now;
      emit('haptic', { style });
    }

    // ---------- 3D (three.js) ----------
    // A game that declares `three: true` gets three.js loaded before setup(), and GT.three() gives
    // it a scene drawn into an offscreen WebGL canvas. view.draw(ctx) renders the scene and
    // composites it into the SDK's 2D canvas, so the HUD, juice, post-fx, attract/over screens,
    // screenshots and QA fingerprints all keep working on one canvas.
    function loadThree() {
      if (self.THREE) return Promise.resolve();
      const src = new URL('/sdk/three/r' + THREE_REV + '.js', SDK_SRC).href;
      return env.loadScript(src).then(
        () => { if (!self.THREE) throw new Error('three.js r' + THREE_REV + ' loaded but did not define THREE'); },
        () => { throw new Error('could not load three.js r' + THREE_REV + ' from ' + src); },
      );
    }
    let view3d = null;
    const MAX_3D_DPR = 2; // phones render at 3x; the 3D layer caps at 2x to save fill rate
    const max3dDpr = () => (GL_FLAGS.has('dpr1') ? 1 : MAX_3D_DPR);
    const stats3d = { frames: 0, lost: 0, lostAt: 0, restored: 0, resizes: 0, gpu: '', note: '' };
    function three(opts) {
      if (view3d) return view3d;
      const THREE = self.THREE;
      if (!THREE) throw new Error(game && !game.three ? 'GT.three() needs `three: true` in GT.game({...})' : 'GT.three(): three.js is not loaded yet (call it from setup/update/draw, not at the top of game.js)');
      opts = Object.assign({}, opts);
      if (GL_FLAGS.has('noshadow')) opts.shadows = false;
      if (GL_FLAGS.has('aa')) opts.antialias = true;
      if (GL_FLAGS.has('noaa')) opts.antialias = false;
      const glCanvas = offscreen(W, H);
      let creationStatus = '';
      glCanvas.addEventListener('webglcontextcreationerror', (e) => { creationStatus = e.statusMessage || ''; });
      // Multisampling is on by default only for low-density screens: at 2x and up it's barely
      // visible, and its buffers are the biggest single GPU allocation on a phone.
      const antialias = opts.antialias != null ? !!opts.antialias : (DPR || 1) < 2;
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias, alpha: true, powerPreference: 'high-performance' });
      } catch (err) {
        throw new Error('3D is not available on this device (' + ((err && err.message) || err) + (creationStatus ? ': ' + creationStatus : '') + ')');
      }
      try {
        const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
        stats3d.gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      } catch (_) { /* diagnostics only */ }
      // The PowerVR driver in the Pixel 10 family (Android 17) loses the WebGL context within
      // seconds of sampling a shadow map, and Chrome then blocks WebGL for the whole origin, so
      // every later 3D game shows only its 2D layer. Shadow maps are refused on that GPU;
      // ?gl=shadow forces them back on for testing.
      if (opts.shadows && /PowerVR|Imagination/i.test(stats3d.gpu) && !GL_FLAGS.has('shadow')) {
        opts.shadows = false;
        stats3d.note = 'shadow maps off (PowerVR)';
      }
      // A shader that fails to link would otherwise only reach the console; report it like any
      // other error so the ?debug overlay and play telemetry show it.
      renderer.debug.onShaderError = (gl, program) => {
        const info = (gl.getProgramInfoLog(program) || '').trim();
        reportError(new Error('shader program failed' + (info ? ': ' + info.slice(0, 200) : '')));
      };
      renderer.setClearColor(0x000000, 0);
      // A lost context (GPU reset, memory pressure) skips 3D drawing until three.js restores it.
      // preventDefault() tells the browser the page can recover, so it attempts a restore instead
      // of treating the loss as fatal and blocking WebGL for the origin.
      let lost = false;
      glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        lost = true;
        stats3d.lost++; stats3d.lostAt = (perfNow() - BOOT_AT) / 1000;
        reportError(new Error('WebGL context lost after ' + stats3d.frames + ' frames'));
      });
      glCanvas.addEventListener('webglcontextrestored', () => {
        lost = false; stats3d.restored++;
        // Whatever the GPU choked on, shadow maps are the likeliest and the one thing the SDK can
        // drop without the game noticing; a second loss would block WebGL for the origin.
        if (renderer.shadowMap.enabled) { renderer.shadowMap.enabled = false; stats3d.note = 'shadow maps off after context loss'; }
      });
      // Dynamic resolution: when frames run slow (under 50 fps), render the 3D layer at a lower
      // resolution (down to 60%), then shed 2D pixels, and creep back up once there's headroom.
      // Never in QA, whose frames must be reproducible.
      let quality = 1, lastDraw = 0, slow = 0, fast = 0;
      function adapt() {
        const now = perfNow(), gap = now - lastDraw;
        lastDraw = now;
        if (QA || paused || gap > 400 || GL_FLAGS.has('noadapt')) return; // skip pauses, tab switches and the first frame
        if (gap > 20) { slow++; fast = 0; } else if (gap < 18) { fast++; slow = Math.max(0, slow - 1); }
        if (slow >= 20 && quality > 0.6) { quality = Math.max(0.6, quality - 0.1); slow = 0; }
        else if (fast >= 180 && quality < 1) { quality = Math.min(1, quality + 0.1); fast = 0; }
        // Still slow with the 3D layer at its floor: the 2D canvas is what's left to shrink.
        else if (slow >= 20 && density > 0.65) { density = Math.max(0.65, density - 0.15); densityPending = true; slow = 0; }
        else if (slow >= 20 && !postLite) { postLite = true; slow = 0; }
        else if (fast >= 300 && postLite) { postLite = false; fast = 0; }
        else if (fast >= 300 && quality >= 1 && density < 1) { density = Math.min(1, density + 0.15); densityPending = true; fast = 0; }
      }
      if (opts.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(opts.fov || 55, W / H, opts.near || 0.1, opts.far || 500);
      const v = new THREE.Vector3();
      // ?gl=basic / noback: applied once, on the first draw, when the game has built its scene.
      let debugPatched = !GL_FLAGS.has('basic') && !GL_FLAGS.has('noback');
      function patchScene() {
        const swap = (m) => (m && (m.isMeshToonMaterial || m.isMeshStandardMaterial)
          ? new THREE.MeshLambertMaterial({ color: m.color, map: m.map, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity, side: m.side })
          : m);
        scene.traverse((o) => {
          if (!o.material) return;
          const mats = [].concat(o.material);
          if (GL_FLAGS.has('noback') && mats.some((m) => m.side === THREE.BackSide)) { o.visible = false; return; }
          if (GL_FLAGS.has('basic')) o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
        });
      }
      view3d = {
        THREE, scene, camera, renderer,
        /** Render the scene and draw it into ctx, filling the 360×640 logical frame. */
        draw(c) {
          adapt();
          if (lost) return;
          if (!debugPatched) { debugPatched = true; patchScene(); }
          const dpr = Math.min(DPR || 1, max3dDpr()) * density * quality;
          const w = Math.max(1, Math.round(W * scale * dpr)), h = Math.max(1, Math.round(H * scale * dpr));
          if (glCanvas.width !== w || glCanvas.height !== h) { renderer.setSize(w, h, false); stats3d.resizes++; }
          const g0 = QA ? perfNow() : 0;
          renderer.render(scene, camera);
          stats3d.frames++;
          if (!GL_FLAGS.has('nocomposite')) c.drawImage(glCanvas, 0, 0, W, H);
          if (QA) glMs += perfNow() - g0;
        },
        /** Current dynamic-resolution factor (1 = full), for debugging. */
        get quality() { return quality; },
        /** A world position → logical screen coords, for 2D juice (bursts, floaters) on 3D objects. */
        project(x, y, z) {
          camera.updateMatrixWorld();
          v.set(x, y, z).project(camera);
          return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, visible: v.z < 1 };
        },
        /** An art-kit canvas (GT.material, GT.bake, GT.canvas) as a tiling three.js texture. */
        texture(src, repeatX, repeatY) {
          // WebGL ignores flipY for ImageBitmaps (sprites, in a worker), so they'd come out upside
          // down: upload a canvas copy instead, as before.
          if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
            let copy = bitmapCopies.get(src);
            if (!copy) { copy = offscreen(src.width, src.height); copy.getContext('2d').drawImage(src, 0, 0); bitmapCopies.set(src, copy); }
            src = copy;
          }
          const t = new THREE.CanvasTexture(src);
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(repeatX || 1, repeatY || repeatX || 1);
          t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
          return t;
        },
      };
      return view3d;
    }
    const bitmapCopies = new WeakMap();

    // ---------- ?debug overlay ----------
    let dbgFrames = 0, dbgFps = 0, dbgT = 0;
    // The overlay's numbers as data, for on-device QA (lib/device.ts reads it from the host page):
    // posted to the shell every 500 ms under ?debug, where window.__gtStats() returns the latest.
    let statsN = 0;
    function stats() {
      const g = view3d && view3d.renderer.domElement, r = view3d && view3d.renderer.info.render;
      return {
        // n counts snapshots and `at` stamps this one (page time), so a reader can tell a live
        // snapshot from the last one a stuck or stopped worker left behind.
        n: ++statsN, at: Math.round(pageNow()),
        sdk: SDK_VERSION, phase, fps: dbgFps, w2d: canvas.width, h2d: canvas.height, density, postLite, dpr: DPR || 1,
        three: !!view3d, w3d: g ? g.width : 0, h3d: g ? g.height : 0, quality: view3d ? view3d.quality : 1, resizes: stats3d.resizes,
        calls: r ? r.calls : 0, tris: r ? r.triangles : 0, frames3d: stats3d.frames, lost: stats3d.lost, restored: stats3d.restored,
        gpu: stats3d.gpu, note: stats3d.note, lastError,
      };
    }
    function drawDebug() {
      const now = perfNow();
      dbgFrames++;
      if (now - dbgT >= 1000) { dbgFps = Math.round((dbgFrames * 1000) / (now - dbgT)); dbgFrames = 0; dbgT = now; }
      const lines = ['sdk ' + SDK_VERSION + ' · ' + dbgFps + ' fps · 2D ' + canvas.width + 'x' + canvas.height + (density < 1 ? ' d' + density.toFixed(2) : '') + (postLite ? ' lite-fx' : '') + ' · dpr ' + (DPR || 1) + (env.inthread ? ' · in-thread' : '') + (typeof env.shell === 'string' && env.shell ? ' · shell ' + env.shell : '')];
      if (view3d) {
        const g = view3d.renderer.domElement, r = view3d.renderer.info.render;
        lines.push('3D ' + g.width + 'x' + g.height + ' q' + view3d.quality.toFixed(1) + (stats3d.resizes > 1 ? ' (' + stats3d.resizes + ' resizes)' : '') + ' · ' + r.calls + ' calls · ' + r.triangles + ' tris · ' + stats3d.frames + ' frames');
        lines.push(stats3d.lost ? 'CONTEXT LOST x' + stats3d.lost + ' at ' + stats3d.lostAt.toFixed(1) + 's' + (stats3d.restored ? ' · restored x' + stats3d.restored : '') : 'context ok');
        lines.push('GPU ' + stats3d.gpu);
        if (stats3d.note) lines.push(stats3d.note);
      } else if (game && game.three) {
        lines.push('3D not created yet');
      }
      if (GL_FLAGS.size) lines.push('gl=' + Array.from(GL_FLAGS).join(','));
      if (lastError) lines.push('err: ' + lastError);
      lines.push(audioLine);
      ctx.save();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.font = '600 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(4, 72, W - 8, lines.length * 13 + 6);
      ctx.fillStyle = '#9dff7a';
      lines.forEach((l, i) => {
        let t = l;
        while (t.length > 8 && ctx.measureText(t).width > W - 16) t = t.slice(0, -2);
        ctx.fillText(t === l ? t : t + '…', 8, 75 + i * 13);
      });
      ctx.restore();
    }

    // ---------- bodies ----------
    // GT.bodies(opts): rigid spheres (circles in 2D) by the hundreds or thousands: balls, boulders,
    // marbles, crowds to push through. Plain typed arrays the game reads and writes; a uniform grid
    // broadphase (each body checks its own cell and the forward neighbours, so a pair once).
    // Position-based (as GT.fluid): predict positions, project contacts, solids and walls as
    // position constraints for `iterations` passes, take velocity from the motion, then a velocity
    // pass adds bounce from the pre-solve approach speeds. Piles come to rest instead of jittering.
    // Rolling spin from each body's support contact. Deterministic: fixed loop order, no clocks, no
    // randomness. Drawn with one InstancedMesh (fill3d, plus shadows3d) or batched 2D draws.
    const ballSprites = new Map(); // 2D 'ball' sprites by colour and radius, shared by every round
    const BODIES_MAX = 2000, BODY_SOLIDS_MAX = 64, BODY_IMPACTS = 32, BODY_CELLS = 65536;
    const BODY_KINDS = { sphere: 'sphere', circle: 'sphere', box: 'box', rect: 'box', capsule: 'capsule', segment: 'capsule' };
    function bodies(opts) {
      opts = opts || {};
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      if (opts.dims != null && opts.dims !== 2 && opts.dims !== 3) throw new Error('GT.bodies: dims is 2 or 3 (got ' + opts.dims + ')');
      const dims = opts.dims === 2 ? 2 : 3, D3 = dims === 3;
      const max = opts.max == null ? 600 : opts.max;
      if (!(Number.isInteger(max) && max >= 1 && max <= BODIES_MAX)) throw new Error('GT.bodies: max is a whole number from 1 to ' + BODIES_MAX + ' (got ' + opts.max + ')');

      // Gravity: { x, y, z } in the bodies' frame. A number is 2D's screen-down (+y) gravity.
      const gravity = D3 ? { x: 0, y: -9.8, z: 0 } : { x: 0, y: 900, z: 0 };
      const gIn = opts.gravity;
      if (typeof gIn === 'number') {
        if (D3) throw new Error('GT.bodies: in 3D, gravity is { x, y, z } (y up), e.g. { x: 0, y: -9.8, z: 0 }');
        gravity.y = gIn;
      } else if (gIn && typeof gIn === 'object') {
        gravity.x = num(gIn.x, 0); gravity.y = num(gIn.y, 0); gravity.z = D3 ? num(gIn.z, 0) : 0;
      } else if (gIn != null) throw new Error('GT.bodies: gravity is { x, y' + (D3 ? ', z' : '') + ' }');

      // Bounds: walls per axis, [min, max] (±Infinity for none); 2D also takes fluid's { x, y, w, h }.
      const lo = [-Infinity, -Infinity, -Infinity], hi = [Infinity, Infinity, Infinity];
      const B = opts.bounds;
      if (B != null) {
        if (typeof B !== 'object') throw new Error('GT.bodies: bounds is { x: [min, max], y: [min, max]' + (D3 ? ', z: [min, max]' : '') + ' }');
        if (typeof B.w === 'number' || typeof B.h === 'number') {
          if (!(B.w > 0 && B.h > 0) || typeof B.x !== 'number' || typeof B.y !== 'number') throw new Error('GT.bodies: bounds { x, y, w, h } needs all four, w and h > 0');
          lo[0] = B.x; hi[0] = B.x + B.w; lo[1] = B.y; hi[1] = B.y + B.h;
          if (D3 && B.d > 0 && typeof B.z === 'number') { lo[2] = B.z; hi[2] = B.z + B.d; }
        } else {
          ['x', 'y', 'z'].forEach((ax, k) => {
            const v = B[ax];
            if (v == null) return;
            if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' || !(v[0] < v[1])) throw new Error('GT.bodies: bounds.' + ax + ' is [min, max] with min < max (±Infinity for an open side)');
            if (k === 2 && !D3) return;
            lo[k] = v[0]; hi[k] = v[1];
          });
        }
      }
      const bounce = num(opts.bounce, 0.35), wallBounce = num(opts.wallBounce, 0.4);
      const friction = Math.max(0, num(opts.friction, 0.6)), drag = Math.max(0, num(opts.drag, 0.3));
      // Two passes keep a resting pile's overlap near 1% of a radius; one is enough for a flow.
      const iterations = Math.max(1, Math.min(4, Math.round(num(opts.iterations, 2))));
      const impactMin = Math.max(0, num(opts.impactMin, 0));

      const X = new Float64Array(max), Y = new Float64Array(max), Z = new Float64Array(max);
      const VX = new Float64Array(max), VY = new Float64Array(max), VZ = new Float64Array(max);
      const R = new Float64Array(max), M = new Float64Array(max), GROUP = new Uint8Array(max);
      const NOGRAV = new Uint8Array(max); // add/set({ gravity: false }): a body the game drives (a player)
      const Q = new Float64Array(max * 4), A = new Float64Array(max); // orientation: 3D quaternion, 2D angle
      const WX = new Float64Array(max), WY = new Float64Array(max), WZ = new Float64Array(max); // spin (2D: WZ)
      // This substep's support: the contact normal most against gravity, and the body it rests on (-1: a solid or wall).
      const SD = new Float64Array(max), SNX = new Float64Array(max), SNY = new Float64Array(max), SNZ = new Float64Array(max);
      const SJ = new Int32Array(max);
      const PX = new Float64Array(max), PY = new Float64Array(max), PZ = new Float64Array(max); // positions before the substep
      const UX = new Float64Array(max), UY = new Float64Array(max), UZ = new Float64Array(max); // velocities before the solve
      // The part of this substep's corrections that cleared overlap older than the substep's own
      // motion (a spawn inside another body, a pile's residue): moved, but not turned into speed.
      const FX = new Float64Array(max), FY = new Float64Array(max), FZ = new Float64Array(max);
      // Contacts found in the first pass, for the velocity pass: bodies i, j (-1: a solid or wall),
      // the normal from i towards j (towards the body, for a solid or wall), and the solid.
      const CMAX = max * 8, CI = new Int32Array(CMAX), CJ = new Int32Array(CMAX);
      const CNX = new Float64Array(CMAX), CNY = new Float64Array(CMAX), CNZ = new Float64Array(CMAX), CS = new Array(CMAX).fill(null);
      let nc = 0, recording = false, hsub = STEP, stepDt = STEP;
      // Depenetration cap, in units of sqrt(|g| r): a body pushed out of an overlap leaves at most
      // about as fast as it would from a short fall. Measured: bodies dropped into a crowd left at
      // up to 47 m/s uncapped, 3.5 m/s at 1, and the overlap was gone within ~10 steps.
      const DEPEN = 1;
      const CELL = new Int32Array(max), ITEMS = new Int32Array(max);
      let start = new Int32Array(1025), fill = new Int32Array(1024);
      const solids = [];
      const impacts = [];
      let n = 0;
      // Unit vector against gravity ("up"), for supports, lift and shadows. Recomputed each step.
      let ux = 0, uy = D3 ? 1 : -1, uz = 0, gmag = 0;

      const checkBody = (i, fn) => { if (!(Number.isInteger(i) && i >= 0 && i < n)) throw new Error('GT.bodies ' + fn + ': no body ' + i + ' (there are ' + n + ')'); };
      function write(i, o, fresh) {
        if (o.r != null) { if (!(typeof o.r === 'number' && o.r > 0 && isFinite(o.r))) throw new Error('GT.bodies: r must be a number > 0 (got ' + o.r + ')'); R[i] = o.r; }
        else if (fresh) throw new Error('GT.bodies add: r is required');
        if (o.mass != null) { if (!(typeof o.mass === 'number' && o.mass > 0 && isFinite(o.mass))) throw new Error('GT.bodies: mass must be a finite number > 0 (use a solid for something immovable)'); M[i] = o.mass; }
        else if (fresh || o.r != null) M[i] = D3 ? R[i] * R[i] * R[i] : R[i] * R[i];
        if (o.group != null) GROUP[i] = Math.max(0, Math.min(255, Math.floor(o.group) || 0)); else if (fresh) GROUP[i] = 0;
        if (o.gravity != null) NOGRAV[i] = o.gravity === false ? 1 : 0; else if (fresh) NOGRAV[i] = 0;
        X[i] = num(o.x, fresh ? 0 : X[i]); Y[i] = num(o.y, fresh ? 0 : Y[i]); Z[i] = D3 ? num(o.z, fresh ? 0 : Z[i]) : 0;
        VX[i] = num(o.vx, 0); VY[i] = num(o.vy, 0); VZ[i] = D3 ? num(o.vz, 0) : 0;
        if (fresh) { Q[i * 4] = 0; Q[i * 4 + 1] = 0; Q[i * 4 + 2] = 0; Q[i * 4 + 3] = 1; A[i] = 0; WX[i] = 0; WY[i] = 0; WZ[i] = 0; }
      }
      function copy(from, to) {
        X[to] = X[from]; Y[to] = Y[from]; Z[to] = Z[from]; VX[to] = VX[from]; VY[to] = VY[from]; VZ[to] = VZ[from];
        R[to] = R[from]; M[to] = M[from]; GROUP[to] = GROUP[from]; NOGRAV[to] = NOGRAV[from]; A[to] = A[from];
        WX[to] = WX[from]; WY[to] = WY[from]; WZ[to] = WZ[from];
        for (let k = 0; k < 4; k++) Q[to * 4 + k] = Q[from * 4 + k];
      }

      // The strongest hits this step, at most BODY_IMPACTS, sorted by impulse (largest first).
      function impact(a, bIdx, solid, imp, speed, x, y, z) {
        if (speed < impactMin) return;
        const full = impacts.length >= BODY_IMPACTS;
        if (full && imp <= impacts[impacts.length - 1].impulse) return;
        const e = full ? impacts.pop() : {};
        e.a = a; e.b = bIdx; e.solid = solid; e.impulse = imp; e.speed = speed; e.x = x; e.y = y; e.z = z;
        let k = impacts.length;
        impacts.push(e);
        while (k > 0 && impacts[k - 1].impulse < imp) { impacts[k] = impacts[k - 1]; k--; }
        impacts[k] = e;
      }
      // A contact normal (pointing at body i) as i's support, if it opposes gravity more than the last.
      function support(i, nx, ny, nz, j) {
        const d = nx * ux + ny * uy + nz * uz;
        if (d > 0.5 && d > SD[i]) { SD[i] = d; SNX[i] = nx; SNY[i] = ny; SNZ[i] = nz; SJ[i] = j; }
      }
      function contact(i, j, nx, ny, nz, solid) {
        if (!recording || nc >= CMAX) return;
        CI[nc] = i; CJ[nc] = j; CNX[nc] = nx; CNY[nc] = ny; CNZ[nc] = nz; CS[nc] = solid; nc++;
      }

      function collide() {
        // Grid over the live bodies' box, cell = the largest diameter (grown if it would be huge).
        // Cells are ordered with the axis gravity pulls along as the slowest, and solved from the
        // bottom up, so each layer of a pile rests on one already solved: support climbs a pile in
        // one pass instead of one layer per pass.
        const gs = [gravity.x, gravity.y, D3 ? gravity.z : 0];
        let slow = 1;
        for (let k = 0; k < dims; k++) if (Math.abs(gs[k]) > Math.abs(gs[slow])) slow = k;
        const ax0 = slow === 0 ? 1 : 0, ax1 = D3 ? (slow === 2 ? 1 : 2) : -1; // fast, mid
        const PS = WALL_P, G = gs;
        const P0 = PS[ax0], P1 = D3 ? PS[ax1] : null, P2 = PS[slow];
        let maxR = 0, a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
        for (let i = 0; i < n; i++) {
          if (R[i] > maxR) maxR = R[i];
          if (P0[i] < a0) a0 = P0[i]; if (P0[i] > b0) b0 = P0[i];
          if (P2[i] < a2) a2 = P2[i]; if (P2[i] > b2) b2 = P2[i];
          if (P1) { if (P1[i] < a1) a1 = P1[i]; if (P1[i] > b1) b1 = P1[i]; }
        }
        let cell = maxR * 2, n0 = 0, n1 = 1, n2 = 0;
        // Stragglers (a body flying off through an open side) mustn't stretch the grid until every
        // cell holds a crowd: an axis spanning more cells than its share of the budget is windowed
        // around the bulk (the median of a sample), and bodies beyond go into its edge cells.
        if ((Math.floor((b0 - a0) / cell) + 1) * (P1 ? Math.floor((b1 - a1) / cell) + 1 : 1) * (Math.floor((b2 - a2) / cell) + 1) > BODY_CELLS) {
          const share = Math.floor(Math.pow(BODY_CELLS, 1 / dims));
          const win = (P, a, b) => {
            if (Math.floor((b - a) / cell) + 1 <= share) return [a, b];
            const smp = [];
            for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 64))) smp.push(P[i]);
            smp.sort((p, q) => p - q);
            const mid = smp[smp.length >> 1], half = (share - 1) * cell / 2;
            return [Math.max(a, mid - half), Math.min(b, mid + half)];
          };
          [a0, b0] = win(P0, a0, b0); [a2, b2] = win(P2, a2, b2);
          if (P1) [a1, b1] = win(P1, a1, b1);
        }
        for (;;) {
          n0 = Math.floor((b0 - a0) / cell) + 1; n2 = Math.floor((b2 - a2) / cell) + 1; n1 = P1 ? Math.floor((b1 - a1) / cell) + 1 : 1;
          if (n0 * n1 * n2 <= BODY_CELLS) break;
          cell *= 1.5;
        }
        const cells = n0 * n1 * n2;
        if (start.length < cells + 1) { start = new Int32Array(cells + 1); fill = new Int32Array(cells); }
        start.fill(0, 0, cells + 1);
        const inv = 1 / cell;
        for (let i = 0; i < n; i++) {
          const c0 = Math.max(0, Math.min(n0 - 1, Math.floor((P0[i] - a0) * inv))), c2 = Math.max(0, Math.min(n2 - 1, Math.floor((P2[i] - a2) * inv)));
          const c1 = P1 ? Math.max(0, Math.min(n1 - 1, Math.floor((P1[i] - a1) * inv))) : 0;
          const c = (c2 * n1 + c1) * n0 + c0;
          CELL[i] = c; start[c + 1]++;
        }
        for (let c = 0; c < cells; c++) start[c + 1] += start[c];
        fill.set(start.subarray(0, cells));
        for (let i = 0; i < n; i++) ITEMS[fill[CELL[i]]++] = i;
        // Offsets are (fast, mid, slow) in the grid's own axes: forward in the cell order.
        const offs = D3 ? BODY_OFFS3 : BODY_OFFS2;
        const up = G[slow] <= 0; // gravity pulls toward the low end: solve from low cells up
        for (let it = 0; it < iterations; it++) {
          recording = it === 0;
          for (let u = 0; u < n; u++) {
            const t0 = up ? u : n - 1 - u, i = ITEMS[t0];
            const c = CELL[i], c0 = c % n0, c12 = (c - c0) / n0, c1 = c12 % n1, c2 = (c12 - c1) / n1;
            for (let o = 0; o < offs.length; o += 3) {
              const q0 = c0 + offs[o], q1 = c1 + offs[o + 1], q2 = c2 + offs[o + 2];
              if (q0 < 0 || q0 >= n0 || q1 < 0 || q1 >= n1 || q2 < 0 || q2 >= n2) continue;
              const nc2 = (q2 * n1 + q1) * n0 + q0;
              for (let t = o === 0 ? t0 + 1 : start[nc2], e = start[nc2 + 1]; t < e; t++) pair(i, ITEMS[t]);
            }
          }
          hitSolids();
          walls();
        }
        recording = false;
      }
      function pair(i, j) {
        const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i], rs = R[i] + R[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rs * rs) return;
        let d = Math.sqrt(d2), ex, ey, ez;
        if (d > 1e-9) { ex = dx / d; ey = dy / d; ez = dz / d; }
        else { d = 0; ex = ux; ey = uy; ez = uz; } // coincident: stack j on i
        const pen = rs - d, wi = M[j] / (M[i] + M[j]), wj = 1 - wi;
        X[i] -= ex * pen * wi; Y[i] -= ey * pen * wi; Z[i] -= ez * pen * wi;
        X[j] += ex * pen * wj; Y[j] += ey * pen * wj; Z[j] += ez * pen * wj;
        // What this substep's approach can't explain is old overlap.
        const old = pen - Math.max(0, Math.min(pen, ((UX[i] - UX[j]) * ex + (UY[i] - UY[j]) * ey + (UZ[i] - UZ[j]) * ez) * hsub));
        if (old > 0) {
          FX[i] -= ex * old * wi; FY[i] -= ey * old * wi; FZ[i] -= ez * old * wi;
          FX[j] += ex * old * wj; FY[j] += ey * old * wj; FZ[j] += ez * old * wj;
        }
        support(i, -ex, -ey, -ez, j);
        support(j, ex, ey, ez, i);
        contact(i, j, ex, ey, ez, null);
      }

      // The closest point of a solid to (px, py, pz) into CP; true when the point is inside a box.
      const CP = [0, 0, 0];
      function closest(s, px, py, pz) {
        if (s._kind === 'sphere') { CP[0] = num(s.x, 0); CP[1] = num(s.y, 0); CP[2] = D3 ? num(s.z, 0) : 0; return false; }
        if (s._kind === 'box') {
          const bx = num(s.x, 0), by = num(s.y, 0), bz = D3 ? num(s.z, 0) : 0, bw = num(s.w, 0), bh = num(s.h, 0), bd = D3 ? num(s.d, 0) : 0;
          CP[0] = Math.max(bx, Math.min(bx + bw, px)); CP[1] = Math.max(by, Math.min(by + bh, py)); CP[2] = D3 ? Math.max(bz, Math.min(bz + bd, pz)) : 0;
          return px > bx && px < bx + bw && py > by && py < by + bh && (!D3 || (pz > bz && pz < bz + bd));
        }
        const ax = num(s.x1, 0), ay = num(s.y1, 0), az = D3 ? num(s.z1, 0) : 0;
        const sx = num(s.x2, 0) - ax, sy = num(s.y2, 0) - ay, sz = D3 ? num(s.z2, 0) - az : 0;
        const l2 = sx * sx + sy * sy + sz * sz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy + (pz - az) * sz) / l2)) : 0;
        CP[0] = ax + sx * t; CP[1] = ay + sy * t; CP[2] = az + sz * t;
        return false;
      }
      function hitSolids() {
        for (const s of solids) {
          if (s.on === false) continue;
          const sr = s._kind === 'box' ? 0 : Math.max(0, num(s.r, 0));
          // Broad test: the solid's box grown by its radius (and each body's).
          let bx0, by0, bz0, bx1, by1, bz1;
          if (s._kind === 'sphere') { bx0 = bx1 = num(s.x, 0); by0 = by1 = num(s.y, 0); bz0 = bz1 = D3 ? num(s.z, 0) : 0; }
          else if (s._kind === 'box') { bx0 = num(s.x, 0); by0 = num(s.y, 0); bz0 = D3 ? num(s.z, 0) : 0; bx1 = bx0 + num(s.w, 0); by1 = by0 + num(s.h, 0); bz1 = bz0 + (D3 ? num(s.d, 0) : 0); }
          else {
            bx0 = Math.min(num(s.x1, 0), num(s.x2, 0)); bx1 = Math.max(num(s.x1, 0), num(s.x2, 0));
            by0 = Math.min(num(s.y1, 0), num(s.y2, 0)); by1 = Math.max(num(s.y1, 0), num(s.y2, 0));
            bz0 = D3 ? Math.min(num(s.z1, 0), num(s.z2, 0)) : 0; bz1 = D3 ? Math.max(num(s.z1, 0), num(s.z2, 0)) : 0;
          }
          bx0 -= sr; by0 -= sr; bz0 -= sr; bx1 += sr; by1 += sr; bz1 += sr;
          for (let i = 0; i < n; i++) {
            const r = R[i];
            if (X[i] < bx0 - r || X[i] > bx1 + r || Y[i] < by0 - r || Y[i] > by1 + r || Z[i] < bz0 - r || Z[i] > bz1 + r) continue;
            const inside = closest(s, X[i], Y[i], Z[i]);
            let ex = X[i] - CP[0], ey = Y[i] - CP[1], ez = Z[i] - CP[2], d = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const reach = r + sr;
            if (!inside && d >= reach) continue;
            let push;
            if (inside) {
              // Centre inside a box: out through the nearest face.
              const bx = num(s.x, 0), by = num(s.y, 0), bz = D3 ? num(s.z, 0) : 0;
              const f = [X[i] - bx, bx + num(s.w, 0) - X[i], Y[i] - by, by + num(s.h, 0) - Y[i]];
              if (D3) f.push(Z[i] - bz, bz + num(s.d, 0) - Z[i]);
              let k = 0;
              for (let q = 1; q < f.length; q++) if (f[q] < f[k]) k = q;
              ex = ey = ez = 0;
              if (k === 0) ex = -1; else if (k === 1) ex = 1; else if (k === 2) ey = -1; else if (k === 3) ey = 1; else if (k === 4) ez = -1; else ez = 1;
              push = f[k] + r;
            } else if (d > 1e-9) { ex /= d; ey /= d; ez /= d; push = reach - d; }
            else { ex = ux; ey = uy; ez = uz; push = reach; }
            X[i] += ex * push; Y[i] += ey * push; Z[i] += ez * push;
            const old = push - Math.max(0, Math.min(push, -(UX[i] * ex + UY[i] * ey + UZ[i] * ez) * hsub));
            if (old > 0) { FX[i] += ex * old; FY[i] += ey * old; FZ[i] += ez * old; }
            support(i, ex, ey, ez, -1);
            contact(i, -1, ex, ey, ez, s);
          }
        }
      }
      const WALL_P = [X, Y, Z], WALL_U = [UX, UY, UZ], WALL_F = [FX, FY, FZ];
      function walls() {
        for (let k = 0; k < dims; k++) {
          const l = lo[k], h = hi[k];
          if (l === -Infinity && h === Infinity) continue;
          const p = WALL_P[k];
          for (let i = 0; i < n; i++) {
            const r = R[i];
            let side = 0, pen = 0;
            if (p[i] - r < l) { pen = l + r - p[i]; p[i] = l + r; side = 1; }
            else if (p[i] + r > h) { pen = p[i] + r - h; p[i] = h - r; side = -1; }
            if (!side) continue;
            const old = pen - Math.max(0, Math.min(pen, -WALL_U[k][i] * side * hsub));
            if (old > 0) WALL_F[k][i] += side * old;
            const nx = k === 0 ? side : 0, ny = k === 1 ? side : 0, nz = k === 2 ? side : 0;
            support(i, nx, ny, nz, -1);
            contact(i, -1, nx, ny, nz, null);
          }
        }
      }
      // After the solve: velocity from the motion, then bounce, lift and wall friction from the
      // approach speeds before the solve (UX…), and this substep's impacts.
      function velocities(h) {
        // Slower than `rest` is resting, not a bounce (per step, so a fast body's substeps don't
        // change it for the whole pile); hits reported in impacts must be clearly faster.
        const inv = 1 / h, rest = 3 * gmag * stepDt, hit = Math.max(impactMin, 2 * rest), roll = Math.max(0, 1 - friction * h);
        // Velocity = the pre-solve velocity plus what the solve's corrections add, capped: pushing a
        // body out of an overlap (a spawn inside another, a pile settling) must not launch it. Real
        // collisions are the velocity pass's job below, from the approach speeds.
        // Velocity from the motion, except the old-overlap part (FX…), which counts only up to `cap`:
        // collisions this substep stop bodies as position-based dynamics does, but a body pushed
        // out of an overlap it started in is eased out, not launched.
        for (let i = 0; i < n; i++) {
          const fx = FX[i] * inv, fy = FY[i] * inv, fz = FZ[i] * inv, f = Math.sqrt(fx * fx + fy * fy + fz * fz);
          VX[i] = (X[i] - PX[i]) * inv; VY[i] = (Y[i] - PY[i]) * inv; VZ[i] = (Z[i] - PZ[i]) * inv;
          if (f < 1e-12) continue;
          // The old-overlap push brings the body up to `cap` along it (never adding to a body already
          // moving away that fast), so a lasting overlap can't pump speed in step after step.
          const along = (UX[i] * fx + UY[i] * fy + UZ[i] * fz) / f, cap = DEPEN * Math.sqrt(gmag * R[i]);
          const kept = Math.max(0, Math.min(f, cap - Math.max(0, along))), k = (f - kept) / f;
          VX[i] -= fx * k; VY[i] -= fy * k; VZ[i] -= fz * k;
        }
        for (let c = 0; c < nc; c++) {
          const i = CI[c], j = CJ[c], nx = CNX[c], ny = CNY[c], nz = CNZ[c];
          if (j >= 0) {
            const pre = (UX[j] - UX[i]) * nx + (UY[j] - UY[i]) * ny + (UZ[j] - UZ[i]) * nz;
            if (pre >= 0) continue;
            const now = (VX[j] - VX[i]) * nx + (VY[j] - VY[i]) * ny + (VZ[j] - VZ[i]) * nz;
            const want = -pre > rest ? -bounce * pre : 0;
            const iw = 1 / M[i] + 1 / M[j];
            if (now < want) {
              const k = (want - now) / iw;
              VX[i] -= nx * k / M[i]; VY[i] -= ny * k / M[i]; VZ[i] -= nz * k / M[i];
              VX[j] += nx * k / M[j]; VY[j] += ny * k / M[j]; VZ[j] += nz * k / M[j];
            }
            if (-pre > hit) impact(i, j, null, (1 + bounce) * -pre / iw, -pre, X[i] + nx * R[i], Y[i] + ny * R[i], Z[i] + nz * R[i]);
          } else {
            // A solid or a wall; the normal points at the body.
            const s = CS[c], pre = UX[i] * nx + UY[i] * ny + UZ[i] * nz;
            { // rolling resistance along a wall or solid
              const rk = s && s.friction != null ? Math.max(0, 1 - Math.max(0, num(s.friction, friction)) * h) : roll;
              const vn = VX[i] * nx + VY[i] * ny + VZ[i] * nz;
              VX[i] = (VX[i] - nx * vn) * rk + nx * vn; VY[i] = (VY[i] - ny * vn) * rk + ny * vn; VZ[i] = (VZ[i] - nz * vn) * rk + nz * vn;
            }
            if (pre >= 0) continue;
            const e = s ? num(s.bounce, wallBounce) : wallBounce;
            const now = VX[i] * nx + VY[i] * ny + VZ[i] * nz, want = -pre > rest ? -e * pre : 0;
            if (now < want) { const k = want - now; VX[i] += nx * k; VY[i] += ny * k; VZ[i] += nz * k; }
            // Lift: a hard side-on hit throws the body up and over (balls hopping off rocks): its
            // speed off the floor (+y in 3D, up the screen in 2D, whatever way gravity is tilted)
            // becomes at least lift × the impact speed, so repeated hits don't stack.
            const lift = s ? Math.max(0, Math.min(1, num(s.lift, 0))) : 0;
            if (lift > 0 && -pre > 2 * Math.sqrt(gmag * R[i])) {
              const up = lift * -pre * (1 - Math.abs(ny));
              if (D3) VY[i] = Math.max(VY[i], up); else VY[i] = Math.min(VY[i], -up);
            }
            if (-pre > hit) impact(i, -1, s, (1 + e) * -pre * M[i], -pre, X[i] - nx * R[i], Y[i] - ny * R[i], Z[i] - nz * R[i]);
          }
        }
      }
      function spin(dt) {
        for (let i = 0; i < n; i++) {
          const r = R[i];
          if (SD[i] > 0.5) {
            // Rolling without slipping on the support: w = n × (v − v_support) / r.
            const j = SJ[i], rx = VX[i] - (j >= 0 ? VX[j] : 0), ry = VY[i] - (j >= 0 ? VY[j] : 0), rz = VZ[i] - (j >= 0 ? VZ[j] : 0);
            const nx = SNX[i], ny = SNY[i], nz = SNZ[i];
            WX[i] = (ny * rz - nz * ry) / r; WY[i] = (nz * rx - nx * rz) / r; WZ[i] = (nx * ry - ny * rx) / r;
          }
          if (!D3) { A[i] += WZ[i] * dt; continue; }
          const ax = WX[i] * dt, ay = WY[i] * dt, az = WZ[i] * dt, ang = Math.sqrt(ax * ax + ay * ay + az * az);
          if (ang < 1e-9) continue;
          const sa = Math.sin(ang / 2) / ang, bx = ax * sa, by = ay * sa, bz = az * sa, bw = Math.cos(ang / 2);
          const o = i * 4, x = Q[o], y = Q[o + 1], z = Q[o + 2], w = Q[o + 3];
          const qx = bw * x + bx * w + by * z - bz * y, qy = bw * y - bx * z + by * w + bz * x;
          const qz = bw * z + bx * y - by * x + bz * w, qw = bw * w - bx * x - by * y - bz * z;
          const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
          Q[o] = qx * l; Q[o + 1] = qy * l; Q[o + 2] = qz * l; Q[o + 3] = qw * l;
        }
      }

      // Drawing helpers.
      const colorCache = new Map();
      function groupColors(colors) {
        // By value, so a palette edited for a flash is seen; a few dozen entries at most.
        const key = Array.isArray(colors) ? colors.join('|') : JSON.stringify(colors);
        let c = colorCache.get(key);
        if (!c) {
          if (colorCache.size > 64) colorCache.clear();
          const T = self.THREE, col = new T.Color();
          c = new Float32Array(256 * 3).fill(1);
          const list = Array.isArray(colors) ? colors.map((v, k) => [k, v]) : Object.entries(colors);
          for (const [k, v] of list) { const g = Number(k); if (g >= 0 && g < 256) { col.set(v); c[g * 3] = col.r; c[g * 3 + 1] = col.g; c[g * 3 + 2] = col.b; } }
          colorCache.set(key, c);
        }
        return c;
      }
      function frameOf(f) {
        if (f == null) return null;
        const e = f.elements || f;
        if (!e || e.length !== 16) throw new Error('GT.bodies: frame is a THREE.Matrix4 or 16 numbers (column-major)');
        return e;
      }
      // out = F · L (column-major 4×4), L given by its columns: c0, c1, c2 (3 each) and translation t.
      function put(out, o, F, c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z, tx, ty, tz) {
        if (!F) {
          out[o] = c0x; out[o + 1] = c0y; out[o + 2] = c0z; out[o + 3] = 0;
          out[o + 4] = c1x; out[o + 5] = c1y; out[o + 6] = c1z; out[o + 7] = 0;
          out[o + 8] = c2x; out[o + 9] = c2y; out[o + 10] = c2z; out[o + 11] = 0;
          out[o + 12] = tx; out[o + 13] = ty; out[o + 14] = tz; out[o + 15] = 1;
          return;
        }
        const m = (x, y, z, w, r) => F[r] * x + F[4 + r] * y + F[8 + r] * z + F[12 + r] * w;
        for (let r = 0; r < 3; r++) {
          out[o + r] = m(c0x, c0y, c0z, 0, r); out[o + 4 + r] = m(c1x, c1y, c1z, 0, r);
          out[o + 8 + r] = m(c2x, c2y, c2z, 0, r); out[o + 12 + r] = m(tx, ty, tz, 1, r);
        }
        out[o + 3] = 0; out[o + 7] = 0; out[o + 11] = 0; out[o + 15] = 1;
      }
      // The mesh should hold every body drawn (the ones not skipped). Too small is a bug QA fails;
      // in play it draws what fits rather than crash a round that outgrew it after the gate.
      function checkMesh(mesh, fn, skip) {
        if (!mesh || !mesh.isInstancedMesh) throw new Error('GT.bodies ' + fn + ': needs a THREE.InstancedMesh');
        const room = mesh.instanceMatrix.count;
        if (!QA) return room;
        let drawn = n;
        if (skip) for (let i = 0; i < n; i++) if (skip[GROUP[i]]) drawn--;
        if (room < drawn) throw new Error('GT.bodies ' + fn + ': the mesh holds ' + room + ' instances but ' + drawn + ' bodies are drawn: make it with max (' + max + ')');
        return room;
      }
      // skip: a group or a list of groups left out of fill3d/shadows3d (a player drawn on its own).
      const skipCache = new Map();
      function skipOf(v) {
        if (v == null) return null;
        const key = Array.isArray(v) ? v.join(',') : String(v);
        let t = skipCache.get(key);
        if (!t) { t = new Uint8Array(256); for (const g of [].concat(v)) if (g >= 0 && g < 256) t[g | 0] = 1; skipCache.set(key, t); }
        return t;
      }

      const api = {
        dims, max, gravity, solids, impacts,
        get n() { return n; },
        get speed() {
          if (!n) return 0;
          let t = 0;
          for (let i = 0; i < n; i++) t += Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i] + VZ[i] * VZ[i]);
          return t / n;
        },
        x: X, y: Y, z: Z, vx: VX, vy: VY, vz: VZ, r: R, m: M, group: GROUP, q: Q, a: A,
        /** The new body's index, or -1 when the world is full (recycle bodies with set). */
        add(o) {
          if (n >= max) return -1;
          write(n, o || {}, true);
          return n++;
        },
        set(i, o) { checkBody(i, 'set'); write(i, o || {}, false); return i; },
        remove(x) {
          if (typeof x === 'number') {
            checkBody(x, 'remove');
            if (x !== n - 1) copy(n - 1, x);
            n--;
            return;
          }
          const k = solids.indexOf(x);
          if (k < 0) throw new Error('GT.bodies remove: pass a body index or a solid from b.solid()');
          solids.splice(k, 1);
        },
        solid(s) {
          if (!s || typeof s !== 'object') throw new Error('GT.bodies solid: pass { kind, … }');
          const kind = BODY_KINDS[s.kind];
          if (!kind) throw new Error('GT.bodies solid: kind is ' + (D3 ? "'sphere', 'box' or 'capsule'" : "'circle', 'rect' or 'segment'") + ' (got ' + s.kind + ')');
          if (solids.length >= BODY_SOLIDS_MAX) throw new Error('GT.bodies solid: at most ' + BODY_SOLIDS_MAX + ' solids');
          if (kind !== 'box' && !(s.r > 0)) throw new Error('GT.bodies solid: a ' + s.kind + ' needs r > 0');
          if (kind === 'box' && !(s.w > 0 && s.h > 0 && (!D3 || s.d > 0))) throw new Error('GT.bodies solid: a ' + s.kind + ' needs w, h' + (D3 ? ', d' : '') + ' > 0 (x, y' + (D3 ? ', z' : '') + ' is its min corner)');
          Object.defineProperty(s, '_kind', { value: kind, enumerable: false, writable: true });
          solids.push(s);
          return s;
        },
        step(dt) {
          dt = Math.max(0, Math.min(0.05, num(dt, STEP)));
          stepDt = dt;
          impacts.length = 0;
          if (!n || dt <= 0) return;
          gmag = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + (D3 ? gravity.z * gravity.z : 0));
          if (gmag > 0) { ux = -gravity.x / gmag; uy = -gravity.y / gmag; uz = D3 ? -gravity.z / gmag : 0; }
          const gx = gravity.x, gy = gravity.y, gz = D3 ? gravity.z : 0;
          // No body may move more than its own radius per substep (no tunnelling: a contact zone is
          // wider than that): fast steps are split into up to 4 substeps, and each body's speed is
          // capped at what 4 substeps carry, 4 r / dt. Bodies too small to be overtaken never hold
          // back big fast ones.
          let worst = 0;
          for (let i = 0; i < n; i++) {
            const vx = VX[i] + gx * dt, vy = VY[i] + gy * dt, vz = VZ[i] + gz * dt;
            const m = (Math.sqrt(vx * vx + vy * vy + vz * vz) * dt) / R[i];
            if (m > worst) worst = m;
          }
          const subs = Math.max(1, Math.min(4, Math.ceil(worst))), h = dt / subs, keep = Math.max(0, 1 - drag * h);
          for (let sub = 0; sub < subs; sub++) {
            for (let i = 0; i < n; i++) {
              const gk = NOGRAV[i] ? 0 : h;
              let vx = (VX[i] + gx * gk) * keep, vy = (VY[i] + gy * gk) * keep, vz = (VZ[i] + gz * gk) * keep;
              const v2 = vx * vx + vy * vy + vz * vz, vmax = R[i] / h;
              if (v2 > vmax * vmax) { const k = vmax / Math.sqrt(v2); vx *= k; vy *= k; vz *= k; }
              UX[i] = vx; UY[i] = vy; UZ[i] = vz;
              PX[i] = X[i]; PY[i] = Y[i]; PZ[i] = Z[i];
              X[i] += vx * h; Y[i] += vy * h; Z[i] += vz * h;
              SD[i] = 0; SJ[i] = -1; FX[i] = 0; FY[i] = 0; FZ[i] = 0;
            }
            nc = 0; hsub = h;
            collide();
            velocities(h);
            spin(h);
          }
        },
        touching(i) {
          checkBody(i, 'touching');
          const out = [];
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i], rs = (R[i] + R[j]) * 1.01;
            if (dx * dx + dy * dy + dz * dz < rs * rs) out.push(j);
          }
          return out;
        },
        // 3D: near(x, y, z, r). 2D: near(x, y, r), or the 3D form with z ignored.
        near(...args) {
          const [px, py, pz, r] = D3 || args.length >= 4 ? [args[0], args[1], D3 ? args[2] : 0, args[3]] : [args[0], args[1], 0, args[2]];
          const out = [];
          for (let j = 0; j < n; j++) {
            const dx = X[j] - px, dy = Y[j] - py, dz = Z[j] - pz, rr = r + R[j];
            if (dx * dx + dy * dy + dz * dz < rr * rr) out.push(j);
          }
          return out;
        },
        blast(...args) {
          const [px, py, pz, r, strength] = D3 || args.length >= 5 ? [args[0], args[1], D3 ? args[2] : 0, args[3], args[4]] : [args[0], args[1], 0, args[2], args[3]];
          if (!(r > 0)) return 0;
          let hit = 0;
          for (let j = 0; j < n; j++) {
            const dx = X[j] - px, dy = Y[j] - py, dz = Z[j] - pz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d >= r) continue;
            const k = num(strength, 0) * (1 - d / r);
            if (d > 1e-9) { VX[j] += (dx / d) * k; VY[j] += (dy / d) * k; VZ[j] += (dz / d) * k; }
            else { VX[j] += ux * k; VY[j] += uy * k; VZ[j] += uz * k; }
            hit++;
          }
          return hit;
        },
        fill3d(mesh, o) {
          o = o || {};
          const skip = skipOf(o.skip), room = checkMesh(mesh, 'fill3d', skip);
          if (o.colors && !self.THREE) throw new Error('GT.bodies fill3d: needs three: true in GT.game');
          const F = frameOf(o.frame), sc = num(o.scale, 1), out = mesh.instanceMatrix.array;
          let k = 0;
          for (let i = 0; i < n && k < room; i++) {
            if (skip && skip[GROUP[i]]) continue;
            const s = R[i] * sc;
            let x, y, z, w;
            if (D3) { x = Q[i * 4]; y = Q[i * 4 + 1]; z = Q[i * 4 + 2]; w = Q[i * 4 + 3]; }
            else { x = 0; y = 0; z = Math.sin(A[i] / 2); w = Math.cos(A[i] / 2); }
            put(out, k++ * 16, F,
              (1 - 2 * (y * y + z * z)) * s, 2 * (x * y + w * z) * s, 2 * (x * z - w * y) * s,
              2 * (x * y - w * z) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z + w * x) * s,
              2 * (x * z + w * y) * s, 2 * (y * z - w * x) * s, (1 - 2 * (x * x + y * y)) * s,
              X[i], Y[i], Z[i]);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (o.colors) {
            const pal = groupColors(o.colors);
            if (!mesh.instanceColor) mesh.setColorAt(0, new self.THREE.Color(1, 1, 1));
            const c = mesh.instanceColor.array;
            let k2 = 0;
            for (let i = 0; i < n && k2 < k; i++) {
              if (skip && skip[GROUP[i]]) continue;
              const g = GROUP[i] * 3, o3 = k2++ * 3;
              c[o3] = pal[g]; c[o3 + 1] = pal[g + 1]; c[o3 + 2] = pal[g + 2];
            }
            mesh.instanceColor.needsUpdate = true;
          }
          mesh.count = k;
        },
        shadows3d(mesh, o) {
          o = o || {};
          const skip = skipOf(o.skip), room = checkMesh(mesh, 'shadows3d', skip);
          if (lo[1] === -Infinity) throw new Error('GT.bodies shadows3d: needs a floor, bounds.y[0]');
          const F = frameOf(o.frame), size = num(o.size, 2.2), lift = num(o.lift, 0.02), fade = num(o.fade, 0.5);
          const floor = lo[1], out = mesh.instanceMatrix.array;
          let k = 0;
          for (let i = 0; i < n && k < room; i++) {
            if (skip && skip[GROUP[i]]) continue;
            const h = Math.max(0, Y[i] - R[i] - floor), s = (size * R[i]) / (1 + h * fade);
            // A PlaneGeometry (XY) laid flat on the floor: x stays, y → −z, z → +y.
            put(out, k++ * 16, F, s, 0, 0, 0, 0, -s, 0, 1, 0, X[i], floor + lift, Z[i]);
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.count = k;
        },
        draw(ctx, o) {
          o = o || {};
          const colors = o.colors || ['#ffffff'];
          const colorOf = (g) => (Array.isArray(colors) ? colors[g % colors.length] : colors[g] || '#ffffff');
          if (o.style === 'flat') {
            // One path per group: a fill per colour, not per body.
            const seen = new Set();
            for (let i = 0; i < n; i++) seen.add(GROUP[i]);
            for (const g of [...seen].sort((p, q) => p - q)) {
              ctx.fillStyle = colorOf(g);
              ctx.beginPath();
              for (let i = 0; i < n; i++) if (GROUP[i] === g) { ctx.moveTo(X[i] + R[i], Y[i]); ctx.arc(X[i], Y[i], R[i], 0, Math.PI * 2); }
              ctx.fill();
            }
            return;
          }
          // 'ball': a shaded sphere per body from sprites baked once per colour and radius.
          for (let i = 0; i < n; i++) {
            const col = colorOf(GROUP[i]), rb = Math.max(2, Math.round(R[i]));
            const key = col + '|' + rb;
            let spr = ballSprites.get(key);
            if (!spr) {
              const px = Math.ceil(rb * 3) * 2 + 4;
              spr = offscreen(px, px);
              ball(spr.getContext('2d'), px / 2, px / 2, rb * 3, col);
              ballSprites.set(key, spr);
            }
            const r = R[i], e = r * (spr.width / (rb * 6));
            ctx.drawImage(spr, X[i] - e, Y[i] - e, e * 2, e * 2);
          }
        },
      };
      return api;
    }
    // Forward neighbour cells (dx, dy, dz), the cell itself first: each pair of cells is visited once.
    const BODY_OFFS2 = [0, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 1, 1, 0, 1]; // 2D: (fast, -, slow)
    const BODY_OFFS3 = (() => {
      const o = [0, 0, 0];
      for (let dz = 0; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && (dy < 0 || (dy === 0 && dx <= 0))) continue;
        o.push(dx, dy, dz);
      }
      return o;
    })();

    // ---------- fluids ----------
    // GT.fluid(opts): a particle liquid, double density relaxation (Clavet, Beaudoin & Poulin 2005).
    // GT.waves(opts): a spring-column height field for water surfaces, a 1D strip or a 2D grid.
    // Both are deterministic: fixed iteration order, no clocks, randomness only from `rand`
    // (default GT.rand, the round's stream), so a seeded round replays exactly.
    //
    // Per substep (1/120 s at the default 2 substeps), in this order:
    //   1 emitters · 2 gravity, bulk drag, speed clamp · 3 viscosity (pairwise) · 4 predict (prev = x;
    //   x += v dt) · 5 density relaxation (Gauss-Seidel, index order) · 6 collisions (solids, bounds,
    //   bodies) · 7 v = (x - prev) / dt, with the normal part killed / reflected at contacts.
    // Neighbours come from a uniform grid (cell = h) rebuilt by counting sort into typed arrays
    // before steps 3 and 5. Particle data is struct-of-arrays sized to `max` once; removal is
    // swap-with-last.
    const FLUID = {
      radius: 12, gravity: 900, max: 600, substeps: 2, viscosity: 0.15, bounce: 0, friction: 0.05,
      // Tuned for h = 12 at 1/120 s (see the defaults' notes in fluid()). Stiffnesses are physical
      // (px/s² per unit density); dt² is folded in at construction, so substeps don't retune them.
      restDensity: 1.35, stiffness: 14400, nearStiffness: 36000,
      pad: 0.3,       // a particle's collision radius, as a fraction of h
      impact: 220,    // px/s into a surface that counts as a hard hit (f.impacts)
    };
    const shapeHas = (s, x, y) => (s.r != null
      ? (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) <= s.r * s.r
      : x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
    // A stable hash of a particle id to [0, 1): per-particle 3D depth jitter that survives compaction.
    function hash01(n) {
      n = Math.imul(n ^ (n >>> 16), 0x7feb352d); n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    }

    function fluid(opts) {
      opts = opts || {};
      const B = opts.bounds;
      if (!B || !(B.w > 0) || !(B.h > 0)) throw new Error('GT.fluid needs bounds: { x, y, w, h }');
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      const h = num(opts.radius, 0) > 0 ? opts.radius : FLUID.radius, h2 = h * h, invH = 1 / h;
      const max = Math.max(1, Math.floor(num(opts.max, FLUID.max)));
      const substeps = Math.max(1, Math.round(num(opts.substeps, FLUID.substeps)));
      const dt = STEP / substeps, invDt = 1 / dt, dt2 = dt * dt;
      const rho0 = num(opts.restDensity, FLUID.restDensity);
      const K = num(opts.stiffness, FLUID.stiffness) * dt2, KN = num(opts.nearStiffness, FLUID.nearStiffness) * dt2;
      const visc = Math.max(0, Math.min(1, num(opts.viscosity, FLUID.viscosity)));
      // viscosity 0..1 maps to three effects:
      // - Clavet's radial impulses between approaching neighbours: linear (sigma, 1/s) and quadratic
      //   (beta, 1/px). The linear floor (10/s) damps the jitter a resting pool would otherwise keep.
      // - shear: symmetric velocity smoothing between neighbours (XSPH-style), ∝ viscosity².
      // - drag: velocity damping inside the bulk (density > 0.6 rest), ∝ viscosity³. Explicit
      //   viscosity spreads a layer per substep, far too slowly to make a pool slump like honey;
      //   this does, while free drops and spray (low density) still fall freely. At water's 0.15
      //   it is ~0.0002 per substep: nothing.
      const sigma = 10 + 135 * visc, beta = 0.3 * visc, shear = 0.5 * visc * visc, drag = 0.06 * visc * visc * visc;
      const bounce = num(opts.bounce, FLUID.bounce), friction = num(opts.friction, FLUID.friction);
      const pad = h * num(opts.pad, FLUID.pad), impactSpeed = num(opts.impact, FLUID.impact);
      const maxMove = 0.45 * h, maxMove2 = maxMove * maxMove, maxV = maxMove * invDt;
      const rnd = typeof opts.rand === 'function' ? opts.rand : () => rand();
      const kills = [].concat(opts.kill || []);
      const killL = kills.includes('left'), killR = kills.includes('right'), killT = kills.includes('top'), killB = kills.includes('bottom');
      const grav = opts.gravity;
      const g = grav && typeof grav === 'object' ? { x: num(grav.x, 0), y: num(grav.y, 0) } : { x: 0, y: num(grav, FLUID.gravity) };
      const bx0 = B.x, by0 = B.y, bx1 = B.x + B.w, by1 = B.y + B.h;

      // particle storage
      const X = new Float32Array(max), Y = new Float32Array(max), VX = new Float32Array(max), VY = new Float32Array(max);
      const PX = new Float32Array(max), PY = new Float32Array(max);
      const G = new Uint8Array(max), ID = new Uint32Array(max);
      const HIT = new Uint8Array(max), HNX = new Float32Array(max), HNY = new Float32Array(max);
      const HB = new Float32Array(max), HF = new Float32Array(max), DEAD = new Uint8Array(max), RHO = new Float32Array(max);
      const HS = new Array(max).fill(null); // the solid a particle last touched this substep (null: bounds)
      let nextId = 1;
      // neighbour grid, padded one cell around the bounds
      const gx0 = bx0 - h, gy0 = by0 - h, gw = Math.ceil(B.w * invH) + 3, gh = Math.ceil(B.h * invH) + 3;
      const cellStart = new Int32Array(gw * gh + 1), cursor = new Int32Array(gw * gh);
      const cellOf = new Int32Array(max), sorted = new Int32Array(max);
      const NB = 96; // neighbours kept per particle in relaxation (more only happens when crushed)
      const nbJ = new Int32Array(NB), nbQ = new Float32Array(NB), nbX = new Float32Array(NB), nbY = new Float32Array(NB);
      const activeSolids = [];

      const f = {
        bounds: B, radius: h, max, n: 0, substeps,
        x: X, y: Y, vx: VX, vy: VY, group: G, id: ID,
        gravity: g, solids: [], emitters: [], bodies: [], impacts: [], speed: 0,
      };

      function add(x, y, vx, vy, group) {
        if (f.n >= max) return false;
        const i = f.n++;
        X[i] = PX[i] = x; Y[i] = PY[i] = y; VX[i] = vx; VY[i] = vy; G[i] = group; ID[i] = nextId++; RHO[i] = 0;
        return true;
      }
      function removeAt(i) {
        const l = --f.n;
        if (i !== l) {
          X[i] = X[l]; Y[i] = Y[l]; VX[i] = VX[l]; VY[i] = VY[l]; PX[i] = PX[l]; PY[i] = PY[l];
          G[i] = G[l]; ID[i] = ID[l]; RHO[i] = RHO[l]; HIT[i] = HIT[l]; HNX[i] = HNX[l]; HNY[i] = HNY[l]; HB[i] = HB[l]; HF[i] = HF[l]; HS[i] = HS[l];
        }
      }

      function buildGrid() {
        const n = f.n;
        cellStart.fill(0);
        for (let i = 0; i < n; i++) {
          let cx = Math.floor((X[i] - gx0) * invH), cy = Math.floor((Y[i] - gy0) * invH);
          cx = cx < 0 ? 0 : cx >= gw ? gw - 1 : cx; cy = cy < 0 ? 0 : cy >= gh ? gh - 1 : cy;
          const c = cy * gw + cx;
          cellOf[i] = c; cellStart[c + 1]++;
        }
        for (let c = 0; c < gw * gh; c++) { cellStart[c + 1] += cellStart[c]; cursor[c] = cellStart[c]; }
        for (let i = 0; i < n; i++) sorted[cursor[cellOf[i]]++] = i;
      }

      // Viscosity: radial impulses between approaching pairs, then shear smoothing (j > i), applied
      // immediately.
      function viscosity() {
        const n = f.n;
        for (let i = 0; i < n; i++) {
          const c = cellOf[i], cx = c % gw, cy = (c - cx) / gw, xi = X[i], yi = Y[i];
          for (let oy = -1; oy <= 1; oy++) {
            const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
              const cc = yy * gw + xx;
              for (let k = cellStart[cc], e = cellStart[cc + 1]; k < e; k++) {
                const j = sorted[k];
                if (j <= i) continue;
                const dx = X[j] - xi, dy = Y[j] - yi, r2 = dx * dx + dy * dy;
                if (r2 >= h2 || r2 < 1e-12) continue;
                const r = Math.sqrt(r2), ux = dx / r, uy = dy / r, q = 1 - r * invH;
                const u = (VX[i] - VX[j]) * ux + (VY[i] - VY[j]) * uy;
                if (u > 0) {
                  let I = dt * q * (sigma * u + beta * u * u);
                  if (I > u) I = u; // never reverse the pair's approach
                  I *= 0.5;
                  VX[i] -= I * ux; VY[i] -= I * uy; VX[j] += I * ux; VY[j] += I * uy;
                }
                if (shear > 0) {
                  const sk = shear * q * 0.5, sx = (VX[j] - VX[i]) * sk, sy = (VY[j] - VY[i]) * sk;
                  VX[i] += sx; VY[i] += sy; VX[j] -= sx; VY[j] -= sy;
                }
              }
            }
          }
        }
      }

      // Double density relaxation, sequential over particles in index order.
      function relax() {
        const n = f.n;
        for (let i = 0; i < n; i++) {
          const c = cellOf[i], cx = c % gw, cy = (c - cx) / gw, xi = X[i], yi = Y[i];
          let rho = 0, rhoN = 0, m = 0;
          RHO[i] = 0;
          for (let oy = -1; oy <= 1; oy++) {
            const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
              const cc = yy * gw + xx;
              for (let k = cellStart[cc], e = cellStart[cc + 1]; k < e && m < NB; k++) {
                const j = sorted[k];
                if (j === i) continue;
                let dx = X[j] - xi, dy = Y[j] - yi;
                const r2 = dx * dx + dy * dy;
                if (r2 >= h2) continue;
                let r;
                if (r2 < 1e-8) { dx = j > i ? 1 : -1; dy = 0; r = 1e-4; } // coincident: split them along x
                else { r = Math.sqrt(r2); dx /= r; dy /= r; }
                const q = 1 - r * invH;
                rho += q * q; rhoN += q * q * q;
                nbJ[m] = j; nbQ[m] = q; nbX[m] = dx; nbY[m] = dy; m++;
              }
            }
          }
          RHO[i] = rho;
          if (!m) continue;
          const P = K * (rho - rho0), PN = KN * rhoN;
          let dxi = 0, dyi = 0;
          for (let k = 0; k < m; k++) {
            const q = nbQ[k], D = (P * q + PN * q * q) * 0.5, j = nbJ[k];
            const ddx = D * nbX[k], ddy = D * nbY[k];
            X[j] += ddx; Y[j] += ddy; dxi -= ddx; dyi -= ddy;
          }
          X[i] += dxi; Y[i] += dyi;
        }
      }

      // ----- collisions -----
      // One routine for particles and bodies: C holds the point, its previous position (the side
      // it came from, so thin walls and gates can't be crossed) and a radius; it accumulates the
      // contact normal and the solid's bounce/friction.
      const C = { x: 0, y: 0, px: 0, py: 0, r: 0, hit: 0, nx: 0, ny: 0, bounce: 0, friction: 0, solid: null };
      function contact(nx, ny, s) {
        C.hit = 1; C.nx += nx; C.ny += ny; C.solid = s;
        C.bounce = s && s.bounce != null ? s.bounce : bounce;
        C.friction = s && s.friction != null ? s.friction : friction;
      }
      function prepSolids() {
        activeSolids.length = 0;
        for (const s of f.solids) {
          if (s.on === false) continue;
          if (s.kind === 'segment') {
            const r = s.r == null ? 4 : s.r;
            s._x0 = Math.min(s.x1, s.x2) - r; s._x1 = Math.max(s.x1, s.x2) + r;
            s._y0 = Math.min(s.y1, s.y2) - r; s._y1 = Math.max(s.y1, s.y2) + r;
          } else if (s.kind === 'circle') {
            s._x0 = s.x - s.r; s._x1 = s.x + s.r; s._y0 = s.y - s.r; s._y1 = s.y + s.r;
          } else {
            s._x0 = s.x; s._x1 = s.x + s.w; s._y0 = s.y; s._y1 = s.y + s.h;
          }
          activeSolids.push(s);
        }
      }
      function hitSolid(s) {
        const R = C.r;
        if (C.x <= s._x0 - R || C.x >= s._x1 + R || C.y <= s._y0 - R || C.y >= s._y1 + R) return;
        if (s.kind === 'rect') {
          // Out through the face the point came in by; nearest face if it started inside (a gate
          // closed on it, or the solid moved onto it).
          const x0 = s._x0 - R, x1 = s._x1 + R, y0 = s._y0 - R, y1 = s._y1 + R;
          const dl = C.x - x0, dr = x1 - C.x, dt_ = C.y - y0, db = y1 - C.y;
          const fromL = C.px <= x0, fromR = C.px >= x1, fromT = C.py <= y0, fromB = C.py >= y1;
          const any = fromL || fromR || fromT || fromB;
          // Never out through a face flush with the world bounds (the bounds would push it back in).
          const okL = x0 >= bx0 + R, okR = x1 <= bx1 - R, okT = y0 >= by0 + R, okB = y1 <= by1 - R;
          const anyOk = okL || okR || okT || okB;
          let best = Infinity, face = 0;
          if ((!any || fromL) && (okL || !anyOk) && dl < best) { best = dl; face = 1; }
          if ((!any || fromR) && (okR || !anyOk) && dr < best) { best = dr; face = 2; }
          if ((!any || fromT) && (okT || !anyOk) && dt_ < best) { best = dt_; face = 3; }
          if ((!any || fromB) && (okB || !anyOk) && db < best) { best = db; face = 4; }
          if (!face) { // it came in through a face it may not leave by: nearest allowed face
            if ((okL || !anyOk) && dl < best) { best = dl; face = 1; }
            if ((okR || !anyOk) && dr < best) { best = dr; face = 2; }
            if ((okT || !anyOk) && dt_ < best) { best = dt_; face = 3; }
            if ((okB || !anyOk) && db < best) { best = db; face = 4; }
          }
          if (face === 1) { C.x = x0; contact(-1, 0, s); } else if (face === 2) { C.x = x1; contact(1, 0, s); }
          else if (face === 3) { C.y = y0; contact(0, -1, s); } else { C.y = y1; contact(0, 1, s); }
        } else if (s.kind === 'circle') {
          const Rt = s.r + R;
          let dx = C.x - s.x, dy = C.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= Rt * Rt) return;
          let d = Math.sqrt(d2);
          if (d < 1e-6) { dx = C.px - s.x; dy = C.py - s.y; d = Math.hypot(dx, dy); if (d < 1e-6) { dx = 0; dy = -1; d = 1; } }
          const nx = dx / d, ny = dy / d;
          C.x = s.x + nx * Rt; C.y = s.y + ny * Rt; contact(nx, ny, s);
        } else { // segment: a capsule of radius r
          const Rt = (s.r == null ? 4 : s.r) + R;
          const ax = s.x1, ay = s.y1, sx = s.x2 - ax, sy = s.y2 - ay, L2 = sx * sx + sy * sy;
          let t = L2 > 0 ? ((C.x - ax) * sx + (C.y - ay) * sy) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = ax + t * sx, cy = ay + t * sy;
          let dx = C.x - cx, dy = C.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= Rt * Rt) return;
          if (t > 0 && t < 1 && L2 > 0) {
            // Along the body: push out on the side the point came from, even if it crossed the line.
            const L = Math.sqrt(L2);
            let nx = -sy / L, ny = sx / L;
            let side = (C.px - ax) * nx + (C.py - ay) * ny;
            if (side === 0) side = dx * nx + dy * ny;
            if (side < 0) { nx = -nx; ny = -ny; }
            const dn = dx * nx + dy * ny;
            C.x += nx * (Rt - dn); C.y += ny * (Rt - dn); contact(nx, ny, s);
          } else {
            let d = Math.sqrt(d2);
            if (d < 1e-6) { dx = C.px - cx; dy = C.py - cy; d = Math.hypot(dx, dy); if (d < 1e-6) { dx = 0; dy = -1; d = 1; } }
            const nx = dx / d, ny = dy / d;
            C.x = cx + nx * Rt; C.y = cy + ny * Rt; contact(nx, ny, s);
          }
        }
      }
      // Solids, then the world bounds. Returns true if the point left through a `kill` side.
      function collide(canDie) {
        for (let k = 0; k < activeSolids.length; k++) hitSolid(activeSolids[k]);
        // A kill side is open: particles pass it and die beyond the edge (bodies still bounce).
        const R = C.r, kl = canDie && killL, kr = canDie && killR, kt = canDie && killT, kb = canDie && killB;
        if (kl ? C.x < bx0 : C.x < bx0 + R) { if (kl) return true; C.x = bx0 + R; contact(1, 0, null); }
        else if (kr ? C.x > bx1 : C.x > bx1 - R) { if (kr) return true; C.x = bx1 - R; contact(-1, 0, null); }
        if (kt ? C.y < by0 : C.y < by0 + R) { if (kt) return true; C.y = by0 + R; contact(0, 1, null); }
        else if (kb ? C.y > by1 : C.y > by1 - R) { if (kb) return true; C.y = by1 - R; contact(0, -1, null); }
        return false;
      }
      // After positions are final: v = (x - prev) / dt, then the normal part into the contact is
      // removed (or reflected by `bounce`) and the tangential part scaled by (1 - friction).
      // `vin` is the velocity the point moved with this substep, used to measure impact speed.
      function respond(vx, vy, vinx, viny, out) {
        if (C.hit) {
          const nl = Math.hypot(C.nx, C.ny);
          if (nl > 1e-6) {
            const nx = C.nx / nl, ny = C.ny / nl, vn = vx * nx + vy * ny;
            const hard = -(vinx * nx + viny * ny);
            if (hard > impactSpeed && f.impacts.length < 32 && out) f.impacts.push({ x: C.x, y: C.y, speed: hard, nx, ny, solid: C.solid });
            if (vn < 0) {
              const tx = vx - vn * nx, ty = vy - vn * ny, k = 1 - C.friction;
              vx = tx * k - C.bounce * vn * nx; vy = ty * k - C.bounce * vn * ny;
            }
          }
        }
        RV[0] = vx; RV[1] = vy;
      }
      const RV = new Float64Array(2);

      // ----- bodies (floating circles, two-way) -----
      // `mass` is relative: 1 floats about half under the drawn surface, 2 rides low, 4 sinks.
      // Internally a body weighs mass * a quarter of its area in rest-spaced particles (tuned
      // against the blob's surface, which sits ~0.6 h above the top particles); pushes between a
      // body and a particle move each in inverse proportion to its weight, so the liquid carries it.
      const restArea = (h * 0.5) * (h * 0.5);
      function bodyWeight(b) { return Math.max(0.05, b.mass == null ? 1 : b.mass) * 0.25 * Math.PI * b.r * b.r / restArea; }

      function substep() {
        // 1. emitters. A jet is laid down at rest spacing: particles go across a nozzle as wide as
        //    the rate needs at this speed (rate * spacing² / speed, at least 2 * spread), at evenly
        //    spread (golden-ratio) offsets, and along the stream by how late in the substep each is
        //    due. Packing them tighter would make the jet burst into globs.
        for (const e of f.emitters) {
          if (!e.on) { e._acc = 0; continue; }
          const rate = e.rate == null ? 120 : e.rate, vx = e.vx || 0, vy = e.vy || 0, sp = e.spread == null ? 3 : e.spread;
          const speed = Math.hypot(vx, vy), ux = speed > 0 ? vx / speed : 0, uy = speed > 0 ? vy / speed : 1;
          const width = Math.max(2 * sp, speed > 0 ? rate * restArea / speed : 0), due = rate * dt;
          e._acc = (e._acc || 0) + due;
          while (e._acc >= 1) {
            e._acc -= 1;
            e._k = ((e._k || 0) + 0.6180339887) % 1;
            const lat = (e._k - 0.5) * width + (rnd() - 0.5) * 0.2 * h, along = speed * dt * (e._acc / due) + (rnd() - 0.5) * 0.1 * h;
            add(e.x - uy * lat + ux * along, e.y + ux * lat + uy * along, vx, vy, e.group || 0);
          }
        }
        const n = f.n, gx = g.x * dt, gy = g.y * dt;
        // 2. gravity, speed clamp
        const dragAt = rho0 * 0.6;
        for (let i = 0; i < n; i++) {
          let vx = VX[i] + gx, vy = VY[i] + gy;
          if (drag > 0 && RHO[i] > dragAt) { vx *= 1 - drag; vy *= 1 - drag; }
          const s2 = vx * vx + vy * vy;
          if (s2 > maxV * maxV) { const k = maxV / Math.sqrt(s2); vx *= k; vy *= k; }
          VX[i] = vx; VY[i] = vy;
        }
        for (const b of f.bodies) {
          if (b.on === false) continue;
          b.vx += gx; b.vy += gy;
          const s2 = b.vx * b.vx + b.vy * b.vy;
          if (s2 > maxV * maxV) { const k = maxV / Math.sqrt(s2); b.vx *= k; b.vy *= k; }
        }
        // 3. viscosity
        buildGrid();
        viscosity();
        // 4. predict
        for (let i = 0; i < n; i++) { PX[i] = X[i]; PY[i] = Y[i]; X[i] += VX[i] * dt; Y[i] += VY[i] * dt; }
        for (const b of f.bodies) { if (b.on === false) continue; b._px = b.x; b._py = b.y; b.x += b.vx * dt; b.y += b.vy * dt; }
        // 5. density relaxation
        buildGrid();
        relax();
        // 6. collisions (moves clamped first, so no point jumps farther than 0.45 h)
        prepSolids();
        let dead = 0;
        const bodies = f.bodies;
        for (let i = 0; i < n; i++) {
          let x = X[i], y = Y[i];
          const mx = x - PX[i], my = y - PY[i], m2 = mx * mx + my * my;
          if (m2 > maxMove2) { const k = maxMove / Math.sqrt(m2); x = PX[i] + mx * k; y = PY[i] + my * k; }
          C.x = x; C.y = y; C.px = PX[i]; C.py = PY[i]; C.r = pad; C.hit = 0; C.nx = C.ny = 0; C.solid = null;
          for (let k = 0; k < bodies.length; k++) {
            const b = bodies[k];
            if (b.on === false) continue;
            const R = b.r + pad, dx = C.x - b.x, dy = C.y - b.y, d2 = dx * dx + dy * dy;
            if (d2 >= R * R) continue;
            let d = Math.sqrt(d2), nx, ny;
            if (d < 1e-6) { nx = 0; ny = -1; d = 0; } else { nx = dx / d; ny = dy / d; }
            const M = bodyWeight(b), depth = R - d, wp = M / (M + 1), wb = 1 / (M + 1);
            C.x += nx * depth * wp; C.y += ny * depth * wp;
            b.x -= nx * depth * wb; b.y -= ny * depth * wb;
          }
          if (collide(true)) { DEAD[i] = 1; dead++; }
          X[i] = C.x; Y[i] = C.y; HIT[i] = C.hit; HNX[i] = C.nx; HNY[i] = C.ny; HB[i] = C.bounce; HF[i] = C.friction; HS[i] = C.solid;
        }
        for (const b of bodies) {
          if (b.on === false) continue;
          // Against solids a body keeps one particle's clearance, so liquid can always get under it
          // (a body resting on the floor would otherwise be held down by the liquid above it).
          C.x = b.x; C.y = b.y; C.px = b._px; C.py = b._py; C.r = b.r + 2 * pad; C.hit = 0; C.nx = C.ny = 0;
          collide(false);
          b.x = C.x; b.y = C.y;
          respond((b.x - b._px) * invDt, (b.y - b._py) * invDt, b.vx, b.vy, false);
          const k = 1 - (b.drag == null ? 0.02 : b.drag);
          b.vx = RV[0] * k; b.vy = RV[1] * k;
        }
        // 7. velocities from positions
        for (let i = 0; i < n; i++) {
          const vx = (X[i] - PX[i]) * invDt, vy = (Y[i] - PY[i]) * invDt;
          if (!HIT[i]) { VX[i] = vx; VY[i] = vy; continue; }
          C.hit = 1; C.nx = HNX[i]; C.ny = HNY[i]; C.bounce = HB[i]; C.friction = HF[i]; C.solid = HS[i]; C.x = X[i]; C.y = Y[i];
          respond(vx, vy, VX[i], VY[i], !DEAD[i]);
          VX[i] = RV[0]; VY[i] = RV[1];
        }
        // Backwards, so the particle swapped into slot i has already been checked (and kept).
        if (dead) for (let i = f.n - 1; i >= 0; i--) if (DEAD[i]) { DEAD[i] = 0; removeAt(i); }
      }

      // ----- public methods -----
      /** Advance by dt (always 1/60 in a game): `substeps` fixed substeps. Call once per update(). */
      f.step = function (stepDt) {
        f.impacts.length = 0;
        const frames = Math.max(1, Math.round((stepDt == null ? STEP : stepDt) / STEP));
        for (let k = 0; k < frames * substeps; k++) substep();
        let sum = 0;
        for (let i = 0; i < f.n; i++) sum += Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i]);
        f.speed = f.n ? sum / f.n : 0;
      };
      /** Add up to n particles around (x, y); returns how many fit under `max`. */
      f.spawn = function (x, y, count, o) {
        o = o || {};
        const sp = o.spread == null ? h / 2 : o.spread;
        let added = 0;
        for (let k = 0; k < (count || 1); k++) {
          if (!add(x + (rnd() * 2 - 1) * sp, y + (rnd() * 2 - 1) * sp, o.vx || 0, o.vy || 0, o.group || 0)) break;
          added++;
        }
        return added;
      };
      /** Fill a rect with a resting lattice (tiny jitter); returns the count added. */
      f.fill = function (r, o) {
        o = o || {};
        const s = o.spacing || h / 2, j = s * 0.04;
        const cols = Math.max(1, Math.floor(r.w / s)), rows = Math.max(1, Math.floor(r.h / s));
        const ox = r.x + (r.w - (cols - 1) * s) / 2, oy = r.y + (r.h - (rows - 1) * s) / 2;
        let added = 0;
        for (let row = rows - 1; row >= 0; row--) { // bottom rows first, so a full tank keeps its floor
          for (let c = 0; c < cols; c++) {
            if (!add(ox + c * s + (rnd() * 2 - 1) * j, oy + row * s + (rnd() * 2 - 1) * j, 0, 0, o.group || 0)) return added;
            added++;
          }
        }
        return added;
      };
      /** Remove the particles inside a shape ({x,y,w,h} or {x,y,r}); returns how many. */
      f.kill = function (shape, group) {
        let k = 0;
        for (let i = f.n - 1; i >= 0; i--) {
          if ((group == null || G[i] === group) && shapeHas(shape, X[i], Y[i])) { removeAt(i); k++; }
        }
        return k;
      };
      f.emitter = function (o) {
        const e = Object.assign({ x: 0, y: 0, rate: 120, vx: 0, vy: 0, spread: 3, group: 0, on: true }, o || {});
        e._acc = 0;
        f.emitters.push(e);
        return e;
      };
      /** A collider: { kind: 'rect', x, y, w, h } | { kind: 'circle', x, y, r } | { kind: 'segment', x1, y1, x2, y2, r = 4 }. */
      f.solid = function (o) {
        const s = Object.assign({ kind: 'rect', on: true }, o || {});
        if (s.kind !== 'rect' && s.kind !== 'circle' && s.kind !== 'segment') throw new Error('GT.fluid solid: kind must be rect, circle or segment');
        f.solids.push(s);
        return s;
      };
      /** A floating circle pushed by the liquid and pushing it back. */
      f.body = function (o) {
        const b = Object.assign({ x: 0, y: 0, vx: 0, vy: 0, r: 12, mass: 1, drag: 0.02, on: true }, o || {});
        b._px = b.x; b._py = b.y;
        f.bodies.push(b);
        return b;
      };
      /** Take a solid, emitter or body out of the simulation. */
      f.remove = function (obj) {
        for (const list of [f.solids, f.emitters, f.bodies]) { const i = list.indexOf(obj); if (i >= 0) list.splice(i, 1); }
      };
      f.count = function (shape, group) {
        let k = 0;
        for (let i = 0; i < f.n; i++) if ((group == null || G[i] === group) && shapeHas(shape, X[i], Y[i])) k++;
        return k;
      };
      /** Particles within r of (x, y) and their mean velocity: buoyancy, currents, "is it wet here". */
      f.sample = function (x, y, r) {
        let k = 0, sx = 0, sy = 0;
        const r2 = r * r;
        for (let i = 0; i < f.n; i++) {
          const dx = X[i] - x, dy = Y[i] - y;
          if (dx * dx + dy * dy <= r2) { k++; sx += VX[i]; sy += VY[i]; }
        }
        return { n: k, vx: k ? sx / k : 0, vy: k ? sy / k : 0 };
      };
      /** Highest particle (smallest y) within halfWidth of column x, or null. */
      f.top = function (x, halfWidth) {
        const hw = halfWidth == null ? h : halfWidth;
        let best = Infinity;
        for (let i = 0; i < f.n; i++) if (Math.abs(X[i] - x) <= hw && Y[i] < best) best = Y[i];
        return best === Infinity ? null : best;
      };
      f.settled = function (threshold) {
        if (!f.n || f.speed >= (threshold == null ? 10 : threshold)) return false;
        for (const e of f.emitters) if (e.on) return false;
        return true;
      };

      // ----- drawing: 2D -----
      // Both styles render into a small offscreen layer in JS (an ImageData), upload only the
      // particles' bounding box, and blit that box with smoothing: a few thousand pixel writes
      // instead of hundreds of canvas arcs, and no ctx.filter (which not every WebView has).
      // 'blob': each particle adds a smooth kernel to a field; the liquid is where the field
      //   passes a threshold (metaballs), so neighbours merge into one surface and lone drops
      //   stay round. Colour runs `color` → `deep` with depth below the surface, groups blend by their
      //   share of the field, the upper rim (inside, but not a few px above) gets `highlight`,
      //   and fast particles get foam specks.
      // 'dots': a shaded ball sprite stamped per particle (sand, beads, bubbles).
      let lay = null, layQ = 0, layM = 0, img = null;
      const fields = [], present = new Uint8Array(256), colorCache = new Map();
      const rgba = (col) => { let v = colorCache.get(col); if (!v) { v = parseColor(col); colorCache.set(col, v); } return v; };
      const stamps = new Map();
      function layerFor(q, m) {
        if (!lay || layQ !== q || layM !== m) {
          lay = offscreen((B.w + 2 * m) * q, (B.h + 2 * m) * q);
          img = lay.getContext('2d').createImageData(lay.width, lay.height);
          layQ = q; layM = m; fields.length = 0;
        }
        return lay;
      }
      // A shaded ball (rim shadow, lit body, glint), rasterized once per colour and size.
      function stampFor(col, R) {
        const key = col + '|' + R;
        let st = stamps.get(key);
        if (st) return st;
        const size = Math.ceil(R * 2) + 2, c0 = size / 2, px = new Float32Array(size * size * 4);
        const base = rgba(col), lit = rgba(shadeColor(col, 0.55)), dark = rgba(shadeColor(col, -0.45));
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const dx = (x + 0.5 - c0) / R, dy = (y + 0.5 - c0) / R, d = Math.sqrt(dx * dx + dy * dy);
          const a = Math.max(0, Math.min(1, (1 - d) * R + 0.5)); // ~1 px antialiased edge
          if (!a) continue;
          const lx = dx + 0.35, ly = dy + 0.4, l = Math.sqrt(lx * lx + ly * ly); // light from top-left
          const t = Math.min(1, l / 1.3);
          const k = (y * size + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const v = t < 0.35 ? lit[ch] + (base[ch] - lit[ch]) * (t / 0.35) : base[ch] + (dark[ch] - base[ch]) * ((t - 0.35) / 0.65);
            px[k + ch] = v;
          }
          px[k + 3] = a * base[3];
        }
        st = { size, px };
        stamps.set(key, st);
        return st;
      }
      f.draw = function (c, o) {
        o = o || {};
        const n = f.n;
        if (!n) return;
        const dots = o.style === 'dots';
        const alpha = o.alpha == null ? 0.92 : o.alpha;
        const rad = o.radius || h * (dots ? 0.3 : 0.6);
        const q = Math.max(0.1, Math.min(2, o.quality || (dots ? 1 : 0.5)));
        const S = dots ? rad : rad * 1.5; // kernel support (logical px)
        const m = Math.ceil(S + 2);
        const L = layerFor(q, m), lw = L.width, lh = L.height, d = img.data;
        const ox = (m - B.x) * q, oy = (m - B.y) * q, Sq = S * q;
        // bounding box in layer px, and which groups are present
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        present.fill(0);
        for (let i = 0; i < n; i++) {
          const x = X[i], y = Y[i];
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          present[G[i]] = 1;
        }
        const x0 = Math.max(0, Math.floor(minX * q + ox - Sq - 1)), x1 = Math.min(lw - 1, Math.ceil(maxX * q + ox + Sq + 1));
        const y0 = Math.max(0, Math.floor(minY * q + oy - Sq - 1)), y1 = Math.min(lh - 1, Math.ceil(maxY * q + oy + Sq + 1));
        if (x1 < x0 || y1 < y0) return;
        // Cleared and uploaded with a 2 px border: smoothing samples just outside the blitted box,
        // where the layer still holds older frames.
        const ux0 = Math.max(0, x0 - 2), ux1 = Math.min(lw - 1, x1 + 2), uy0 = Math.max(0, y0 - 2), uy1 = Math.min(lh - 1, y1 + 2);
        for (let y = uy0; y <= uy1; y++) d.fill(0, (y * lw + ux0) * 4, (y * lw + ux1 + 1) * 4);
        const styleOf = (gi) => {
          const over = o.colors && o.colors[gi];
          return { color: (over && over.color) || o.color || '#3fa9f5', deep: (over && over.deep) || o.deep || '#0b3d91' };
        };
        if (dots) {
          for (let gi = 0; gi < 256; gi++) {
            if (!present[gi]) continue;
            const st = stampFor(styleOf(gi).color, rad * q), size = st.size, sp = st.px, half = size / 2;
            for (let i = 0; i < n; i++) {
              if (G[i] !== gi) continue;
              const sx = Math.round(X[i] * q + ox - half), sy = Math.round(Y[i] * q + oy - half);
              for (let yy = 0; yy < size; yy++) {
                const ty = sy + yy; if (ty < y0 || ty > y1) continue;
                for (let xx = 0; xx < size; xx++) {
                  const tx = sx + xx; if (tx < x0 || tx > x1) continue;
                  const k = (yy * size + xx) * 4, a = sp[k + 3];
                  if (!a) continue;
                  const t = (ty * lw + tx) * 4, da = d[t + 3] / 255, oa = a + da * (1 - a);
                  d[t] = (sp[k] * a + d[t] * da * (1 - a)) / oa; d[t + 1] = (sp[k + 1] * a + d[t + 1] * da * (1 - a)) / oa;
                  d[t + 2] = (sp[k + 2] * a + d[t + 2] * da * (1 - a)) / oa; d[t + 3] = oa * 255;
                }
              }
            }
          }
        } else {
          // 1. fields, one per group present (cleared over the box only)
          const S2 = Sq * Sq, gl = [];
          const off = Math.max(1, Math.round(Math.max(2, rad * 0.45) * q)); // rim thickness (layer px)
          for (let gi = 0; gi < 256; gi++) {
            if (!present[gi]) continue;
            const F = fields[gi] || (fields[gi] = new Float32Array(lw * lh));
            for (let y = Math.max(0, y0 - off); y <= y1; y++) F.fill(0, y * lw + x0, y * lw + x1 + 1); // + the rows the rim looks at
            gl.push(gi);
          }
          for (let i = 0; i < n; i++) {
            const F = fields[G[i]], cx = X[i] * q + ox, cy = Y[i] * q + oy;
            const ax = Math.max(x0, Math.floor(cx - Sq)), bx = Math.min(x1, Math.ceil(cx + Sq));
            const ay = Math.max(y0, Math.floor(cy - Sq)), by = Math.min(y1, Math.ceil(cy + Sq));
            for (let y = ay; y <= by; y++) {
              const dy = y + 0.5 - cy, dy2 = dy * dy, row = y * lw;
              for (let x = ax; x <= bx; x++) {
                const dx = x + 0.5 - cx, r2 = dx * dx + dy2;
                if (r2 < S2) { const k = 1 - r2 / S2; F[row + x] += k * k; }
              }
            }
          }
          // 2. pixels: threshold (an isolated particle's edge sits at `radius`), colour, rim.
          // Colour goes from `color` at the liquid's top to `deep` `gradient` px below it, and
          // lightens toward every edge (where the field is thin), so streams and drops read as
          // light and pools as deep. (Per-column depth was tried: it streaks under props.)
          const T = (1 - 1 / 2.25) * (1 - 1 / 2.25), T0 = T * 0.7, T1 = T * 1.3, E0 = T, E1 = T * 4;
          const hl = rgba(o.highlight || 'rgba(255,255,255,0.45)');
          const topY = (minY - rad) * q + oy, invSpan = 1 / (Math.max(1, o.gradient || 110) * q);
          const cols = gl.map((gi) => { const st = styleOf(gi); return [rgba(st.color), rgba(st.deep)]; });
          const one = gl.length === 1, F0 = fields[gl[0]], ng = gl.length;
          const smooth01 = (v) => (v <= T0 ? 0 : v >= T1 ? 1 : ((v - T0) / (T1 - T0)) * ((v - T0) / (T1 - T0)) * (3 - 2 * (v - T0) / (T1 - T0)));
          for (let y = y0; y <= y1; y++) {
            const row = y * lw, up = Math.max(0, y - off) * lw;
            for (let x = x0; x <= x1; x++) {
              const p = row + x;
              let v = 0;
              if (one) v = F0[p]; else for (let g2 = 0; g2 < ng; g2++) v += fields[gl[g2]][p];
              if (v <= T0) continue;
              const e = v >= E1 ? 1 : v <= E0 ? 0 : (v - E0) / (E1 - E0);
              const t = Math.min(1, (y - topY) * invSpan) * (0.4 + 0.6 * e);
              let r = 0, gg = 0, b = 0, a = 0;
              if (one) {
                const c0 = cols[0][0], c1 = cols[0][1];
                r = c0[0] + (c1[0] - c0[0]) * t; gg = c0[1] + (c1[1] - c0[1]) * t; b = c0[2] + (c1[2] - c0[2]) * t; a = c0[3] + (c1[3] - c0[3]) * t;
              } else {
                for (let g2 = 0; g2 < ng; g2++) {
                  const w = fields[gl[g2]][p] / v, c0 = cols[g2][0], c1 = cols[g2][1];
                  r += w * (c0[0] + (c1[0] - c0[0]) * t); gg += w * (c0[1] + (c1[1] - c0[1]) * t);
                  b += w * (c0[2] + (c1[2] - c0[2]) * t); a += w * (c0[3] + (c1[3] - c0[3]) * t);
                }
              }
              // rim light: strong where the field a few px above is outside the liquid
              let vu = 0;
              if (one) vu = F0[up + x]; else for (let g2 = 0; g2 < ng; g2++) vu += fields[gl[g2]][up + x];
              const rk = (1 - smooth01(vu)) * hl[3];
              if (rk > 0) { r += (hl[0] - r) * rk; gg += (hl[1] - gg) * rk; b += (hl[2] - b) * rk; }
              const k = p * 4;
              d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = smooth01(v) * a * 255;
            }
          }
          // 3. foam: white specks on fast particles, inside the liquid
          if (o.foam !== false) {
            const fs = o.foamSpeed || 360, fs2 = fs * fs;
            for (let i = 0; i < n; i++) {
              if (VX[i] * VX[i] + VY[i] * VY[i] < fs2) continue;
              const px = Math.round(X[i] * q + ox), py = Math.round(Y[i] * q + oy);
              if (px < x0 || px > x1 || py < y0 || py > y1) continue;
              const k = (py * lw + px) * 4;
              if (d[k + 3] < 128) continue;
              d[k] += (255 - d[k]) * 0.55; d[k + 1] += (255 - d[k + 1]) * 0.55; d[k + 2] += (255 - d[k + 2]) * 0.55;
            }
          }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        L.getContext('2d').putImageData(img, 0, 0, ux0, uy0, ux1 - ux0 + 1, uy1 - uy0 + 1);
        c.save();
        c.globalAlpha *= alpha;
        c.imageSmoothingEnabled = true;
        c.drawImage(L, x0, y0, bw, bh, B.x - m + x0 / q, B.y - m + y0 / q, bw / q, bh / q);
        c.restore();
      };

      // ----- drawing: 3D -----
      // One instance per particle, written straight into instanceMatrix.array (translation +
      // uniform scale, column-major like THREE.Matrix4), so this needs no THREE. Default mapping:
      // the bounds' centre at the origin, y up, `scale` world units per px, and z jitter of ±depth/2
      // from each particle's stable id.
      // `stretch: k` (opt-in) elongates each instance along its velocity by 1 + k * speed / 450,
      // capped at 1 + 2.4 k (k = 1: ~2.4x at the 648 px/s speed cap, ~1.7x at 300 px/s), and
      // shrinks the other two axes by 1/sqrt of that, so volume holds. The velocity is taken in the
      // mapped frame (map is called at x and at x + v/60, so a custom map must be pure), and the
      // instance's local x axis is rotated onto it.
      const out3 = [0, 0, 0, 0], out3b = [0, 0, 0, 0], STRETCH_REF = 450;
      f.fill3d = function (mesh, o) {
        o = o || {};
        const im = mesh && mesh.instanceMatrix;
        if (!im || !im.array) throw new Error('GT.fluid fill3d: needs a THREE.InstancedMesh');
        const arr = im.array, cap = Math.min(f.n, Math.floor(arr.length / 16));
        const sc = o.scale == null ? 1 : o.scale, rad = o.radius == null ? h * 0.5 * sc : o.radius;
        const depth = o.depth || 0, map = typeof o.map === 'function' ? o.map : null, stretch = o.stretch > 0 ? o.stretch : 0;
        const cx = B.x + B.w / 2, cy = B.y + B.h / 2;
        for (let i = 0; i < cap; i++) {
          out3[3] = rad;
          if (map) { out3[0] = out3[1] = out3[2] = 0; map(i, X[i], Y[i], out3); }
          else { out3[0] = (X[i] - cx) * sc; out3[1] = -(Y[i] - cy) * sc; out3[2] = (hash01(ID[i]) - 0.5) * depth; }
          const s = out3[3], k = i * 16;
          const sp = stretch ? Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i]) : 0;
          if (sp > 1) {
            // direction of motion in the mapped (world) frame
            let ax, ay, az;
            if (map) {
              out3b[0] = out3b[1] = out3b[2] = 0; out3b[3] = s;
              map(i, X[i] + VX[i] * STEP, Y[i] + VY[i] * STEP, out3b);
              ax = out3b[0] - out3[0]; ay = out3b[1] - out3[1]; az = out3b[2] - out3[2];
            } else { ax = VX[i]; ay = -VY[i]; az = 0; }
            const al = Math.sqrt(ax * ax + ay * ay + az * az);
            if (al > 1e-9) {
              ax /= al; ay /= al; az /= al;
              // b = helper × a, c = a × b: a right-handed basis with x along the motion
              const hz = Math.abs(az) < 0.9;
              let bx = hz ? -ay : az, by = hz ? ax : 0, bz = hz ? 0 : -ax; // helper (0,0,1) or (0,1,0)
              const bl = Math.sqrt(bx * bx + by * by + bz * bz); bx /= bl; by /= bl; bz /= bl;
              const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
              const st = 1 + Math.min(2.4, sp / STRETCH_REF) * stretch, sa = s * st, sb = s / Math.sqrt(st);
              arr[k] = ax * sa; arr[k + 1] = ay * sa; arr[k + 2] = az * sa; arr[k + 3] = 0;
              arr[k + 4] = bx * sb; arr[k + 5] = by * sb; arr[k + 6] = bz * sb; arr[k + 7] = 0;
              arr[k + 8] = cx * sb; arr[k + 9] = cy * sb; arr[k + 10] = cz * sb; arr[k + 11] = 0;
              arr[k + 12] = out3[0]; arr[k + 13] = out3[1]; arr[k + 14] = out3[2]; arr[k + 15] = 1;
              continue;
            }
          }
          arr[k] = s; arr[k + 1] = 0; arr[k + 2] = 0; arr[k + 3] = 0;
          arr[k + 4] = 0; arr[k + 5] = s; arr[k + 6] = 0; arr[k + 7] = 0;
          arr[k + 8] = 0; arr[k + 9] = 0; arr[k + 10] = s; arr[k + 11] = 0;
          arr[k + 12] = out3[0]; arr[k + 13] = out3[1]; arr[k + 14] = out3[2]; arr[k + 15] = 1;
        }
        mesh.count = cap;
        im.needsUpdate = true;
        mesh.frustumCulled = false; // three.js caches instance bounds; the liquid moves
        return cap;
      };
      return f;
    }

    // GT.waves(opts): spring columns (the classic 2D water surface), 1D (`rows: 0`) or a rows×cols
    // grid for a 3D plane. Heights are px (or world units via apply's scale), positive = up.
    // Constants are per 1/60 s step. Each step: every column springs toward 0 with damping, then
    // `passes` rounds of neighbour spreading push velocities toward the neighbours' heights (so a
    // dent travels outward as a ripple), with a little height smoothing against grid-scale noise.
    function waves(opts) {
      opts = opts || {};
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      const cols = Math.max(2, Math.floor(num(opts.cols, 64))), rows = Math.max(0, Math.floor(num(opts.rows, 0)));
      const N = rows ? rows * cols : cols;
      const tension = num(opts.tension, 0.02), damping = num(opts.damping, 0.025);
      // Spreading drives velocities (a wave equation), which is only stable while spread * passes
      // stays under 0.9 on a strip and 0.45 on a grid (twice the neighbours); it is capped there.
      const passes = Math.max(0, Math.floor(num(opts.passes, 4)));
      const spread = Math.min(num(opts.spread, 0.2), (rows ? 0.45 : 0.9) / Math.max(1, passes));
      const hh = new Float32Array(N), vv = new Float32Array(N), d = new Float32Array(N);
      const w = { cols, rows, h: hh, v: vv };
      const colAt = (u) => (u > 1 ? u : Math.max(0, Math.min(1, u)) * (cols - 1));
      const rowAt = (v) => (v > 1 ? v : Math.max(0, Math.min(1, v)) * (rows - 1));
      /** Dent the surface: amount ≈ px pushed down at the centre (negative lifts), falling off over ~2 columns. */
      w.splash = function (u, a, b) {
        if (!rows) {
          const p = colAt(u), amount = num(a, 8);
          for (let c = Math.floor(p - 2); c <= Math.ceil(p + 2); c++) {
            if (c < 0 || c >= cols) continue;
            const k = 1 - Math.abs(c - p) / 2.5;
            if (k > 0) hh[c] -= amount * k;
          }
          return;
        }
        const pc = colAt(u), pr = rowAt(a), amount = num(b, 8);
        for (let r = Math.floor(pr - 2); r <= Math.ceil(pr + 2); r++) {
          if (r < 0 || r >= rows) continue;
          for (let c = Math.floor(pc - 2); c <= Math.ceil(pc + 2); c++) {
            if (c < 0 || c >= cols) continue;
            const k = 1 - Math.hypot(c - pc, r - pr) / 2.5;
            if (k > 0) hh[r * cols + c] -= amount * k;
          }
        }
      };
      w.step = function (stepDt) {
        const k = num(stepDt, STEP) / STEP;
        for (let i = 0; i < N; i++) { vv[i] += (-tension * hh[i] - damping * vv[i]) * k; hh[i] += vv[i] * k; }
        for (let p = 0; p < passes; p++) {
          if (!rows) {
            for (let i = 0; i < cols; i++) {
              let s = 0;
              if (i > 0) s += hh[i - 1] - hh[i];
              if (i < cols - 1) s += hh[i + 1] - hh[i];
              d[i] = spread * s * k;
            }
          } else {
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              const i = r * cols + c, v0 = hh[i];
              let s = 0;
              if (c > 0) s += hh[i - 1] - v0;
              if (c < cols - 1) s += hh[i + 1] - v0;
              if (r > 0) s += hh[i - cols] - v0;
              if (r < rows - 1) s += hh[i + cols] - v0;
              d[i] = spread * s * k;
            }
          }
          for (let i = 0; i < N; i++) { vv[i] += d[i]; hh[i] += d[i] * 0.1; }
        }
      };
      /** Interpolated height at u (0..1 along the strip), or at (u, v) on a grid. */
      w.at = function (u, v) {
        const p = colAt(u), c0 = Math.min(cols - 2, Math.floor(p)), fu = p - c0;
        if (!rows) return hh[c0] + (hh[c0 + 1] - hh[c0]) * fu;
        const pr = rowAt(v == null ? 0.5 : v), r0 = Math.min(rows - 2, Math.floor(pr)), fv = pr - r0;
        const i = r0 * cols + c0;
        const top = hh[i] + (hh[i + 1] - hh[i]) * fu, bot = hh[i + cols] + (hh[i + cols + 1] - hh[i + cols]) * fu;
        return top + (bot - top) * fv;
      };
      /** 1D: fill from the surface (resting at y) down to y + depth, across x..x+w. */
      w.draw = function (c, o) {
        o = o || {};
        const x = num(o.x, 0), y = num(o.y, H * 0.75), ww = num(o.w, W), depth = num(o.depth, 80);
        const dx = ww / (cols - 1);
        const path = () => {
          c.moveTo(x, y - hh[0]);
          for (let i = 1; i < cols - 1; i++) {
            const mx = x + (i + 0.5) * dx, my = y - (hh[i] + hh[i + 1]) / 2;
            c.quadraticCurveTo(x + i * dx, y - hh[i], mx, my);
          }
          c.lineTo(x + ww, y - hh[cols - 1]);
        };
        c.save();
        if (o.alpha != null) c.globalAlpha *= o.alpha;
        c.beginPath(); path(); c.lineTo(x + ww, y + depth); c.lineTo(x, y + depth); c.closePath();
        c.fillStyle = linear(c, 0, y - 12, 0, y + depth, [o.color || '#3fa9f5', o.deep || '#0b3d91']);
        c.fill();
        c.beginPath(); path();
        c.strokeStyle = o.highlight || 'rgba(255,255,255,0.6)';
        c.lineWidth = o.lineWidth || 2; c.lineJoin = 'round';
        c.stroke();
        c.restore();
      };
      /** Write heights into a THREE.PlaneGeometry(w, h, cols - 1, rows - 1) (a 1D strip repeats on every row). */
      w.apply = function (geometry, o) {
        o = o || {};
        const pos = geometry && geometry.attributes && geometry.attributes.position;
        if (!pos || !pos.array) throw new Error('GT.waves apply: needs a BufferGeometry with a position attribute');
        const count = pos.count != null ? pos.count : Math.floor(pos.array.length / 3);
        const shape = rows ? (cols - 1) + ', ' + (rows - 1) : (cols - 1) + ', 1';
        if (rows ? count !== N : count % cols !== 0) throw new Error('GT.waves apply: geometry has ' + count + ' vertices; make it with new THREE.PlaneGeometry(w, h, ' + shape + ')');
        const axis = { x: 0, y: 1, z: 2 }[o.axis || 'z'];
        if (axis == null) throw new Error('GT.waves apply: axis must be x, y or z');
        const sc = num(o.scale, 1), arr = pos.array;
        for (let i = 0; i < count; i++) arr[i * 3 + axis] = hh[rows ? i : i % cols] * sc;
        pos.needsUpdate = true;
        if (typeof geometry.computeVertexNormals === 'function') geometry.computeVertexNormals();
      };
      return w;
    }

    // ---------- public API ----------
    const GT = {
      W, H,
      version: SDK_VERSION,
      t: 0,
      get phase() { return phase; },
      get attract() { return phase === 'attract'; },

      game(def) {
        if (game) throw new Error('GT.game() called twice');
        for (const k of ['setup', 'update', 'draw']) {
          if (typeof def[k] !== 'function') throw new Error('GT.game() needs a ' + k + '() function');
        }
        // v13: stages: { count } (0 or absent: endless stages).
        if (def.stages != null) {
          const n = typeof def.stages === 'object' ? (def.stages.count == null ? 0 : def.stages.count) : NaN;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000) throw new Error('GT.game: stages.count must be a whole number');
          stageCount = n;
        }
        // v14: turns: { count, unit, settle } for kind 'turns' (ignored on other kinds); puzzle: { solutions }.
        if (kindOf(def) === 'turns') turnsDef = turnsConf(def.turns);
        if (kindOf(def) === 'puzzle' && def.puzzle != null) {
          const sol = def.puzzle && typeof def.puzzle === 'object' ? (def.puzzle.solutions == null ? 'unique' : def.puzzle.solutions) : null;
          if (sol !== 'unique' && sol !== 'many') throw new Error("GT.game: puzzle.solutions must be 'unique' or 'many'");
          solutionsDef = sol;
        }
        game = def;
        chrome = chromeDef(def.chrome);
        // The page's title, background (for the shell's own crash screen) and the music settings.
        post({ t: 'game', title: def.title == null ? 'diddly' : String(def.title), bg: def.bg == null ? '' : String(def.bg), music: musicDef(def.music), kind: kindOf(def) });
        resize();
        render();
        // Load the bundle, rasterize declared SVG sprites (and load three.js for 3D games) before
        // setup() runs, so draw() can use them immediately.
        const count = Object.keys(def.sprites || {}).length;
        Promise.all([loadBundle(def), loadSprites(def.sprites), def.three ? loadThree() : null]).then(() => {
          newRound('attract');
          // The first attract frame (for 3D games, with its shader compiles) is drawn before
          // 'ready', so a host that shows the card on ready never shows it blank.
          render();
          postState(); // QA's state() reads 'attract' by the time it sees 'ready'
          emit('ready', { title: def.title, instruction: def.instruction, seed: baseSeed, sprites: count, sdk: SDK_VERSION, kind: kindOf(def), best, bundle: bundleInfo || undefined });
          running = !QA;
          loop();
        }, (err) => { reportError(err); crash(); render(); });
      },
      /** v11+: the SDK loads the game's code itself (from its script tag's data-game). */
      loadsGame: true,

      // scoring + lifecycle
      addScore(n) { if (phase === 'play' || phase === 'attract') score += n == null ? 1 : n; },
      setScore(n) { if (phase === 'play' || phase === 'attract') score = n; },
      getScore() { return score; },
      over() { if (phase === 'play' || phase === 'attract') overPending = true; },
      /** End the round as won: a puzzle solved, a level cleared. Shows the solved/cleared screen. */
      win() { if (phase === 'play' || phase === 'attract') { winPending = true; overPending = true; } },
      /** v13: stages inside one round. GT.stage.index (1-based), GT.stage.t (seconds in this stage),
       *  GT.stage.next({ title, subtitle }) clears the stage: an intermission, then setup() for the
       *  next one; clearing the declared last stage (GT.game({ stages: { count } })) is GT.win(). */
      stage: Object.freeze({
        get index() { return stageIndex; },
        get t() { return stageT; },
        next: (o) => stageNext(o),
      }),
      get kind() { return kindOf(game); },
      /** v14: the resource of a turns game (kind: 'turns', turns: { count, unit, settle }). GT.turns.use()
       *  as a turn is spent; after the last one the SDK waits for settled(s) and ends the round. */
      turns: Object.freeze({
        get count() { return turnsDef ? turnsDef.count : 0; },
        get left() { return turnsLeft; },
        get used() { return turnsUsed; },
        get finishing() { return turnsFinishing; },
        use: (n) => turnsUse(n),
        add: (n) => turnsAdd(n),
        set: (n) => turnsSet(n),
      }),

      // randomness (seeded; never use Math.random in games)
      rand: () => rand(),
      range: (a, b) => a + rand() * (b - a),
      int: (a, b) => Math.floor(a + rand() * (b - a + 1)),
      pick: (arr) => arr[Math.floor(rand() * arr.length)],
      chance: (p) => rand() < p,

      // math
      clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
      lerp: (a, b, t) => a + (b - a) * t,
      dist: (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay),
      ramp(from, to, seconds) { return from + (to - from) * Math.min(1, GT.t / seconds); },
      circleHit: (ax, ay, ar, bx, by, br) => (ax - bx) ** 2 + (ay - by) ** 2 <= (ar + br) ** 2,
      rectHit: (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
      circleRectHit(cx, cy, r, b) {
        const nx = Math.max(b.x, Math.min(cx, b.x + b.w)), ny = Math.max(b.y, Math.min(cy, b.y + b.h));
        return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
      },

      // drawing
      text: drawText,
      circle(c, x, y, r, color) { c.fillStyle = color; c.beginPath(); c.arc(x, y, Math.max(0, r), 0, Math.PI * 2); c.fill(); },
      rect(c, x, y, w, h, color) { c.fillStyle = color; c.fillRect(x, y, w, h); },
      roundRect(c, x, y, w, h, r, color) {
        c.fillStyle = color; c.beginPath();
        if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
        c.fill();
      },

      // juice
      burst,
      shake(px) {
        const amt = px == null ? 8 : px;
        shakeAmt = Math.max(shakeAmt, amt);
        haptic(amt >= 14 ? 'heavy' : amt >= 6 ? 'medium' : 'light');
      },
      haptic,
      flash(color) { flashColor = color || '#fff'; flashT = 0.25; },
      float(text, x, y, color, size) { floaters.push({ text: String(text), x, y, color: color || '#fff', size: size || 20, life: 0.8 }); },
      /** Freeze update() for `steps` fixed steps (default 4, max 8) on an impact; effects keep playing. */
      hitStop,
      /** Slow the game to `factor` (0.2–1) and ease back to full speed over `seconds`. update()'s dt shrinks. */
      slowmo,
      /** Animate numeric props of obj from their current values: GT.tween(o, { y: 100 }, 0.3, 'outBack', done). */
      tween,
      ease: EASE,
      /** A named spring: GT.spring('player', 1) → { v, target, kick(a), set(v) }. Read .v each draw. */
      spring,
      /** Combo meter: GT.combo.hit(n=1) · GT.combo.miss() · GT.combo.end() · GT.combo.count · GT.combo.max. Window: GT.game({ combo: { window } }). */
      combo,
      /** "That almost got you": slow-mo pulse, flash, "close!", swoosh, buzz. At most one per 0.5 s; returns whether it fired. */
      nearMiss,
      /** True when two circles don't touch but come within `margin` (default 16) of each other. */
      nearMissCheck,
      /** A queued banner under the score: GT.toast('LEVEL 2', { color, size }). */
      toast,
      /** GT.sfx(name, { pitch, vol, n }): a synthesized effect with a little random variation. */
      sfx,
      tone,
      /** GT.music.set(intensity 0..1) · GT.music.mood(name | 'off'). Start it with `music:` in GT.game. */
      music: musicApi,
      /** ?debug only: GT.audio.render(seconds, opts) renders music/sfx offline, for tests. The engine
       *  runs on the page: in-thread this is the page's own; in a worker, state() is the last one the
       *  page reported and render() is only on the page's window.GT.audio. */
      audio: !DEBUG ? undefined : env.audio || {
        moods: Object.keys(MOODS), sfx: Object.keys(SFX), soloGroups: MUSIC_GROUPS.slice(),
        state: () => audioInfo,
        render: () => Promise.reject(new Error('GT.audio.render runs on the page: call it on the game frame\'s window.GT.audio')),
      },

      // art kit
      color: { mix: mixColor, shade: shadeColor, alpha: withAlpha },
      material,
      materials: () => Object.keys(MATERIALS),
      noiseTexture,
      noise: makeNoise,
      bake,
      /** A fresh offscreen canvas (not cached), for static layers that change per round, e.g. a puzzle board. */
      canvas: (w, h) => offscreen(w, h),
      fillTex,
      texBall,
      ball,
      glow,
      shadow,
      panel,
      linear,
      radial,
      /** The sprite's ImageBitmap (a canvas in-thread): draw it with drawImage or GT.drawSprite. A bundle
       *  image's is the whole image (all of a strip); an atlas sprite has none of its own. */
      sprite(name) {
        const s = getSprite(name);
        if (s.atlas) throw new Error('GT.sprite("' + name + '"): it is part of an atlas; use GT.drawSprite or GT.asset("' + s.atlas + '").sprites');
        return s.canvas;
      },
      drawSprite,
      /** v12: a bundle asset's record: { type: 'image', bitmap, w, h, scale, tile, frames?, sprites? } |
       *  { type: 'mesh', vertices, indices, attributes, geometry() } | { type: 'audio', seconds, channels, rate, loop? }. */
      asset: getAsset,
      /** v12: every bundle asset as [name, type], for debugging. */
      assets: () => Array.from(assets, ([name, a]) => [name, a.type]),

      // 3D
      three,

      // fluids
      fluid,
      waves,
      bodies,
    };
    self.GT = GT;

    // ---------- QA hooks: the shell's window.__gt forwards here (see the protocol at the top) ----------
    let qaStepMs = 0; // the last QA step op's step() time, ms
    var qaDrawMs = 0, glMs = 0; // (var: read by renderFrame and view.draw, which may run before this line) the game's draw() time without WebGL (last frame); WebGL time so far (QA only)
    function qaState() {
      return {
        stepMs: qaStepMs, drawMs: qaDrawMs,
        phase, score, t: roundTime, rounds, won, kind: GT.kind, three: !!view3d, errors: errorCount, stage: stageIndex, stageT, stages: stageCount,
        turns: turnsDef ? turnsDef.count : 0, turnsLeft, turnsUsed, finishing: turnsFinishing, settleCapped: turnsCapped,
        solutions: GT.kind === 'puzzle' ? solutionsDef : null, outOfTurns,
      };
    }
    function postState() { if (QA) post({ t: 'state', state: qaState() }); }
    // A cheap visual hash of the frame on a 36×64 grid, for "did anything change" checks; with
    // `grid`, also the grid's RGB values (compared with a tolerance on phones).
    function fingerprint(grid) {
      const w = 36, h = 64, o = offscreen(w, h).getContext('2d');
      o.drawImage(canvas, 0, 0, w, h);
      const d = o.getImageData(0, 0, w, h).data;
      const colors = new Set(), cells = grid ? [] : null;
      let hash = 0;
      for (let i = 0; i < d.length; i += 4) {
        const q = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        colors.add(q);
        hash = (Math.imul(hash, 31) + q) | 0;
        if (cells) cells.push(d[i], d[i + 1], d[i + 2]);
      }
      return cells ? { colors: colors.size, hash, grid: cells } : { colors: colors.size, hash };
    }
    // The frame at the logical 360×640, as a PNG data URL (thumbnails, device screenshots).
    function screenshot() {
      const o = offscreen(W, H), x = o.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(canvas, 0, 0, W, H);
      present();
      return env.dataUrl(o);
    }
    const QA_OPS = {
      step(d) {
        const n = Math.max(0, Math.floor(Number(d.n) || 0));
        // v16: the steps' own time (game logic and the SDK's per-step work, no drawing), so headless
        // QA can judge a 3D game's JavaScript apart from its CPU-rendered WebGL.
        const t0 = perfNow();
        for (let i = 0; i < n; i++) step();
        qaStepMs = perfNow() - t0;
        render();
        return qaState();
      },
      overlay(d) { hideOverlay = !d.show; render(); present(); },
      fingerprint: (d) => fingerprint(!!d.grid),
      screenshot,
      inject: (d) => env.runScript(String(d.src)),
      call(d) {
        // v13: the SDK's own, ahead of anything game code put in __qaCalls.
        if (d.name === 'stage') return { index: stageIndex, t: stageT, count: stageCount };
        if (d.name === 'turns') return { count: turnsDef ? turnsDef.count : 0, left: turnsLeft, used: turnsUsed, finishing: turnsFinishing, unit: turnsDef ? turnsDef.unit.slice() : null };
        const calls = self.__qaCalls, fn = calls && Object.prototype.hasOwnProperty.call(calls, d.name) ? calls[d.name] : null;
        if (typeof fn !== 'function') throw new Error('__gt.call: no self.__qaCalls.' + d.name);
        return fn.apply(null, Array.isArray(d.args) ? d.args : []);
      },
    };
    // Handled in order, in the message handler itself: a step runs before any later message.
    function onQa(d) {
      if (d.op === 'input') { onInput(d); return postState(); }
      if (d.op === 'swipe') { pending.swipe = String(d.dir); handleMeta(); return postState(); }
      if (d.op === 'autoplay') { autoplay = !!d.on; return; }
      const op = Object.prototype.hasOwnProperty.call(QA_OPS, d.op) ? QA_OPS[d.op] : null;
      const reply = (ok, value) => post(ok ? { t: 'qa', id: d.id, ok, value, state: qaState() } : { t: 'qa', id: d.id, ok, error: String((value && value.message) || value), state: qaState() });
      let result;
      try {
        if (!op) throw new Error('__gt: unknown op ' + d.op);
        result = op(d);
      } catch (err) { return reply(false, err); }
      Promise.resolve(result).then((v) => reply(true, v), (err) => reply(false, err));
    }

    function handle(d) {
      if (!d || typeof d !== 'object') return;
      switch (d.t) {
        case 'size': return onSize(d);
        case 'input': return onInput(d);
        case 'host': return onHost(d);
        case 'vis': pageHidden = d.hidden === true; if (!pageHidden) { last = 0; loop(); } return;
        case 'sprites': { const done = spritesDone; spritesDone = null; if (done) done(d.bitmaps); return; }
        case 'clips': { const done = clipsDone; clipsDone = null; if (done) done(d); else clipsStray = true; return; }
        case 'audioLine': audioLine = String(d.text); audioInfo = d.state || null; return;
        case 'music': musicLv = Number(d.lv) || 0; return;
        case 'qa': if (QA) onQa(d); return;
      }
    }
    resize();
    return {
      GT,
      handle,
      /** The game's code failed to load or threw at its top level: report it and show the crash screen. */
      fail(err) { reportError(err); crash(); render(); },
      frameInfo: () => frameStat,
      hasGame: () => !!game,
    };
  }

  // ================================================================ worker adapter
  // The runtime's side of the worker: answers pings, waits for `init`, then loads the game.
  function workerMain() {
    // Games may read window.THREE or window.GT; nothing else of `window` exists here.
    self.window = self;
    let rt = null, timeOffset = null;
    self.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.t === 'ping') {
        // How long the ping sat in this worker's queue, and what the runtime's frame loop was doing.
        const f = rt ? rt.frameInfo() : null, now = perfNow();
        NATIVE.postMessage({
          t: 'pong', id: d.id,
          wait: typeof d.at === 'number' && timeOffset != null ? Math.round(now + timeOffset - d.at) : null,
          frameAgo: f && f.at ? Math.round(now - f.at) : null, frameMs: f ? f.ms : null, frameGap: f ? f.gap : null,
        });
        return;
      }
      if (d.t === 'init') { if (!rt) boot(d); return; }
      if (rt) rt.handle(d);
    });
    // From v16 hello says which release this is and the protocol it speaks; the shell checks both.
    NATIVE.postMessage({ t: 'hello', sdk: SDK_VERSION, protocol: SHELL_PROTOCOL });

    // importScripts of a URL blocks this thread on the network; the shell's watchdog allows it.
    function importUrl(src) {
      NATIVE.postMessage({ t: 'loading', on: true });
      try { NATIVE.importScripts(src); } finally { NATIVE.postMessage({ t: 'loading', on: false }); }
    }
    function importText(code) {
      const u = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { NATIVE.importScripts(u); } finally { URL.revokeObjectURL(u); }
    }
    function boot(d) {
      rt = runtime({
        canvas: d.canvas, post: (m, transfer) => NATIVE.postMessage(m, transfer || []), search: String(d.search || ''),
        baseSeed: d.baseSeed, embedded: !!d.embedded, inthread: false, sdkSrc: String(d.sdkSrc), url: String(d.url || ''),
        shell: typeof d.shell === 'string' ? d.shell.slice(0, 32) : '',
        timeOffset: (timeOffset = typeof d.timeOrigin === 'number' ? performance.timeOrigin - d.timeOrigin : 0),
        vw: d.vw, vh: d.vh, dpr: d.dpr,
        offscreen: (w, h) => new OffscreenCanvas(w, h),
        raf: typeof requestAnimationFrame === 'function' ? (f) => requestAnimationFrame(f) : (f) => setTimeout(() => f(perfNow()), 16),
        loadScript: (src) => new Promise((resolve) => { importUrl(src); resolve(); }),
        dataUrl: (o) => o.convertToBlob({ type: 'image/png' }).then((b) => new FileReaderSync().readAsDataURL(b)),
        runScript: (src) => importText(src),
        onError(report) {
          self.addEventListener('error', (e) => { e.preventDefault(); report(e.error || e.message); });
          self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); report(e.reason); });
        },
        audio: null,
      });
      loadGame(String(d.url || ''));
    }
    // The game's code is fetched and run from a blob, so its errors keep their messages and
    // lines (a script imported from another origin reports only "Script error."). A page whose
    // CSP refuses the fetch (no connect-src for the games folder) gets it by URL instead.
    async function loadGame(url) {
      if (!url) return rt.fail(new Error('no game code to load'));
      let code = null;
      try {
        const r = await NATIVE.fetch(url);
        if (!r.ok) return rt.fail(new Error('could not load the game code (HTTP ' + r.status + ')'));
        code = await r.text();
      } catch (_) { /* refused: by URL below */ }
      try {
        if (code != null) importText(code); else importUrl(url);
      } catch (err) {
        return rt.fail(code == null && err && err.name === 'NetworkError' ? new Error('could not load the game code') : err);
      }
      if (!rt.hasGame() && rt.GT.phase !== 'crashed') rt.fail(new Error('the game code did not call GT.game()'));
    }
  }

  if (typeof document === 'undefined') workerMain(); else shellMain();
})();
