// fx.js — everything transient and visual: tracer rounds, impact sparks and
// decals, shield-puff hits, death bursts, muzzle flashes, grenade bodies,
// smoke, explosions and the Leech prop itself. Everything is pooled and
// reused — the hot loops here allocate nothing per frame beyond the odd
// vector handed in by callers.

import * as THREE from 'three';
import { S } from './state.js';
import { scene, sites } from './world.js';

const fxGroup = new THREE.Group();
scene.add(fxGroup);

export let shake = 0;
export function addShake(n) { shake = Math.min(0.6, shake + n); }

// ---------- tracers ----------
const TRACERS = 48;
const tracerPool = [];
for (let i = 0; i < TRACERS; i++) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0 }));
  line.frustumCulled = false; line.visible = false;
  fxGroup.add(line);
  tracerPool.push({ line, until: 0 });
}
let tracerIdx = 0;
export function tracer(x1, y1, z1, x2, y2, z2, enemy = false) {
  const t = tracerPool[tracerIdx++ % TRACERS];
  const p = t.line.geometry.attributes.position;
  p.setXYZ(0, x1, y1, z1); p.setXYZ(1, x2, y2, z2); p.needsUpdate = true;
  t.line.material.color.setHex(enemy ? 0xff7d9c : 0xffe2ae);
  t.line.material.opacity = 0.85; t.line.visible = true;
  t.until = S.time + 0.055;
}

// ---------- particle sparks (one Points cloud, ring buffer) ----------
const PMAX = 900;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
points.frustumCulled = false;
fxGroup.add(points);
const parts = [];
for (let i = 0; i < PMAX; i++) parts.push({ life: 0, vx: 0, vy: 0, vz: 0, grav: 0 });
let pIdx = 0;
const _c = new THREE.Color();
function burst(x, y, z, n, color, speed, life, grav = -4) {
  _c.setHex(color);
  for (let i = 0; i < n; i++) {
    const p = parts[pIdx], j = pIdx * 3;
    pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
    pCol[j] = _c.r; pCol[j + 1] = _c.g; pCol[j + 2] = _c.b;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = speed * (0.3 + Math.random() * 0.7);
    p.vx = Math.sin(ph) * Math.cos(th) * sp; p.vy = Math.cos(ph) * sp; p.vz = Math.sin(ph) * Math.sin(th) * sp;
    p.life = life * (0.5 + Math.random() * 0.5); p.grav = grav;
    pIdx = (pIdx + 1) % PMAX;
  }
}
export function impact(x, y, z) { burst(x, y, z, 5, 0xffca7a, 2.6, 0.32); }
export function bloodPuff(x, y, z, team) { burst(x, y, z, 9, team === 'warden' ? 0x46e0d4 : 0xff5d8f, 2.0, 0.4); }
export function deathBurst(x, y, z, team) {
  burst(x, y, z, 26, team === 'warden' ? 0x46e0d4 : 0xff5d8f, 3.2, 0.8);
  burst(x, y, z, 10, 0xffffff, 1.6, 0.5, -1);
  addShake(0.08);
}
export function explosionFx(x, y, z) {
  burst(x, y, z, 46, 0xffa63d, 7, 0.7);
  burst(x, y, z, 22, 0xff5d3d, 4, 0.9);
  shockwave(x, Math.max(0.15, y), z);
  addShake(0.25);
}

// ---------- shockwave rings: an expanding torus on every explosion ----------
const shockPool = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 40),
    new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0, depthWrite: false }));
  m.rotation.x = Math.PI / 2; m.visible = false;
  fxGroup.add(m);
  shockPool.push({ mesh: m, born: 0, until: 0 });
}
let shockIdx = 0;
export function shockwave(x, y, z) {
  const s = shockPool[shockIdx++ % shockPool.length];
  s.mesh.position.set(x, y, z);
  s.mesh.scale.setScalar(0.2);
  s.mesh.material.opacity = 0.9; s.mesh.visible = true;
  s.born = S.time; s.until = S.time + 0.55;
}

// ---------- impact decals: a scorch mark where a round hit a wall ----------
const DECALS = 24;
const decalPool = [];
{
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  grad.addColorStop(0, 'rgba(20,16,12,0.9)'); grad.addColorStop(1, 'rgba(20,16,12,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  var decalTex = new THREE.CanvasTexture(c);
}
for (let i = 0; i < DECALS; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22),
    new THREE.MeshBasicMaterial({ map: decalTex, transparent: true, opacity: 0, depthWrite: false }));
  m.visible = false;
  fxGroup.add(m);
  decalPool.push({ mesh: m, until: 0 });
}
let decalIdx = 0;
export function impactDecal(x, y, z, nx, ny, nz) {
  const d = decalPool[decalIdx++ % DECALS];
  d.mesh.position.set(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01);
  d.mesh.lookAt(x + nx, y + ny, z + nz);
  d.mesh.material.opacity = 0.85; d.mesh.visible = true;
  d.until = S.time + 9;
}

// ---------- muzzle flashes ----------
const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,240,200,1)'); grad.addColorStop(0.4, 'rgba(255,170,60,0.7)'); grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const flashes = [];
for (let i = 0; i < 10; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  sp.scale.setScalar(0.5); sp.visible = false;
  fxGroup.add(sp);
  flashes.push({ sp, until: 0 });
}
let flashIdx = 0;
const _mv = new THREE.Vector3();
export function muzzleFlash(actor) {
  if (!actor.muzzle) return;
  actor.muzzle.getWorldPosition(_mv);
  const f = flashes[flashIdx++ % flashes.length];
  f.sp.position.copy(_mv);
  f.sp.scale.setScalar(0.35 + Math.random() * 0.3);
  f.sp.material.rotation = Math.random() * Math.PI;
  f.sp.material.opacity = 0.95; f.sp.visible = true;
  f.until = S.time + 0.045;
  // A wisp of smoke trails the flash on the big guns.
  if (actor.primary === 'osprey' || actor.primary === 'mule') burst(_mv.x, _mv.y, _mv.z, 2, 0x8a94a8, 0.4, 0.9, 0.6);
}

// ---------- grenades, smoke, explosion light ----------
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMats = {
  splinter: new THREE.MeshStandardMaterial({ color: 0xb8542e, roughness: 0.5, emissive: 0x521f00 }),
  shroud: new THREE.MeshStandardMaterial({ color: 0x5a6a7a, roughness: 0.5, emissive: 0x0c1420 }),
};
export function grenadeMesh(kind) {
  const m = new THREE.Mesh(grenadeGeo, grenadeMats[kind]);
  fxGroup.add(m);
  return m;
}
export function removeFx(obj) { fxGroup.remove(obj); }

const smokeMat = new THREE.MeshStandardMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.34, roughness: 1, depthWrite: false });
const liveSmokes = [];
export function spawnSmoke(x, z) {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1.1 + Math.random() * 0.9, 10, 8), smokeMat);
    s.position.set(x + (Math.random() - 0.5) * 3.4, 0.8 + Math.random() * 1.3, z + (Math.random() - 0.5) * 3.4);
    g.add(s);
  }
  fxGroup.add(g);
  const cloud = { x, z, r: 3.3, until: S.time + 14, group: g, born: S.time };
  liveSmokes.push(cloud); S.smokes.push(cloud);
}

// Does a sight line pass through any live smoke cloud? (sphere vs segment)
export function smokeBlocks(x1, y1, z1, x2, y2, z2) {
  for (const s of liveSmokes) {
    const vx = x2 - x1, vy = y2 - y1, vz = z2 - z1;
    const len2 = vx * vx + vy * vy + vz * vz;
    let t = len2 > 0 ? ((s.x - x1) * vx + (1.2 - y1) * vy + (s.z - z1) * vz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x1 + vx * t - s.x, dy = y1 + vy * t - 1.2, dz = z1 + vz * t - s.z;
    if (dx * dx + dy * dy + dz * dz < s.r * s.r) return true;
  }
  return false;
}

// ---------- the Leech prop ----------
const leechGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.44),
    new THREE.MeshStandardMaterial({ color: 0x2a1420, roughness: 0.4, metalness: 0.5 }));
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff5d8f }));
  eye.position.set(0, 0.06, 0.2);
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xff5d8f, transparent: true, opacity: 0.4 }));
  beacon.position.y = 3;
  leechGroup.add(body, eye, beacon);
  leechGroup.userData = { eye, beacon };
  leechGroup.visible = false;
  fxGroup.add(leechGroup);
}
export function dropLeech() { /* state already set by combat.js; visuals follow in tickFx */ }

// The drain beam: a live conduit from the docked Leech into the core.
const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0 }));
beam.frustumCulled = false; beam.visible = false;
fxGroup.add(beam);

const _lv = new THREE.Vector3();
export function tickFx(dt) {
  // The beam burns while a Leech is docked, breathing with the drain.
  if (S.leech.state === 'docked' && S.leech.site) {
    const s = sites[S.leech.site];
    const p = beamGeo.attributes.position;
    p.setXYZ(0, s.dockX, 1.18, s.dockZ);
    p.setXYZ(1, s.x, 1.7 + Math.sin(S.time * 7) * 0.15, s.z);
    p.needsUpdate = true;
    beam.material.opacity = 0.55 + Math.sin(S.time * 9) * 0.25;
    beam.visible = true;
    if (Math.random() < dt * 7) burst(s.dockX, 1.2, s.dockZ, 2, 0xffb454, 1.1, 0.4, 1.5);
  } else beam.visible = false;
  // Tracers, flashes, decals and shockwaves expire.
  for (const t of tracerPool) if (t.line.visible && S.time > t.until) { t.line.visible = false; t.line.material.opacity = 0; }
  for (const f of flashes) if (f.sp.visible && S.time > f.until) f.sp.visible = false;
  for (const s of shockPool) {
    if (!s.mesh.visible) continue;
    if (S.time > s.until) { s.mesh.visible = false; continue; }
    const k = (S.time - s.born) / 0.55;
    s.mesh.scale.setScalar(0.2 + k * 6.5);
    s.mesh.material.opacity = 0.9 * (1 - k);
  }
  for (const d of decalPool) {
    if (!d.mesh.visible) continue;
    if (S.time > d.until) { d.mesh.visible = false; continue; }
    d.mesh.material.opacity = Math.min(0.85, (d.until - S.time) / 3);
  }
  // Particles integrate.
  let any = false;
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i]; if (p.life <= 0) continue;
    any = true; p.life -= dt;
    const j = i * 3;
    if (p.life <= 0) { pPos[j + 1] = -50; continue; }
    p.vy += p.grav * dt;
    pPos[j] += p.vx * dt; pPos[j + 1] += p.vy * dt; pPos[j + 2] += p.vz * dt;
    if (pPos[j + 1] < 0.03) { pPos[j + 1] = 0.03; p.vy *= -0.4; }
  }
  if (any) { pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true; }
  // Smoke ages out.
  for (let i = liveSmokes.length - 1; i >= 0; i--) {
    const s = liveSmokes[i];
    const grow = Math.min(1, (S.time - s.born) / 0.9);
    s.group.scale.setScalar(0.4 + grow * 0.6);
    if (S.time > s.until) {
      fxGroup.remove(s.group);
      liveSmokes.splice(i, 1);
      const k = S.smokes.indexOf(s); if (k >= 0) S.smokes.splice(k, 1);
    }
  }
  // The Leech follows its state: on a back, on the floor, or on the pylon.
  const L = S.leech;
  if (L.state === 'carried' && L.carrier) {
    const c = L.carrier;
    leechGroup.visible = true;
    leechGroup.position.set(c.pos.x - Math.sin(c.yaw) * -0.28, c.pos.y + 1.18 - (c.crouch ? 0.34 : 0), c.pos.z - Math.cos(c.yaw) * -0.28);
    leechGroup.rotation.y = c.yaw;
    leechGroup.userData.beacon.visible = false;
  } else if (L.state === 'dropped') {
    leechGroup.visible = true;
    leechGroup.position.set(L.pos.x, 0.12 + Math.sin(S.time * 3) * 0.02, L.pos.z);
    leechGroup.userData.beacon.visible = true;
    leechGroup.userData.eye.material.color.setHex(Math.sin(S.time * 6) > 0 ? 0xff5d8f : 0x66182e);
  } else if (L.state === 'docked' && L.site) {
    const s = sites[L.site];
    leechGroup.visible = true;
    leechGroup.position.set(s.dockX, 1.12, s.dockZ);
    leechGroup.userData.beacon.visible = false;
    leechGroup.userData.eye.material.color.setHex(Math.sin(S.time * 10) > 0 ? 0xffb454 : 0xff5d8f);
  } else {
    leechGroup.visible = false;
  }
  shake = Math.max(0, shake - dt * 1.8);
}
