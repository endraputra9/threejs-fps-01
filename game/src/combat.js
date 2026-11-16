// combat.js — hit resolution: one hitscan test shared by the player and the
// bots. A shot is a ray; the world gets first claim (raycast in world.js),
// then each living enemy is tested as a head sphere over a body capsule, so
// headshots pay per-weapon multipliers, legs pay less, and plating soaks a
// share of what lands — a share each weapon's penetration can punch through.
// Damage falls off past a gun's honest range on a curve, not a cliff.

import { S, TEAM, RULES, pay, pushFeed } from './state.js';
import { raycast } from './world.js';
import * as audio from './audio.js';
import * as fx from './fx.js';
import { flashHitmarker } from './hud.js';

const HEAD_R = 0.19, BODY_R = 0.35;

// Distance from a ray to a point, and the ray parameter of closest approach.
function rayPoint(ox, oy, oz, dx, dy, dz, px, py, pz) {
  const vx = px - ox, vy = py - oy, vz = pz - oz;
  const t = vx * dx + vy * dy + vz * dz;
  if (t < 0) return { t, d: Math.hypot(vx, vy, vz) };
  const cx = ox + dx * t - px, cy = oy + dy * t - py, cz = oz + dz * t - pz;
  return { t, d: Math.hypot(cx, cy, cz) };
}

// A shot past its honest range loses damage on a smooth curve down to a
// floor, so a long rifle shot still stings and a pistol at range still taps.
function falloff(weapon, dist) {
  if (dist <= weapon.range) return 1;
  const over = (dist - weapon.range) / 60;
  return Math.max(weapon.falloffFloor ?? 0.35, 1 - over);
}

// Fire one hitscan pellet from an actor along a direction. Returns what was
// hit: { kind: 'wall'|'head'|'body'|'legs'|'none', victim, dist }.
// A high-penetration gun (the Osprey) punches through low cover — crates and
// waist-high barriers — and still finds the body behind it at half damage,
// so hiding behind a crate is cover from a rifle, not from a longshot.
export function hitscan(shooter, ox, oy, oz, dx, dy, dz, weapon) {
  const maxD = 120;
  const wall = raycast(ox, oy, oz, dx, dy, dz, maxD);
  const wallD = wall ? wall.dist : maxD;
  const pierce = wall && (weapon.penetration ?? 0) >= 0.5 && wall.collider && wall.collider.h <= 1.2;
  // The actor test runs from the muzzle, or from just past a pierced wall.
  const test = (fromX, fromY, fromZ, limit, dmgMult) => {
    let victim = null, part = 'body', bestD = limit;
    for (const a of S.actors) {
      if (a === shooter || !a.alive || a.team === shooter.team) continue;
      const baseY = a.pos.y - (a.crouch ? 0.34 : 0);
      const head = rayPoint(fromX, fromY, fromZ, dx, dy, dz, a.pos.x, baseY + 1.58, a.pos.z);
      if (head.d < HEAD_R && head.t < bestD && head.t >= 0) { victim = a; part = 'head'; bestD = head.t; continue; }
      for (let i = 0; i < 3; i++) {
        const y = baseY + 1.24 - i * 0.38;
        const p = rayPoint(fromX, fromY, fromZ, dx, dy, dz, a.pos.x, y, a.pos.z);
        if (p.d < BODY_R && p.t < bestD && p.t >= 0) { victim = a; part = i === 2 ? 'legs' : 'body'; bestD = p.t; }
      }
    }
    return { victim, part, bestD, dmgMult };
  };
  let res = test(ox, oy, oz, wallD, 1);
  if (!res.victim && pierce) {
    // The round went through the crate: test again from the far side.
    const px = ox + dx * (wall.dist + 0.3), py = oy + dy * (wall.dist + 0.3), pz = oz + dz * (wall.dist + 0.3);
    const wall2 = raycast(px, py, pz, dx, dy, dz, maxD);
    res = test(px, py, pz, wall2 ? wall2.dist : maxD, 0.5);
    if (res.victim) {
      res.bestD += wall.dist + 0.3; // report the full distance from the muzzle
      fx.impact(px - dx * 0.05, py - dy * 0.05, pz - dz * 0.05, -dx, -dy, -dz);
    }
  }
  const { victim, part } = res;
  const bestD = res.bestD;
  if (victim) {
    const hx = ox + dx * bestD, hy = oy + dy * bestD, hz = oz + dz * bestD;
    const fall = falloff(weapon, bestD);
    const headMult = weapon.headMult ?? 4;
    let dmg = weapon.damage * fall * res.dmgMult * (part === 'head' ? headMult : part === 'legs' ? 0.72 : 1);
    if (victim.armor > 0 && !(part === 'head' && !victim.helm)) {
      // Penetration: a share of the damage ignores plating entirely.
      const pen = weapon.penetration ?? 0;
      const blocked = dmg * (1 - pen);
      const soaked = Math.min(victim.armor, blocked * 0.5);
      victim.armor -= soaked;
      dmg -= soaked;
    }
    dmg = Math.max(1, Math.round(dmg));
    fx.bloodPuff(hx, hy, hz, victim.team);
    damage(shooter, victim, dmg, part === 'head');
    return { kind: part, victim, dist: bestD };
  }
  // No victim: the round stops at the first wall it met (or flies free).
  if (wall) {
    const hx = ox + dx * wallD, hy = oy + dy * wallD, hz = oz + dz * wallD;
    fx.impact(hx, hy, hz, wall.nx, wall.ny, wall.nz); fx.impactDecal(hx, hy, hz, wall.nx, wall.ny, wall.nz);
    return { kind: 'wall', dist: wallD };
  }
  return { kind: 'none', dist: maxD };
}

// Apply damage, handle death: kill credit, assist credit, feed entry,
// Leech drop, corpse. Assists go to anyone who hurt the victim in the last
// 6 seconds and is not the killer.
export function damage(attacker, victim, dmg, headshot) {
  if (!victim.alive) return;
  victim.hp -= dmg;
  victim.lastHurtAt = S.time;
  victim.lastHurtBy = attacker;
  victim.damageTaken += dmg;
  if (attacker && attacker !== victim) {
    attacker.damageDealt += dmg;
    attacker.roundDamage += dmg;
    victim.recentHits.push({ actor: attacker, at: S.time });
    if (victim.recentHits.length > 8) victim.recentHits.shift();
  }
  if (victim.isPlayer) audio.hurtSound();
  if (attacker && attacker.isPlayer) { audio.hitTick(victim.hp <= 0); flashHitmarker(victim.hp <= 0); }
  if (victim.hp > 0) return;
  victim.hp = 0; victim.alive = false; victim.deaths++;
  fx.deathBurst(victim.pos.x, victim.pos.y + 1.1, victim.pos.z, victim.team);
  if (attacker && attacker !== victim) {
    attacker.kills++;
    attacker.roundKills++;
    pay(attacker, RULES.killReward);
    const credited = new Set([attacker]);
    for (const h of victim.recentHits) {
      if (credited.has(h.actor) || !h.actor.alive || S.time - h.at > 6) continue;
      credited.add(h.actor);
      h.actor.assists++;
      pay(h.actor, RULES.assistReward);
    }
    const aCls = attacker.team === TEAM.WARDEN ? 'wn' : 'rn';
    const vCls = victim.team === TEAM.WARDEN ? 'wn' : 'rn';
    pushFeed(`<b class="${aCls}">${attacker.name}</b> ▸ <b class="${vCls}">${victim.name}</b>${headshot ? ' · headshot' : ''}`);
  }
  // A dead carrier drops the Leech where they fell.
  if (S.leech.carrier === victim) {
    S.leech.state = 'dropped'; S.leech.carrier = null;
    S.leech.pos = { x: victim.pos.x, z: victim.pos.z };
    fx.dropLeech(victim.pos.x, victim.pos.z);
    pushFeed('<b>The Leech is down</b> — recover it');
  }
  if (S.channel && S.channel.actor === victim) S.channel = null;
}
