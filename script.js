/* ==========================================================
   ネットワークのしくみ体験 ― 情報Ⅰ「ネットワークと情報システム」
   index.html / style.css / script.js だけで動きます(外部ライブラリなし)

   第1部: 回線交換 と パケット交換 をくらべる
   第2部: パケット交換を体験する(分割 → ヘッダ → 送信 → 受信・復元)
   ========================================================== */
(function () {
  'use strict';

  /* ---------- 共通ヘルパー ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const fmt = (n) => Number(n).toLocaleString('ja-JP');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, f) => a + (b - a) * f;

  function svgEl(name, attrs, text) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }
  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const pastel = (i) => `hsl(${Math.round((i * 137.5) % 360)}, 68%, 84%)`;

  /* 区間(leg)のリストをたどって、時刻 t の位置を返す。
     leg = { from, to, t0, t1, frac }  frac: 途中で消えるパケット用(その区間の何割まで進むか) */
  function posAlong(legs, t, nodes) {
    const n = legs.length;
    if (!n || t < legs[0].t0) return null;
    for (let i = 0; i < n; i++) {
      const L = legs[i];
      if (t < L.t1) {
        const a = nodes[L.from];
        if (t >= L.t0) {
          const f = ((t - L.t0) / (L.t1 - L.t0)) * (L.frac == null ? 1 : L.frac);
          const b = nodes[L.to];
          return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), leg: i, waiting: false };
        }
        return { x: a.x, y: a.y, leg: i, waiting: true, node: L.from };
      }
    }
    return null;
  }

  /* 時計(再生・一時停止・シーク) */
  class Clock {
    constructor(onFrame) {
      this.t = 0; this.max = 1; this.rate = 1;
      this.playing = false; this.last = 0; this.raf = 0;
      this.onFrame = onFrame; this.onState = null;
      this._loop = this._loop.bind(this);
    }
    play() {
      if (this.playing) return;
      if (this.t >= this.max) this.t = 0;
      this.playing = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._loop);
      if (this.onState) this.onState();
    }
    pause() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this.raf);
      if (this.onState) this.onState();
    }
    seek(t) { this.t = clamp(t, 0, this.max); this.onFrame(this.t); if (this.onState) this.onState(); }
    reset() { this.pause(); this.seek(0); }
    _loop(now) {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.t += dt * this.rate;
      if (this.t >= this.max) {
        this.t = this.max;
        this.playing = false;
        this.onFrame(this.t);
        if (this.onState) this.onState();
        return;
      }
      this.onFrame(this.t);
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  /* ヒーローの図(パケットのイラスト) */
  (function heroArt() {
    const g = $('#hero-pkts');
    if (!g) return;
    for (let i = 0; i < 5; i++) {
      const x = 20 + i * 90;
      g.appendChild(svgEl('rect', { x: x, y: 100, width: 18, height: 44, rx: 3, class: 'pk-h' }));
      g.appendChild(svgEl('rect', { x: x + 18, y: 100, width: 62, height: 44, rx: 3, fill: '#5b7590' }));
      g.appendChild(svgEl('text', { x: x + 49, y: 128, 'text-anchor': 'middle' }, String(i + 1) + '/5'));
    }
  })();

  /* ---------- タブ ---------- */
  const tabs = $$('.tab');
  const stopAll = [];
  function activateTab(panelId) {
    tabs.forEach((tab) => {
      const on = tab.dataset.panel === panelId;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    $$('.tabpanel').forEach((p) => { p.hidden = p.id !== panelId; });
    stopAll.forEach((fn) => fn());
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.panel));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      activateTab(next.dataset.panel);
    });
  });

  /* ==========================================================
     第1部: 回線交換 と パケット交換
     ========================================================== */
  const P1 = (function () {
    const W = 680, H = 320;
    const N = 6;            // 1人が送る量(パケット6個ぶん)
    const SETUP = 4;        // 回線をつなぐのにかかる時間
    const PAUSE_AFTER = 3;  // 3個送ったあと…
    const PAUSE_LEN = 6;    // …6コマ休む(チェックを入れたとき)
    const COLOR = { A: '#1d6fe0', C: '#ee6a1f' };

    const NODES = {
      A:  { x: 52,  y: 60,  kind: 'end', user: 'A', name: 'Aさん' },
      C:  { x: 52,  y: 240, kind: 'end', user: 'C', name: 'Cさん' },
      R1: { x: 205, y: 150, kind: 'sw' },
      R2: { x: 340, y: 150, kind: 'sw' },
      R3: { x: 475, y: 150, kind: 'sw' },
      B:  { x: 628, y: 60,  kind: 'end', user: 'A', name: 'Bさん' },
      D:  { x: 628, y: 240, kind: 'end', user: 'C', name: 'Dさん' }
    };
    const LINKS = [['A', 'R1'], ['C', 'R1'], ['R1', 'R2'], ['R2', 'R3'], ['R3', 'B'], ['R3', 'D']];
    const PATH = { A: ['A', 'R1', 'R2', 'R3', 'B'], C: ['C', 'R1', 'R2', 'R3', 'D'] };

    const legsFor = (path, t0) =>
      path.slice(0, -1).map((from, i) => ({ from, to: path[i + 1], t0: t0 + i, t1: t0 + i + 1 }));

    /* --- 回線交換のスケジュールを作る --- */
    function buildCircuit(pause) {
      const P = pause ? PAUSE_LEN : 0;
      const sendA = (i) => SETUP + i + (i >= PAUSE_AFTER ? P : 0);
      const endA = sendA(N - 1) + 4;
      const relA = endA;                       // Aが終わって回線を開放する時刻
      const startC = relA + SETUP;
      const sendC = (i) => startC + i;
      const endC = sendC(N - 1) + 4;
      const idleFrom = sendA(PAUSE_AFTER - 1) + 1;
      const idleTo = sendA(PAUSE_AFTER);

      const dots = [], resv = [], badges = [], gantt = [], events = [];
      const arrivals = { A: [], C: [] };

      // Aさん: 接続要求 → データ
      dots.push({ user: 'A', kind: 'req', legs: legsFor(PATH.A, 0) });
      for (let i = 0; i < N; i++) {
        dots.push({ user: 'A', kind: 'data', label: String(i + 1), legs: legsFor(PATH.A, sendA(i)) });
        arrivals.A.push(sendA(i) + 4);
      }
      for (let k = 0; k < 4; k++) resv.push({ link: PATH.A[k] + '-' + PATH.A[k + 1], user: 'A', from: k, to: endA });

      // Cさん: 話中 → 待つ → かけなおす → データ
      dots.push({ user: 'C', kind: 'req', busy: true, legs: [
        { from: 'C', to: 'R1', t0: 1, t1: 2 }, { from: 'R1', to: 'C', t0: 2, t1: 3 }] });
      dots.push({ user: 'C', kind: 'req', legs: legsFor(PATH.C, relA) });
      for (let i = 0; i < N; i++) {
        dots.push({ user: 'C', kind: 'data', label: String(i + 1), legs: legsFor(PATH.C, sendC(i)) });
        arrivals.C.push(sendC(i) + 4);
      }
      for (let k = 0; k < 4; k++) resv.push({ link: PATH.C[k] + '-' + PATH.C[k + 1], user: 'C', from: relA + k, to: endC });

      badges.push({ x: 150, y: 266, text: '話中…待つ', cls: 'bad', from: 2, to: relA });
      if (pause) badges.push({ x: 340, y: 100, text: '通信していないのに占有中!', cls: 'warn', from: idleFrom, to: idleTo });

      events.push({ t: 0, text: 'Aさん→Bさん:「つないでください」と要求。通る回線を予約していく' });
      events.push({ t: 1, text: 'Cさん→Dさん も、つなぐように要求する' });
      events.push({ t: 2, text: '幹線はAさんが予約ずみ → 「話中」。Cさんはつながらない', cls: 'bad' });
      events.push({ t: SETUP, text: 'Aさん専用の回線ができた。データを送りはじめる' });
      if (pause) {
        events.push({ t: idleFrom, text: 'Aさんは通信を休み中。でも回線は占有したまま。Cさんは使えない', cls: 'warn' });
        events.push({ t: idleTo, text: 'Aさんが通信を再開' });
      }
      events.push({ t: relA, text: 'Aさんの通信が終わり、回線を開放。Cさんがかけなおす', cls: 'good' });
      events.push({ t: startC, text: 'Cさん専用の回線ができた。データを送りはじめる' });
      events.push({ t: endC, text: 'Cさんの通信が終わった', cls: 'good' });

      gantt.push({ row: 'A', from: 0, to: SETUP, cls: 'g-setup', label: '接続' });
      gantt.push({ row: 'A', from: SETUP, to: endA, cls: 'g-A', label: '通信' });
      if (pause) gantt.push({ row: 'A', from: idleFrom, to: idleTo, cls: 'g-idle', label: '休み' });
      gantt.push({ row: 'C', from: 1, to: relA, cls: 'g-wait', label: '話中・待つ' });
      gantt.push({ row: 'C', from: relA, to: startC, cls: 'g-setup', label: '接続' });
      gantt.push({ row: 'C', from: startC, to: endC, cls: 'g-C', label: '通信' });

      events.sort((a, b) => a.t - b.t);
      return { dots, resv, badges, gantt, events, arrivals, endA, endC, firstC: sendC(0) + 4, end: endC };
    }

    /* --- パケット交換のスケジュールを作る --- */
    function buildPacket(pause) {
      const P = pause ? PAUSE_LEN : 0;
      const sendA = (i) => i + (i >= PAUSE_AFTER ? P : 0);
      const idleFrom = sendA(PAUSE_AFTER - 1) + 1;
      const idleTo = sendA(PAUSE_AFTER);

      const pk = [];
      for (let i = 0; i < N; i++) pk.push({ user: 'A', i, send: sendA(i) });
      for (let i = 0; i < N; i++) pk.push({ user: 'C', i, send: 1 + i });
      pk.forEach((p) => { p.arr = p.send + 1; });          // ルータR1に着く時刻

      // 幹線は1コマに1パケット。先に着いた順に送り出す(順番待ち)
      const rest = pk.slice().sort((a, b) =>
        a.arr - b.arr || (a.user === b.user ? 0 : a.user === 'A' ? -1 : 1) || a.i - b.i);
      let t = 0;
      while (rest.length) {
        let idx = rest.findIndex((p) => p.arr <= t);
        if (idx < 0) { t = rest[0].arr; idx = 0; }
        const p = rest.splice(idx, 1)[0];
        p.dep = t;
        t += 1;
      }

      const dots = [], badges = [], gantt = [], events = [];
      const arrivals = { A: [], C: [] };
      pk.forEach((p) => {
        const path = PATH[p.user];
        dots.push({
          user: p.user, kind: 'data', label: String(p.i + 1), dep: p.dep,
          legs: [
            { from: path[0], to: 'R1', t0: p.send, t1: p.send + 1 },
            { from: 'R1', to: 'R2', t0: p.dep, t1: p.dep + 1 },
            { from: 'R2', to: 'R3', t0: p.dep + 1, t1: p.dep + 2 },
            { from: 'R3', to: path[4], t0: p.dep + 2, t1: p.dep + 3 }
          ]
        });
        arrivals[p.user].push(p.dep + 3);
      });
      const endA = Math.max.apply(null, arrivals.A);
      const endC = Math.max.apply(null, arrivals.C);
      const firstC = Math.min.apply(null, arrivals.C);

      if (pause) badges.push({ x: 150, y: 30, text: '休み中 → 幹線があく', cls: 'warn', from: idleFrom, to: idleTo });

      const firstWait = pk.filter((p) => p.dep > p.arr).sort((a, b) => a.arr - b.arr)[0];

      events.push({ t: 0, text: 'Aさんはデータを6個のパケットに分けて、送りはじめる(接続の準備はいらない)' });
      events.push({ t: 1, text: 'Cさんも同時に送りはじめる。幹線はパケット1個ずつ、交代で使われる' });
      if (firstWait) events.push({ t: firstWait.arr, text: '幹線が使用中のパケットは、ルータで順番待ち(キュー)' });
      if (pause) {
        events.push({ t: idleFrom, text: 'Aさんが休み中 → 空いた幹線を、Cさんのパケットが使える', cls: 'good' });
        events.push({ t: idleTo, text: 'Aさんが通信を再開' });
      }
      events.push({ t: endA, text: 'Aさんの6個が、すべてBさんに届いた', cls: 'good' });
      events.push({ t: endC, text: 'Cさんの6個が、すべてDさんに届いた', cls: 'good' });

      gantt.push({ row: 'A', from: 0, to: endA, cls: 'g-A', label: '通信' });
      if (pause) gantt.push({ row: 'A', from: idleFrom, to: idleTo, cls: 'g-free', label: '休み' });
      gantt.push({ row: 'C', from: 1, to: endC, cls: 'g-C', label: '通信' });

      events.sort((a, b) => a.t - b.t);
      return { dots, resv: [], badges, gantt, events, arrivals, endA, endC, firstC, end: Math.max(endA, endC) };
    }

    /* --- 1つの図(パネル)を作る --- */
    function createPanel(mode) {
      const isCircuit = mode === 'circuit';
      const host = $('#net-' + mode);
      const logEl = $('#log-' + mode);
      const ganttEl = $('#gantt-' + mode);

      const svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'net-svg', role: 'img',
        'aria-label': isCircuit ? '回線交換方式のネットワーク図' : 'パケット交換方式のネットワーク図'
      });
      host.appendChild(svg);
      const gLinks = svgEl('g'), gNodes = svgEl('g'), gRecv = svgEl('g'), gBadge = svgEl('g'), gDots = svgEl('g'), gTop = svgEl('g');
      [gLinks, gNodes, gRecv, gBadge, gDots, gTop].forEach((g) => svg.appendChild(g));

      const linkEls = {};
      LINKS.forEach((pair) => {
        const a = pair[0], b = pair[1];
        const trunk = (a === 'R1' && b === 'R2') || (a === 'R2' && b === 'R3');
        const ln = svgEl('line', { x1: NODES[a].x, y1: NODES[a].y, x2: NODES[b].x, y2: NODES[b].y });
        ln.dataset.base = 'link' + (trunk ? ' trunk' : '');
        ln.setAttribute('class', ln.dataset.base);
        gLinks.appendChild(ln);
        linkEls[a + '-' + b] = ln;
      });
      gLinks.appendChild(svgEl('text', { x: 340, y: 192, 'text-anchor': 'middle', class: 'trunk-label' }, '共用の回線(幹線)'));

      Object.keys(NODES).forEach((id) => {
        const n = NODES[id];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'node ' + n.kind });
        if (n.kind === 'end') {
          g.appendChild(svgEl('circle', { r: 22, fill: COLOR[n.user] }));
          g.appendChild(svgEl('text', { y: 8, 'text-anchor': 'middle', class: 'node-letter' }, id));
          g.appendChild(svgEl('text', { y: 42, 'text-anchor': 'middle', class: 'node-name' }, n.name));
        } else {
          g.appendChild(svgEl('rect', { x: -34, y: -17, width: 68, height: 34, rx: 8 }));
          g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle', class: 'node-sw' }, isCircuit ? '交換機' : 'ルータ'));
        }
        gNodes.appendChild(g);
      });

      const recv = {};
      ['B', 'D'].forEach((id) => {
        const n = NODES[id];
        const rects = [];
        for (let i = 0; i < N; i++) {
          const r = svgEl('rect', { x: n.x - (N * 13) / 2 + i * 13, y: n.y + 52, width: 11, height: 11, rx: 2, class: 'sq' });
          gRecv.appendChild(r);
          rects.push(r);
        }
        const tx = svgEl('text', { x: n.x, y: n.y + 78, 'text-anchor': 'middle', class: 'recv-text' }, '受信 0/' + N);
        gRecv.appendChild(tx);
        recv[id] = { rects, tx, user: n.user };
      });

      const qLabel = svgEl('text', { x: NODES.R1.x + 18, y: 0, class: 'q-label' }, '順番待ち(キュー)');
      qLabel.style.display = 'none';
      gTop.appendChild(qLabel);

      let data = null, Tmax = 1, logCount = -1;
      const phEls = [];

      function makeBadge(b) {
        const g = svgEl('g', { class: 'badge ' + (b.cls || ''), transform: 'translate(' + b.x + ',' + b.y + ')' });
        const w = b.text.length * 13.5 + 24;
        g.appendChild(svgEl('rect', { x: -w / 2, y: -14, width: w, height: 28, rx: 14 }));
        g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle' }, b.text));
        g.style.display = 'none';
        return g;
      }
      function makeDot(dot) {
        const g = svgEl('g', { class: 'dot ' + dot.kind });
        const col = COLOR[dot.user];
        if (dot.kind === 'data') {
          g.appendChild(svgEl('rect', { x: -11, y: -9, width: 22, height: 18, rx: 4, fill: col }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, dot.label));
        } else if (dot.busy) {
          g.appendChild(svgEl('rect', { x: -21, y: -11, width: 42, height: 22, rx: 11, fill: '#d92d20' }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, '話中'));
        } else {
          g.appendChild(svgEl('circle', { r: 11, fill: '#fff', stroke: col, 'stroke-width': 3, 'stroke-dasharray': '4 3' }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-q', fill: col }, '☎'));
        }
        g.style.display = 'none';
        return g;
      }
      function buildGantt() {
        clearEl(ganttEl);
        phEls.length = 0;
        const cap = document.createElement('div');
        cap.className = 'g-cap';
        cap.textContent = '時間の使われ方(黒い線が今の時刻)';
        ganttEl.appendChild(cap);
        ['A', 'C'].forEach((row) => {
          const r = document.createElement('div');
          r.className = 'g-row';
          const lab = document.createElement('span');
          lab.className = 'g-label ' + row.toLowerCase();
          lab.textContent = row === 'A' ? 'A→B' : 'C→D';
          const track = document.createElement('div');
          track.className = 'g-track';
          data.gantt.filter((g) => g.row === row).forEach((g) => {
            const bar = document.createElement('div');
            bar.className = 'g-bar ' + g.cls;
            bar.style.left = (g.from / Tmax) * 100 + '%';
            bar.style.width = ((g.to - g.from) / Tmax) * 100 + '%';
            bar.textContent = g.label;
            track.appendChild(bar);
          });
          const ph = document.createElement('i');
          ph.className = 'ph';
          track.appendChild(ph);
          phEls.push(ph);
          r.appendChild(lab);
          r.appendChild(track);
          ganttEl.appendChild(r);
        });
      }

      function load(d, tmax) {
        data = d; Tmax = tmax; logCount = -1;
        clearEl(gBadge); clearEl(gDots); clearEl(logEl);
        d.badges.forEach((b) => { b.el = makeBadge(b); gBadge.appendChild(b.el); });
        d.dots.forEach((dot) => { dot.el = makeDot(dot); gDots.appendChild(dot.el); });
        buildGantt();
      }

      function render(t) {
        if (!data) return;
        // 回線の色
        Object.keys(linkEls).forEach((id) => linkEls[id].setAttribute('class', linkEls[id].dataset.base));
        data.resv.forEach((r) => {
          if (t >= r.from && t < r.to) linkEls[r.link].setAttribute('class', linkEls[r.link].dataset.base + ' resv-' + r.user);
        });
        // 点(要求・パケット)
        const waiting = [];
        data.dots.forEach((dot) => {
          const p = posAlong(dot.legs, t, NODES);
          if (!p) { dot.el.style.display = 'none'; return; }
          dot.el.style.display = '';
          if (p.waiting && p.node === 'R1' && dot.kind === 'data') { waiting.push(dot); return; }
          dot.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')');
          if (dot.kind === 'data' && !p.waiting) {
            const L = dot.legs[p.leg];
            const ln = linkEls[L.from + '-' + L.to];
            if (ln && !/resv-/.test(ln.getAttribute('class'))) ln.setAttribute('class', ln.dataset.base + ' use-' + dot.user);
          }
        });
        waiting.sort((a, b) => a.dep - b.dep).forEach((dot, rank) => {
          dot.el.setAttribute('transform', 'translate(' + NODES.R1.x + ',' + (NODES.R1.y - 34 - rank * 19) + ')');
        });
        if (waiting.length) {
          qLabel.style.display = '';
          qLabel.setAttribute('y', String(NODES.R1.y - 34 - (waiting.length - 1) * 19 + 4));
        } else {
          qLabel.style.display = 'none';
        }
        // ふきだし
        data.badges.forEach((b) => { b.el.style.display = t >= b.from && t < b.to ? '' : 'none'; });
        // 受信
        ['B', 'D'].forEach((id) => {
          const user = recv[id].user;
          const cnt = data.arrivals[user].filter((x) => x <= t).length;
          recv[id].rects.forEach((r, i) => r.setAttribute('class', 'sq' + (i < cnt ? ' on-' + user : '')));
          recv[id].tx.textContent = '受信 ' + cnt + '/' + N;
        });
        // ガントの現在線
        phEls.forEach((ph) => { ph.style.left = (t / Tmax) * 100 + '%'; });
        // ログ
        const shown = data.events.filter((e) => e.t <= t);
        if (shown.length !== logCount) {
          logCount = shown.length;
          logEl.innerHTML = shown.length
            ? shown.map((e) => '<li class="' + (e.cls || '') + '"><span class="t">時刻 ' + Math.floor(e.t) + '</span>' + e.text + '</li>').join('')
            : '<li class="empty">「スタート」をおすと、ここに動きの説明が出ます</li>';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      return { load, render };
    }

    /* --- コントローラ --- */
    let circuit, packet, dataC, dataP, Tmax = 30, clock;

    function init() {
      circuit = createPanel('circuit');
      packet = createPanel('packet');
      clock = new Clock(onFrame);
      clock.rate = parseFloat($('#p1-speed').value);
      clock.onState = updatePlayLabel;

      $('#p1-play').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p1-step').addEventListener('click', () => { clock.pause(); clock.seek(Math.floor(clock.t + 1e-6) + 1); });
      $('#p1-reset').addEventListener('click', () => clock.reset());
      $('#p1-speed').addEventListener('change', (e) => { clock.rate = parseFloat(e.target.value); });
      $('#p1-pause').addEventListener('change', () => { rebuild(); });
      $('#p1-seek').addEventListener('input', (e) => { clock.pause(); clock.seek(parseFloat(e.target.value)); });
      stopAll.push(() => clock.pause());
      rebuild();
    }

    function rebuild() {
      const pause = $('#p1-pause').checked;
      dataC = buildCircuit(pause);
      dataP = buildPacket(pause);
      Tmax = Math.max(dataC.end, dataP.end) + 1;
      clock.max = Tmax;
      $('#p1-seek').max = String(Tmax);
      circuit.load(dataC, Tmax);
      packet.load(dataP, Tmax);
      clock.reset();
    }

    function updatePlayLabel() {
      const b = $('#p1-play');
      if (clock.playing) b.textContent = '⏸ 一時停止';
      else if (clock.t >= clock.max) b.textContent = '↻ もういちど';
      else if (clock.t > 0) b.textContent = '▶ つづける';
      else b.textContent = '▶ スタート';
    }

    function onFrame(t) {
      circuit.render(t);
      packet.render(t);
      $('#p1-seek').value = String(t);
      $('#p1-clock').textContent = String(Math.floor(t));
      const cell = (id, val) => { $('#' + id).textContent = t >= val ? String(val) : '…'; };
      cell('r-endA-c', dataC.endA); cell('r-endA-p', dataP.endA);
      cell('r-firstC-c', dataC.firstC); cell('r-firstC-p', dataP.firstC);
      cell('r-endC-c', dataC.endC); cell('r-endC-p', dataP.endC);
      const tk = $('#p1-takeaway');
      if (t >= Math.max(dataC.end, dataP.end)) {
        const early = dataC.endC - dataP.endC;
        const dA = dataP.endA - dataC.endA;
        let s = '回線交換では、Cさんは回線があくまで待たされて、時刻 ' + dataC.endC + ' に終わりました。パケット交換では時刻 ' + dataP.endC + ' に終わり、' + early + ' コマ早くなりました。';
        s += $('#p1-pause').checked
          ? ' Aさんが休んでいる間の空きを、パケット交換ではCさんが使えたからです。'
          : ' 幹線をパケット1個ずつ交代で使えるので、回線がむだなく使われます。';
        s += dA > 0 ? ' そのかわり、Aさんの終わりは ' + dA + ' コマおそくなりました。' : dA < 0 ? ' Aさんも ' + (-dA) + ' コマ早く終わりました。' : ' Aさんの終わる時刻は変わりません。';
        tk.textContent = s;
        tk.hidden = false;
      } else {
        tk.hidden = true;
      }
    }

    return { init };
  })();

  /* ==========================================================
     第2部: パケット交換を体験する
     ========================================================== */
  const P2 = (function () {
    const MSS = 1460;   // 1パケットに入るデータの最大(バイト)
    const HDR = 40;     // ヘッダの大きさ(IP 20 + TCP 20)
    const SRC = '198.51.100.24';
    const DST = '203.0.113.80';
    const DOMAIN = 'www.example.jp';

    const KINDS = {
      small:  { key: 'small',  label: '小', icon: '📝', name: 'テキスト(メール本文)',     bytes: 4000,  ratio: 0.4 },
      medium: { key: 'medium', label: '中', icon: '🖼️', name: '画像(圧縮していない写真)', bytes: 12000, ratio: 0.5 },
      large:  { key: 'large',  label: '大', icon: '🎞️', name: '動画(圧縮していない)',     bytes: 36000, ratio: 0.5 }
    };
    const ROUTES = [
      { id: 'up',  name: '上の経路', via: ['R2', 'R5'], d: 0.85, color: '#1d6fe0' },
      { id: 'mid', name: '中の経路', via: ['R3', 'R6'], d: 0.55, color: '#0d8a7a' },
      { id: 'low', name: '下の経路', via: ['R4', 'R7'], d: 1.15, color: '#7b3fe4' }
    ];
    const NODES = {
      PC:  { x: 48,  y: 160 },
      R1:  { x: 150, y: 160 },
      R2:  { x: 290, y: 56 },  R5: { x: 430, y: 56 },
      R3:  { x: 290, y: 160 }, R6: { x: 430, y: 160 },
      R4:  { x: 290, y: 264 }, R7: { x: 430, y: 264 },
      R8:  { x: 570, y: 160 },
      SRV: { x: 668, y: 160 }
    };
    const LINKS2 = [
      ['PC', 'R1', ''], ['R1', 'R2', 'up'], ['R1', 'R3', 'mid'], ['R1', 'R4', 'low'],
      ['R2', 'R5', 'up'], ['R3', 'R6', 'mid'], ['R4', 'R7', 'low'],
      ['R5', 'R8', 'up'], ['R6', 'R8', 'mid'], ['R7', 'R8', 'low'], ['R8', 'SRV', '']
    ];

    const state = { size: 'small', compress: false, loss: false, step: 0, sim: null, simKey: '', selPkt: 1 };
    const ui = { clock: null, sim: null, nodeEls: {}, slots: [], chips: null, chipCount: -1, logEl: null, logCount: -1 };

    /* --- パケットの計画(分割) --- */
    function plan(sizeKey, compress) {
      const k = KINDS[sizeKey];
      const sendBytes = compress ? Math.round(k.bytes * k.ratio) : k.bytes;
      const chunks = [];
      let rem = sendBytes;
      while (rem > 0) { const c = Math.min(MSS, rem); chunks.push(c); rem -= c; }
      return {
        kind: k, orig: k.bytes, sendBytes, chunks, count: chunks.length,
        headerTotal: chunks.length * HDR, total: sendBytes + chunks.length * HDR
      };
    }
    const curPlan = () => plan(state.size, state.compress);

    /* --- ネットワークを通す様子のシミュレーション --- */
    function buildSim(pl, loss) {
      const N = pl.count;
      const gap = Math.min(0.45, 7 / N);
      const journeys = [], events = [];

      function makeJourney(no, depart, retrans, lost) {
        const r = ROUTES[Math.floor(Math.random() * ROUTES.length)];
        const path = ['PC', 'R1', r.via[0], r.via[1], 'R8', 'SRV'];
        const jit = () => r.d * (0.8 + Math.random() * 0.5);
        const durs = [0.5, jit(), jit(), jit(), 0.5];
        const legs = [];
        let t = depart;
        for (let i = 0; i < durs.length; i++) {
          legs.push({ from: path[i], to: path[i + 1], t0: t, t1: t + durs[i], frac: 1 });
          t += durs[i];
        }
        const j = { kind: 'data', no, retrans, route: r, legs, arr: t, lost: false, depart };
        if (lost) {
          const li = 1 + Math.floor(Math.random() * 3);
          const frac = 0.45 + Math.random() * 0.35;
          const L = legs[li];
          const tl = L.t0 + (L.t1 - L.t0) * frac;
          legs.length = li + 1;
          L.t1 = tl; L.frac = frac;
          const a = NODES[L.from], b = NODES[L.to];
          j.lost = true; j.arr = null;
          j.lostMarker = { t: tl, x: lerp(a.x, b.x, frac), y: lerp(a.y, b.y, frac) };
        }
        journeys.push(j);
        return j;
      }

      // 1回目の送信
      const lostSet = new Set();
      if (loss) {
        const want = Math.min(N >= 8 ? 2 : 1, N - 1);
        const nos = shuffle(Array.from({ length: N }, (_, i) => i + 1));
        for (let k = 0; k < want; k++) lostSet.add(nos[k]);
      }
      for (let i = 1; i <= N; i++) makeJourney(i, (i - 1) * gap, false, lostSet.has(i));

      const firstOk = journeys.filter((j) => !j.lost);
      const lastFirst = Math.max.apply(null, firstOk.map((j) => j.arr));
      events.push({ t: 0, text: 'PCがパケットを1つずつ送り出す。ルータはヘッダの宛先IPアドレスを見て、それぞれ次の行き先を決める' });

      // 消えたパケットの再送
      if (lostSet.size) {
        const missing = Array.from(lostSet).sort((a, b) => a - b);
        const tDetect = lastFirst + 0.7;
        const rp = ['SRV', 'R8', 'R6', 'R3', 'R1', 'PC'];
        const rl = [];
        let t = tDetect;
        for (let i = 0; i < rp.length - 1; i++) {
          rl.push({ from: rp[i], to: rp[i + 1], t0: t, t1: t + 0.5, frac: 1 });
          t += 0.5;
        }
        journeys.push({ kind: 'req', label: '再送要求', legs: rl, arr: t });
        journeys.filter((j) => j.lost).forEach((j) => {
          events.push({ t: j.lostMarker.t, cls: 'bad', text: '✕ パケット' + j.no + ' が途中で消えた(混雑や故障など)' });
        });
        events.push({ t: tDetect, cls: 'warn', text: '受信側「' + missing.join('番・') + '番が届いていない」→ 送信側に再送を要求' });
        events.push({ t: t, text: '送信側が要求を受け取り、' + missing.join('番・') + '番だけをもう一度送る' });
        missing.forEach((no, k) => makeJourney(no, t + k * gap, true, false));
      }

      // 到着リスト
      const arrivals = journeys
        .filter((j) => j.kind === 'data' && !j.lost)
        .map((j) => ({ no: j.no, t: j.arr, route: j.route, color: j.route.color, retrans: j.retrans }))
        .sort((a, b) => a.t - b.t);
      let maxNo = 0, ooo = 0;
      arrivals.forEach((a) => {
        a.ooo = !a.retrans && a.no < maxNo;
        if (a.ooo) ooo++;
        if (!a.retrans) maxNo = Math.max(maxNo, a.no);
        events.push({
          t: a.t,
          cls: a.retrans ? 'good' : a.ooo ? 'warn' : '',
          text: 'パケット' + a.no + ' が到着(' + a.route.name + (a.retrans ? '・再送' : '') + ')' + (a.ooo ? ' ← 追いこされて、順番が入れかわった' : '')
        });
      });
      const allDone = arrivals[arrivals.length - 1].t;
      events.push({ t: allDone, cls: 'good', text: 'すべて届いた。番号順にならべれば元のデータにもどせる' });
      events.sort((a, b) => a.t - b.t);
      return { journeys, events, arrivals, ooo, lost: Array.from(lostSet), T: allDone + 0.8 };
    }

    function ensureSim(force) {
      const key = [state.size, state.compress, state.loss].join('|');
      if (force || !state.sim || state.simKey !== key) {
        state.sim = buildSim(curPlan(), state.loss);
        state.simKey = key;
      }
      return state.sim;
    }

    /* --- ステップの定義 --- */
    const STEPS = [
      { id: 'dns',      short: '宛先を調べる' },
      { id: 'data',     short: '元のデータ' },
      { id: 'compress', short: '圧縮する' },
      { id: 'split',    short: '分割する' },
      { id: 'header',   short: 'ヘッダをつける' },
      { id: 'send',     short: 'ネットワークを通す' },
      { id: 'recv',     short: '受信・復元' }
    ];

    function pktCard(i, size, total, withHdr, idx, tag) {
      const w = Math.round(52 + (48 * size) / MSS);
      const t = tag || 'span';
      const extra = t === 'button' ? ' type="button" data-no="' + (i + 1) + '"' : '';
      return '<' + t + ' class="pkt" style="--pc:' + pastel(i) + ';--d:' + Math.min(idx * 0.05, 1.4).toFixed(2) + 's"' + extra + '>' +
        (withHdr ? '<span class="hdr">ヘッダ</span>' : '') +
        '<span class="pl" style="min-width:' + w + 'px"><b>' + (i + 1) + '/' + total + '</b><small>' + fmt(size) + 'B</small></span></' + t + '>';
    }

    function barRow(label, bytes, maxBytes, cls, extraCls) {
      return '<div class="bar-row ' + (extraCls || '') + '"><span class="lab">' + label + '</span>' +
        '<div class="bar-track"><div class="bar ' + cls + '" style="width:' + (bytes / maxBytes) * 100 + '%"></div></div>' +
        '<span class="val">' + fmt(bytes) + ' バイト</span></div>';
    }

    function renderStepContent(id) {
      const pl = curPlan();
      const k = pl.kind;
      switch (id) {
        case 'dns':
          return {
            title: '宛先を調べる',
            lead: 'パケットのヘッダに書く宛先は「IPアドレス」です。まず、ドメイン名からDNSでIPアドレスを調べます。',
            html:
              '<div class="dns-scene">' +
              '<div class="nodecard"><span class="ic">💻</span><b>自分のPC</b><br><code>' + SRC + '</code></div>' +
              '<div class="bubbles">' +
              '<div class="bubble q">① 「<b>' + DOMAIN + '</b> のIPアドレスを教えて」</div>' +
              '<div class="bubble a">② 「<b class="mono">' + DST + '</b> です」</div>' +
              '</div>' +
              '<div class="nodecard"><span class="ic">📖</span><b>DNSサーバ</b><small>ドメイン名 ⇔ IPアドレス</small></div>' +
              '</div>' +
              '<p class="dns-result">送り先(宛先IPアドレス)が分かった → <code>' + DST + '</code>　これから、全パケットのヘッダに書きます。</p>' +
              '<p class="fine" style="margin-top:8px;">※ IPアドレスは、学習用に予約されている番号です。</p>',
            point: 'ドメイン名 → IPアドレス の変換は、DNSの仕事。パケットの宛先は、IPアドレスで書きます。'
          };

        case 'data':
          return {
            title: '元のデータ',
            lead: k.icon + ' 「' + k.name + '」を送ります。大きさは ' + fmt(pl.orig) + ' バイトです。',
            html:
              '<div class="kindcard"><span class="ic">' + k.icon + '</span><div><b>' + k.name + '</b><br><span class="fine">大きさ:' + k.label + '(' + fmt(pl.orig) + ' バイト)</span></div></div>' +
              Object.keys(KINDS).map((key) => {
                const kk = KINDS[key];
                return barRow(kk.icon + ' ' + kk.label, kk.bytes, KINDS.large.bytes, key === state.size ? 'sel' : 'orig', key === state.size ? '' : 'dim');
              }).join(''),
            point: '送るデータが大きいほど、あとで必要になるパケットの数が増えます。'
          };

        case 'compress': {
          const on = state.compress;
          const comp = plan(state.size, true);
          return {
            title: '圧縮する',
            lead: on
              ? 'データを圧縮して、バイト数を減らしてから送ります。受け取った側で「展開」すると、元にもどります(ZIPなど)。'
              : '今は「圧縮しない」設定です。そのまま送ります。',
            html:
              barRow('元のデータ', pl.orig, pl.orig, 'orig') +
              (on
                ? '<div class="bar-row"><span class="lab">圧縮後</span><div class="bar-track"><div class="bar comp" id="comp-bar" style="width:100%"></div></div><span class="val">' + fmt(comp.sendBytes) + ' バイト</span></div>' +
                  '<p class="equation">' + fmt(pl.orig) + ' → <code>' + fmt(comp.sendBytes) + '</code> バイト(元の ' + Math.round(k.ratio * 100) + '%)</p>' +
                  '<p class="equation">パケットの数: ' + plan(state.size, false).count + ' 個 → <code>' + comp.count + ' 個</code></p>'
                : '<p class="fine" style="margin:10px 0;">圧縮すると、この ' + fmt(pl.orig) + ' バイトが ' + fmt(comp.sendBytes) + ' バイトになります。</p>' +
                  '<button class="btn" type="button" id="btn-comp-on">圧縮をONにして見る</button>'),
            point: on
              ? '圧縮すると、送るバイト数が減り、パケットの数も減ります。JPEG や MP3 など、すでに圧縮されたデータは、あまり小さくなりません。'
              : '圧縮は必須ではありません。データが大きいときや、回線が遅いときに役立ちます。',
            after: () => {
              const bar = $('#comp-bar');
              if (bar) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = (comp.sendBytes / pl.orig) * 100 + '%'; }));
              const btn = $('#btn-comp-on');
              if (btn) btn.addEventListener('click', () => { $('#p2-compress').checked = true; settingsChanged(); });
            }
          };
        }

        case 'split':
          return {
            title: '分割する',
            lead: '1つのパケットに入るデータの大きさには上限があります(ここでは ' + fmt(MSS) + ' バイト)。上限をこえるデータは、分割して送ります。',
            html:
              '<p class="equation">' + fmt(pl.sendBytes) + ' バイト ÷ ' + fmt(MSS) + ' バイト → <code>' + pl.count + ' 個</code>のパケット' + (state.compress ? '(圧縮ずみ)' : '') + '</p>' +
              '<div class="pkts">' + pl.chunks.map((c, i) => pktCard(i, c, pl.count, false, i)).join('') + '</div>' +
              '<p class="fine">数字は「何番目 / 全部で何個」。最後のパケットは、あまりのぶんだけ小さくなります。</p>',
            point: '大きなデータは、小さなパケットに分けて送ります。分けたものに番号をつけるのは、次のステップです。'
          };

        case 'header':
          return {
            title: 'ヘッダをつける',
            lead: '分けたデータの前に「ヘッダ」をつけます。ヘッダには、届けるために必要な情報が書かれます。パケットをクリックして、中を見てみよう。',
            html:
              '<div class="pkts" id="hdr-pkts">' + pl.chunks.map((c, i) => pktCard(i, c, pl.count, true, i, 'button')).join('') + '</div>' +
              '<div class="inspector" id="inspector"></div>' +
              '<p class="equation" style="margin-top:12px;">ヘッダの大きさ <code>' + HDR + ' バイト</code> × ' + pl.count + ' 個 = ' + fmt(pl.headerTotal) + ' バイト増える → ネットワークに流れる合計 <code>' + fmt(pl.total) + ' バイト</code></p>',
            point: 'ヘッダのおかげで、パケットは1つずつ独立して届けられ、受信側で元の順に組み立てられます。かわりに、ヘッダの分だけデータが増えます。',
            after: () => {
              const paint = () => {
                $$('#hdr-pkts .pkt').forEach((b) => b.classList.toggle('sel', Number(b.dataset.no) === state.selPkt));
                $('#inspector').innerHTML = inspectorHtml(state.selPkt, pl);
              };
              state.selPkt = Math.min(state.selPkt, pl.count);
              $$('#hdr-pkts .pkt').forEach((b) => b.addEventListener('click', () => { state.selPkt = Number(b.dataset.no); paint(); }));
              paint();
            }
          };

        case 'send': {
          const sim = ensureSim();
          return {
            title: 'ネットワークを通す',
            lead: 'パケットを1つずつ送り出します。ルータはヘッダの宛先IPアドレスを見て、次にどこへ送るかを決めます(ルーティング)。',
            html:
              '<div class="send-tools">' +
              '<button class="btn primary" type="button" id="p2-play">⏸ 一時停止</button>' +
              '<button class="btn" type="button" id="p2-replay">↺ もういちど送る</button>' +
              '<label class="field">速さ <select id="p2-speed"><option value="0.5">ゆっくり</option><option value="1" selected>ふつう</option><option value="2">はやい</option></select></label>' +
              '</div>' +
              '<div class="seekbar"><span>時間</span><input type="range" id="p2-seek" min="0" max="' + sim.T.toFixed(2) + '" step="0.02" value="0" aria-label="時間を動かす"></div>' +
              '<div class="net2" id="net2"></div>' +
              '<p class="legend"><span class="dotkey up"></span>上の経路 <span class="dotkey mid"></span>中の経路 <span class="dotkey low"></span>下の経路 / 点の数字は「パケット番号」/ <b>もういちど</b>を押すと、通る経路が変わります</p>' +
              '<div class="recv">' +
              '<div><h4>届いた順(先に着いたものが左)</h4><div class="chips" id="chips"></div></div>' +
              '<div><h4>受信側の入れもの(パケット番号のところに入る)</h4><div class="slots" id="slots"></div></div>' +
              '</div>' +
              '<div class="done-msg" id="p2-done" hidden>✔ すべてのパケットがそろいました。「次へ」で受信側の復元を見よう。</div>' +
              '<ul class="log" id="log2"></ul>',
            point: state.loss
              ? '同じデータのパケットでも、通る経路はバラバラで、届く順番も入れかわります。消えたパケットは、受信側が番号で気づいて、そのパケットだけ再送してもらいます。'
              : '同じデータのパケットでも、通る経路はバラバラで、届く順番も入れかわることがあります。それでも、番号があるので元にもどせます。',
            after: () => setupSend()
          };
        }

        case 'recv': {
          const sim = ensureSim();
          const comp = state.compress;
          const chips = sim.arrivals.map((a) => '<span class="chip' + (a.retrans ? ' re' : '') + '" style="background:' + a.color + '">' + a.no + '</span>').join('');
          const sorted = pl.chunks.map((c, i) => pktCard(i, c, pl.count, false, 0).replace('class="pkt"', 'class="pkt small"')).join('');
          return {
            title: '受信して、元にもどす',
            lead: '宛先のコンピュータが、届いたパケットから元のデータを組み立てます。',
            html:
              '<div class="flow">' +
              '<div class="step" style="animation-delay:0s"><h4>① 届いた順(バラバラ)</h4><div class="chips">' + chips + '</div>' +
              '<p class="fine" style="margin-top:4px;">' + (sim.ooo > 0 ? '先に着いたパケットに追いこされて、順番が入れかわったものが ' + sim.ooo + ' 個ありました。' : '今回は、たまたま順番どおりに届きました。') +
              (sim.lost.length ? ' 消えた ' + sim.lost.join('番・') + '番は、再送してもらいました(点線の枠)。' : '') + '</p></div>' +
              '<div class="arrow" style="animation-delay:.7s">▼ ヘッダの「パケット番号」を見て、番号順にならべる</div>' +
              '<div class="step" style="animation-delay:1.2s"><h4>② 番号順</h4><div class="pkts">' + sorted + '</div></div>' +
              '<div class="arrow" style="animation-delay:1.9s">▼ ヘッダをはずして、データ部分だけをつなぐ' + (comp ? ' → 圧縮を展開する' : '') + '</div>' +
              '<div class="final" style="animation-delay:2.5s">' + pl.kind.icon + ' 元のデータにもどった! ' + fmt(pl.orig) + ' バイト' +
              (comp ? '(' + fmt(pl.sendBytes) + ' → ' + fmt(pl.orig) + ' バイトに展開)' : '') + '</div>' +
              '</div>',
            point: '番号のおかげで、順番がバラバラでも元通り。もう一度ためすなら、上の設定を変えて、最初のステップから見なおしてみよう。'
          };
        }
      }
      return { title: '', lead: '', html: '', point: '' };
    }

    function inspectorHtml(no, pl) {
      const size = pl.chunks[no - 1];
      return '<h4>パケット ' + no + ' のヘッダ(ヘッダ全体で ' + HDR + ' バイト)</h4>' +
        '<table>' +
        '<tr><th>宛先IPアドレス</th><td class="v">' + DST + '</td><td class="h">荷物の「あて先」。ルータはこれを見て、転送先を決める</td></tr>' +
        '<tr><th>送信元IPアドレス</th><td class="v">' + SRC + '</td><td class="h">再送の要求や返事を返すときに使う</td></tr>' +
        '<tr><th>パケット番号</th><td class="v">' + no + ' / ' + pl.count + '</td><td class="h">受信側が、正しい順にならべるための番号</td></tr>' +
        '<tr><th>TTL(生存時間)</th><td class="v">64</td><td class="h">ルータを通るたびに1減り、0になると捨てられる(迷子で回り続けるのを防ぐ)</td></tr>' +
        '<tr><th>データの長さ</th><td class="v">' + fmt(size) + ' バイト</td><td class="h">このパケットに入っているデータの量</td></tr>' +
        '</table>' +
        '<p class="fine" style="margin-top:6px;">※ 実際のヘッダは、IPヘッダ(約20バイト)とTCPヘッダ(約20バイト)などに分かれています。</p>';
    }

    /* --- 「ネットワークを通す」ステップの画面 --- */
    function setupSend() {
      const sim = ensureSim();
      ui.sim = sim;
      ui.slots = []; ui.chipCount = -1; ui.logCount = -1;
      ui.logEl = $('#log2');
      ui.chips = $('#chips');
      const pl = curPlan();

      // 受信の入れもの
      const slotsEl = $('#slots');
      for (let i = 1; i <= pl.count; i++) {
        const s = document.createElement('span');
        s.className = 'slot';
        s.textContent = String(i);
        slotsEl.appendChild(s);
        ui.slots.push(s);
      }

      // ネットワーク図
      const host = $('#net2');
      const svg = svgEl('svg', { viewBox: '0 0 720 320', role: 'img', 'aria-label': 'パケットが3つの経路に分かれて届く様子' });
      host.appendChild(svg);
      const gL = svgEl('g'), gN = svgEl('g'), gD = svgEl('g');
      [gL, gN, gD].forEach((g) => svg.appendChild(g));
      LINKS2.forEach((l) => {
        gL.appendChild(svgEl('line', { x1: NODES[l[0]].x, y1: NODES[l[0]].y, x2: NODES[l[1]].x, y2: NODES[l[1]].y, class: 'link2 ' + l[2] }));
      });
      ui.nodeEls = {};
      Object.keys(NODES).forEach((id) => {
        const n = NODES[id];
        const g = svgEl('g', { transform: 'translate(' + n.x + ',' + n.y + ')', class: 'nd' });
        if (id === 'PC' || id === 'SRV') {
          g.appendChild(svgEl('text', { y: 8, 'text-anchor': 'middle', class: 'em' }, id === 'PC' ? '💻' : '🖥️'));
          g.appendChild(svgEl('text', { y: 40, 'text-anchor': 'middle', class: 'cap' }, id === 'PC' ? '送信元のPC' : '宛先のサーバ'));
          g.appendChild(svgEl('text', { y: 55, 'text-anchor': 'middle', class: 'ip' }, id === 'PC' ? SRC : DST));
        } else {
          g.appendChild(svgEl('rect', { x: -21, y: -14, width: 42, height: 28, rx: 7 }));
          g.appendChild(svgEl('text', { y: 5, 'text-anchor': 'middle', class: 'r' }, id));
        }
        gN.appendChild(g);
        ui.nodeEls[id] = g;
      });
      sim.journeys.forEach((j) => {
        const g = svgEl('g');
        if (j.kind === 'data') {
          g.appendChild(svgEl('rect', {
            x: -13, y: -10, width: 26, height: 20, rx: 5, fill: j.route.color,
            stroke: j.retrans ? '#f59e0b' : '#fff', 'stroke-width': j.retrans ? 3 : 1.5,
            'stroke-dasharray': j.retrans ? '4 2' : ''
          }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'dot-t' }, String(j.no)));
        } else {
          g.appendChild(svgEl('rect', { x: -34, y: -11, width: 68, height: 22, rx: 11, fill: '#ffd84d', stroke: '#12263a', 'stroke-width': 2 }));
          g.appendChild(svgEl('text', { y: 4, 'text-anchor': 'middle', class: 'req-t' }, '再送要求'));
        }
        g.style.display = 'none';
        gD.appendChild(g);
        j.el = g;
        if (j.lostMarker) {
          const m = svgEl('g', { transform: 'translate(' + j.lostMarker.x.toFixed(1) + ',' + j.lostMarker.y.toFixed(1) + ')' });
          m.appendChild(svgEl('text', { y: 9, 'text-anchor': 'middle', class: 'lostx' }, '✕'));
          m.appendChild(svgEl('text', { x: -16, y: 4, 'text-anchor': 'end', class: 'lostt' }, '消えた!' + j.no));
          m.style.display = 'none';
          gD.appendChild(m);
          j.lostMarker.el = m;
        }
      });

      // 時計
      const clock = ui.clock;
      clock.max = sim.T;
      clock.rate = parseFloat($('#p2-speed').value);
      clock.onState = () => {
        const b = $('#p2-play');
        if (!b) return;
        b.textContent = clock.playing ? '⏸ 一時停止' : clock.t >= clock.max ? '↻ もういちど' : '▶ つづける';
      };
      $('#p2-play').addEventListener('click', () => { clock.playing ? clock.pause() : clock.play(); });
      $('#p2-replay').addEventListener('click', () => {
        clock.pause();
        ensureSim(true);
        goStep(state.step);   // 同じステップを作りなおす(経路が変わる)
      });
      $('#p2-speed').addEventListener('change', (e) => { clock.rate = parseFloat(e.target.value); });
      $('#p2-seek').addEventListener('input', (e) => { clock.pause(); clock.seek(parseFloat(e.target.value)); });
      clock.t = 0;
      renderSend(0);
      clock.play();
    }

    function renderSend(t) {
      const sim = ui.sim;
      if (!sim || !ui.logEl || !$('#net2')) return;
      const active = new Set();
      sim.journeys.forEach((j) => {
        const p = posAlong(j.legs, t, NODES);
        if (!p) {
          j.el.style.display = 'none';
        } else {
          j.el.style.display = '';
          j.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')');
          if (p.leg >= 1 && !p.waiting && t - j.legs[p.leg].t0 < 0.22) active.add(j.legs[p.leg].from);
        }
        if (j.lostMarker) j.lostMarker.el.style.display = t >= j.lostMarker.t && t < j.lostMarker.t + 1.8 ? '' : 'none';
      });
      Object.keys(ui.nodeEls).forEach((id) => {
        if (id !== 'PC' && id !== 'SRV') ui.nodeEls[id].setAttribute('class', 'nd' + (active.has(id) ? ' active' : ''));
      });

      const got = sim.arrivals.filter((a) => a.t <= t);
      // 受信の入れもの
      const byNo = {};
      got.forEach((a) => { byNo[a.no] = a; });
      ui.slots.forEach((s, i) => {
        const a = byNo[i + 1];
        const on = !!a;
        if (on && !s.classList.contains('on')) { s.classList.add('on'); s.style.background = a.color; }
        if (!on && s.classList.contains('on')) { s.classList.remove('on'); s.style.background = ''; }
      });
      // 届いた順
      if (got.length !== ui.chipCount) {
        ui.chipCount = got.length;
        ui.chips.innerHTML = got.length
          ? got.map((a) => '<span class="chip' + (a.retrans ? ' re' : '') + '" style="background:' + a.color + '">' + a.no + '</span>').join('')
          : '<span class="empty-note">まだ何も届いていません</span>';
      }
      // ログ
      const shown = sim.events.filter((e) => e.t <= t);
      if (shown.length !== ui.logCount) {
        ui.logCount = shown.length;
        ui.logEl.innerHTML = shown.map((e) => '<li class="' + (e.cls || '') + '">' + e.text + '</li>').join('');
        ui.logEl.scrollTop = ui.logEl.scrollHeight;
      }
      const seek = $('#p2-seek');
      if (seek) seek.value = String(t);
      const done = $('#p2-done');
      if (done) done.hidden = t < sim.T - 0.8;
    }

    /* --- 画面の切りかえ --- */
    function goStep(n) {
      ui.clock.pause();
      ui.clock.onState = null;
      ui.sim = null;
      state.step = clamp(n, 0, STEPS.length - 1);
      const id = STEPS[state.step].id;
      const c = renderStepContent(id);
      $('#p2-no').textContent = String(state.step + 1);
      $('#p2-title').textContent = c.title;
      $('#p2-lead').textContent = c.lead;
      $('#p2-body').innerHTML = c.html;
      $('#p2-point').textContent = c.point;
      $('#p2-prev').disabled = state.step === 0;
      $('#p2-next').textContent = state.step === STEPS.length - 1 ? '↺ 最初から' : '次へ ▶';
      renderStepper();
      if (c.after) c.after();
    }

    function renderStepper() {
      const ol = $('#p2-stepper');
      ol.innerHTML = STEPS.map((s, i) =>
        '<li><button type="button" data-i="' + i + '" class="' + (i === state.step ? 'now' : i < state.step ? 'done' : '') + '"' +
        (i === state.step ? ' aria-current="step"' : '') + '><span class="n">' + (i + 1) + '</span>' + s.short + '</button></li>'
      ).join('');
      $$('button', ol).forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.i))));
    }

    function renderSummary() {
      const a = plan(state.size, false), b = plan(state.size, true);
      const cs = state.compress ? 'sel' : '', ns = state.compress ? '' : 'sel';
      const row = (label, x, y, unit) =>
        '<tr><th>' + label + '</th><td class="num ' + ns + '">' + fmt(x) + ' ' + unit + '</td><td class="num ' + cs + '">' + fmt(y) + ' ' + unit + '</td></tr>';
      const cut = Math.round((1 - b.total / a.total) * 100);
      $('#p2-summary').innerHTML =
        '<thead><tr><th>' + a.kind.icon + ' ' + a.kind.name + '</th><th class="' + ns + '">圧縮しない</th><th class="' + cs + '">圧縮する</th></tr></thead><tbody>' +
        row('元のデータの大きさ', a.orig, b.orig, 'バイト') +
        row('送るデータの大きさ', a.sendBytes, b.sendBytes, 'バイト') +
        row('パケットの数', a.count, b.count, '個') +
        row('ヘッダの合計(' + HDR + 'バイト×個数)', a.headerTotal, b.headerTotal, 'バイト') +
        row('ネットワークに流れる合計', a.total, b.total, 'バイト') +
        '<tr><th>圧縮したときの変化</th><td colspan="2">流れるデータが約 <b>' + cut + '%</b> 減る(' + fmt(a.total) + ' → ' + fmt(b.total) + ' バイト)</td></tr></tbody>';
    }

    function settingsChanged() {
      state.size = ($('input[name="p2size"]:checked') || { value: 'small' }).value;
      state.compress = $('#p2-compress').checked;
      state.loss = $('#p2-loss').checked;
      state.sim = null;
      renderSummary();
      goStep(state.step);
    }

    function init() {
      ui.clock = new Clock(renderSend);
      stopAll.push(() => ui.clock.pause());
      $$('input[name="p2size"]').forEach((r) => r.addEventListener('change', settingsChanged));
      $('#p2-compress').addEventListener('change', settingsChanged);
      $('#p2-loss').addEventListener('change', settingsChanged);
      $('#p2-prev').addEventListener('click', () => goStep(state.step - 1));
      $('#p2-next').addEventListener('click', () => goStep(state.step === STEPS.length - 1 ? 0 : state.step + 1));
      renderSummary();
      goStep(0);
    }

    return { init };
  })();

  P1.init();
  P2.init();
})();
