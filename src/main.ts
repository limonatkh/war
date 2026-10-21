import './style.css';
import { GameAudio } from './audio';
import { GameView } from './render/view';
import { Battle, TICK } from './sim/battle';
import { UNIT_DEFS } from './sim/units';
import { BATTALION_NAMES, BLUE, TEAM_NAME, UNIT_TYPE_IDS, emptyInput, type Composition, type ControlInput, type OrderType, type SimEvent, type Team, type UnitTypeId } from './sim/types';
import { Hud } from './ui/hud';
import { PRESETS, showMenu, type MenuChoice } from './ui/menu';
import { showResult } from './ui/result';

const ui = document.getElementById('ui') as HTMLElement;

const ORDER_LABEL: Record<OrderType, string> = { move: 'Move', attack: 'Attack', defend: 'Defend', hold: 'Hold position', retreat: 'Retreat', capture: 'Capture', follow: 'Follow me' };

class App {
  private audio = new GameAudio();
  private canvas!: HTMLCanvasElement;
  private battle!: Battle;
  private view!: GameView;
  private hud!: Hud;
  private choice!: MenuChoice;
  private humanTeam: Team = BLUE;
  private slotId = 0;
  private role: MenuChoice['role'] = 'commander';

  private running = false;
  private paused = false;
  private speed = 1;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private endAt = -1;
  private ended = false;

  private keys = new Set<string>();
  private mouseDown = false;
  private reloadQueued = false;
  private touchEl: HTMLElement | null = null;
  private tMove = { f: 0, r: 0, sprint: false };
  private tFire = false;
  private tJump = false;
  private armed: OrderType | null = null;
  private selection = new Set<number>();
  private drag: { x: number; y: number; active: boolean } | null = null;
  private pendingFpp = -1;
  private lastControlled = -1;
  private squads: number[][] = [[], [], []];
  private activeSquad = 0;
  private qStarted = 0;
  private wheelOpen = false;
  private wheelIndex = 0;
  private wheelX = 0;
  private wheelY = 0;
  private readonly fieldOrders: OrderType[] = ['follow', 'hold', 'move', 'attack', 'retreat'];
  private unlockExpected = false;
  private pauseEl: HTMLElement | null = null;
  private lastHqWarn = -99;
  private look = { yaw: 0, pitch: 0 };

  constructor() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.cancelFieldInput());
    window.addEventListener('resize', () => this.view?.resize());
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    document.addEventListener('pointerlockchange', () => this.onPointerLock());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.running && !this.ended) this.pause(true); });
    this.menu();
  }

  // ------------------------------------------------------------------ lifecycle

  private menu(last?: MenuChoice) {
    this.teardown();
    showMenu(ui, (c) => this.start(c), last ?? this.choice);
  }

  private teardown() {
    cancelAnimationFrame(this.raf);
    this.running = false;
    this.hud?.destroy();
    this.view?.dispose();
    this.pauseEl?.remove();
    this.pauseEl = null;
    this.touchEl?.remove();
    this.touchEl = null;
    document.querySelectorAll('.screen').forEach((n) => n.remove());
    this.canvas?.remove();
    this.exitLock();
  }

  private newCanvas() {
    const c = document.createElement('canvas');
    c.id = 'game';
    c.tabIndex = 0;
    document.body.insertBefore(c, ui);
    c.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.bindTouch(c);
    this.bindTouchPad();
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { e.preventDefault(); if (this.view.mode === 'commander') this.view.cmd.zoom(e.deltaY); }, { passive: false });
    return c;
  }

  private start(choice: MenuChoice) {
    this.teardown();
    this.audio.unlock();
    this.choice = choice;
    this.humanTeam = choice.team;
    this.role = 'commander';
    const seed = (Math.random() * 1e9) | 0;
    const aiComp: Composition = { ...PRESETS[seed % PRESETS.length].comp };
    const mine: Composition = choice.role === 'commander' && choice.battalion < 0 ? choice.composition : { ...PRESETS[0].comp };
    const comps: [Composition, Composition] = choice.team === 0 ? [mine, aiComp] : [aiComp, mine];
    this.battle = new Battle({
      seed, compositions: comps, humanTeam: choice.team, humanRole: choice.role, humanBattalion: choice.battalion,
      mapId: choice.mapId, deathBehavior: choice.deathBehavior,
      soldierType: choice.soldierType, deploy: choice.role === 'commander', difficulty: choice.difficulty,
    });
    this.slotId = this.battle.humanSlotId;
    document.body.classList.toggle('bn-mode', this.battle.slots[this.slotId].battalion >= 0);
    this.canvas = this.newCanvas();
    this.view = new GameView(this.canvas, this.battle, this.humanTeam);
    this.selection = new Set();
    this.view.selection = this.selection;
    this.hud = new Hud(ui, this.battle, this.humanTeam, this.role, {
      fieldOrder: (t) => this.fieldOrder(t),
      squad: (n) => this.selectSquad(n),
      toggleView: () => this.toggleView(),
      order: (t) => this.orderButton(t),
      buy: (t) => this.buy(t),
      select: (k) => this.selectKind(k),
      selectBattalion: (n) => this.selectBattalion(n),
      speed: (n) => { this.speed = n; },
      possess: () => this.possessSelected(),
      begin: () => this.begin(),
      pause: () => this.pause(!this.paused),
      focusMap: (x, z) => this.view.cmd.focus(x, z),
    });
    this.lastControlled = -1; this.qStarted = 0; this.wheelOpen = false; this.activeSquad = 0;
    this.squads = [0, 1, 2].map((bn) => this.battle.units.filter((u) => u.team === this.humanTeam && u.battalion === bn &&
      (choice.battalion < 0 || u.battalion === choice.battalion)).map((u) => u.id));
    this.speed = 1; this.acc = 0; this.paused = false; this.armed = null; this.ended = false; this.endAt = -1;
    this.pendingFpp = -1; this.lastHqWarn = -99; this.keys.clear();
    this.running = true;
    this.last = performance.now();

    if (choice.role === 'soldier') {
      const slot = this.battle.slots[this.slotId];
      this.enterFpp(slot.unitId);
      this.lockPointer();
      this.hud.message('Field command: Q gives orders, hold Q for the command wheel. Tab opens strategy.', 'info');
    } else {
      this.hud.message('You are the Army Commander. Select units, give orders, then begin the battle.', 'info');
      this.hud.hint('Right-click: smart order · Z Move · X Attack · C Capture · V Defend · F take control of a soldier');
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ main loop

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.touchEl) this.touchEl.style.display = this.view.mode === "fpp" && !this.paused && !this.ended ? "block" : "none";
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const b = this.battle;

    if (this.running && !this.paused && b.phase !== 'ended') {
      const speed = this.view.mode === 'fpp' ? 1 : this.speed;
      this.acc += dt * speed;
      let n = 0;
      while (this.acc >= TICK && n < 12) { this.tick(); this.acc -= TICK; n++; }
      if (n >= 12) this.acc = 0;
    }
    if (this.view.mode === 'commander' && !this.paused) this.view.cmd.update(dt, this.keys);
    for (const id of [...this.selection]) { const u = b.unitById(id); if (!u || !u.alive) this.selection.delete(id); }

    const alpha = this.paused || b.phase !== 'running' ? 1 : this.acc / TICK;
    this.view.frame(alpha, dt, t);
    this.hud.update({
      view: this.view, selection: this.selection, armed: this.armed, paused: this.paused,
      speed: this.speed, fppUnitId: this.view.fppUnitId,
    }, dt);

    if (this.qStarted && !this.wheelOpen && t - this.qStarted > 220 && !this.paused) {
      this.wheelOpen = true; this.wheelX = 0; this.wheelY = 0; this.wheelIndex = 0;
    }
    this.hud.fieldState(this.activeSquad, this.squadIds(), this.wheelOpen ? this.wheelIndex : -1);
    if (this.endAt >= 0 && t >= this.endAt && !this.ended) {
      this.ended = true;
      this.exitLock();
      this.hud.destroy();
      showResult(ui, b, this.humanTeam, { again: () => this.start(this.choice), menu: () => this.menu(this.choice) });
    }
  };

  private tick() {
    const b = this.battle;
    if (this.view.mode === 'fpp' && this.view.fppUnitId >= 0) {
      b.setInput(this.slotId, this.buildInput());
      this.reloadQueued = false;
    }
    b.step();
    this.view.processEvents(b.events, this.audio);
    this.handleEvents(b.events);
    if (this.pendingFpp >= 0) {
      const slot = b.slots[this.slotId];
      if (slot.unitId === this.pendingFpp) this.enterFpp(this.pendingFpp);
      else if (b.phase !== 'deploy') this.pendingFpp = -1;
    }
  }

  private buildInput(): ControlInput {
    const k = this.keys;
    const inp = emptyInput();
    inp.moveF = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    inp.moveR = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    inp.yaw = this.look.yaw;
    inp.pitch = this.look.pitch;
    if (this.wheelOpen) return { ...emptyInput(), yaw: inp.yaw, pitch: inp.pitch };
    inp.fire = (this.mouseDown && document.pointerLockElement === this.canvas) || this.tFire;
    inp.jump = k.has('Space') || this.tJump;
    if (this.tMove.f || this.tMove.r) { inp.moveF = this.tMove.f; inp.moveR = this.tMove.r; }
    inp.sprint = this.tMove.sprint || k.has('ShiftLeft') || k.has('ShiftRight');
    inp.reload = this.reloadQueued || k.has('KeyR');
    return inp;
  }

  private handleEvents(events: SimEvent[]) {
    const b = this.battle;
    for (const e of events) {
      switch (e.t) {
        case 'capture': {
          const cp = b.cps[e.cpId];
          if (e.owner === -1) this.hud.message(`Point ${cp.name} is neutral`, 'info');
          else {
            this.hud.message(`Point ${cp.name} captured by ${TEAM_NAME[e.owner]}`, e.owner === this.humanTeam ? 'good' : 'bad');
            this.audio.capture();
          }
          break;
        }
        case 'hit':
          if (e.attackerId === this.view.fppUnitId) { this.hud.hitMarker(e.head); this.audio.hitMarker(); }
          if (e.unitId === this.view.fppUnitId) { this.hud.hurt(); this.audio.hurt(); }
          break;
        case 'order':
          if (this.role === 'soldier' && e.team === this.humanTeam && e.unitIds.includes(this.view.fppUnitId)) {
            this.hud.message(`New order: ${ORDER_LABEL[e.order]}`, 'order');
            this.audio.order();
          }
          break;
        case 'structureHit':
          if (e.structureId === this.humanTeam && b.time - this.lastHqWarn > 12) {
            this.lastHqWarn = b.time;
            this.hud.message('Headquarters under attack!', 'bad');
          }
          break;
        case 'possessLost':
          if (e.slotId === this.slotId) {
            if (this.role === 'commander') {
              this.hud.message('Unit lost — returned to strategy. No replacement was spawned.', 'bad');
              this.leaveFpp(false);
            }
          }
          break;
        case 'controlTransferred':
          if (e.slotId === this.slotId) {
            this.enterFpp(e.unitId);
            this.hud.message('Unit lost — controlling a surviving soldier.', 'info');
            const u = b.unitById(e.unitId);
            if (u) { this.look.yaw = u.yaw; this.look.pitch = 0; this.view.look = this.look; }
            this.hud.death('');
          }
          break;
        case 'end': {
          const w = e.result.winner;
          this.hud.message(w === -1 ? 'The battle ended in a draw' : `${TEAM_NAME[w]} Army wins — ${e.result.reason}`, w === this.humanTeam ? 'good' : 'bad');
          this.endAt = performance.now() + 2600;
          this.armed = null;
          break;
        }
        default:
      }
    }
  }

  // ------------------------------------------------------------------ first person <-> command view

  private enterFpp(unitId: number) {
    const u = this.battle.unitById(unitId);
    if (!u) return;
    this.pendingFpp = -1;
    this.lastControlled = unitId;
    this.cancelFieldInput();
    this.view.mode = 'fpp';
    this.view.fppUnitId = unitId;
    this.look.yaw = u.yaw; this.look.pitch = 0;
    this.view.look = this.look;
    this.armed = null;
    this.canvas.style.cursor = 'none';
    this.hud.setMode('fpp');
    this.hud.death('');
    this.hud.hint('');
    this.hud.banner('');
    this.selectSquad(this.activeSquad, false);
  }

  private leaveFpp(release = true) {
    if (this.view.mode !== 'fpp') return;
    const u = this.battle.unitById(this.view.fppUnitId);
    this.cancelFieldInput();
    if (release) this.battle.submit({ kind: 'possess', slotId: this.slotId, unitId: -1 });
    this.view.mode = 'commander';
    this.view.fppUnitId = -1;
    this.mouseDown = false;
    if (u) this.view.cmd.focus(u.x, u.z);
    this.canvas.style.cursor = 'default';
    this.hud.setMode('commander');
    this.exitLock();
  }

  private possessSelected() {
    if (this.role !== 'commander' || this.view.mode !== 'commander') return;
    const b = this.battle;
    if (b.phase !== 'running') { this.hud.message('Begin the battle first (Space).', 'info'); return; }
    const id = [...this.selection].find((i) => { const u = b.unitById(i); return u && u.alive && u.controller < 0; });
    if (id === undefined) { this.hud.message('Select a soldier first, then press F to take control.', 'info'); return; }
    b.submit({ kind: 'possess', slotId: this.slotId, unitId: id });
    this.pendingFpp = id;
    this.lockPointer();
  }

  private cancelFieldInput() {
    this.keys.clear(); this.mouseDown = false; this.reloadQueued = false;
    this.qStarted = 0; this.wheelOpen = false; this.tFire = false; this.tJump = false;
    this.tMove = { f: 0, r: 0, sprint: false };
  }

  private toggleView() {
    if (this.view.mode === 'fpp') { this.leaveFpp(); return; }
    const u = this.battle.unitById(this.lastControlled);
    if (u && this.isMine(u)) {
      this.selection.clear(); this.selection.add(u.id);
    }
    this.possessSelected();
  }

  private squadIds() {
    return this.squads[this.activeSquad].filter((id) => {
      const u = this.battle.unitById(id); return u && this.isMine(u);
    });
  }

  private selectSquad(n: number, announce = true) {
    this.activeSquad = n;
    this.selection.clear();
    for (const id of this.squadIds()) this.selection.add(id);
    if (announce) this.hud.message(`Squad ${n + 1}: ${this.selection.size} available units`, 'info');
  }

  private aimedUnit(friendly: boolean) {
    const me = this.battle.unitById(this.view.fppUnitId);
    if (!me) return undefined;
    const dx = -Math.sin(this.look.yaw) * Math.cos(this.look.pitch);
    const dy = Math.sin(this.look.pitch), dz = -Math.cos(this.look.yaw) * Math.cos(this.look.pitch);
    const oy = me.y + 1.5 * UNIT_DEFS[me.type].scale;
    const wall = this.battle.map.raycast(me.x, oy, me.z, dx, dy, dz, 60);
    let best: typeof me | undefined, nearest = wall?.t ?? 60;
    for (const u of this.battle.units) {
      if (!u.alive || u.id === me.id || (u.team === me.team) !== friendly) continue;
      if (friendly && !this.isMine(u)) continue;
      const rx = u.x - me.x, ry = u.y + UNIT_DEFS[u.type].scale - oy, rz = u.z - me.z;
      const t = rx * dx + ry * dy + rz * dz;
      const miss = Math.hypot(rx - dx * t, ry - dy * t, rz - dz * t);
      if (t > 0 && t < nearest && miss < 0.9 * UNIT_DEFS[u.type].scale) { best = u; nearest = t; }
    }
    return best;
  }

  private toggleAimedAlly() {
    const u = this.aimedUnit(true);
    if (!u) { this.hud.message('Aim at an available ally to add or remove it.', 'info'); return; }
    const squad = this.squads[this.activeSquad], i = squad.indexOf(u.id);
    if (i >= 0) squad.splice(i, 1);
    else { for (const s of this.squads) { const at = s.indexOf(u.id); if (at >= 0) s.splice(at, 1); } squad.push(u.id); }
    this.selectSquad(this.activeSquad);
  }

  private fieldOrder(type?: OrderType) {
    if (this.paused || this.ended || this.view.mode !== 'fpp') return;
    const me = this.battle.unitById(this.view.fppUnitId);
    if (!me?.alive) return;
    const ids = this.squadIds();
    if (!ids.length) { this.hud.message('Squad empty — choose 1/2/3 or aim at an ally and press G.', 'info'); return; }
    let x = me.x, z = me.z;
    const foe = this.aimedUnit(false);
    if (!type || type === 'move' || type === 'attack') {
      const cp = Math.cos(this.look.pitch);
      const dx = -Math.sin(this.look.yaw) * cp, dy = Math.sin(this.look.pitch), dz = -Math.cos(this.look.yaw) * cp;
      const hit = this.battle.map.raycast(me.x, me.y + 1.5 * UNIT_DEFS[me.type].scale, me.z, dx, dy, dz, 80);
      if (foe && type !== 'move') { x = foe.x; z = foe.z; type ??= 'attack'; }
      else if (hit) { x = me.x + dx * hit.t; z = me.z + dz * hit.t; type ??= 'move'; }
      else { this.hud.message('Aim at terrain or an enemy to place an order.', 'info'); return; }
    }
    this.battle.submit({ kind: 'order', slotId: this.slotId, unitIds: ids,
      order: { type, x, z, followId: type === 'follow' ? me.id : undefined } });
    this.audio.order();
    this.hud.message(`Squad ${this.activeSquad + 1}: ${ORDER_LABEL[type]} — ${ids.length} units`, 'order');
  }

  private onKeyUp(e: KeyboardEvent) {
    this.keys.delete(e.code);
    if (e.code !== 'KeyQ' || !this.qStarted) return;
    if (!this.paused && this.view.mode === 'fpp') this.fieldOrder(this.wheelOpen ? this.fieldOrders[this.wheelIndex] : undefined);
    this.qStarted = 0; this.wheelOpen = false;
  }

  // ------------------------------------------------------------------ pointer lock / pause

  private lockPointer() {
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch { /* needs a user gesture; the next click will retry */ }
  }

  private exitLock() {
    if (document.pointerLockElement) { this.unlockExpected = true; document.exitPointerLock(); }
  }

  private onPointerLock() {
    if (document.pointerLockElement === this.canvas) { this.unlockExpected = false; return; }
    if (this.unlockExpected) { this.unlockExpected = false; return; }
    if (this.running && !this.ended && this.view?.mode === 'fpp' && !this.paused) this.pause(true);
  }

  private pause(on: boolean) {
    if (!this.running || this.ended || this.battle.phase === 'ended') return;
    if (on === this.paused) return;
    this.paused = on;
    this.cancelFieldInput();
    this.pauseEl?.remove();
    this.pauseEl = null;
    if (!on) return;
    this.exitLock();
    const el = document.createElement('div');
    el.className = 'screen';
    el.innerHTML = `<div class="card pause-card"><h2>Paused</h2>
      <p class="hint">${this.view.mode === 'fpp' ? 'Click Resume to capture the mouse again.' : 'Press P to resume.'}</p>
      <label class="death-setting">When my unit dies
        <select id="deathSetting"><option value="nearest">Control nearest soldier</option><option value="farthest">Control farthest soldier</option><option value="commander">Return to strategy</option></select></label>
      <div class="row"><button class="primary" id="resume">Resume</button></div>
      <div class="row"><button id="restart">Restart</button><button id="menu">Main menu</button></div></div>`;
    ui.appendChild(el);
    this.pauseEl = el;
    const deathSetting = el.querySelector<HTMLSelectElement>('#deathSetting')!;
    deathSetting.value = this.choice.deathBehavior;
    deathSetting.addEventListener('change', () => {
      this.choice.deathBehavior = deathSetting.value as MenuChoice['deathBehavior'];
      this.battle.slots[this.slotId].deathBehavior = this.choice.deathBehavior;
      try { localStorage.setItem('war-death-behavior', this.choice.deathBehavior); } catch { /* optional persistence */ }
    });
    el.querySelector('#resume')!.addEventListener('click', () => { this.pause(false); if (this.view.mode === 'fpp') this.lockPointer(); });
    el.querySelector('#restart')!.addEventListener('click', () => this.start(this.choice));
    el.querySelector('#menu')!.addEventListener('click', () => this.menu(this.choice));
  }

  private begin() {
    if (this.battle.phase !== 'deploy') return;
    this.battle.submit({ kind: 'begin' });
    this.hud.banner('');
    this.hud.message('The battle begins!', 'good');
    this.audio.capture();
  }

  // ------------------------------------------------------------------ commander actions

  /** Units the human may select/command: the whole army, or just their battalion. */
  private isMine(u: { team: number; battalion: number; controller: number; alive: boolean }): boolean {
    const bn = this.battle.slots[this.slotId]?.battalion ?? -1;
    return u.alive && u.team === this.humanTeam && u.controller < 0 && (bn < 0 || u.battalion === bn);
  }

  private ownIds(): number[] {
    return [...this.selection].filter((id) => { const u = this.battle.unitById(id); return u && this.isMine(u); });
  }

  private orderButton(type: OrderType) {
    if (this.role !== 'commander' || this.view.mode !== 'commander') return;
    if (type === 'hold' || type === 'retreat') { this.issue(type, 0, 0); return; }
    this.armed = this.armed === type ? null : type;
    this.canvas.style.cursor = this.armed ? 'crosshair' : 'default';
    this.hud.hint(this.armed ? `${ORDER_LABEL[type]}: click on the map (right-click or Esc to cancel)` : '');
  }

  private issue(type: OrderType, x: number, z: number) {
    const ids = this.ownIds();
    if (!ids.length) { this.hud.message('Select some units first.', 'info'); return; }
    let cpId = -1;
    if (type === 'capture') {
      let best = 14;
      for (const c of this.battle.cps) { const d = Math.hypot(c.x - x, c.z - z); if (d < best) { best = d; cpId = c.id; } }
      if (cpId < 0) { this.hud.message('Capture: click near a control point (A, B or C).', 'info'); return; }
    }
    this.battle.submit({ kind: 'order', slotId: this.slotId, unitIds: ids, order: { type, x, z, cpId } });
    this.audio.order();
    const where = cpId >= 0 ? ` point ${this.battle.cps[cpId].name}` : '';
    this.hud.message(`${ORDER_LABEL[type]}${where} — ${ids.length} unit${ids.length > 1 ? 's' : ''}`, 'order');
  }

  /** On-screen controls for the first-person view (touch devices only). */
  private bindTouchPad() {
    this.touchEl?.remove();
    this.touchEl = null;
    if (!('ontouchstart' in window) && !matchMedia('(pointer: coarse)').matches) return;
    const el = document.createElement('div');
    el.className = 'touchpad';
    el.innerHTML = `<div class="stick" id="tStick"><i></i></div>
      <div class="tbtns"><button id="tFire">FIRE</button><button id="tJump">JUMP</button><button id="tReload">R</button>${this.role === 'commander' ? '<button id="tBack">BACK</button>' : ''}</div>`;
    ui.appendChild(el);
    this.touchEl = el;
    const q = (s: string) => el.querySelector<HTMLElement>(s)!;
    const stick = q('#tStick'), knob = stick.querySelector('i') as HTMLElement;
    let sid = -1, ox = 0, oy = 0;
    const R = 55;
    stick.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; sid = t.identifier; ox = t.clientX; oy = t.clientY; }, { passive: false });
    stick.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== sid) continue;
        let dx = t.clientX - ox, dy = t.clientY - oy;
        const m = Math.hypot(dx, dy);
        if (m > R) { dx *= R / m; dy *= R / m; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        const dz = 0.15;
        const f = -dy / R, r = dx / R;
        this.tMove.f = Math.abs(f) < dz ? 0 : f; this.tMove.r = Math.abs(r) < dz ? 0 : r;
        this.tMove.sprint = Math.min(1, m / R) > 0.95;
      }
    }, { passive: false });
    const endStick = (e: TouchEvent) => { e.preventDefault(); sid = -1; knob.style.transform = ''; this.tMove = { f: 0, r: 0, sprint: false }; };
    stick.addEventListener('touchend', endStick, { passive: false });
    stick.addEventListener('touchcancel', endStick, { passive: false });
    const hold = (id: string, on: (v: boolean) => void) => {
      const b = q(id);
      b.addEventListener('touchstart', (e) => { e.preventDefault(); on(true); }, { passive: false });
      const off = (e: TouchEvent) => { e.preventDefault(); on(false); };
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    };
    hold('#tFire', (v) => { this.tFire = v; });
    hold('#tJump', (v) => { this.tJump = v; });
    hold('#tReload', (v) => { if (v) this.reloadQueued = true; });
    el.querySelector('#tBack')?.addEventListener('touchstart', (e) => { e.preventDefault(); this.leaveFpp(); }, { passive: false });
  }

  /** Touch: 1 finger drag = pan, 2 fingers = pan + pinch zoom, tap = select / armed order / smart order. */
  private bindTouch(c: HTMLCanvasElement) {
    let g: { x: number; y: number; sx: number; sy: number; t: number; moved: boolean; dist: number } | null = null;
    const centre = (t: TouchList) => t.length > 1
      ? { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) }
      : { x: t[0].clientX, y: t[0].clientY, d: 0 };
    let lookId = -1, lx = 0, ly = 0;
    c.addEventListener('touchstart', (e) => {
      if (this.running && !this.paused && !this.ended && this.view.mode === 'fpp') {
        e.preventDefault();
        const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY;
        return;
      }
      if (!this.running || this.paused || this.ended || this.view.mode !== 'commander') return;
      e.preventDefault();
      this.audio.unlock();
      const p = centre(e.touches);
      g = { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), moved: false, dist: p.d };
      if (e.touches.length > 1) g.moved = true;
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      if (this.view.mode === 'fpp') {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier !== lookId) continue;
          this.look.yaw -= (t.clientX - lx) * 0.006;
          this.look.pitch = Math.max(-1.45, Math.min(1.45, this.look.pitch - (t.clientY - ly) * 0.006));
          lx = t.clientX; ly = t.clientY;
        }
        return;
      }
      if (!g || this.view.mode !== 'commander') return;
      e.preventDefault();
      const p = centre(e.touches);
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > 10) g.moved = true;
      if (g.moved) {
        this.view.cmd.panPx(p.x - g.x, p.y - g.y);
        if (e.touches.length > 1 && g.dist > 0) this.view.cmd.zoom((g.dist - p.d) * 2.2);
      }
      g.x = p.x; g.y = p.y; g.dist = p.d;
    }, { passive: false });
    c.addEventListener('touchend', (e) => {
      if (this.view.mode === 'fpp') { e.preventDefault(); lookId = -1; return; }
      if (!g || this.view.mode !== 'commander') return;
      e.preventDefault();
      if (e.touches.length > 0) return;
      const tap = !g.moved && performance.now() - g.t < 450;
      const { x, y } = g;
      g = null;
      if (!tap || !this.running || this.paused || this.ended) return;
      this.onTap(x, y);
    }, { passive: false });
  }

  private onTap(x: number, y: number) {
    if (this.armed) {
      const p = this.view.pickGround(x, y);
      if (p) this.issue(this.armed, p.x, p.z);
      this.armed = null; this.canvas.style.cursor = 'default'; this.hud.hint('');
      return;
    }
    const id = this.view.unitAt(x, y, true);
    if (id !== null && this.isMine(this.battle.unitById(id)!)) {
      if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    } else if (this.selection.size) this.rightClick({ clientX: x, clientY: y } as MouseEvent); // tap ground with a selection = smart order
  }

  private rightClick(e: MouseEvent) {
    if (this.role !== 'commander' || this.paused) return;
    if (this.armed) { this.armed = null; this.canvas.style.cursor = 'default'; this.hud.hint(''); return; }
    const p = this.view.pickGround(e.clientX, e.clientY);
    if (!p) return;
    const b = this.battle;
    const cp = b.cps.find((c) => Math.hypot(c.x - p.x, c.z - p.z) < c.radius + 2.5);
    if (cp) {
      if (cp.owner === this.humanTeam) this.issue('defend', cp.x, cp.z);
      else this.issue('capture', cp.x, cp.z);
      return;
    }
    const foe = b.units.find((u) => u.alive && u.team !== this.humanTeam && b.canSee(this.humanTeam, u) && Math.hypot(u.x - p.x, u.z - p.z) < 4);
    const hq = b.structures[1 - this.humanTeam];
    if (foe || Math.hypot(hq.x - p.x, hq.z - p.z) < 9) this.issue('attack', p.x, p.z);
    else this.issue('move', p.x, p.z);
  }

  private selectKind(kind: 'all' | UnitTypeId) {
    if (this.view.mode !== 'commander') return;
    this.selection.clear();
    for (const u of this.battle.units) {
      if (this.isMine(u) && (kind === 'all' || u.type === kind)) this.selection.add(u.id);
    }
  }

  private selectBattalion(n: number) {
    if (this.view.mode !== 'commander') return;
    this.selection.clear();
    for (const u of this.battle.units) {
      if (this.isMine(u) && u.battalion === n) this.selection.add(u.id);
    }
    this.hud.message(`${BATTALION_NAMES[n]} battalion selected (${this.selection.size})`, 'info');
  }

  private buy(t: UnitTypeId) {
    if (this.role !== 'commander') return;
    if (this.battle.slots[this.slotId].battalion >= 0) { this.hud.message('Only the Army Commander can buy reinforcements.', 'info'); return; }
    const b = this.battle;
    const def = UNIT_DEFS[t];
    if (b.teams[this.humanTeam].supplies < def.cost) { this.hud.message(`Not enough supplies for a ${def.name} (${def.cost}).`, 'bad'); return; }
    b.submit({ kind: 'buy', slotId: this.slotId, unitType: t });
    this.audio.order();
    this.hud.message(`Reinforcement: ${def.name} arrives at your HQ`, 'good');
  }

  // ------------------------------------------------------------------ raw input

  private onKeyDown(e: KeyboardEvent) {
    if (!this.running) return;
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) { this.keys.add(e.code); return; }
    this.keys.add(e.code);
    if (e.code === 'KeyP') { this.pause(!this.paused); return; }
    if (e.code === 'KeyM') { this.hud.message(this.audio.toggle() ? 'Sound off' : 'Sound on', 'info'); return; }
    if (this.paused || this.ended) return;

    if (this.view.mode === 'fpp') {
      if (e.code === 'Tab') this.toggleView();
      else if (e.code === 'KeyQ') this.qStarted = performance.now();
      else if (e.code === 'KeyG') this.toggleAimedAlly();
      else if (/^Digit[123]$/.test(e.code)) this.selectSquad(Number(e.code.slice(-1)) - 1);
      else if (e.code === 'KeyR') this.reloadQueued = true;
      return;
    }
    // commander view
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && /^Digit[123]$/.test(e.code)) {
      e.preventDefault(); const n = Number(e.code.slice(-1)) - 1;
      const ids = this.ownIds();
      for (let i = 0; i < 3; i++) this.squads[i] = this.squads[i].filter((id) => !ids.includes(id));
      this.squads[n] = ids; this.selectSquad(n); return;
    }
    switch (e.code) {
      case 'Tab': this.toggleView(); break;
      case 'Digit5': this.buy('tank'); break;
      case 'Digit6': this.buy('vehicle'); break;
      case 'Space': this.begin(); break;
      case 'KeyA': if (ctrl) { e.preventDefault(); this.selectKind('all'); } break;
      case 'KeyZ': this.orderButton('move'); break;
      case 'KeyX': this.orderButton('attack'); break;
      case 'KeyC': if (!ctrl) this.orderButton('capture'); break;
      case 'KeyV': this.orderButton('defend'); break;
      case 'KeyB': this.orderButton('hold'); break;
      case 'KeyN': this.orderButton('retreat'); break;
      case 'KeyF': this.possessSelected(); break;
      case 'Digit1': if (e.shiftKey) this.selectBattalion(0); else this.buy(UNIT_TYPE_IDS[0]); break;
      case 'Digit2': if (e.shiftKey) this.selectBattalion(1); else this.buy(UNIT_TYPE_IDS[1]); break;
      case 'Digit3': if (e.shiftKey) this.selectBattalion(2); else this.buy(UNIT_TYPE_IDS[2]); break;
      case 'Digit4': this.buy(UNIT_TYPE_IDS[3]); break;
      case 'Escape':
        if (this.armed) { this.armed = null; this.canvas.style.cursor = 'default'; this.hud.hint(''); }
        else if (this.selection.size) this.selection.clear();
        else this.pause(true);
        break;
      default:
    }
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.running || this.paused || this.ended) return;
    this.audio.unlock();
    if (e.button === 2) { if (this.view.mode === 'commander') this.rightClick(e); return; }
    if (this.view.mode === 'fpp') {
      if (document.pointerLockElement !== this.canvas) { this.lockPointer(); return; }
      if (e.button === 0) this.mouseDown = true;
      return;
    }
    if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, active: false };
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.running) return;
    if (this.view.mode === 'fpp') {
      if (document.pointerLockElement !== this.canvas) return;
      if (this.wheelOpen) {
        this.wheelX += e.movementX; this.wheelY += e.movementY;
        if (Math.hypot(this.wheelX, this.wheelY) > 12) {
          const angle = Math.atan2(this.wheelX, -this.wheelY);
          this.wheelIndex = Math.round((angle + Math.PI * 2) / (Math.PI * 2 / 5)) % 5;
        }
        return;
      }
      this.look.yaw -= e.movementX * 0.0022;
      this.look.pitch = Math.max(-1.45, Math.min(1.45, this.look.pitch - e.movementY * 0.0022));
      return;
    }
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (!this.drag.active && Math.hypot(dx, dy) > 6 && !this.armed) this.drag.active = true;
    const box = this.hud.selBox;
    if (this.drag.active) {
      box.style.display = 'block';
      box.style.left = `${Math.min(this.drag.x, e.clientX)}px`;
      box.style.top = `${Math.min(this.drag.y, e.clientY)}px`;
      box.style.width = `${Math.abs(dx)}px`;
      box.style.height = `${Math.abs(dy)}px`;
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (e.button === 0) this.mouseDown = false;
    if (!this.running || !this.drag || this.view.mode !== 'commander') { this.drag = null; return; }
    const d = this.drag;
    this.drag = null;
    this.hud.selBox.style.display = 'none';
    if (e.button !== 0 || this.paused) return;
    if (d.active) {
      const ids = this.view.unitsInRect(d.x, d.y, e.clientX, e.clientY).filter((id) => this.isMine(this.battle.unitById(id)!));
      if (!e.shiftKey) this.selection.clear();
      ids.forEach((id) => this.selection.add(id));
      return;
    }
    if (this.armed) {
      const p = this.view.pickGround(e.clientX, e.clientY);
      if (p) this.issue(this.armed, p.x, p.z);
      this.armed = null;
      this.canvas.style.cursor = 'default';
      this.hud.hint('');
      return;
    }
    const id = this.view.unitAt(e.clientX, e.clientY, true);
    if (id !== null && this.isMine(this.battle.unitById(id)!)) {
      if (e.shiftKey) { if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
      else { this.selection.clear(); this.selection.add(id); }
    } else if (!e.shiftKey) this.selection.clear();
  }
}

const app = new App();
(window as unknown as { __war: App }).__war = app;

