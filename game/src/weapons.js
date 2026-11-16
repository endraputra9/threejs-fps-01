// weapons.js — the armoury: five original guns, the Arc Knife, two grenades
// and the buy catalogue. One firing path serves the human and the bots, so a
// Ripper behaves identically in any hands: spread grows with movement and
// with sustained fire (bloom), recoil kicks the aim up along a per-weapon
// pattern that resets when you stop, and damage falls off past each gun's
// honest range. Stopping to shoot is how you hit things — and the first
// shot after a pause is the truest one you will get. Spread is drawn from a
// summed-uniform (near-Gaussian) cone, so shots cluster toward the aim point
// instead of spraying the corners of a square; a reload is cancelled the
// moment you switch weapons, so a swap is never a free reload.

import * as THREE from 'three';
import { S, noteShot } from './state.js';
import { hitscan, damage } from './combat.js';
import { losClear, colliders } from './world.js';
import { dodgeCheck } from './bots.js';
import * as audio from './audio.js';
import * as fx from './fx.js';

// headMult: headshot multiplier for this gun. penetration: share of damage
// that ignores plating. falloffFloor: the least damage a far shot keeps.
// pattern: the yaw drift each shot of a sustained burst adds, cycling.
// kick: view-model kick scale. adsSpread: spread multiplier while scoped.
export const WEAPONS = {
  knife:  { name: 'Arc Knife', slot: 'knife', price: 0, damage: 55, rpm: 110, mag: 0, reserve: 0, reload: 0, spread: 0, moveSpread: 0, bloom: 0, bloomMax: 0, recoil: 0, range: 2, auto: false, zoom: 1, headMult: 2, penetration: 1, falloffFloor: 1, pattern: [0], kick: 0, adsSpread: 1 },
  wasp:   { name: 'P3 Wasp', slot: 'sidearm', price: 0, damage: 26, rpm: 380, mag: 12, reserve: 60, reload: 1.1, spread: 0.009, moveSpread: 0.028, bloom: 0.005, bloomMax: 0.04, recoil: 0.012, range: 26, auto: false, zoom: 1, headMult: 3, penetration: 0.1, falloffFloor: 0.4, pattern: [0.4, -0.3, 0.2], kick: 1, adsSpread: 0.85 },
  ripper: { name: 'Ripper-9 SMG', slot: 'primary', price: 1100, damage: 20, rpm: 840, mag: 30, reserve: 120, reload: 1.9, spread: 0.015, moveSpread: 0.04, bloom: 0.007, bloomMax: 0.065, recoil: 0.009, range: 20, auto: true, zoom: 1, headMult: 3.5, penetration: 0.2, falloffFloor: 0.3, pattern: [0.5, -0.4, 0.6, -0.5, 0.3], kick: 0.9, adsSpread: 0.8 },
  mule:   { name: 'Mule-8 Scattergun', slot: 'primary', price: 1200, damage: 10, pellets: 9, rpm: 62, mag: 6, reserve: 30, reload: 2.6, spread: 0.052, moveSpread: 0.03, bloom: 0.01, bloomMax: 0.05, recoil: 0.055, range: 11, auto: false, zoom: 1, headMult: 2, penetration: 0.05, falloffFloor: 0.35, pattern: [0], kick: 1.6, adsSpread: 0.9 },
  lance:  { name: 'Lance AR', slot: 'primary', price: 2600, damage: 32, rpm: 660, mag: 30, reserve: 120, reload: 2.2, spread: 0.007, moveSpread: 0.048, bloom: 0.006, bloomMax: 0.05, recoil: 0.015, range: 38, auto: true, zoom: 1.12, headMult: 4, penetration: 0.35, falloffFloor: 0.4, pattern: [0.3, 0.5, -0.4, 0.6, -0.6, 0.4], kick: 1.1, adsSpread: 0.55 },
  osprey: { name: 'Osprey-7 Longshot', slot: 'primary', price: 4500, damage: 110, rpm: 40, mag: 5, reserve: 25, reload: 2.9, spread: 0.055, moveSpread: 0.09, bloom: 0.01, bloomMax: 0.06, recoil: 0.085, range: 85, auto: false, zoom: 2.6, headMult: 2.2, penetration: 0.6, falloffFloor: 0.6, pattern: [0], kick: 2.2, adsSpread: 0.02 },
};
export const GRENADES = {
  splinter: { name: 'Splinter Charge', price: 300, blurb: 'Fragmentation — 1.6 s fuse' },
  shroud: { name: 'Shroud Canister', price: 300, blurb: 'Smoke screen — blinds bot sensors' },
};
// The buy menu, in key order. `kind` tells buy() how to apply the purchase.
export const CATALOG = [
  { key: '1', id: 'ripper', kind: 'weapon' },
  { key: '2', id: 'mule', kind: 'weapon' },
  { key: '3', id: 'lance', kind: 'weapon' },
  { key: '4', id: 'osprey', kind: 'weapon' },
  { key: '5', id: 'armor', kind: 'gear', name: 'Plating Vest', price: 650, blurb: 'Soaks half of incoming damage' },
  { key: '6', id: 'armorHelm', kind: 'gear', name: 'Plating + Helm', price: 1000, blurb: 'Vest plus headshot protection' },
  { key: '7', id: 'splinter', kind: 'grenade' },
  { key: '8', id: 'shroud', kind: 'grenade' },
  { key: '9', id: 'purgeKit', kind: 'gear', name: 'Purge Kit', price: 400, blurb: 'Purges a docked Leech twice as fast' },
];

export function heldWeapon(actor) {
  if (actor.slot === 'primary') return actor.primary ? WEAPONS[actor.primary] : null;
  if (actor.slot === 'sidearm') return WEAPONS[actor.sidearm];
  if (actor.slot === 'knife') return WEAPONS.knife;
  return null; // grenade slot holds no gun
}
export function heldId(actor) {
  if (actor.slot === 'primary') return actor.primary;
  if (actor.slot === 'sidearm') return actor.sidearm;
  if (actor.slot === 'knife') return 'knife';
  return null;
}

export function giveWeapon(actor, id) {
  const w = WEAPONS[id];
  if (w.slot === 'primary') actor.primary = id; else if (w.slot === 'sidearm') actor.sidearm = id;
  actor.mag[id] = w.mag; actor.reserve[id] = w.reserve;
}
export function refillAmmo(actor) {
  for (const id of [actor.primary, actor.sidearm]) {
    if (!id) continue;
    actor.mag[id] = WEAPONS[id].mag; actor.reserve[id] = WEAPONS[id].reserve;
  }
}

// One purchase. Returns true when the sale went through.
export function buy(actor, entry) {
  if (entry.kind === 'weapon') {
    const w = WEAPONS[entry.id];
    if (actor.money < w.price) return false;
    if (actor.primary === entry.id) return false;
    actor.money -= w.price;
    giveWeapon(actor, entry.id);
    actor.slot = 'primary';
    return true;
  }
  if (entry.kind === 'grenade') {
    const g = GRENADES[entry.id];
    if (actor.money < g.price || actor.grenades.length >= 2 || actor.grenades.includes(entry.id)) return false;
    actor.money -= g.price;
    actor.grenades.push(entry.id);
    return true;
  }
  // gear
  if (entry.id === 'armor' || entry.id === 'armorHelm') {
    if (actor.money < entry.price) return false;
    if (entry.id === 'armor' && actor.armor >= 100 && !actor.helm) return false;
    if (entry.id === 'armorHelm' && actor.armor >= 100 && actor.helm) return false;
    actor.money -= entry.price;
    actor.armor = 100;
    if (entry.id === 'armorHelm') actor.helm = true;
    return true;
  }
  if (entry.id === 'purgeKit') {
    if (actor.money < entry.price || actor.purgeKit) return false;
    actor.money -= entry.price; actor.purgeKit = true;
    return true;
  }
  return false;
}

// ---------- firing ----------
const _dir = new THREE.Vector3(), _org = new THREE.Vector3(), _mzl = new THREE.Vector3();
export function aimDirection(actor, out) {
  const cp = Math.cos(actor.pitch);
  out.set(-Math.sin(actor.yaw) * cp, Math.sin(actor.pitch), -Math.cos(actor.yaw) * cp);
  return out;
}

// Near-Gaussian in [-1, 1]: the average of two uniforms clusters toward 0,
// so a spread cone throws most pellets near the aim point and few at the
// rim — the same cone, but a fairer one.
function gauss01() { return (Math.random() + Math.random() - 1); }

function currentSpread(actor, w) {
  const speed = Math.hypot(actor.vel.x, actor.vel.z);
  let s = w.spread + actor.spreadBloom;
  // Any scoped gun steadies hard: the zoom is the point of the scope.
  if (actor.scoped && w.zoom > 1) s = 0.0012 + actor.spreadBloom * 0.2 * w.adsSpread;
  else if (actor.scoped) s *= w.adsSpread;
  s += Math.min(0.06, speed * 0.011) * (w.moveSpread / 0.04);
  if (!actor.grounded) s += 0.05;
  if (actor.crouch) s *= 0.78;
  if (actor.sprinting) s *= 1.6;
  // First-shot accuracy: a pause of 0.8 s steadies the barrel.
  if (S.time - actor.lastShotAt > 0.8) s *= 0.7;
  return s;
}

// Attempt one shot (or one knife swing / grenade throw). Honours cooldown,
// magazine and reload state. Called every frame while the trigger is held;
// the weapon's own rate limiter decides what actually leaves the barrel.
export function fire(actor) {
  if (!actor.alive || S.phase !== 'live') return;
  if (S.time < actor.nextShotAt || S.time < actor.reloadingUntil) return;
  if (actor.slot === 'grenade') { throwGrenade(actor); return; }
  const w = heldWeapon(actor); if (!w) return;
  const id = heldId(actor);
  if (id === 'knife') {
    actor.nextShotAt = S.time + 60 / w.rpm;
    audio.shotSound('knife', 0);
    // A swing connects with the nearest foe inside 1.8 m and a forward cone,
    // and carries a short lunge so a knife kill is a commitment, not a tap.
    aimDirection(actor, _dir);
    let best = null, bd = 1.8;
    for (const foe of S.actors) {
      if (foe.team === actor.team || !foe.alive) continue;
      const dx = foe.pos.x - actor.pos.x, dz = foe.pos.z - actor.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < bd && (dx * _dir.x + dz * _dir.z) / (d || 1) > 0.4) { best = foe; bd = d; }
    }
    if (best) {
      actor.vel.x += _dir.x * 1.6; actor.vel.z += _dir.z * 1.6;
      damage(actor, best, w.damage, false);
    }
    return;
  }
  if (actor.mag[id] <= 0) {
    audio.dryFire();
    actor.nextShotAt = S.time + 0.3;
    startReload(actor);
    return;
  }
  actor.mag[id]--;
  actor.nextShotAt = S.time + 60 / w.rpm;
  actor.lastShotAt = S.time;
  actor.spreadBloom = Math.min(w.bloomMax, actor.spreadBloom + w.bloom);
  // Recoil: up the pitch, and sideways along the weapon's pattern — the
  // pattern resets when the trigger is released (see tickWeapon).
  actor.recoilShots = (actor.recoilShots || 0) + 1;
  const pat = w.pattern[(actor.recoilShots - 1) % w.pattern.length];
  actor.pitch += w.recoil * (0.7 + Math.random() * 0.6);
  actor.yaw += pat * w.recoil * 0.9;
  // Shot origin: the eye, pushed a little toward the muzzle.
  _org.set(actor.pos.x, actor.pos.y + actor.eye - (actor.crouch ? 0.34 : 0), actor.pos.z);
  aimDirection(actor, _dir);
  _org.addScaledVector(_dir, 0.25);
  const pellets = w.pellets || 1;
  const spread = currentSpread(actor, w);
  const distToPlayer = S.player ? Math.hypot(actor.pos.x - S.player.pos.x, actor.pos.z - S.player.pos.z) : 0;
  audio.shotSound(id, actor.isPlayer ? 0 : distToPlayer);
  noteShot(actor.pos.x, actor.pos.z, actor.team);
  fx.muzzleFlash(actor);
  for (let i = 0; i < pellets; i++) {
    // A scoped shot's first pellet rides the aim point exactly, and a
    // multi-pellet gun's first pellet always does — a well-aimed shot is
    // never pure lottery. The rest spread on a near-Gaussian cone.
    const cone = (i === 0 && (pellets > 1 || actor.scoped)) ? 0 : spread;
    const rx = gauss01() * cone, ry = gauss01() * cone, rz = gauss01() * cone;
    _dir.set(-Math.sin(actor.yaw) * Math.cos(actor.pitch) + rx, Math.sin(actor.pitch) + ry, -Math.cos(actor.yaw) * Math.cos(actor.pitch) + rz).normalize();
    const hit = hitscan(actor, _org.x, _org.y, _org.z, _dir.x, _dir.y, _dir.z, w);
    if (actor.isPlayer || (S.player && actor.team !== S.player.team)) {
      _mzl.copy(_org);
      fx.tracer(_mzl.x, _mzl.y, _mzl.z, _org.x + _dir.x * hit.dist, _org.y + _dir.y * hit.dist, _org.z + _dir.z * hit.dist, !actor.isPlayer);
    }
  }
  if (actor.mag[id] === 0) startReload(actor);
}

export function startReload(actor) {
  const id = heldId(actor); if (!id || id === 'knife') return;
  const w = WEAPONS[id];
  if (actor.mag[id] >= w.mag || actor.reserve[id] <= 0) return;
  if (S.time < actor.reloadingUntil) return;
  actor.reloadingUntil = S.time + w.reload;
  actor.reloadId = id; // the gun being loaded — a swap cancels the reload
  audio.reloadSound(id);
}
export function cancelReload(actor) {
  actor.reloadingUntil = 0;
  actor.reloadId = null;
}
export function tickWeapon(actor) {
  // Reload completion moves rounds from reserve to magazine — but only if
  // the actor still holds the gun that was being loaded. Switching away
  // mid-reload cancels it (see startReload's reloadId).
  if (actor.reloadingUntil && S.time >= actor.reloadingUntil) {
    const id = actor.reloadId || heldId(actor);
    if (id && WEAPONS[id] && id === heldId(actor)) {
      const w = WEAPONS[id];
      const move = Math.min(w.mag - actor.mag[id], actor.reserve[id]);
      actor.mag[id] += move; actor.reserve[id] -= move;
    }
    actor.reloadingUntil = 0;
    actor.reloadId = null;
  }
  // Bloom recovers faster when still and crouched; the recoil pattern
  // resets once the trigger has been up for a beat.
  const still = Math.hypot(actor.vel.x, actor.vel.z) < 0.5;
  const recover = 0.055 * (still ? 1.6 : 1) * (actor.crouch ? 1.25 : 1);
  actor.spreadBloom = Math.max(0, actor.spreadBloom - recover * (1 / 60));
  if (S.time - actor.lastShotAt > 0.6) actor.recoilShots = 0;
}

// ---------- grenades ----------
const liveGrenades = [];
function throwGrenade(actor) {
  const kind = actor.grenades[0];
  if (!kind) { actor.slot = actor.primary ? 'primary' : 'sidearm'; return; }
  actor.grenades.shift();
  actor.nextShotAt = S.time + 0.55;
  aimDirection(actor, _dir);
  const mesh = fx.grenadeMesh(kind);
  // Crouched throws go underhand: shorter, softer, and they stay low —
  // the way to roll a shroud under a doorway instead of over it.
  const underhand = actor.crouch;
  const speed = underhand ? 8 : 13;
  const spin = (Math.random() - 0.5) * 14;
  liveGrenades.push({
    kind, mesh, owner: actor, fuse: kind === 'splinter' ? 1.6 : 1.15, resting: 0, warned: false,
    spin, roll: 0,
    x: actor.pos.x + _dir.x * 0.4, y: actor.pos.y + 1.45, z: actor.pos.z + _dir.z * 0.4,
    vx: _dir.x * speed, vy: _dir.y * speed + (underhand ? 1.0 : 2.2), vz: _dir.z * speed,
  });
  audio.throwSound();
  actor.slot = actor.primary ? 'primary' : 'sidearm';
}

export function tickGrenades(dt) {
  for (let i = liveGrenades.length - 1; i >= 0; i--) {
    const g = liveGrenades[i];
    g.fuse -= dt;
    if (g.resting < 0.4) {
      g.vy -= 18 * dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
      if (g.y < 0.1) {
        g.y = 0.1; g.vy *= -0.38; g.vx *= 0.7; g.vz *= 0.7;
        // A spent bounce keeps rolling: the mesh spins along the floor
        // instead of sliding dead, and the roll feeds the resting timer.
        g.roll += Math.hypot(g.vx, g.vz) * dt * 2.2;
        if (Math.abs(g.vy) < 0.8) g.resting += dt;
      }
      // Bounce off walls: push the point out of any collider it entered and
      // reflect the velocity component that carried it in.
      for (const c of colliders) {
        if (g.y > c.h || g.x < c.minX - 0.08 || g.x > c.maxX + 0.08 || g.z < c.minZ - 0.08 || g.z > c.maxZ + 0.08) continue;
        const pl = g.x - (c.minX - 0.08), pr = (c.maxX + 0.08) - g.x, pt = g.z - (c.minZ - 0.08), pb = (c.maxZ + 0.08) - g.z;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) { g.x = c.minX - 0.08; g.vx = -Math.abs(g.vx) * 0.45; }
        else if (m === pr) { g.x = c.maxX + 0.08; g.vx = Math.abs(g.vx) * 0.45; }
        else if (m === pt) { g.z = c.minZ - 0.08; g.vz = -Math.abs(g.vz) * 0.45; }
        else { g.z = c.maxZ + 0.08; g.vz = Math.abs(g.vz) * 0.45; }
      }
      g.mesh.position.set(g.x, g.y, g.z);
      g.mesh.rotation.x += g.spin * dt;
      g.mesh.rotation.z += g.roll * dt * 0.4;
    }
    // A live splinter warns nearby bots once, a second before it pops:
    // they scatter, and a bot that saw it coming is a bot that survives it.
    if (g.kind === 'splinter' && !g.warned && g.fuse < 1.0) {
      g.warned = true;
      for (const a of S.actors) {
        if (a.brain && a.team !== g.owner.team) dodgeCheck(a, g.x, g.z);
      }
    }
    if (g.fuse > 0) continue;
    liveGrenades.splice(i, 1);
    fx.removeFx(g.mesh);
    if (g.kind === 'shroud') {
      fx.spawnSmoke(g.x, g.z);
      audio.smokeSound();
    } else {
      fx.explosionFx(g.x, Math.max(0.4, g.y), g.z);
      audio.explosionSound();
      const R = 6.5;
      for (const a of S.actors) {
        if (!a.alive) continue;
        const d = Math.hypot(a.pos.x - g.x, a.pos.z - g.z);
        if (d > R) continue;
        const clear = losClear(g.x, 1.0, g.z, a.pos.x, 1.1, a.pos.z);
        const dmg = Math.round(95 * (1 - d / R) * (clear ? 1 : 0.25));
        if (dmg > 0) damage(g.owner, a, dmg, false);
      }
    }
  }
}

// ---------- first-person view model ----------
let vmGroup = null, vmWeapon = null, vmKind = null, vmBob = 0;
let vmSwayX = 0, vmSwayY = 0, vmLastYaw = 0, vmLastPitch = 0;
const vmMats = {
  body: new THREE.MeshStandardMaterial({ color: 0x272e3a, roughness: 0.45, metalness: 0.65 }),
  accent: new THREE.MeshBasicMaterial({ color: 0x46e0d4 }),
  glove: new THREE.MeshStandardMaterial({ color: 0x151a24, roughness: 0.9 }),
};
export function buildViewModel(camera) {
  vmGroup = new THREE.Group();
  vmGroup.position.set(0.24, -0.24, -0.45);
  camera.add(vmGroup);
  return vmGroup;
}
function vmMesh(kind) {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; g.add(m); return m; };
  if (kind === 'knife') {
    add(new THREE.BoxGeometry(0.035, 0.09, 0.3), vmMats.accent, 0, 0, -0.1);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.12), vmMats.glove, 0, -0.02, 0.08);
  } else if (kind === 'grenade') {
    add(new THREE.SphereGeometry(0.075, 12, 10), vmMats.body, 0, 0, -0.05);
    add(new THREE.SphereGeometry(0.03, 8, 6), vmMats.accent, 0, 0.06, -0.05);
  } else if (kind === 'osprey') {
    add(new THREE.BoxGeometry(0.07, 0.1, 0.95), vmMats.body, 0, 0, -0.25);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10), vmMats.body, 0, 0.09, -0.3, Math.PI / 2);
    add(new THREE.BoxGeometry(0.05, 0.16, 0.12), vmMats.glove, 0, -0.12, 0.05);
  } else if (kind === 'mule') {
    add(new THREE.BoxGeometry(0.09, 0.11, 0.8), vmMats.body, 0, 0, -0.2);
    add(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 10), vmMats.body, 0, 0.01, -0.35, Math.PI / 2);
  } else if (kind === 'ripper') {
    add(new THREE.BoxGeometry(0.075, 0.13, 0.55), vmMats.body, 0, 0, -0.15);
    add(new THREE.BoxGeometry(0.05, 0.2, 0.08), vmMats.body, 0, -0.14, -0.1);
    add(new THREE.BoxGeometry(0.03, 0.03, 0.1), vmMats.accent, 0, 0.08, -0.3);
  } else { // wasp pistol + lance rifle share a frame, scaled by barrel
    const long = kind === 'lance';
    add(new THREE.BoxGeometry(0.07, 0.12, long ? 0.7 : 0.34), vmMats.body, 0, 0, long ? -0.18 : -0.05);
    add(new THREE.BoxGeometry(0.05, 0.18, 0.09), vmMats.glove, 0, -0.13, 0.02, 0.3);
    add(new THREE.BoxGeometry(0.018, 0.03, 0.04), vmMats.accent, 0, 0.072, long ? -0.42 : -0.18);
  }
  return g;
}
export function animateViewModel(actor, dt) {
  if (!vmGroup) return;
  const kind = actor.slot === 'grenade' ? 'grenade' : heldId(actor);
  if (kind !== vmKind) {
    if (vmWeapon) vmGroup.remove(vmWeapon);
    vmWeapon = kind ? vmMesh(kind) : null;
    if (vmWeapon) vmGroup.add(vmWeapon);
    vmKind = kind;
  }
  const speed = Math.hypot(actor.vel.x, actor.vel.z);
  vmBob += dt * (2 + speed * 1.6);
  const sway = Math.min(1, speed / 4);
  // Kick scales with the held gun: a Longshot bucks, a Wasp barely moves.
  const w = heldWeapon(actor);
  const kick = Math.max(0, (actor.nextShotAt - S.time)) * (w?.recoil || 0) * 2.2 * (w?.kick || 1);
  // Aim sway: the gun lags a fraction behind the mouse, so fast flicks
  // visibly drag the barrel — the view model follows the aim, it does not
  // ride it.
  let dYaw = actor.yaw - vmLastYaw, dPitch = actor.pitch - vmLastPitch;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;
  vmLastYaw = actor.yaw; vmLastPitch = actor.pitch;
  const swayK = 1 - Math.exp(-10 * dt);
  vmSwayX += (Math.max(-0.06, Math.min(0.06, -dYaw * 0.9)) - vmSwayX) * swayK;
  vmSwayY += (Math.max(-0.05, Math.min(0.05, dPitch * 0.9)) - vmSwayY) * swayK;
  // Reloading dips the gun down and away; sprinting lowers it to the hip.
  const reloading = S.time < actor.reloadingUntil;
  const sprintDip = actor.sprinting ? 0.16 : 0;
  vmGroup.position.set(
    0.24 + Math.sin(vmBob) * 0.008 * sway + vmSwayX,
    -0.24 + Math.abs(Math.cos(vmBob)) * 0.01 * sway + kick * 0.4 - (reloading ? 0.12 : 0) - sprintDip + vmSwayY,
    -0.45 + kick);
  vmGroup.rotation.x = kick * 1.4 + (reloading ? 0.45 : 0) + sprintDip * 1.2;
  vmGroup.rotation.z = reloading ? -0.5 : vmSwayX * 1.5;
  vmGroup.visible = actor.alive && !actor.scoped;
}
