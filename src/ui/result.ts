import { TEAM_NAME, type Team } from '../sim/types';
import type { Battle } from '../sim/battle';
import { SCORE_TO_WIN } from '../sim/battle';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function showResult(root: HTMLElement, battle: Battle, humanTeam: Team | -1, handlers: { again(): void; menu(): void }) {
  const sum = battle.summary();
  const res = battle.result!;
  const me = humanTeam === -1 ? 0 : humanTeam;
  const won = res.winner === me;
  const draw = res.winner === -1;
  const title = draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
  const [b, r] = sum.teams;
  const row = (label: string, x: string | number, y: string | number) => `<tr><td>${label}</td><td class="b">${x}</td><td class="r">${y}</td></tr>`;
  const p = sum.player;
  const acc = p && p.shots > 0 ? Math.round((p.hits / p.shots) * 100) : 0;

  const el = document.createElement('div');
  el.className = 'screen result';
  el.innerHTML = `
    <div class="card result-card">
      <h1 class="${draw ? 'draw' : won ? 'win' : 'lose'}">${title}</h1>
      <p class="why">${draw ? 'No winner.' : `${TEAM_NAME[res.winner as Team]} Army wins`} — ${res.reason}. <span class="dim">Battle length ${mmss(res.duration)}.</span></p>
      <table>
        <thead><tr><th></th><th class="b">Blue</th><th class="r">Red</th></tr></thead>
        <tbody>
          ${row('Units remaining', `${b.alive} / ${b.total}`, `${r.alive} / ${r.total}`)}
          ${row('Army health left', `${Math.round(b.hpPct * 100)}%`, `${Math.round(r.hpPct * 100)}%`)}
          ${row('Enemy units destroyed', b.kills, r.kills)}
          ${row('Conquest score', `${Math.floor(b.score)} / ${SCORE_TO_WIN}`, `${Math.floor(r.score)} / ${SCORE_TO_WIN}`)}
          ${row('Control points held', b.pointsHeld.join(' ') || '—', r.pointsHeld.join(' ') || '—')}
          ${row('Time holding points', mmss(b.cpSeconds), mmss(r.cpSeconds))}
          ${row('Headquarters', `${Math.round(b.hqHp * 100)}%`, `${Math.round(r.hqHp * 100)}%`)}
          ${row('Supplies spent on reinforcements', b.suppliesSpent, r.suppliesSpent)}
        </tbody>
      </table>
      ${p ? `<h3>Your performance in the field</h3>
        <div class="stats">
          <div><b>${p.kills}</b><span>Kills</span></div>
          <div><b>${p.deaths}</b><span>Deaths</span></div>
          <div><b>${acc}%</b><span>Accuracy</span></div>
          <div><b>${p.headshots}</b><span>Headshots</span></div>
          <div><b>${Math.round(p.damage)}</b><span>Damage</span></div>
        </div>` : ''}
      <div class="row end">
        <button id="menu">Main menu</button>
        <button id="again" class="primary">Play again</button>
      </div>
    </div>`;
  root.appendChild(el);
  el.querySelector('#again')!.addEventListener('click', () => { el.remove(); handlers.again(); });
  el.querySelector('#menu')!.addEventListener('click', () => { el.remove(); handlers.menu(); });
}
