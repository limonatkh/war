import type { Battle } from '../sim/battle';
import { MAX_TIME, SCORE_TO_WIN } from '../sim/battle';
import { G, MAP_H, MAP_W } from '../sim/map';
import { UNIT_DEFS } from '../sim/units';
import { UNIT_TYPE_IDS, type OrderType, type SlotRole, type Team, type UnitTypeId } from '../sim/types';
import { ORDER_COLORS, type GameView, type ViewMode } from '../render/view';

export interface HudHandlers {
  order(type: OrderType): void;
  buy(t: UnitTypeId): void;
  select(kind: 'all' | UnitTypeId): void;
  speed(n: number): void;
  possess(): void;
  begin(): void;
  pause(): void;
  focusMap(x: number, z: number): void;
}

export interface HudFrame {
  view: GameView;
  selection: Set<number>;
  armed: OrderType | null;
  paused: boolean;
  speed: number;
  fppUnitId: number;
}

const ORDER_BTNS: { type: OrderType; label: string; key: string; hint: string }[] = [
  { type: 'move', label: 'Move', key: 'Z', hint: 'Walk to a point (units still shoot back)' },
  { type: 'attack', label: 'Attack', key: 'X', hint: 'Advance to a point, fighting everything on the way' },
  { type: 'capture', label: 'Capture', key: 'C', hint: 'Take a control point' },
  { type: 'defend', label: 'Defend', key: 'V', hint: 'Hold an area and fight inside it' },
  { type: 'hold', label: 'Hold', key: 'B', hint: 'Stay exactly where you are' },
  { type: 'retreat', label: 'Retreat', key: 'N', hint: 'Fall back to the HQ' },
];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const TEAM_COL = ['#4a8cf0', '#f0524c'];

export class Hud {
  readonly el: HTMLDivElement;
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private terrainLayer: HTMLCanvasElement;
  private frameN = 0;
  private hitT = 0;
  private hurtT = 0;
  private mode: ViewMode = 'commander';
  private lastBuyState = '';

  constructor(root: HTMLElement, private battle: Battle, private humanTeam: Team, private role: SlotRole, h: HudHandlers) {
    this.el = document.createElement('div');
    this.el.className = `hud role-${role}`;
    this.el.innerHTML = `
      <div class="topbar">
        <div class="side blue"><div class="bar"><i id="bFill"></i></div><b id="bScore">0</b></div>
        <div class="center"><div id="clock">0:00</div><div id="phase"></div></div>
        <div class="side red"><b id="rScore">0</b><div class="bar"><i id="rFill"></i></div></div>
      </div>
      <div class="pts" id="pts"></div>
      <div class="econ"><span id="supplies"></span><span id="counts"></span></div>
      <div class="feed" id="feed"></div>
      <div class="banner" id="banner"></div>
      <button class="begin" id="beginBtn">Begin battle<kbd>Space</kbd></button>

      <div class="cmd-only">
        <div class="cmdbar">
          <div class="sel"><div id="selInfo">Nothing selected</div>
            <div class="sel-btns">
              <button data-sel="all">All</button>
              ${UNIT_TYPE_IDS.map((t) => `<button data-sel="${t}">${UNIT_DEFS[t].name}</button>`).join('')}
            </div></div>
          <div class="orders">
            ${ORDER_BTNS.map((o) => `<button data-order="${o.type}" title="${o.hint}" style="--c:${ORDER_COLORS[o.type]}"><b>${o.label}</b><kbd>${o.key}</kbd></button>`).join('')}
            <button id="enter" title="Take direct control of the selected soldier (first person)"><b>Take control</b><kbd>F</kbd></button>
          </div>
        </div>
        <div class="buy" id="buy">
          <div class="buy-title">Reinforcements</div>
          ${UNIT_TYPE_IDS.map((t, i) => `<button data-buy="${t}" title="${UNIT_DEFS[t].role}"><kbd>${i + 1}</kbd><b>${UNIT_DEFS[t].name}</b><span>${UNIT_DEFS[t].cost}</span></button>`).join('')}
        </div>
        <div class="speed">
          <button data-speed="1">×1</button><button data-speed="2">×2</button><button data-speed="3">×3</button><button id="pauseBtn">❚❚</button>
        </div>
        <div class="hintbar" id="hintbar"></div>
      </div>

      <div class="minimap"><canvas id="mini" width="190" height="190"></canvas></div>

      <div class="fpp-only">
        <div class="crosshair"><i></i><i></i><i></i><i></i></div>
        <div class="hitmarker" id="hitmarker"></div>
        <div class="vignette" id="vignette"></div>
        <div class="vitals">
          <div class="hp"><div id="hpFill"></div><span id="hpText"></span></div>
          <div class="unit-name" id="unitName"></div>
        </div>
        <div class="ammo"><b id="ammo"></b><span id="reload"></span></div>
        <div class="orderbox" id="orderbox"></div>
        <div class="fpp-hint" id="fppHint"></div>
      </div>
      <div class="death" id="death"></div>
      <div class="selbox" id="selbox"></div>`;
    root.appendChild(this.el);

    this.mini = this.q<HTMLCanvasElement>('#mini');
    this.miniCtx = this.mini.getContext('2d')!;
    this.terrainLayer = this.renderTerrainLayer();

    this.el.querySelectorAll<HTMLElement>('[data-order]').forEach((b) => b.addEventListener('click', () => h.order(b.dataset.order as OrderType)));
    this.el.querySelectorAll<HTMLElement>('[data-buy]').forEach((b) => b.addEventListener('click', () => h.buy(b.dataset.buy as UnitTypeId)));
    this.el.querySelectorAll<HTMLElement>('[data-sel]').forEach((b) => b.addEventListener('click', () => h.select(b.dataset.sel as 'all' | UnitTypeId)));
    this.el.querySelectorAll<HTMLElement>('[data-speed]').forEach((b) => b.addEventListener('click', () => h.speed(Number(b.dataset.speed))));
    this.q('#enter').addEventListener('click', () => h.possess());
    this.q('#beginBtn').addEventListener('click', () => h.begin());
    this.q('#pauseBtn').addEventListener('click', () => h.pause());
    this.mini.addEventListener('mousedown', (e) => {
      if (this.mode !== 'commander') return;
      const r = this.mini.getBoundingClientRect();
      let fx = (e.clientX - r.left) / r.width, fz = (e.clientY - r.top) / r.height;
      if (this.humanTeam === 1) { fx = 1 - fx; fz = 1 - fz; }
      h.focusMap(fx * MAP_W, fz * MAP_H);
      e.stopPropagation();
    });

    this.q('#pts').innerHTML = battle.cps.map((c) => `<div class="pt" id="pt${c.id}"><b>${c.name}</b><div><i></i></div></div>`).join('');
    this.setMode(role === 'soldier' ? 'fpp' : 'commander');
  }

  destroy() { this.el.remove(); }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.el.classList.toggle('mode-fpp', mode === 'fpp');
    this.el.classList.toggle('mode-cmd', mode === 'commander');
    this.q('#fppHint').textContent = this.role === 'commander' ? 'TAB: back to command view' : '';
  }

  get selBox() { return this.q('#selbox'); }

  message(text: string, kind: 'info' | 'good' | 'bad' | 'order' = 'info') {
    const feed = this.q('#feed');
    const d = document.createElement('div');
    d.className = `msg ${kind}`;
    d.textContent = text;
    feed.appendChild(d);
    while (feed.children.length > 6) feed.firstChild!.remove();
    setTimeout(() => d.classList.add('fade'), 5000);
    setTimeout(() => d.remove(), 6500);
  }

  banner(text: string) { this.q('#banner').textContent = text; this.q('#banner').style.display = text ? 'block' : 'none'; }
  hint(text: string) { this.q('#hintbar').textContent = text; }
  hitMarker(head: boolean) { this.hitT = 0.18; this.q('#hitmarker').classList.toggle('head', head); }
  hurt() { this.hurtT = 0.5; }
  death(text: string) { const d = this.q('#death'); d.textContent = text; d.style.display = text ? 'flex' : 'none'; }

  // ------------------------------------------------------------------ per frame

  update(f: HudFrame, dt: number) {
    const b = this.battle;
    this.frameN++;
    const own = b.teams[this.humanTeam];
    this.q('#bScore').textContent = String(Math.floor(b.teams[0].score));
    this.q('#rScore').textContent = String(Math.floor(b.teams[1].score));
    this.q('#bFill').style.width = `${Math.min(100, (b.teams[0].score / SCORE_TO_WIN) * 100)}%`;
    this.q('#rFill').style.width = `${Math.min(100, (b.teams[1].score / SCORE_TO_WIN) * 100)}%`;
    this.q('#clock').textContent = mmss(b.time);
    this.q('#phase').textContent = b.phase === 'deploy' ? 'DEPLOYMENT' : f.paused ? 'PAUSED' : `first to ${SCORE_TO_WIN} · limit ${mmss(MAX_TIME)}`;
    const owned = b.cps.filter((c) => c.owner === this.humanTeam).length;
    this.q('#supplies').textContent = `Supplies ${Math.floor(own.supplies)}  (+${(0.35 + 0.9 * owned).toFixed(1)}/s)`;
    const mine = b.alive(this.humanTeam).length;
    const seen = [...b.visible[this.humanTeam]].length;
    this.q('#counts').textContent = `Your units ${mine} · enemies in sight ${seen}`;

    for (const c of b.cps) {
      const pt = this.q(`#pt${c.id}`);
      const fill = pt.querySelector('i') as HTMLElement;
      const col = c.progress === 0 ? '#ddd' : TEAM_COL[c.progress > 0 ? 0 : 1];
      fill.style.width = `${Math.abs(c.progress) * 100}%`;
      fill.style.background = col;
      pt.style.borderColor = c.owner === -1 ? 'rgba(255,255,255,.25)' : TEAM_COL[c.owner];
      pt.classList.toggle('contested', c.contested);
    }

    if (this.mode === 'commander') this.updateCommander(f);
    else this.updateFpp(f, dt);
    if (this.frameN % 2 === 0) this.drawMinimap(f);

    this.hitT = Math.max(0, this.hitT - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.q('#hitmarker').style.opacity = String(this.hitT > 0 ? 1 : 0);
    this.q('#vignette').style.opacity = String(this.hurtT * 1.4);
  }

  private updateCommander(f: HudFrame) {
    const b = this.battle;
    const ids = [...f.selection].filter((id) => b.unitById(id)?.alive);
    if (!ids.length) this.q('#selInfo').textContent = 'Nothing selected — click or drag to select units';
    else {
      const counts: Record<string, number> = {};
      for (const id of ids) { const u = b.unitById(id)!; counts[u.type] = (counts[u.type] ?? 0) + 1; }
      this.q('#selInfo').textContent = `${ids.length} selected: ` + Object.entries(counts).map(([t, n]) => `${n} ${UNIT_DEFS[t as UnitTypeId].name}`).join(', ');
    }
    this.el.querySelectorAll<HTMLElement>('[data-order]').forEach((btn) => btn.classList.toggle('armed', btn.dataset.order === f.armed));
    this.el.querySelectorAll<HTMLElement>('[data-speed]').forEach((btn) => btn.classList.toggle('on', Number(btn.dataset.speed) === f.speed));
    const sup = b.teams[this.humanTeam].supplies;
    const state = UNIT_TYPE_IDS.map((t) => (sup >= UNIT_DEFS[t].cost ? 1 : 0)).join('');
    if (state !== this.lastBuyState) {
      this.lastBuyState = state;
      this.el.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach((btn) => { btn.disabled = sup < UNIT_DEFS[btn.dataset.buy as UnitTypeId].cost; });
    }
    this.el.classList.toggle('deploy', b.phase === 'deploy');
    this.q('#banner').style.display = b.phase === 'deploy' ? 'block' : 'none';
    if (b.phase === 'deploy') this.q('#banner').textContent = 'DEPLOYMENT — give your opening orders, then begin the battle';
  }

  private updateFpp(f: HudFrame, _dt: number) {
    const u = this.battle.unitById(f.fppUnitId);
    if (!u) return;
    const def = UNIT_DEFS[u.type];
    this.q('#hpFill').style.width = `${(u.hp / u.maxHp) * 100}%`;
    this.q('#hpFill').style.background = u.hp / u.maxHp > 0.5 ? '#59d36b' : u.hp / u.maxHp > 0.25 ? '#f2c94c' : '#ef5350';
    this.q('#hpText').textContent = `${Math.ceil(u.hp)}`;
    this.q('#unitName').textContent = def.name;
    this.q('#ammo').textContent = `${u.ammo} / ${def.mag}`;
    this.q('#reload').textContent = u.reloadT > 0 ? 'RELOADING…' : u.ammo === 0 ? 'press R' : '';
    const o = u.order;
    const box = this.q('#orderbox');
    if (o && o.type !== 'hold') {
      const dist = Math.hypot(o.x - u.x, o.z - u.z);
      const target = o.cpId >= 0 ? `point ${this.battle.cps[o.cpId].name}` : o.type === 'retreat' ? 'HQ' : 'marker';
      // bearing relative to where we are looking
      const bearing = Math.atan2(-(o.x - u.x), -(o.z - u.z)) - f.view.look.yaw;
      box.innerHTML = `<span class="ord" style="color:${ORDER_COLORS[o.type]}">ORDER: ${o.type.toUpperCase()} ${target}</span><span class="arrow" style="transform:rotate(${-bearing}rad)">▲</span><span>${Math.round(dist)} m</span>`;
    } else if (o) box.innerHTML = `<span class="ord" style="color:${ORDER_COLORS.hold}">ORDER: HOLD POSITION</span>`;
    else box.innerHTML = `<span class="ord dim">No orders — use your own judgement</span>`;
  }

  // ------------------------------------------------------------------ minimap

  private renderTerrainLayer(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = this.mini.width;
    const g = c.getContext('2d')!;
    const s = c.width / MAP_W;
    const m = this.battle.map;
    for (let z = 0; z < MAP_H; z++) {
      for (let x = 0; x < MAP_W; x++) {
        const i = m.idx(x, z);
        const h = m.heights[i];
        let col: string;
        const gk = m.ground[i];
        if (m.obsH[i] > 0) col = m.obsKind[i] === 4 ? '#2f7a3a' : m.obsKind[i] === 5 ? '#444' : '#8d8a80';
        else if (gk === G.sand) col = '#e6d49a';
        else if (gk === G.road) col = '#cdb982';
        else if (gk === G.bluePad) col = '#7da3d8';
        else if (gk === G.redPad) col = '#d88d86';
        else if (gk === G.stone) col = '#a7adb5';
        else col = `hsl(96 45% ${34 + h * 6}%)`;
        g.fillStyle = col;
        g.fillRect(x * s, z * s, Math.ceil(s), Math.ceil(s));
      }
    }
    return c;
  }

  private drawMinimap(f: HudFrame) {
    const g = this.miniCtx, S = this.mini.width, b = this.battle;
    const flip = this.humanTeam === 1;
    const px = (x: number) => (flip ? S - (x / MAP_W) * S : (x / MAP_W) * S);
    const pz = (z: number) => (flip ? S - (z / MAP_H) * S : (z / MAP_H) * S);
    g.clearRect(0, 0, S, S);
    g.save();
    if (flip) { g.translate(S, S); g.rotate(Math.PI); }
    g.drawImage(this.terrainLayer, 0, 0);
    g.restore();

    for (const c of b.cps) {
      g.beginPath();
      g.arc(px(c.x), pz(c.z), (c.radius / MAP_W) * S, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.strokeStyle = c.owner === -1 ? '#fff' : TEAM_COL[c.owner];
      g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.name, px(c.x), pz(c.z));
    }
    for (const s of b.structures) {
      g.fillStyle = s.alive ? TEAM_COL[s.team] : '#444';
      g.fillRect(px(s.x) - 5, pz(s.z) - 5, 10, 10);
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(px(s.x) - 5, pz(s.z) - 5, 10, 10);
    }
    for (const u of b.units) {
      if (!u.alive || !b.canSee(this.humanTeam, u)) continue;
      const sel = f.selection.has(u.id);
      g.fillStyle = TEAM_COL[u.team];
      g.beginPath(); g.arc(px(u.x), pz(u.z), sel ? 3.6 : 2.6, 0, Math.PI * 2); g.fill();
      if (sel) { g.strokeStyle = '#ffe96b'; g.lineWidth = 1.5; g.stroke(); }
      if (u.id === f.fppUnitId) { g.strokeStyle = '#58e6ff'; g.lineWidth = 2; g.beginPath(); g.arc(px(u.x), pz(u.z), 5, 0, Math.PI * 2); g.stroke(); }
    }
    if (this.mode === 'commander') {
      // camera footprint
      const v = f.view, r = v.canvas.getBoundingClientRect();
      const pts = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]
        .map(([x, y]) => v.pickGround(x, y));
      if (pts.every((p) => p)) {
        g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5;
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(px(p!.x), pz(p!.z)) : g.moveTo(px(p!.x), pz(p!.z))));
        g.closePath(); g.stroke();
      }
    } else {
      const u = b.unitById(f.fppUnitId);
      if (u) {
        const a = f.view.look.yaw;
        const dx = -Math.sin(a) * (flip ? -1 : 1), dz = -Math.cos(a) * (flip ? -1 : 1);
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(px(u.x), pz(u.z)); g.lineTo(px(u.x) + dx * 14, pz(u.z) + dz * 14); g.stroke();
      }
    }
  }
}
