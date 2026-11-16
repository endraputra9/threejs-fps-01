// hud.js — every DOM layer drawn over the canvas: vitals, the round clock
// and score pips, the kill feed, banners, context prompts, the channel bar,
// the buy menu, the scoreboard, and the crew panel (who is alive, at what
// health, on your side). This module owns presentation only: it reads state.js
// and writes elements, it never decides match outcomes. The per-frame work is
// split into small renderers (vitals, weapon, clock, crew, feed, channel,
// prompt) so a single frame touches only the slice that changed.

import { S, TEAM, RULES, attackTeam, isAttacker } from './state.js';
import { sites } from './world.js';
import { WEAPONS, GRENADES, CATALOG, buy, heldId } from './weapons.js';
import { nextRoundPayouts } from './rounds.js';
import * as audio from './audio.js';

const $ = (id) => document.getElementById(id);

// Cached element handles, filled by initHud. Every id here must exist in
// index.html; the two overlays built at runtime (damage ring, crew panel)
// are created below and kept out of the static shell on purpose.
const els = {};
let dmgEl = null;      // damage-direction ring around the crosshair
let dmgArc = null;     // the lit arc inside the ring
let crewEl = null;     // teammate status panel down the left edge
let buyOpen = false;
let shownEvent = null;
let bannerUntil = 0;
let feedSignature = '';
let hitmarkUntil = 0;
let lastPlayerHp = 100;

export const hud = {
  onPlay: null,
  onAgain: null,
  get buyOpen() { return buyOpen; },
};

const HUD_IDS = [
  'hud', 'topbar', 'clock', 'round-label', 'pips', 'hp-fill', 'hp-val', 'armor-fill', 'armor-val',
  'money', 'kit-tag', 'weapon-name', 'ammo-line', 'ammo-mag', 'ammo-reserve', 'slots', 'killfeed', 'banner',
  'banner-title', 'banner-sub', 'prompt', 'channel', 'channel-label', 'channel-fill', 'leech-tag', 'leech-site',
  'crosshair', 'hitmarker', 'hurt-vignette', 'scope', 'buymenu', 'buy-grid', 'buy-clock', 'buy-money', 'buy-team',
  'scoreboard', 'sb-body', 'sb-sub', 'menu', 'endcard', 'end-title', 'end-sub',
];

export function initHud() {
  for (const id of HUD_IDS) els[id] = $(id);

  // Damage ring: a fixed circle around the crosshair whose single lit arc
  // rotates to point at whoever just shot the player.
  dmgEl = document.createElement('div');
  dmgEl.style.cssText = 'position:fixed;left:50%;top:50%;width:132px;height:132px;transform:translate(-50%,-50%);pointer-events:none;opacity:0;z-index:5';
  dmgArc = document.createElement('div');
  dmgArc.style.cssText = 'position:absolute;left:50%;top:0;width:58px;height:16px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(ellipse at center, rgba(255,60,70,0.95), rgba(255,60,70,0) 70%)';
  dmgEl.appendChild(dmgArc);
  document.body.appendChild(dmgEl);

  // Crew panel: one small bar per teammate, alive or down, with the Leech
  // carrier marked. Built here so index.html stays a static shell.
  crewEl = document.createElement('div');
  crewEl.id = 'crew-panel';
  crewEl.style.cssText = 'position:fixed;left:14px;top:96px;z-index:6;pointer-events:none;font:11px/1.5 ui-monospace,monospace;color:#cfe3e0';
  document.body.appendChild(crewEl);

  $('play-btn').addEventListener('click', () => { audio.initAudio(); hud.onPlay && hud.onPlay(); });
  $('again-btn').addEventListener('click', () => { hud.onAgain && hud.onAgain(); });
  els['buy-grid'].addEventListener('click', (e) => {
    const item = e.target.closest('[data-buy]');
    if (item) tryBuyKey(item.dataset.buy);
  });
}

export function flashHitmarker(kill) {
  hitmarkUntil = S.time + 0.14;
  els.hitmarker.classList.toggle('kill', !!kill);
}

function crewName(team) { return team === TEAM.WARDEN ? 'WARDENS' : 'RECLAIMERS'; }
function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function clampPct(v) { return Math.max(0, Math.min(100, v)); }

// ---------- banners ----------
// One banner at a time, driven by S.lastEvent. watchEvents consumes each
// event exactly once (shownEvent) so a round start never re-announces.
const REASONS = {
  elimination: 'Enemy crew eliminated',
  drain: 'The core was drained dry',
  purge: 'The Leech was purged in time',
  time: 'The clock ran out',
};

function watchEvents() {
  const ev = S.lastEvent;
  if (!ev || ev === shownEvent) return;
  shownEvent = ev;
  const player = S.player;
  if (ev.type === 'roundStart') {
    const atk = isAttacker(player);
    showBanner(`ROUND ${ev.round}${S.overtime ? ' · OVERTIME' : ''}`, atk
      ? (S.leech.carrier === player ? 'You carry the Leech — dock it on a core' : 'Attack: dock the Leech on Core A or B')
      : 'Defend: hold both cores, purge any docked Leech');
  } else if (ev.type === 'overtime') {
    showBanner('OVERTIME', `Regulation ended 6-6 — first to ${RULES.overtimeToWin} takes the ring`);
  } else if (ev.type === 'docked') {
    showBanner('LEECH DOCKED', `${sites[ev.site].name} is draining — ${isAttacker(player) ? 'guard it' : 'purge it before the drain ends'}`);
  } else if (ev.type === 'roundEnd') {
    const won = player.team === ev.winner;
    const mvp = S.mvp ? ` · MVP ${S.mvp.name}` : '';
    showBanner(won ? 'ROUND WON' : 'ROUND LOST', `${crewName(ev.winner)} — ${REASONS[ev.reason] || ''}${mvp}`);
    els['banner-title'].style.color = won ? 'var(--good)' : 'var(--bad)';
    return;
  } else {
    // 'live' and 'matchEnd' need no banner: the clock speaks for live, and
    // the end card speaks for the match.
    return;
  }
  els['banner-title'].style.color = '';
}

function showBanner(title, sub) {
  els['banner-title'].textContent = title;
  els['banner-sub'].textContent = sub;
  els['banner-title'].style.color = '';
  els.banner.classList.remove('hidden');
  bannerUntil = S.time + 2.8;
}

// ---------- buy menu ----------
export function setBuyOpen(open) {
  if (open && S.phase !== 'buy') open = false;
  buyOpen = open;
  els.buymenu.classList.toggle('hidden', !open);
  if (open) renderBuy();
}

export function tryBuyKey(key) {
  if (!buyOpen || S.phase !== 'buy') return;
  const entry = CATALOG.find((e) => e.key === key);
  if (!entry) return;
  const ok = buy(S.player, entry);
  audio.buySound(ok);
  if (ok) renderBuy();
}

function priceOf(entry) {
  if (entry.kind === 'weapon') return WEAPONS[entry.id].price;
  if (entry.kind === 'grenade') return GRENADES[entry.id].price;
  return entry.price;
}
function nameOf(entry) {
  if (entry.kind === 'weapon') return WEAPONS[entry.id].name;
  if (entry.kind === 'grenade') return GRENADES[entry.id].name;
  return entry.name;
}
function blurbOf(entry) {
  if (entry.kind === 'weapon') {
    const w = WEAPONS[entry.id];
    return `${w.damage} dmg · ${w.rpm} rpm · mag ${w.mag} · ${w.headMult}× head`;
  }
  if (entry.kind === 'grenade') return GRENADES[entry.id].blurb;
  return entry.blurb;
}
function ownedOf(entry) {
  const p = S.player;
  if (entry.kind === 'weapon') return p.primary === entry.id;
  if (entry.kind === 'grenade') return p.grenades.includes(entry.id);
  if (entry.id === 'armor') return p.armor >= 100 && !p.helm;
  if (entry.id === 'armorHelm') return p.armor >= 100 && p.helm;
  if (entry.id === 'purgeKit') return p.purgeKit;
  return false;
}

const BUY_SECTIONS = [
  { kind: 'weapon', label: 'WEAPONS' },
  { kind: 'gear', label: 'GEAR' },
  { kind: 'grenade', label: 'GRENADES' },
];

function buyItemHtml(entry) {
  const p = S.player;
  const owned = ownedOf(entry);
  const cant = !owned && p.money < priceOf(entry);
  return `<div class="buy-item ${owned ? 'owned' : ''} ${cant ? 'cant' : ''}" data-buy="${entry.key}">
    <span><span class="key">${entry.key}</span>${nameOf(entry)}<small>${owned ? 'Owned' : blurbOf(entry)}</small></span>
    <span class="price">${owned ? '—' : priceOf(entry)}</span></div>`;
}

function renderBuy() {
  const p = S.player;
  const payouts = nextRoundPayouts(p.team);
  els['buy-team'].textContent = `${crewName(p.team)}${isAttacker(p) ? ' (attack)' : ' (defend)'} · ` +
    `win +${payouts.win} · lose +${payouts.loss}${payouts.streak > 0 ? ` (streak ${payouts.streak})` : ''}`;
  els['buy-money'].textContent = p.money;
  // Grouped by kind so the eye finds guns, gear and grenades without
  // scanning the whole grid; the economy line above says what this round
  // is worth before the wallet is spent.
  els['buy-grid'].innerHTML = BUY_SECTIONS.map(({ kind, label }) => {
    const items = CATALOG.filter((e) => e.kind === kind).map(buyItemHtml).join('');
    return `<div class="buy-section">${label}</div>${items}`;
  }).join('');
}

// ---------- scoreboard ----------
export function renderScoreboard() {
  const rows = [...S.actors].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const target = S.overtime ? RULES.overtimeToWin : RULES.roundsToWin;
  els['sb-sub'].textContent = `Round ${S.round} of ${RULES.regulationRounds}${S.overtime ? ' · OVERTIME' : ''} · First to ${target} · ${crewName(attackTeam())} attacking`;
  els['sb-body'].innerHTML = rows.map((a) => {
    const mvpTag = S.mvp === a ? ' · MVP' : '';
    return `<tr class="${a.alive ? '' : 'dead'} ${a.isPlayer ? 'me' : ''} ${S.mvp === a ? 'mvp' : ''}">
    <td>${a.name}${S.leech.carrier === a ? ' · LEECH' : ''}${mvpTag}</td>
    <td class="${a.team === TEAM.WARDEN ? 'wn' : 'rn'}">${crewName(a.team)}</td>
    <td class="num">${a.kills}</td><td class="num">${a.assists}</td><td class="num">${a.deaths}</td><td class="num">${Math.round(a.damageDealt)}</td><td class="num">${a.money}</td>
    <td>${a.alive ? 'On deck' : 'Down'}</td></tr>`;
  }).join('');
}
export function setScoreboard(open) {
  els.scoreboard.classList.toggle('hidden', !open);
  if (open) renderScoreboard();
}

// ---------- end card ----------
export function showEndcard() {
  const w = S.winner;
  els['end-title'].textContent = w === TEAM.WARDEN ? 'WARDENS HOLD THE RING' : 'RECLAIMERS TAKE THE RING';
  els['end-title'].style.color = S.player.team === w ? 'var(--good)' : 'var(--bad)';
  const top = [...S.actors].sort((a, b) => b.kills - a.kills || b.damageDealt - a.damageDealt)[0];
  const me = S.player;
  els['end-sub'].textContent = `Final score — Wardens ${S.roundWins.warden}, Reclaimers ${S.roundWins.reclaimer}. ` +
    (top ? `Top fragger: ${top.name} (${top.kills} kills, ${top.assists} assists, ${Math.round(top.damageDealt)} dmg). ` : '') +
    (me ? `You: ${me.kills} kills, ${me.deaths} deaths, ${Math.round(me.damageDealt)} dmg. ` : '') +
    (S.player.team === w ? 'Your crew leaves with the Vesper Ring.' : 'The ring slips away this time. Refit and board again.');
  els.endcard.classList.remove('hidden');
  els.hud.classList.add('hidden');
}
export function hideEndcard() {
  els.endcard.classList.add('hidden');
  els.hud.classList.remove('hidden');
}

// ---------- per-frame ----------
export function updateHud() {
  const p = S.player;
  if (!p) return;
  watchEvents();
  if (S.time > bannerUntil) els.banner.classList.add('hidden');

  renderVitals(p);
  renderWeapon(p);
  renderClock();
  renderCrew(p);
  renderFeed();
  renderChannel();
  renderPrompt(p);

  if (buyOpen) {
    els['buy-clock'].textContent = Math.max(0, Math.ceil(S.phaseT));
    els['buy-money'].textContent = p.money;
    if (S.phase !== 'buy') setBuyOpen(false);
  }
}

// Health, armor, wallet and kit tags, plus the hurt feedback: a vignette
// flash on damage, a ring that points at the shooter, and a low-health
// marker on the number itself once the player is nearly down.
function renderVitals(p) {
  els['hp-fill'].style.width = `${clampPct(p.hp)}%`;
  els['hp-val'].textContent = Math.max(0, Math.ceil(p.hp));
  els['hp-val'].classList.toggle('critical', p.alive && p.hp <= 25);
  els['armor-fill'].style.width = `${clampPct(p.armor)}%`;
  els['armor-val'].textContent = Math.round(p.armor);
  els.money.textContent = p.money;
  els['kit-tag'].textContent = [p.purgeKit ? 'PURGE KIT' : '', S.leech.carrier === p ? '◆ YOU CARRY THE LEECH' : ''].filter(Boolean).join(' · ');

  if (p.hp < lastPlayerHp) els['hurt-vignette'].style.opacity = 0.9;
  lastPlayerHp = p.hp;
  els['hurt-vignette'].style.opacity = Math.max(0, parseFloat(els['hurt-vignette'].style.opacity || 0) - 0.03);
  els.scope.style.opacity = p.scoped && p.alive ? 1 : 0;

  // Point the damage ring at the shooter for a breath after each hit. The
  // angle is the shooter's bearing in the player's own frame: forward is
  // (−sin yaw, −cos yaw), right is (cos yaw, −sin yaw).
  if (dmgEl) {
    const src = p.lastHurtBy;
    if (src && p.alive && S.time - p.lastHurtAt < 0.9) {
      const dx = src.pos.x - p.pos.x, dz = src.pos.z - p.pos.z;
      const fxv = -Math.sin(p.yaw), fzv = -Math.cos(p.yaw);
      const rxv = Math.cos(p.yaw), rzv = -Math.sin(p.yaw);
      const ang = Math.atan2(dx * rxv + dz * rzv, dx * fxv + dz * fzv);
      dmgEl.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
      dmgEl.style.opacity = 0.95;
    } else {
      dmgEl.style.opacity = 0;
    }
  }
}

// Weapon box, slot strip and crosshair. Bloom follows the gun's real spread
// drivers (bloom, speed, sprint) so the crosshair never lies about the gun.
function renderWeapon(p) {
  const wid = heldId(p);
  const w = wid ? WEAPONS[wid] : null;
  els['weapon-name'].textContent = p.slot === 'grenade'
    ? (p.grenades.length ? GRENADES[p.grenades[0]].name : 'NO GRENADE')
    : (w ? w.name : '—');
  if (wid === 'knife' || p.slot === 'grenade') {
    els['ammo-mag'].textContent = p.slot === 'grenade' ? String(p.grenades.length) : '—';
    els['ammo-reserve'].textContent = '';
    els['ammo-line'].className = '';
  } else if (w) {
    const mag = p.mag[wid] ?? w.mag;
    const reserve = p.reserve[wid] ?? w.reserve;
    els['ammo-mag'].textContent = S.time < p.reloadingUntil ? '··' : mag;
    els['ammo-reserve'].textContent = `/ ${reserve}`;
    // 'out' when the mag is dry, 'low' under a quarter, and the reserve
    // count itself tells the player whether a reload is even possible.
    els['ammo-line'].className = mag === 0 ? 'out' : mag <= w.mag * 0.25 ? 'low' : '';
  }
  for (const span of els.slots.querySelectorAll('span')) {
    span.classList.toggle('on', span.dataset.slot === p.slot);
  }
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const gap = 5 + p.spreadBloom * 260 + speed * 1.1 + (p.sprinting ? 6 : 0);
  els.crosshair.style.setProperty('--gap', `${Math.min(22, gap)}px`);
  els.crosshair.style.opacity = p.scoped ? 0 : 1;
  els.hitmarker.classList.toggle('on', S.time < hitmarkUntil);
}

// Round clock, score pips and the drain indicator. While docked the clock
// counts the drain, not the round; in the last ten live seconds it warns.
function renderClock() {
  const docked = S.leech.state === 'docked';
  els.clock.textContent = S.phase === 'buy' ? fmtClock(S.phaseT) : docked ? fmtClock(S.leech.drainT) : fmtClock(S.phaseT);
  els.clock.className = docked ? 'docked' : (S.phaseT <= 10 && S.phase === 'live' ? 'low' : '');
  if (S.overtime) els.clock.classList.add('ot');
  els['round-label'].textContent = S.phase === 'buy' ? `ROUND ${S.round}${S.overtime ? ' · OT' : ''} · BUY` : `ROUND ${S.round}${S.overtime ? ' · OT' : ''}`;
  document.querySelector('#score-wardens .wins').textContent = S.roundWins.warden;
  document.querySelector('#score-reclaimers .wins').textContent = S.roundWins.reclaimer;
  const pipsHtml = S.roundHistory.map((t) => `<i class="${t === TEAM.WARDEN ? 'w' : 'r'}"></i>`).join('');
  if (els.pips.innerHTML !== pipsHtml) els.pips.innerHTML = pipsHtml;
  els['leech-tag'].classList.toggle('hidden', !docked);
  if (docked) els['leech-site'].textContent = S.leech.site;
}

// Teammate panel: every crewmate alive, at what health, who carries the
// Leech. Dead mates dim to half opacity with a cross instead of a number.
function renderCrew(p) {
  if (!crewEl) return;
  const mates = S.actors.filter((a) => a.team === p.team);
  crewEl.innerHTML = mates.map((a) => {
    const bar = a.alive ? clampPct(a.hp) : 0;
    const col = a.alive ? (a.hp > 50 ? '#46e0d4' : '#ffb454') : '#5a6274';
    return `<div style="opacity:${a.alive ? 1 : 0.45};margin-bottom:3px">${a.isPlayer ? '▶ ' : ''}${a.name}${S.leech.carrier === a ? ' ◆' : ''} ` +
      `<span style="display:inline-block;width:52px;height:5px;background:#222a38;vertical-align:middle"><span style="display:block;height:5px;width:${bar}%;background:${col}"></span></span> ${a.alive ? Math.ceil(a.hp) : '✕'}</div>`;
  }).join('');
}

// Kill feed, rebuilt only when its contents change (signature check).
function renderFeed() {
  const sig = S.feed.map((f) => f.html).join('|');
  if (sig !== feedSignature) {
    feedSignature = sig;
    els.killfeed.innerHTML = S.feed.filter((f) => f.until > S.time).slice(-5).map((f) => `<div class="kf">${f.html}</div>`).join('');
  }
}

// Channel bar: whoever is docking or purging, with a live percentage — it is
// the round's centre of gravity while it runs.
function renderChannel() {
  if (S.channel) {
    els.channel.classList.remove('hidden');
    const pct = Math.min(100, Math.round(S.channel.t / S.channel.need * 100));
    els['channel-label'].textContent = S.channel.kind === 'dock'
      ? `${S.channel.actor.name} IS DOCKING THE LEECH — ${pct}%`
      : `${S.channel.actor.name} IS PURGING THE LEECH — ${pct}%`;
    els['channel-fill'].style.width = `${pct}%`;
    els['channel-fill'].style.background = S.channel.kind === 'dock' ? 'var(--reclaimer)' : 'var(--warden)';
  } else {
    els.channel.classList.add('hidden');
  }
}

// One-line context prompt: what the player should do next, given the phase,
// the Leech, and where they stand. Dead players get a different line.
function renderPrompt(p) {
  let prompt = '';
  if (!p.alive) {
    prompt = 'Down — your crew fights on';
  } else if (S.phase === 'buy') {
    prompt = 'Press <kbd>B</kbd> to requisition gear';
  } else if (S.phase === 'live') {
    if (S.leech.carrier === p) {
      const nearA = Math.hypot(p.pos.x - sites.A.dockX, p.pos.z - sites.A.dockZ) < 2.4;
      const nearB = Math.hypot(p.pos.x - sites.B.dockX, p.pos.z - sites.B.dockZ) < 2.4;
      prompt = nearA || nearB ? 'Hold <kbd>E</kbd> to dock the Leech' : 'Reach Core A or Core B and dock the Leech';
    } else if (!isAttacker(p) && S.leech.state === 'docked') {
      const s = sites[S.leech.site];
      prompt = Math.hypot(p.pos.x - s.dockX, p.pos.z - s.dockZ) < 2.4 ? 'Hold <kbd>E</kbd> to purge the Leech' : `The Leech drains ${s.name} — purge it`;
    } else if (isAttacker(p) && S.leech.state === 'dropped') {
      prompt = 'The Leech is down — recover it';
    }
  }
  if (prompt) { els.prompt.innerHTML = prompt; els.prompt.classList.remove('hidden'); }
  else els.prompt.classList.add('hidden');
}
