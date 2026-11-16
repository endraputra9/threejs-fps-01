// bots.js — the AI crew. Each bot runs a small brain on a staggered think
// tick: perceive (sight cones + real line-of-sight + smoke, gunfire and
// footsteps heard through the deck), share sightings with its team as intel,
// then act on a role — carry the Leech, escort it, lurk the far core, hold a
// site, rotate, purge, or fake a push to pull the defence off a core.
// Combat is burst fire with human-ish reaction times and aim error, strafing
// between bursts, so a bot is dangerous but beatable. Bots dodge a splinter
// they see land, throw their own shroud to cover a dock, save their credits
// when the round is already lost, patrol their hold when the deck goes
// quiet, and unstick themselves when a corner eats their path. A bot that
// watches a teammate die pushes the killer's last known spot; a bot that
// shares a target with a mate strafes the other way, so the pair crossfires
// instead of stacking into one lane.

import { S, TEAM, attackTeam, isAttacker, RULES } from './state.js';
import { findPath, NODES, losClear, sites, collideCircle } from './world.js';
import { WEAPONS, CATALOG, buy, fire, startReload } from './weapons.js';
import { smokeBlocks } from './fx.js';
import { requestChannel } from './rounds.js';

// Team-shared picture of the enemy: last known position and when it was set.
const intel = {
  warden: { x: 0, z: 0, at: -99, live: false },
  reclaimer: { x: 0, z: 0, at: -99, live: false },
};
export function teamIntel(team) { return intel[team]; }

const SKILLS = [
  { aim: 2.4, react: 0.24, burst: 5 }, { aim: 3.1, react: 0.3, burst: 4 },
  { aim: 3.8, react: 0.36, burst: 4 }, { aim: 4.4, react: 0.42, burst: 3 },
  { aim: 5.2, react: 0.5, burst: 3 },
];

// Veterans tighten up as the match goes on: a bot's aim error shrinks a
// little each round, so late rounds feel sharper than the pistol round.
function veteranAim(actor) {
  const rounds = Math.min(Math.max(S.round - 1, 0), 4);
  return 1 - 0.04 * rounds;
}

export function makeBrain(actor, index) {
  const skill = SKILLS[index % SKILLS.length];
  actor.brain = {
    skill, role: 'push', site: 'A', holdNode: null,
    path: [], pathI: 0, goalX: actor.pos.x, goalZ: actor.pos.z, hasGoal: false,
    enemy: null, seenAt: -9, reactUntil: 0, aimYaw: actor.yaw, aimPitch: 0,
    thinkAt: Math.random() * 0.3, perceptAt: Math.random() * 0.12,
    burstLeft: 0, nextBurstAt: 0, strafeDir: 1, strafeAt: 0,
    lastX: actor.pos.x, lastZ: actor.pos.z, stuckAt: 0, watchYaw: actor.yaw,
    // Dodging, faking, peeking, saving — and the second pass's additions:
    // patrol cycling, alert propagation and retribution pushes.
    dodgeX: 0, dodgeZ: 0, dodgeUntil: 0,
    peekAt: 0, peekDir: 1, peekNode: null,
    fakeSite: null, fakeUntil: 0,
    saveRound: false, regroupAt: 0,
    hurtDir: 0, hurtAt: -9,
    patrolAt: 0, patrolIdx: 0,
    matesAlive: 10, avengeUntil: 0,
  };
  return actor.brain;
}

// Roles are dealt at round start by rounds.js (it knows who carries). One
// attacker fakes the far core: the defence has to guess which core is real.
export function assignRoles() {
  const atk = attackTeam();
  const attackers = S.actors.filter((a) => a.team === atk && a.brain);
  const defenders = S.actors.filter((a) => a.team !== atk && a.brain);
  const site = Math.random() < 0.5 ? 'A' : 'B';
  const other = site === 'A' ? 'B' : 'A';
  for (const a of attackers) {
    const b = a.brain;
    b.site = site;
    b.fakeSite = null; b.fakeUntil = 0;
    if (S.leech.carrier === a) b.role = 'carry';
    else if (attackers.indexOf(a) % 2 === 0) b.role = 'escort';
    else { b.role = 'lurk'; b.site = other; b.fakeSite = other; b.fakeUntil = S.time + 18 + Math.random() * 8; }
  }
  const holdsA = ['holdA1', 'holdA3', 'holdA2', 'holdA4'];
  const holdsB = ['holdB1', 'holdB3', 'holdB2', 'holdB4'];
  defenders.forEach((a, i) => {
    const b = a.brain;
    if (i < 2) { b.role = 'hold'; b.site = 'A'; b.holdNode = holdsA[i]; }
    else if (i < 4) { b.role = 'hold'; b.site = 'B'; b.holdNode = holdsB[i - 2]; }
    else { b.role = 'flex'; b.site = site; b.holdNode = 'c'; }
    b.patrolIdx = 0; b.patrolAt = S.time + 10 + Math.random() * 6;
    b.matesAlive = S.actors.filter((m) => m.team === a.team && m.alive).length;
    b.avengeUntil = 0;
  });
  intel.warden.at = -99; intel.reclaimer.at = -99;
  intel.warden.live = false; intel.reclaimer.live = false;
}

// ---------- buying ----------
const byId = (id) => CATALOG.find((e) => e.id === id);
export function botBuy(actor) {
  const b = actor.brain; if (!b) return;
  // Save round: down 1-4 with a thin wallet, keep the pistol and the
  // credits — a full buy now loses the next round too.
  const m = actor.money;
  const losing = S.roundWins[actor.team === TEAM.WARDEN ? 'reclaimer' : 'warden'] -
    S.roundWins[actor.team === TEAM.WARDEN ? 'warden' : 'reclaimer'];
  b.saveRound = losing >= 2 && m < 2400 && S.round > 1;
  if (b.saveRound) {
    if (m >= 650 && actor.armor < 100) buy(actor, byId('armor'));
    actor.slot = actor.primary ? 'primary' : 'sidearm';
    return;
  }
  // Weapon first: reach decides the pick, wallet decides the reach.
  if (!actor.primary) {
    if (m >= WEAPONS.lance.price + 650) buy(actor, byId(Math.random() < 0.12 && m >= WEAPONS.osprey.price + 650 ? 'osprey' : 'lance'));
    else if (m >= WEAPONS.ripper.price + 300) buy(actor, byId(Math.random() < 0.5 ? 'ripper' : 'mule'));
  }
  if (actor.money >= 1000 && !(actor.armor >= 100 && actor.helm)) buy(actor, byId('armorHelm'));
  else if (actor.money >= 650 && actor.armor < 100) buy(actor, byId('armor'));
  if (!isAttacker(actor) && !actor.purgeKit && actor.money >= 900 && Math.random() < 0.6) buy(actor, byId('purgeKit'));
  if (actor.money >= 600 && Math.random() < 0.45) buy(actor, byId(Math.random() < 0.5 ? 'splinter' : 'shroud'));
  actor.slot = actor.primary ? 'primary' : 'sidearm';
}

// ---------- perception ----------
function perceive(actor) {
  const b = actor.brain;
  let best = null, bd = Infinity;
  for (const foe of S.actors) {
    if (foe.team === actor.team || !foe.alive) continue;
    const dx = foe.pos.x - actor.pos.x, dz = foe.pos.z - actor.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 62) continue;
    let seen = false;
    if (d < 3.4) seen = true;
    else {
      const fx = -Math.sin(actor.yaw), fz = -Math.cos(actor.yaw);
      const dot = (dx * fx + dz * fz) / (d || 1);
      if (dot > 0.42) { // ~65° half-angle cone
        const eyeY = actor.pos.y + 1.5;
        const chestY = foe.pos.y + 1.15 - (foe.crouch ? 0.3 : 0);
        if (losClear(actor.pos.x, eyeY, actor.pos.z, foe.pos.x, chestY, foe.pos.z) &&
            !smokeBlocks(actor.pos.x, eyeY, actor.pos.z, foe.pos.x, chestY, foe.pos.z)) seen = true;
      }
    }
    if (seen && d < bd) { best = foe; bd = d; }
    // Hearing: a sprinting foe nearby, or fresh gunfire, feeds team intel.
    if (foe.isPlayer && foe.noise > 0 && d < foe.noise * 1.7) {
      const inf = intel[actor.team]; inf.x = foe.pos.x; inf.z = foe.pos.z; inf.at = S.time; inf.live = foe.alive;
    }
  }
  for (const s of S.shots) {
    if (s.team === actor.team || S.time - s.t > 2.5) continue;
    if (Math.hypot(s.x - actor.pos.x, s.z - actor.pos.z) < 30) {
      const inf = intel[actor.team]; inf.x = s.x; inf.z = s.z; inf.at = s.t; inf.live = true;
    }
  }
  if (best) {
    const fresh = b.enemy !== best;
    if (fresh) b.reactUntil = S.time + b.skill.react * (0.7 + Math.random() * 0.6);
    b.enemy = best; b.seenAt = S.time;
    const inf = intel[actor.team]; inf.x = best.pos.x; inf.z = best.pos.z; inf.at = S.time; inf.live = true;
    // Alert: mates close by get the same enemy at once, so the crew turns
    // together instead of one bot at a time.
    if (fresh) {
      for (const mate of S.actors) {
        if (mate === actor || mate.team !== actor.team || !mate.alive || !mate.brain) continue;
        if (Math.hypot(mate.pos.x - actor.pos.x, mate.pos.z - actor.pos.z) > 14) continue;
        if (!mate.brain.enemy) {
          mate.brain.enemy = best;
          mate.brain.seenAt = S.time;
          mate.brain.reactUntil = S.time + mate.brain.skill.react * (0.9 + Math.random() * 0.5);
        }
      }
    }
  } else if (S.time - b.seenAt > 1.4) {
    b.enemy = null;
  }
  // Hurt direction: being shot from an unseen angle turns the bot toward it
  // for a beat, so a flank is not free.
  if (actor.lastHurtAt > b.hurtAt && actor.lastHurtBy) {
    b.hurtAt = actor.lastHurtAt;
    const src = actor.lastHurtBy;
    b.hurtDir = Math.atan2(-(src.pos.x - actor.pos.x), -(src.pos.z - actor.pos.z));
    if (!b.enemy) b.watchYaw = b.hurtDir;
  }
}

// ---------- movement ----------
function setGoal(actor, x, z, force = false) {
  const b = actor.brain;
  if (!force && b.hasGoal && Math.hypot(b.goalX - x, b.goalZ - z) < 1.2) return;
  b.goalX = x; b.goalZ = z; b.hasGoal = true;
  b.path = findPath(actor.pos.x, actor.pos.z, x, z);
  b.pathI = 0;
}
function followPath(actor, dt, speed) {
  const b = actor.brain;
  let tx = b.goalX, tz = b.goalZ;
  if (b.pathI < b.path.length) { [tx, tz] = b.path[b.pathI]; }
  const dx = tx - actor.pos.x, dz = tz - actor.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.55 && b.pathI < b.path.length) { b.pathI++; return followPath(actor, dt, speed); }
  if (d < 0.1) { actor.vel.x *= 0.8; actor.vel.z *= 0.8; return true; }
  // Separation so the crew does not stack into one silhouette.
  let sx = 0, sz = 0;
  for (const o of S.actors) {
    if (o === actor || !o.alive) continue;
    const ox = actor.pos.x - o.pos.x, oz = actor.pos.z - o.pos.z;
    const od = Math.hypot(ox, oz);
    if (od > 0.01 && od < 1.0) { sx += ox / od * (1 - od); sz += oz / od * (1 - od); }
  }
  const vx = dx / d + sx * 0.9, vz = dz / d + sz * 0.9;
  const vl = Math.hypot(vx, vz) || 1;
  const k = 1 - Math.exp(-9 * dt);
  actor.vel.x += (vx / vl * speed - actor.vel.x) * k;
  actor.vel.z += (vz / vl * speed - actor.vel.z) * k;
  return d < 0.8 && b.pathI >= b.path.length;
}
function faceToward(actor, x, z, dt, rate = 10) {
  const want = Math.atan2(-(x - actor.pos.x), -(z - actor.pos.z));
  let diff = want - actor.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  actor.yaw += diff * Math.min(1, rate * dt);
  return Math.abs(diff);
}

// A splinter that lands near a bot sends it sideways, away from the blast.
export function dodgeCheck(actor, gx, gz) {
  const b = actor.brain; if (!b) return;
  const d = Math.hypot(gx - actor.pos.x, gz - actor.pos.z);
  if (d > 5.5 || S.time < b.dodgeUntil) return;
  const away = Math.atan2(actor.pos.x - gx, actor.pos.z - gz);
  b.dodgeX = actor.pos.x + Math.sin(away) * 4;
  b.dodgeZ = actor.pos.z + Math.cos(away) * 4;
  b.dodgeUntil = S.time + 1.1;
}

// A bot wedged on a corner re-paths with a sidestep: nudge the goal sideways
// and let the pathfinder route around whatever caught it.
function unstick(actor) {
  const b = actor.brain;
  const side = Math.random() < 0.5 ? -1 : 1;
  const gx = b.goalX + side * 3, gz = b.goalZ + side * 2;
  setGoal(actor, gx, gz, true);
  b.stuckAt = S.time + 1.5;
  b.lastX = actor.pos.x; b.lastZ = actor.pos.z;
}

// ---------- think: choose goals by role and round state ----------
function think(actor) {
  const b = actor.brain;
  const atk = isAttacker(actor);
  const L = S.leech;
  const mySite = sites[b.site];

  // A teammate just died: push the killer's last known spot for a few
  // seconds instead of standing on a quiet post.
  const matesNow = S.actors.filter((a) => a.team === actor.team && a.alive).length;
  if (matesNow < b.matesAlive) {
    b.matesAlive = matesNow;
    const inf = intel[actor.team];
    if (inf.live && S.time - inf.at < 5) b.avengeUntil = S.time + 4;
  } else b.matesAlive = matesNow;
  if (S.time < b.avengeUntil && !b.enemy && L.state !== 'docked') {
    const inf = intel[actor.team];
    setGoal(actor, inf.x, inf.z);
    return;
  }

  // Outnumbered 1v3 or worse with the clock under 25 s: fall back and play
  // for the next round instead of feeding the enemy one more kill.
  const mates = S.actors.filter((a) => a.team === actor.team && a.alive).length;
  const foes = S.actors.filter((a) => a.team !== actor.team && a.alive).length;
  if (mates === 1 && foes >= 3 && S.phaseT < 25 && L.state !== 'docked' && !atk) {
    if (S.time >= b.regroupAt) { b.regroupAt = S.time + 6; setGoal(actor, 0, actor.pos.z > 0 ? 27 : -27, true); }
    return;
  }

  if (L.state === 'docked') {
    const ds = sites[L.site];
    if (atk) { // guard the drain from the site's own cover points
      const holds = L.site === 'A' ? ['holdA3', 'holdA1', 'holdA4', 'holdA2'] : ['holdB3', 'holdB1', 'holdB4', 'holdB2'];
      const node = holds[S.actors.filter((a) => a.team === actor.team).indexOf(actor) % holds.length];
      const [hx, hz] = NODES[node];
      setGoal(actor, hx, hz);
      b.watchYaw = Math.atan2(-(ds.x - hx), -(ds.z - hz));
    } else { // retake: two purge, the rest cover the approaches
      const matesAlive = S.actors.filter((a) => a.team === actor.team && a.alive);
      if (matesAlive.indexOf(actor) < 2) { b.role = 'purge'; setGoal(actor, ds.dockX, ds.dockZ); }
      else { b.role = 'cover'; setGoal(actor, ds.x * 0.72, ds.z + (actor.id % 2 ? 7 : -7)); }
    }
    return;
  }

  if (atk) {
    if (b.role === 'carry' || L.carrier === actor) {
      // A shroud over the dock hides the channel from the far door.
      if (actor.grenades.includes('shroud') && Math.hypot(actor.pos.x - mySite.dockX, actor.pos.z - mySite.dockZ) < 12 &&
          S.time >= (b.shroudAt || 0)) {
        const keep = actor.slot; actor.slot = 'grenade'; fire(actor);
        if (actor.slot === 'grenade') actor.slot = keep;
        b.shroudAt = S.time + 30;
      }
      setGoal(actor, mySite.dockX, mySite.dockZ);
      if (Math.hypot(actor.pos.x - mySite.dockX, actor.pos.z - mySite.dockZ) < 2.1) requestChannel(actor, 'dock', b.site);
    } else if (L.state === 'dropped' && b.role !== 'lurk') {
      setGoal(actor, L.pos.x, L.pos.z);
    } else if (b.role === 'escort') {
      // Walk a flank off the carrier, not on their heels: two guns, two angles.
      const carrier = L.carrier;
      if (carrier && carrier !== actor) {
        const side = actor.id % 2 ? 1 : -1;
        const fxv = -Math.sin(carrier.yaw), fzv = -Math.cos(carrier.yaw);
        setGoal(actor, carrier.pos.x + fzv * side * 3.2 - fxv * 1.5, carrier.pos.z - fxv * side * 3.2 - fzv * 1.5);
      } else setGoal(actor, mySite.x * 0.8, mySite.z + (actor.id % 2 ? 6 : -6));
    } else { // lurk: lean on the far core while the fake is live, drift to mid on intel
      const inf = intel[actor.team];
      if (S.time < b.fakeUntil && b.fakeSite) {
        const fs = sites[b.fakeSite];
        setGoal(actor, fs.x * 0.75, fs.z + (actor.id % 2 ? 8 : -8));
      } else if (inf.live && S.time - inf.at < 4) setGoal(actor, inf.x, inf.z);
      else setGoal(actor, mySite.x * 0.75, mySite.z + (actor.id % 2 ? 8 : -8));
    }
  } else {
    const inf = intel[actor.team];
    if (b.role === 'flex' && inf.live && S.time - inf.at < 5) setGoal(actor, inf.x, inf.z);
    else if (b.holdNode && NODES[b.holdNode]) {
      // Patrol: a quiet hold cycles between the site's cover points every
      // ~12 s, so a holder is never a statue the enemy can pre-aim forever.
      if (S.time >= b.patrolAt && !b.enemy) {
        const holds = b.site === 'A'
          ? ['holdA1', 'holdA3', 'holdA2', 'holdA4']
          : ['holdB1', 'holdB3', 'holdB2', 'holdB4'];
        b.patrolIdx = (b.patrolIdx + 1) % holds.length;
        b.holdNode = holds[b.patrolIdx];
        b.patrolAt = S.time + 11 + Math.random() * 5;
      }
      const [hx, hz] = NODES[b.holdNode];
      setGoal(actor, hx, hz);
      b.watchYaw = Math.atan2(-(sites[b.site].x - hx), -(sites[b.site].z - hz));
    }
    // A holder rotates if the other site is clearly under attack.
    if (b.role === 'hold' && inf.live && S.time - inf.at < 3) {
      const nearOther = Math.hypot(inf.x - sites[b.site === 'A' ? 'B' : 'A'].x, inf.z) < 12;
      if (nearOther && actor.id % 2 === 0) setGoal(actor, inf.x, inf.z);
    }
  }
  // Weapon housekeeping: empty primary → sidearm; dry gun → reload.
  const id = actor.slot === 'primary' ? actor.primary : actor.sidearm;
  if (id && actor.mag[id] === 0 && actor.reserve[id] === 0 && actor.slot === 'primary') actor.slot = 'sidearm';
  if (id && actor.mag[id] <= (WEAPONS[id].mag * 0.25) && !b.enemy) startReload(actor);
  actor.crouch = b.role === 'hold' && !b.enemy && Math.random() < 0.3;
}

// A peek spot: a nearby waypoint the enemy cannot see, so the bot can
// break the duel for a beat after a burst instead of standing in the open.
function peekSpot(actor, foe) {
  let best = null, bd = Infinity;
  for (const [nx, nz] of Object.values(NODES)) {
    const d = Math.hypot(nx - actor.pos.x, nz - actor.pos.z);
    if (d > 7 || d < 1.5) continue;
    if (losClear(nx, 1.5, nz, foe.pos.x, foe.pos.y + 1.15, foe.pos.z)) continue;
    if (d < bd) { bd = d; best = [nx, nz]; }
  }
  return best;
}

// ---------- per-frame bot update ----------
export function updateBot(actor, dt) {
  const b = actor.brain;
  if (!b || !actor.alive) return;
  if (S.phase !== 'live') { actor.vel.x *= 0.8; actor.vel.z *= 0.8; return; }
  if (S.time >= b.perceptAt) { b.perceptAt = S.time + 0.12; perceive(actor); }
  if (S.time >= b.thinkAt) { b.thinkAt = S.time + 0.25 + Math.random() * 0.08; think(actor); }

  // Stuck watch: a bot with a goal that has barely moved in 1.2 s is wedged
  // on something — re-path with a sidestep instead of grinding the corner.
  if (b.hasGoal && S.time >= b.stuckAt) {
    const moved = Math.hypot(actor.pos.x - b.lastX, actor.pos.z - b.lastZ);
    if (moved < 0.25 && Math.hypot(actor.vel.x, actor.vel.z) > 0.5) unstick(actor);
    else { b.lastX = actor.pos.x; b.lastZ = actor.pos.z; b.stuckAt = S.time + 1.2; }
  }

  // Channelling bots stand still and face the core.
  if (S.channel && S.channel.actor === actor) {
    actor.vel.x *= 0.7; actor.vel.z *= 0.7;
    const s = sites[S.channel.site];
    faceToward(actor, s.x, s.z, dt);
    stepBody(actor, dt);
    return;
  }

  // A live dodge overrides the plan for a second.
  if (S.time < b.dodgeUntil) {
    setGoal(actor, b.dodgeX, b.dodgeZ, true);
    followPath(actor, dt, 5.2);
    stepBody(actor, dt);
    return;
  }

  const foe = b.enemy && b.enemy.alive ? b.enemy : null;
  if (foe) {
    // Fight: close to the weapon's honest range, strafe, burst.
    const d = Math.hypot(foe.pos.x - actor.pos.x, foe.pos.z - actor.pos.z);
    const range = actor.primary === 'mule' ? 9 : actor.primary === 'ripper' ? 17 : actor.primary === 'osprey' ? 48 : 30;
    let arrived = false;
    // A fresh peek overrides the strafe: break line of sight first, then
    // re-engage from the new angle.
    if (S.time - b.peekAt < 0.9 && b.hasGoal) { arrived = followPath(actor, dt, 4.6); }
    else if (d > range) { setGoal(actor, foe.pos.x, foe.pos.z); arrived = followPath(actor, dt, 4.35); }
    else if (d < 4.5) { setGoal(actor, actor.pos.x - (foe.pos.x - actor.pos.x), actor.pos.z - (foe.pos.z - actor.pos.z)); followPath(actor, dt, 3.6); }
    else {
      // Strafe sideways between bursts, and peek: break line of sight for a
      // beat after a burst so the enemy's return fire meets a wall.
      if (S.time >= b.strafeAt) {
        b.strafeAt = S.time + 0.6 + Math.random() * 0.8;
        // Crossfire: if a mate is already duelling this foe, strafe the
        // other way — two guns from two angles, not one stacked lane.
        const mate = S.actors.find((m) => m !== actor && m.team === actor.team && m.alive && m.brain && m.brain.enemy === foe);
        b.strafeDir = mate ? -mate.brain.strafeDir : (Math.random() < 0.5 ? -1 : 1);
      }
      const fxv = -(foe.pos.z - actor.pos.z) / (d || 1) * b.strafeDir, fzv = (foe.pos.x - actor.pos.x) / (d || 1) * b.strafeDir;
      const k = 1 - Math.exp(-8 * dt);
      actor.vel.x += (fxv * 2.4 - actor.vel.x) * k;
      actor.vel.z += (fzv * 2.4 - actor.vel.z) * k;
      arrived = true;
    }
    // Aim: chest-seeking with skill error that settles the longer we track.
    // Veterans (later rounds) hold a tighter cone.
    const settle = Math.min(1, (S.time - b.seenAt) / 0.9);
    const err = (1 - settle * 0.55) * b.skill.aim * veteranAim(actor) * (Math.PI / 180);
    const aimX = foe.pos.x + Math.sin(S.time * 1.7 + actor.id) * err * d * 0.6;
    const aimZ = foe.pos.z + Math.cos(S.time * 1.3 + actor.id * 2) * err * d * 0.6;
    faceToward(actor, aimX, aimZ, dt, 12);
    const dy = (foe.pos.y + 1.32 - (foe.crouch ? 0.3 : 0)) - (actor.pos.y + 1.5);
    const wantPitch = Math.atan2(dy, d);
    actor.pitch += (wantPitch - actor.pitch) * Math.min(1, 12 * dt);
    // A carried Splinter goes out ahead of the burst when the range suits it:
    // far enough to arm, close enough to land among the enemy.
    if (actor.grenades[0] === 'splinter' && d > 7 && d < 21 && S.time >= (b.grenadeAt || 0) && S.time >= b.reactUntil) {
      const keep = actor.slot;
      actor.slot = 'grenade';
      fire(actor); // throws grenades[0] along the bot's aim
      if (actor.slot === 'grenade') actor.slot = keep; // throw refused (e.g. reloading): stay as we were
      b.grenadeAt = S.time + 18 + Math.random() * 10;
    }
    // Bursts after the reaction delay.
    if (S.time >= b.reactUntil && S.time >= b.nextBurstAt) {
      if (b.burstLeft <= 0) { b.burstLeft = b.skill.burst; }
      fire(actor);
      b.burstLeft--;
      if (b.burstLeft <= 0) {
        b.nextBurstAt = S.time + 0.34 + Math.random() * 0.4;
        // Peek: after a burst, duck behind cover for the pause when the
        // enemy is still up and the bot has a spot to duck to.
        if (foe.alive && Math.random() < 0.55) {
          const spot = peekSpot(actor, foe);
          if (spot) { setGoal(actor, spot[0], spot[1], true); b.peekAt = S.time; }
        }
      }
    }
    actor.crouch = actor.primary === 'osprey' && d > 25;
    void arrived;
  } else {
    const arrived = followPath(actor, dt, b.role === 'carry' ? 4.3 : 4.45);
    if (arrived || Math.hypot(actor.vel.x, actor.vel.z) < 0.4) {
      // At post: watch the assigned angle, drift the gaze slowly.
      const wy = b.watchYaw + Math.sin(S.time * 0.4 + actor.id) * 0.3;
      let diff = wy - actor.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      actor.yaw += diff * Math.min(1, 3 * dt);
    } else {
      faceToward(actor, actor.pos.x + actor.vel.x, actor.pos.z + actor.vel.z, dt, 8);
    }
    actor.pitch *= 0.9;
  }
  stepBody(actor, dt);
}

function stepBody(actor, dt) {
  actor.pos.x += actor.vel.x * dt;
  actor.pos.z += actor.vel.z * dt;
  actor.pos.y = 0;
  collideCircle(actor.pos, actor.radius);
  actor.noise = Math.hypot(actor.vel.x, actor.vel.z) > 2.5 ? 9 : 2;
}
