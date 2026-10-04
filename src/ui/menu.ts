import { DEFAULT_BUDGET, DEFAULT_COMPOSITION, UNIT_DEFS, compositionCost, compositionCount } from '../sim/units';
import { UNIT_TYPE_IDS, type Composition, type SlotRole, type Team, type UnitTypeId } from '../sim/types';

export interface MenuChoice {
  team: Team;
  role: SlotRole;
  soldierType: UnitTypeId;
  composition: Composition;
}

export const PRESETS: { name: string; comp: Composition; blurb: string }[] = [
  { name: 'Balanced', comp: { ...DEFAULT_COMPOSITION }, blurb: 'A bit of everything.' },
  { name: 'Rush', comp: { infantry: 10, heavy: 0, scout: 10, ranged: 3 }, blurb: 'Fast and cheap. Take points early.' },
  { name: 'Fortress', comp: { infantry: 6, heavy: 6, scout: 1, ranged: 2 }, blurb: 'Slow, tough, wins fights at the points.' },
  { name: 'Marksmen', comp: { infantry: 8, heavy: 1, scout: 2, ranged: 6 }, blurb: 'Long range. Needs good cover and positioning.' },
];

export function showMenu(root: HTMLElement, onStart: (c: MenuChoice) => void, last?: MenuChoice) {
  const state: MenuChoice = last ? { ...last, composition: { ...last.composition } } : {
    team: 0, role: 'commander', soldierType: 'infantry', composition: { ...DEFAULT_COMPOSITION },
  };

  const el = document.createElement('div');
  el.className = 'screen menu';
  root.appendChild(el);

  const render = () => {
    const cost = compositionCost(state.composition);
    const left = DEFAULT_BUDGET - cost;
    const count = compositionCount(state.composition);
    el.innerHTML = `
      <div class="card menu-card">
        <h1><span class="lemon">Lemonat</span>: WAR</h1>
        <p class="sub">Two armies. One commander above the battlefield, soldiers fighting on the ground.<br/>Strategy + army strength + player skill + execution.</p>

        <h3>1 · Choose your army</h3>
        <div class="row">
          <button class="choice team-blue ${state.team === 0 ? 'on' : ''}" data-team="0">Blue Army</button>
          <button class="choice team-red ${state.team === 1 ? 'on' : ''}" data-team="1">Red Army</button>
        </div>

        <h3>2 · Choose your role</h3>
        <div class="row">
          <button class="choice role ${state.role === 'commander' ? 'on' : ''}" data-role="commander">
            <b>Army Commander</b><span>Top-down view. Select units, give orders, spend supplies. You may also jump into any soldier.</span>
          </button>
          <button class="choice role ${state.role === 'soldier' ? 'on' : ''}" data-role="soldier">
            <b>Soldier</b><span>First-person fighter. Follow your AI commander's orders — or ignore them and risk losing.</span>
          </button>
        </div>

        ${state.role === 'soldier' ? `
          <h3>Your unit</h3>
          <div class="row wrap">
            ${UNIT_TYPE_IDS.map((t) => `<button class="chip ${state.soldierType === t ? 'on' : ''}" data-soldier="${t}"><b>${UNIT_DEFS[t].name}</b><span>${UNIT_DEFS[t].hp} HP · ${UNIT_DEFS[t].damage} dmg · range ${UNIT_DEFS[t].range}</span></button>`).join('')}
          </div>` : `
          <h3>3 · Army composition <small>(${count} units · ${cost}/${DEFAULT_BUDGET} points${left < 0 ? ' · OVER BUDGET' : ''})</small></h3>
          <div class="row wrap presets">${PRESETS.map((p, i) => `<button class="chip" data-preset="${i}" title="${p.blurb}">${p.name}</button>`).join('')}</div>
          <div class="comp">
            ${UNIT_TYPE_IDS.map((t) => {
              const d = UNIT_DEFS[t];
              return `<div class="comp-row">
                <div class="comp-name"><b>${d.name}</b><span>${d.role}</span></div>
                <div class="comp-stats">${d.hp} HP · ${d.damage} dmg · ${d.speed} spd · cost ${d.cost}</div>
                <div class="stepper"><button data-dec="${t}">−</button><b>${state.composition[t]}</b><button data-inc="${t}">+</button></div>
              </div>`;
            }).join('')}
          </div>
          <div class="budget"><div style="width:${Math.min(100, (cost / DEFAULT_BUDGET) * 100)}%" class="${left < 0 ? 'over' : ''}"></div></div>
          <p class="hint">The enemy fields a similar budget. Unspent supplies are kept for reinforcements.</p>`}

        <div class="row end">
          <button id="start" class="primary" ${state.role === 'commander' && (left < 0 || count === 0) ? 'disabled' : ''}>Start battle</button>
        </div>

        <details>
          <summary>Controls</summary>
          <div class="controls">
            <div><h4>Commander</h4>
              <p><b>WASD / arrows</b> pan · <b>Q / E</b> rotate · <b>wheel</b> zoom · <b>click / drag</b> select · <b>Ctrl+A</b> all</p>
              <p><b>Right-click</b> smart order (capture / defend a point, attack, or move) · <b>Z</b> Move · <b>X</b> Attack · <b>C</b> Capture · <b>V</b> Defend · <b>B</b> Hold · <b>N</b> Retreat</p>
              <p><b>1–4</b> buy reinforcements · <b>F</b> take control of the selected soldier · <b>Space</b> begin battle · <b>P</b> pause · <b>M</b> mute</p></div>
            <div><h4>Soldier (first person)</h4>
              <p><b>WASD</b> move · <b>Mouse</b> aim · <b>Click</b> fire · <b>Space</b> jump · <b>Shift</b> sprint · <b>R</b> reload</p>
              <p><b>Tab</b> back to command view (commander) · <b>Esc</b> pause</p>
              <p>Hide behind cover — low walls stop bullets. Headshots hit harder.</p></div>
          </div>
        </details>
      </div>`;

    el.querySelectorAll<HTMLElement>('[data-team]').forEach((b) => b.addEventListener('click', () => { state.team = Number(b.dataset.team) as Team; render(); }));
    el.querySelectorAll<HTMLElement>('[data-role]').forEach((b) => b.addEventListener('click', () => { state.role = b.dataset.role as SlotRole; render(); }));
    el.querySelectorAll<HTMLElement>('[data-soldier]').forEach((b) => b.addEventListener('click', () => { state.soldierType = b.dataset.soldier as UnitTypeId; render(); }));
    el.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => b.addEventListener('click', () => { state.composition = { ...PRESETS[Number(b.dataset.preset)].comp }; render(); }));
    el.querySelectorAll<HTMLElement>('[data-inc]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.inc as UnitTypeId;
      if (compositionCost(state.composition) + UNIT_DEFS[t].cost <= DEFAULT_BUDGET && compositionCount(state.composition) < 36) { state.composition[t]++; render(); }
    }));
    el.querySelectorAll<HTMLElement>('[data-dec]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.dec as UnitTypeId;
      if (state.composition[t] > 0) { state.composition[t]--; render(); }
    }));
    el.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', () => {
      el.remove();
      onStart({ ...state, composition: { ...state.composition } });
    });
  };
  render();
}
