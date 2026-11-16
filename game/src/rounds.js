// rounds.js — the match itself: twelve rounds, a swap at the half, first to
// seven, overtime when regulation ends 6-6. Owns the phase clock (buy → live
// → end), round setup (spawns, loadouts, who carries the Leech), the
// dock/purge channel, and every credit payout. Kills are reported by
// combat.js; this module decides what they mean for the score, and names
// each round's MVP when the dust settles.

import { S, TEAM, RULES, makeActor, attackTeam, defendTeam, isAttacker, pay, teamPay, aliveCount, pushFeed, roundMvp, WARDEN_NAMES, RECLAIMER_NAMES } from './state.js';
import { spawns, sites, scene } from './world.js';
import { makeBody } from './bodies.js';
import { makeBrain, assignRoles, botBuy } from './bots.js';
import { refillAmmo } from './weapons.js';
import * as audio from './audio.js';

// Overtime bookkeeping, kept module-local: how many extra rounds have been
// played, so the feed can warn the crews as the three-round OT cap closes.
let otRoundsPlayed = 0;

// ---------- economy hooks (read by the buy menu) ----------
// What this crew banks for the round just played, before it is paid: the
// win purse, the loss purse for the current streak, and the streak itself.
// The HUD shows these in the buy menu so a spend is weighed against the
// next round's income, not just the wallet on hand.
export function nextRoundPayouts(team) {
  const streak = S.lossStreak[team] || 0;
  const loss = RULES.lossBase + Math.min(RULES.lossStreakMax, streak * RULES.lossStreakStep);
  return { win: RULES.winElimination, winObjective: RULES.winObjective, loss, streak };
}

// A one-line summary of where the match stands, for the scoreboard and the
// end card: current round, scoreline, leader, and the last round's MVP.
export function roundSummary() {
  const w = S.roundWins.warden, r = S.roundWins.reclaimer;
  return {
    round: S.round,
    warden: w, reclaimer: r,
    leader: w === r ? null : (w > r ? TEAM.WARDEN : TEAM.RECLAIMER),
    mvpName: S.mvp ? S.mvp.name : null,
    overtime: S.overtime,
    otRoundsPlayed,
  };
}

export function setupMatch() {
  const player = makeActor(TEAM.WARDEN, 'You', true);
  S.player = player;
  S.actors.push(player);
  WARDEN_NAMES.forEach((name, i) => {
    if (i === 0) return; // the player fills the first warden slot
    const a = makeActor(TEAM.WARDEN, name, false);
    makeBrain(a, i);
    S.actors.push(a);
  });
  RECLAIMER_NAMES.forEach((name, i) => {
    const a = makeActor(TEAM.RECLAIMER, name, false);
    makeBrain(a, i + 1);
    S.actors.push(a);
  });
  for (const a of S.actors) scene.add(makeBody(a));
}

export function startMatch() {
  S.roundWins.warden = 0; S.roundWins.reclaimer = 0;
  S.roundHistory = [];
  S.lossStreak.warden = 0; S.lossStreak.reclaimer = 0;
  S.winner = null; S.mvp = null; S.overtime = false;
  for (const a of S.actors) {
    a.money = RULES.startMoney; a.kills = 0; a.deaths = 0; a.assists = 0;
    a.damageDealt = 0; a.damageTaken = 0;
    a.primary = null; a.armor = 0; a.helm = false; a.grenades = []; a.purgeKit = false;
  }
  S.round = 0;
  otRoundsPlayed = 0;
  nextRound();
}

function placeTeam(team, points) {
  const members = S.actors.filter((a) => a.team === team);
  members.forEach((a, i) => {
    const [x, z] = points[i % points.length];
    a.pos.x = x + (i % 2 ? 0.7 : -0.7); a.pos.z = z; a.pos.y = 0;
    a.vel.x = 0; a.vel.y = 0; a.vel.z = 0;
    // Forward is (−sin yaw, −cos yaw): north spawn faces south (yaw π), south faces north (yaw 0).
    a.yaw = points === spawns.north ? Math.PI : 0;
    a.pitch = 0; a.hp = 100; a.alive = true;
    a.reloadingUntil = 0; a.spreadBloom = 0; a.scoped = false;
    a.roundKills = 0; a.roundDamage = 0; a.recentHits.length = 0;
  });
}

function nextRound() {
  S.round++;
  const atk = attackTeam(), def = defendTeam();
  // The half-time swap resets everyone to a pistol round, as is tradition.
  if (S.round === RULES.swapAfterRound + 1) {
    for (const a of S.actors) {
      a.money = RULES.startMoney; a.primary = null; a.armor = 0; a.helm = false;
      a.grenades = []; a.purgeKit = false;
    }
    pushFeed('<b>Half time</b> — sides swap, wallets reset');
  }
  // Overtime opens with a full wallet each: no crew loses the ring broke.
  // The first OT round also resets the OT counter, so the three-round cap
  // in matchOver counts from the first extra round, not from regulation.
  if (S.overtime && S.round === RULES.regulationRounds + 1) {
    for (const a of S.actors) a.money = Math.max(a.money, RULES.overtimeMoney);
    otRoundsPlayed = 0;
    pushFeed('<b>Overtime</b> — first to 8 takes the ring');
  }
  if (S.overtime && S.round > RULES.regulationRounds + 1) {
    otRoundsPlayed = S.round - RULES.regulationRounds;
    const left = 3 - otRoundsPlayed;
    if (left === 1) pushFeed('<b>Overtime</b> — one extra round left after this one');
    else if (left > 0) pushFeed(`<b>Overtime</b> — ${left} extra rounds left after this one`);
  }
  for (const a of S.actors) {
    if (!a.alive) { // the dead come back with a sidearm and empty pockets of gear
      a.primary = null; a.armor = 0; a.helm = false; a.grenades = []; a.purgeKit = false;
    }
    a.sidearm = 'wasp';
    a.slot = a.primary ? 'primary' : 'sidearm';
    refillAmmo(a);
    a.mag.wasp = 12; a.reserve.wasp = 60;
  }
  placeTeam(atk, spawns.north);
  placeTeam(def, spawns.south);
  // The Leech rides with the player when they attack, else a random bot.
  const attackers = S.actors.filter((a) => a.team === atk);
  const carrier = attackers.find((a) => a.isPlayer) || attackers[Math.floor(Math.random() * attackers.length)];
  S.leech.state = 'carried'; S.leech.carrier = carrier; S.leech.site = null; S.leech.drainT = 0;
  S.channel = null;
  S.shots.length = 0; S.smokes.length = 0;
  assignRoles();
  for (const a of S.actors) if (a.brain) botBuy(a);
  S.phase = 'buy';
  S.phaseT = RULES.buySeconds;
  S.lastEvent = { type: 'roundStart', round: S.round };
}

// ---------- the channel: docking and purging ----------
export function requestChannel(actor, kind, siteId) {
  if (S.phase !== 'live' || !actor.alive) return false;
  if (S.channel) return S.channel.actor === actor;
  const site = sites[siteId];
  const d = Math.hypot(actor.pos.x - site.dockX, actor.pos.z - site.dockZ);
  if (kind === 'dock') {
    if (S.leech.state !== 'carried' || S.leech.carrier !== actor) return false;
    if (d > 2.4) return false;
    S.channel = { actor, kind, site: siteId, t: 0, need: RULES.dockSeconds, x: actor.pos.x, z: actor.pos.z, hurtAtStart: actor.lastHurtAt };
    return true;
  }
  if (kind === 'purge') {
    if (S.leech.state !== 'docked' || S.leech.site !== siteId) return false;
    if (isAttacker(actor)) return false;
    if (d > 2.4) return false;
    S.channel = { actor, kind, site: siteId, t: 0, need: actor.purgeKit ? RULES.purgeKitSeconds : RULES.purgeSeconds, x: actor.pos.x, z: actor.pos.z, hurtAtStart: actor.lastHurtAt };
    return true;
  }
  return false;
}
export function cancelChannel(actor) {
  if (S.channel && S.channel.actor === actor) S.channel = null;
}

function completeChannel() {
  const ch = S.channel;
  S.channel = null;
  const site = sites[ch.site];
  if (ch.kind === 'dock') {
    S.leech.state = 'docked'; S.leech.site = ch.site; S.leech.carrier = null;
    S.leech.drainT = RULES.drainSeconds;
    teamPay(attackTeam(), RULES.dockTeamBonus);
    pay(ch.actor, RULES.dockReward);
    audio.dockedAlarm();
    // The feed names the docker and the drain clock, so defenders know
    // exactly how long they have to answer.
    pushFeed(`<b>${site.name}</b> — ${ch.actor.name} docked the Leech, ${RULES.drainSeconds}s to drain`);
    S.lastEvent = { type: 'docked', site: ch.site };
  } else {
    pay(ch.actor, RULES.purgeReward);
    pushFeed(`<b>${ch.actor.name}</b> purged the Leech at ${site.name} (+${RULES.purgeReward})`);
    endRound(defendTeam(), 'purge');
  }
}

// ---------- round end ----------
function endRound(winner, reason) {
  const loser = winner === TEAM.WARDEN ? TEAM.RECLAIMER : TEAM.WARDEN;
  const objective = reason === 'drain' || reason === 'purge';
  teamPay(winner, objective ? RULES.winObjective : RULES.winElimination);
  S.lossStreak[winner] = 0;
  S.lossStreak[loser]++;
  teamPay(loser, RULES.lossBase + Math.min(RULES.lossStreakMax, (S.lossStreak[loser] - 1) * RULES.lossStreakStep));
  S.roundWins[winner]++;
  S.roundHistory.push(winner);
  S.channel = null;
  if (S.leech.state === 'docked' && reason !== 'drain') S.leech.state = 'spent';
  // Freeze the deck for a beat so the round's last frame reads, then the
  // end phase runs its clock. The MVP is named now, while it is fresh, and
  // the feed carries the scoreline plus the loser's streak, so the economy
  // story of the round is visible without opening the scoreboard.
  S.mvp = roundMvp();
  const score = `Wardens ${S.roundWins.warden} — ${S.roundWins.reclaimer} Reclaimers`;
  if (S.mvp) pushFeed(`<b>MVP</b> — ${S.mvp.name} (${S.mvp.roundKills} kills, ${Math.round(S.mvp.roundDamage)} dmg) · ${score}`);
  else pushFeed(`<b>Round ${S.round}</b> — ${score}`);
  if (S.lossStreak[loser] >= 2) pushFeed(`<b>${loser === TEAM.WARDEN ? 'Wardens' : 'Reclaimers'}</b> on a ${S.lossStreak[loser]}-round slide — loss bonus grows`);
  S.phase = 'end';
  S.phaseT = RULES.endSeconds;
  S.lastEvent = { type: 'roundEnd', winner, reason, round: S.round };
  audio.roundStinger(S.player && S.player.team === winner);
}

function matchOver() {
  const w = S.roundWins.warden, r = S.roundWins.reclaimer;
  const target = S.overtime ? RULES.overtimeToWin : RULES.roundsToWin;
  if (w >= target || r >= target) return w > r ? TEAM.WARDEN : TEAM.RECLAIMER;
  if (S.round >= RULES.regulationRounds && w !== r && !S.overtime) return w > r ? TEAM.WARDEN : TEAM.RECLAIMER;
  // Regulation tied 6-6: overtime, first to 8. Three extra rounds at most;
  // a still-tied match after them goes to the crew that won the last round,
  // and the feed says so — a match decided on a tiebreak should never look
  // like a bug to the players watching it.
  if (S.overtime && S.round >= RULES.regulationRounds + 3) {
    const decider = S.roundHistory[S.roundHistory.length - 1];
    pushFeed(`<b>Overtime over</b> — still tied, the ring goes to the last round's winner`);
    return decider;
  }
  return null;
}

// ---------- per-step tick ----------
let drainSecond = -1;
export function tickRounds(dt) {
  S.time += dt;
  if (S.phase === 'buy') {
    S.phaseT -= dt;
    if (S.phaseT <= 0) { S.phase = 'live'; S.phaseT = RULES.roundSeconds; S.lastEvent = { type: 'live' }; }
    return;
  }
  if (S.phase === 'end') {
    S.phaseT -= dt;
    if (S.phaseT <= 0) {
      const winner = matchOver();
      if (winner) {
        S.phase = 'over'; S.winner = winner;
        S.lastEvent = { type: 'matchEnd', winner };
        audio.matchStinger(S.player && S.player.team === winner);
      } else {
        if (S.round >= RULES.regulationRounds && !S.overtime) {
          S.overtime = true;
          S.lastEvent = { type: 'overtime' };
        }
        nextRound();
      }
    }
    return;
  }
  if (S.phase !== 'live') return;

  // Channel progress: pain, movement and death all break it. A broken
  // channel is feed-worthy — the crew that was counting on it needs to know
  // it failed, and why.
  const ch = S.channel;
  if (ch) {
    const moved = Math.hypot(ch.actor.pos.x - ch.x, ch.actor.pos.z - ch.z);
    if (!ch.actor.alive || moved > 0.5 || ch.actor.lastHurtAt > ch.hurtAtStart) {
      const why = !ch.actor.alive ? 'went down' : ch.actor.lastHurtAt > ch.hurtAtStart ? 'took fire' : 'moved off the point';
      pushFeed(`<b>${ch.actor.name}</b>'s ${ch.kind} was broken — ${why}`);
      S.channel = null;
    } else {
      ch.t += dt;
      if (ch.kind === 'dock' && Math.floor(ch.t * 2) !== Math.floor((ch.t - dt) * 2)) audio.dockBeep(Math.floor(ch.t * 2));
      if (ch.kind === 'purge' && Math.random() < dt * 6) audio.purgeHum(ch.t);
      if (ch.t >= ch.need) completeChannel();
    }
  }

  // A dropped Leech is picked up by the first attacker who steps on it —
  // the pickup radius is generous on purpose, so a dead carrier's team can
  // recover it without pixel-hunting the floor.
  if (S.leech.state === 'dropped') {
    for (const a of S.actors) {
      if (!a.alive || !isAttacker(a)) continue;
      if (Math.hypot(a.pos.x - S.leech.pos.x, a.pos.z - S.leech.pos.z) < 1.3) {
        S.leech.state = 'carried'; S.leech.carrier = a;
        if (a.brain) a.brain.role = 'carry';
        pushFeed(`<b>${a.name}</b> recovered the Leech`);
        break;
      }
    }
  }

  const atkAlive = aliveCount(attackTeam());
  const defAlive = aliveCount(defendTeam());
  if (defAlive === 0) { endRound(attackTeam(), 'elimination'); return; }
  if (atkAlive === 0 && S.leech.state !== 'docked') { endRound(defendTeam(), 'elimination'); return; }
  if (atkAlive === 0 && defAlive === 0) { endRound(defendTeam(), 'elimination'); return; }

  if (S.leech.state === 'docked') {
    S.leech.drainT -= dt;
    const sec = Math.ceil(S.leech.drainT);
    // The drain's last ten seconds get a tick each second, and a single
    // feed warning at ten seconds so defenders feel the deadline coming.
    if (sec !== drainSecond) {
      drainSecond = sec;
      if (sec === 10) pushFeed(`<b>${sites[S.leech.site].name}</b> — drain critical, 10s left`);
      if (sec <= 10) audio.drainTick();
    }
    if (S.leech.drainT <= 0) { S.leech.state = 'spent'; endRound(attackTeam(), 'drain'); }
    return;
  }
  S.phaseT -= dt;
  if (S.phaseT <= 0) endRound(defendTeam(), 'time');
}
