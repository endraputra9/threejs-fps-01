// world.js — the Vesper Ring, Deck 7: an orbital-station deck laid out as a
// 3×3 grid of bays cut by two cross partitions, so every bay has three doors
// and no route is a single corridor. This module owns the three.js scene,
// the collider boxes every other system tests against, the raycast used for
// bullets and sight lines, and the waypoint graph the bots path on. Each core
// wears a floating holo label and an energy column, and a docked core sets
// off a red alarm wash across its whole bay so the drain is visible from
// the far side of the deck. Layout, colliders and node names are the stable
// contract — bots.js and combat.js read them verbatim — so visual work here
// adds meshes only; it never moves a wall, a crate or a waypoint.

import * as THREE from 'three';
import { S } from './state.js';

export const BOUND = 34;          // hull half-extent in metres
export const WALL_H = 3.4;

export const colliders = [];       // { minX, maxX, minZ, maxZ, h }
export const sites = {
  A: { id: 'A', name: 'Helios Core', x: -24, z: 0, dockX: -21.4, dockZ: 0, color: 0xffb454 },
  B: { id: 'B', name: 'Umbra Core', x: 24, z: 0, dockX: 21.4, dockZ: 0, color: 0x9a6bff },
};
export const spawns = {
  north: [[-4.5, -27], [-1.5, -28.5], [1.5, -28.5], [4.5, -27], [0, -25.5]],
  south: [[-4.5, 27], [-1.5, 28.5], [1.5, 28.5], [4.5, 27], [0, 25.5]],
};

// ---------- procedural canvas textures ----------
function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function floorTexture() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#232a3a'; g.fillRect(0, 0, s, s);
    // Wear: faint speckle so the deck does not read as flat plastic.
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${140 + Math.random() * 60},${160 + Math.random() * 60},200,${Math.random() * 0.05})`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    // Panel seams and a worn inner frame.
    g.strokeStyle = '#12151f'; g.lineWidth = 6; g.strokeRect(0, 0, s, s);
    g.strokeStyle = 'rgba(120,170,255,0.13)'; g.lineWidth = 2; g.strokeRect(8, 8, s - 16, s - 16);
    // Hazard chevrons on two edges — the tile reads as a walkway edge
    // wherever it repeats, and the amber ticks double as a guide.
    g.fillStyle = 'rgba(255,180,84,0.5)';
    g.fillRect(0, s / 2 - 2, 26, 4); g.fillRect(s - 26, s / 2 - 2, 26, 4);
    g.fillStyle = 'rgba(255,180,84,0.28)';
    for (let i = 0; i < 4; i++) {
      g.beginPath(); g.moveTo(30 + i * 8, s / 2 - 8); g.lineTo(36 + i * 8, s / 2); g.lineTo(30 + i * 8, s / 2 + 8); g.closePath(); g.fill();
    }
    // A couple of darker service hatches break the grid up.
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(58, 58, 40, 40); g.fillRect(158, 158, 40, 40);
    g.strokeStyle = 'rgba(140,190,255,0.10)'; g.lineWidth = 2;
    g.strokeRect(58, 58, 40, 40); g.strokeRect(158, 158, 40, 40);
  }, 10);
}
function wallTexture() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#39415a'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#2c3348'; g.fillRect(0, s * 0.62, s, s * 0.38);
    g.strokeStyle = '#171b28'; g.lineWidth = 4; g.strokeRect(2, 2, s - 4, s - 4);
    g.beginPath(); g.moveTo(0, s * 0.62); g.lineTo(s, s * 0.62); g.stroke();
    // Lit service slits near the top, and a vent grille low down.
    g.fillStyle = 'rgba(140,190,255,0.20)';
    for (let i = 0; i < 5; i++) g.fillRect(18 + i * 48, 26, 26, 8);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 6; i++) g.fillRect(20 + i * 38, s * 0.74, 22, 5);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, s - 18, s, 18);
  }, 3);
}
function crateTexture() {
  return canvasTex(128, (g, s) => {
    g.fillStyle = '#4a4234'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#241f16'; g.lineWidth = 8; g.strokeRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,190,90,0.65)'; g.lineWidth = 3; g.strokeRect(14, 14, s - 28, s - 28);
    // Stencil: cargo mark plus a corner serial, so crates are not clones.
    g.fillStyle = 'rgba(255,190,90,0.8)'; g.font = 'bold 17px monospace'; g.fillText('VESPER', 22, s / 2 + 6);
    g.fillStyle = 'rgba(255,190,90,0.45)'; g.font = '11px monospace';
    g.fillText(`D7-${Math.floor(Math.random() * 900 + 100)}`, 22, s - 22);
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(14, 14); g.lineTo(s - 14, s - 14); g.stroke();
  });
}
function viewportTexture() {
  return canvasTex(512, (g, s) => {
    const grad = g.createRadialGradient(s * 0.72, s * 0.78, 40, s * 0.72, s * 0.78, 340);
    grad.addColorStop(0, '#3d6fb8'); grad.addColorStop(0.45, '#1d3a68'); grad.addColorStop(1, '#04060f');
    g.fillStyle = '#04060f'; g.fillRect(0, 0, s, s);
    g.fillStyle = grad; g.beginPath(); g.arc(s * 0.72, s * 0.86, 300, 0, Math.PI * 2); g.fill();
    // Planet limb: a lit arc over the disc, plus a thin ring band.
    g.fillStyle = 'rgba(160,210,255,0.5)'; g.beginPath(); g.arc(s * 0.72, s * 0.86, 300, Math.PI * 1.08, Math.PI * 1.5); g.lineWidth = 7; g.strokeStyle = 'rgba(170,220,255,0.55)'; g.stroke();
    g.beginPath(); g.ellipse(s * 0.72, s * 0.86, 330, 60, -0.5, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = 'rgba(200,230,255,0.28)'; g.stroke();
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.75})`;
      const r = Math.random() < 0.06 ? 2 : 1;
      g.fillRect(Math.random() * s, Math.random() * s * 0.8, r, r);
    }
  });
}
function labelTexture(text, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 96);
  g.fillStyle = color; g.font = 'bold 44px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = 18;
  g.fillText(text, 256, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function floorLetterTexture(letter, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = color; g.lineWidth = 10; g.globalAlpha = 0.75;
  g.strokeRect(28, 28, 200, 200);
  g.fillStyle = color; g.font = 'bold 150px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 128, 138);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- scene ----------
export const scene = new THREE.Scene();
export const worldGroup = new THREE.Group();
const dynGroup = new THREE.Group();   // cores' moving rings, holo — ticked in animateWorld
scene.add(worldGroup, dynGroup);
export const coreMeshes = {};
const guideStrips = []; // floor strips toward each core — pulsed in animateWorld

const MAT = {};
function buildMaterials() {
  MAT.floor = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.9, metalness: 0.25 });
  MAT.wall = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.75, metalness: 0.35 });
  MAT.wallCore = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.7, metalness: 0.4, color: 0xd8c9a8 });
  MAT.crate = new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.85, metalness: 0.15 });
  MAT.trim = new THREE.MeshBasicMaterial({ color: 0x3fd8ff });
  MAT.strip = new THREE.MeshBasicMaterial({ color: 0xbfe6ff });
}

function box(x, z, w, d, h, mat, y = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  worldGroup.add(m);
  return m;
}
function solid(x, z, w, d, h, mat) {
  box(x, z, w, d, h, mat);
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h });
}
// A wall run along one axis with door gaps cut out of it. Returns the gaps
// so callers can dress the doorways afterwards.
function wallRun(axis, at, from, to, gaps, mat) {
  const cuts = [[from, to]];
  for (const [g0, g1] of gaps) {
    for (let i = cuts.length - 1; i >= 0; i--) {
      const [a, b] = cuts[i];
      if (g1 <= a || g0 >= b) continue;
      cuts.splice(i, 1);
      if (g0 > a) cuts.push([a, g0]);
      if (g1 < b) cuts.push([g1, b]);
    }
  }
  for (const [a, b] of cuts) {
    if (b - a < 0.05) continue;
    const mid = (a + b) / 2, len = b - a;
    if (axis === 'x') solid(at, mid, 0.6, len, WALL_H, mat); else solid(mid, at, len, 0.6, WALL_H, mat);
  }
  // Neon guide strip above each doorway.
  for (const [g0, g1] of gaps) {
    const mid = (g0 + g1) / 2, len = g1 - g0;
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(axis === 'x' ? 0.7 : len, 0.14, axis === 'x' ? len : 0.7),
      new THREE.MeshBasicMaterial({ color: 0x3fd8ff }));
    strip.position.set(axis === 'x' ? at : mid, WALL_H - 0.12, axis === 'x' ? mid : at);
    worldGroup.add(strip);
  }
  return gaps;
}

// Ceiling fixtures: emissive light bars and hanging cable trays. Purely
// visual — they sit above head height and register no colliders.
function buildCeilingFixtures() {
  const barGeo = new THREE.BoxGeometry(4.2, 0.08, 0.5);
  const trayGeo = new THREE.BoxGeometry(6.5, 0.1, 0.35);
  const trayMat = new THREE.MeshStandardMaterial({ color: 0x232a3c, roughness: 0.8, metalness: 0.5 });
  for (const [x, z, ry] of [[-11, -11, 0], [11, -11, 0], [-11, 11, 0], [11, 11, 0], [0, -22, Math.PI / 2], [0, 22, Math.PI / 2]]) {
    const bar = new THREE.Mesh(barGeo, MAT.strip);
    bar.position.set(x, WALL_H - 0.05, z); bar.rotation.y = ry;
    worldGroup.add(bar);
    const tray = new THREE.Mesh(trayGeo, trayMat);
    tray.position.set(x, WALL_H - 0.16, z); tray.rotation.y = ry + Math.PI / 2;
    worldGroup.add(tray);
  }
}

export function buildWorld() {
  buildMaterials();
  scene.background = new THREE.Color(0x05070f);
  scene.fog = new THREE.Fog(0x05070f, 34, 95);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(BOUND * 2 + 4, BOUND * 2 + 4), MAT.floor);
  floor.rotation.x = -Math.PI / 2; worldGroup.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(BOUND * 2 + 4, BOUND * 2 + 4),
    new THREE.MeshStandardMaterial({ color: 0x1a2132, roughness: 0.95 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = WALL_H; worldGroup.add(ceil);
  buildCeilingFixtures();

  // Perimeter hull.
  solid(0, -BOUND - 0.3, BOUND * 2 + 1.2, 0.6, WALL_H, MAT.wall);
  solid(0, BOUND + 0.3, BOUND * 2 + 1.2, 0.6, WALL_H, MAT.wall);
  solid(-BOUND - 0.3, 0, 0.6, BOUND * 2 + 1.2, WALL_H, MAT.wall);
  solid(BOUND + 0.3, 0, 0.6, BOUND * 2 + 1.2, WALL_H, MAT.wall);

  // Cross partitions: doors north / mid / south on both axes.
  const gaps = [[-22, -18], [-2, 2], [18, 22]];
  wallRun('x', -11, -BOUND, BOUND, gaps, MAT.wall);
  wallRun('x', 11, -BOUND, BOUND, gaps, MAT.wall);
  wallRun('z', -11, -BOUND, BOUND, gaps, MAT.wall);
  wallRun('z', 11, -BOUND, BOUND, gaps, MAT.wall);

  // Atrium pillars and cargo cover, scattered so lanes bend around them.
  for (const [x, z] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) solid(x, z, 1.0, 1.0, WALL_H, MAT.wall);
  const crates = [
    [-22, -24], [-19.5, -19], [22, -24], [19.5, -19], [-22, 24], [19.5, 19], [22, 24], [-19.5, 19],
    [0, -20], [-4, -15], [4, -15], [0, 20], [-4, 15], [4, 15],
    [-27, -5], [-27, 5], [27, -5], [27, 5], [-16, -4], [16, 4], [-16, 4], [16, -4],
    [-24, -22], [24, 22], [-3, 0], [3.4, -1],
    // Mid-lane cover: a low crate on each spoke so a crossing is not a bare sprint.
    [-8, -3], [8, 3], [-8, 14], [8, -14],
  ];
  for (const [x, z] of crates) solid(x, z, 1.15, 1.15, 1.12, MAT.crate);
  // Low shield barriers: waist-high cover in the two core bays and the spokes.
  for (const [x, z, w, d] of [[-18, -8, 2.6, 0.5], [-18, 8, 2.6, 0.5], [18, -8, 2.6, 0.5], [18, 8, 2.6, 0.5], [0, -6, 0.5, 2.6], [0, 6, 0.5, 2.6]])
    solid(x, z, w, d, 1.05, MAT.wall);

  buildCore(sites.A, 0xffa63d);
  buildCore(sites.B, 0x9a6bff);
  buildLightsAndSky();
}

function buildCore(site, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.75, 3.1, 20),
    new THREE.MeshStandardMaterial({ color: 0x39415a, roughness: 0.45, metalness: 0.7 }));
  body.position.set(site.x, 1.55, site.z);
  // The glow is a band worn proud of the hull, so the core reads as lit from
  // across the deck (a fully internal glow cylinder would never be seen).
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(1.72, 1.78, 1.35, 20),
    new THREE.MeshBasicMaterial({ color }));
  glow.position.set(site.x, 1.55, site.z);
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.07, 8, 40), new THREE.MeshBasicMaterial({ color }));
  ring1.rotation.x = Math.PI / 2; ring1.position.set(site.x, 2.5, site.z);
  const ring2 = ring1.clone(); ring2.position.y = 0.9; ring2.scale.setScalar(0.86);
  // Energy column: a faint beam rising off the core to the ceiling, so the
  // reactor reads as live even when the room light is low.
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.9, WALL_H - 0.4, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  column.position.set(site.x, (WALL_H + 0.4) / 2, site.z);
  // Floating holo label so a new player can read which core is which.
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: labelTexture(site.name.toUpperCase(), `#${color.toString(16).padStart(6, '0')}`),
    transparent: true, depthWrite: false,
  }));
  label.scale.set(7.5, 1.4, 1);
  label.position.set(site.x, 3.9, site.z);
  // Floor decal: a big painted letter under the approach, readable at a run.
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({
      map: floorLetterTexture(site.id, `#${color.toString(16).padStart(6, '0')}`),
      transparent: true, depthWrite: false,
    }));
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(site.x > 0 ? site.x - 5.4 : site.x + 5.4, 0.02, site.z);
  g.add(body, glow, ring1, ring2, column, label, decal);
  worldGroup.add(g);
  const light = new THREE.PointLight(color, 60, 20, 1.8);
  light.position.set(site.x, 2.4, site.z);
  worldGroup.add(light);
  // Alarm light: dark until this core is draining, then a red wash.
  const alarm = new THREE.PointLight(0xff2a3c, 0, 26, 1.6);
  alarm.position.set(site.x, 3.1, site.z);
  worldGroup.add(alarm);
  colliders.push({ minX: site.x - 1.7, maxX: site.x + 1.7, minZ: site.z - 1.7, maxZ: site.z + 1.7, h: 3.2 });
  coreMeshes[site.id] = { group: g, glow, ring1, ring2, column, light, alarm, label, baseIntensity: 60 };
  // Docking pylon: the small console the Leech physically plugs into.
  solid(site.dockX, site.dockZ, 0.5, 0.5, 1.0, MAT.wallCore);
}

function buildLightsAndSky() {
  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1426, 0.95));
  scene.add(new THREE.AmbientLight(0x2a3648, 0.7));
  const atrium = new THREE.PointLight(0x54e0ff, 120, 32, 1.7); atrium.position.set(0, 3.1, 0); worldGroup.add(atrium);
  const north = new THREE.PointLight(0xff5d8f, 60, 24, 1.8); north.position.set(0, 3, -24); worldGroup.add(north);
  const south = new THREE.PointLight(0x46e0d4, 60, 24, 1.8); south.position.set(0, 3, 24); worldGroup.add(south);
  // Spinning holo-ring over the atrium.
  const holo = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.05, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0x54e0ff, transparent: true, opacity: 0.8 }));
  holo.position.set(0, 2.7, 0); holo.rotation.x = Math.PI / 2;
  dynGroup.add(holo); dynGroup.userData.holo = holo;
  // Viewports: emissive star-and-planet panels on the hull walls.
  const vtex = viewportTexture();
  const vmat = new THREE.MeshBasicMaterial({ map: vtex });
  for (const [x, z, ry] of [[-20, -33.6, 0], [14, -33.6, 0], [-14, 33.6, Math.PI], [20, 33.6, Math.PI], [-33.6, -16, Math.PI / 2], [33.6, 16, -Math.PI / 2]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 2.1), vmat);
    p.position.set(x, 1.9, z); p.rotation.y = ry; worldGroup.add(p);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(7.9, 2.4, 0.1), MAT.wall);
    frame.position.set(x, 1.9, z + (ry === 0 ? -0.06 : ry === Math.PI ? 0.06 : 0));
    if (ry === Math.PI / 2 || ry === -Math.PI / 2) { frame.rotation.y = ry; frame.position.set(x + (ry > 0 ? -0.06 : 0.06), 1.9, z); }
    worldGroup.add(frame); frame.renderOrder = -1; p.renderOrder = 0;
  }
  // Guide strips along the floor toward each core — pulsed in animateWorld
  // so a new player is drawn toward the objective without a tutorial.
  for (const s of [sites.A, sites.B]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(11, 0.28),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.55 }));
    strip.rotation.x = -Math.PI / 2; strip.rotation.z = Math.PI / 2;
    strip.position.set(s.x > 0 ? 16.5 : -16.5, 0.02, 0);
    worldGroup.add(strip);
    guideStrips.push(strip);
  }
}

let worldT = 0;
export function animateWorld(dt) {
  worldT += dt;
  dynGroup.userData.holo.rotation.z = worldT * 0.5;
  // Guide strips breathe slowly; a draining core's strip flashes with it.
  for (let i = 0; i < guideStrips.length; i++) {
    const strip = guideStrips[i];
    const id = i === 0 ? 'A' : 'B';
    const draining = S.leech.state === 'docked' && S.leech.site === id;
    strip.material.opacity = draining
      ? 0.55 + Math.sin(worldT * 6) * 0.35
      : 0.42 + Math.sin(worldT * 1.1 + i * 2.4) * 0.13;
  }
  for (const id of ['A', 'B']) {
    const c = coreMeshes[id]; if (!c) continue;
    c.ring1.rotation.z = worldT * 0.8; c.ring2.rotation.z = -worldT * 0.6;
    const pulse = 0.85 + Math.sin(worldT * 2.2) * 0.15;
    c.light.intensity = c.baseIntensity * pulse;
    // The energy column twists slowly and breathes with the same pulse.
    c.column.rotation.y = worldT * 0.35;
    c.column.material.opacity = 0.11 + pulse * 0.07;
    // The label bobs gently; a draining core flashes its alarm red.
    c.label.position.y = 3.9 + Math.sin(worldT * 1.4 + (id === 'A' ? 0 : 2)) * 0.08;
    const draining = S.leech.state === 'docked' && S.leech.site === id;
    c.alarm.intensity = draining ? 70 + Math.sin(worldT * 6) * 40 : 0;
    c.glow.material.color.setHex(draining && Math.sin(worldT * 6) > 0 ? 0xff2a3c : sites[id].color);
  }
}

// ---------- collision & raycast ----------
export function collideCircle(pos, radius) {
  // Push a circle (actor feet at pos.y) out of every collider it overlaps.
  for (const c of colliders) {
    if (pos.y > c.h - 0.22) continue;
    const nx = Math.max(c.minX, Math.min(c.maxX, pos.x));
    const nz = Math.max(c.minZ, Math.min(c.maxZ, pos.z));
    let dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2), push = (radius - d) / d;
      pos.x += dx * push; pos.z += dz * push;
    } else {
      // Centre inside the box: leave by the shallowest face.
      const left = pos.x - c.minX, right = c.maxX - pos.x, top = pos.z - c.minZ, bot = c.maxZ - pos.z;
      const m = Math.min(left, right, top, bot);
      if (m === left) pos.x = c.minX - radius; else if (m === right) pos.x = c.maxX + radius;
      else if (m === top) pos.z = c.minZ - radius; else pos.z = c.maxZ + radius;
    }
  }
  pos.x = Math.max(-BOUND + radius, Math.min(BOUND - radius, pos.x));
  pos.z = Math.max(-BOUND + radius, Math.min(BOUND - radius, pos.z));
}

const _inv = { x: 0, y: 0, z: 0 };
// Slab ray vs every collider. Returns nearest { dist, nx, ny, nz } or null.
export function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = null;
  for (const c of colliders) {
    let t0 = 0, t1 = maxDist, nx = 0, ny = 0, nz = 0;
    // X slab
    if (Math.abs(dx) < 1e-9) { if (ox < c.minX || ox > c.maxX) continue; }
    else {
      _inv.x = 1 / dx;
      let ta = (c.minX - ox) * _inv.x, tb = (c.maxX - ox) * _inv.x, s = -Math.sign(dx);
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = s; ny = 0; nz = 0; }
      t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    // Y slab (boxes stand on the floor)
    if (Math.abs(dy) < 1e-9) { if (oy < 0 || oy > c.h) continue; }
    else {
      _inv.y = 1 / dy;
      let ta = (0 - oy) * _inv.y, tb = (c.h - oy) * _inv.y, s = -Math.sign(dy);
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = 0; ny = s; nz = 0; }
      t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-9) { if (oz < c.minZ || oz > c.maxZ) continue; }
    else {
      _inv.z = 1 / dz;
      let ta = (c.minZ - oz) * _inv.z, tb = (c.maxZ - oz) * _inv.z, s = -Math.sign(dz);
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = 0; ny = 0; nz = s; }
      t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    if (!best || t0 < best.dist) best = { dist: t0, nx, ny, nz, collider: c };
  }
  return best;
}

export function losClear(x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return true;
  const hit = raycast(x1, y1, z1, dx / dist, dy / dist, dz / dist, dist);
  return !hit || hit.dist >= dist - 0.05;
}

// 2D segment vs every collider rect, expanded by a margin. Used to smooth
// bot paths: a shortcut is only taken when the whole straight line clears
// the boxes a walking actor would actually collide with.
export function segmentClear(x1, z1, x2, z2, margin = 0.5) {
  const dx = x2 - x1, dz = z2 - z1;
  for (const c of colliders) {
    if (c.h < 0.5) continue; // low crates are stepped around, not through
    const minX = c.minX - margin, maxX = c.maxX + margin;
    const minZ = c.minZ - margin, maxZ = c.maxZ + margin;
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-9) { if (x1 < minX || x1 > maxX) continue; }
    else {
      let ta = (minX - x1) / dx, tb = (maxX - x1) / dx;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (z1 < minZ || z1 > maxZ) continue; }
    else {
      let ta = (minZ - z1) / dz, tb = (maxZ - z1) / dz;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    return false;
  }
  return true;
}

// ---------- waypoint graph ----------
export const NODES = {
  nw: [-22, -22], n: [0, -22], ne: [22, -22],
  wa: [-19, 0], c: [0, 0], eb: [19, 0],
  sw: [-22, 22], s: [0, 22], se: [22, 22],
  dxWn: [-11, -20], dxWm: [-11, 0], dxWs: [-11, 20],
  dxEn: [11, -20], dxEm: [11, 0], dxEs: [11, 20],
  dzNw: [-20, -11], dzNc: [0, -11], dzNe: [20, -11],
  dzSw: [-20, 11], dzSc: [0, 11], dzSe: [20, 11],
  dockA: [-21.4, 0], dockB: [21.4, 0],
  holdA1: [-29, -6.5], holdA2: [-29, 6.5], holdA3: [-16.5, -7], holdA4: [-16.5, 7],
  holdB1: [29, -6.5], holdB2: [29, 6.5], holdB3: [16.5, -7], holdB4: [16.5, 7],
  atNW: [-6, -6], atNE: [6, -6], atSW: [-6, 6], atSE: [6, 6],
  spN: [0, -27], spS: [0, 27],
};
const EDGES = [
  ['spN', 'n'], ['n', 'dxWn'], ['n', 'dxEn'], ['n', 'dzNc'],
  ['nw', 'dxWn'], ['nw', 'dzNw'], ['ne', 'dxEn'], ['ne', 'dzNe'],
  ['dzNw', 'wa'], ['dzNc', 'c'], ['dzNe', 'eb'],
  ['wa', 'dxWm'], ['wa', 'dockA'], ['wa', 'dzSw'], ['wa', 'holdA3'], ['wa', 'holdA4'],
  ['eb', 'dxEm'], ['eb', 'dockB'], ['eb', 'dzSe'], ['eb', 'holdB3'], ['eb', 'holdB4'],
  ['dockA', 'holdA1'], ['dockA', 'holdA2'], ['dockB', 'holdB1'], ['dockB', 'holdB2'],
  ['holdA1', 'dzNw'], ['holdA2', 'dzSw'], ['holdB1', 'dzNe'], ['holdB2', 'dzSe'],
  ['c', 'dxWm'], ['c', 'dxEm'], ['c', 'dzNc'], ['c', 'dzSc'],
  ['c', 'atNW'], ['c', 'atNE'], ['c', 'atSW'], ['c', 'atSE'],
  ['atNW', 'dxWm'], ['atNW', 'dzNc'], ['atNE', 'dxEm'], ['atNE', 'dzNc'],
  ['atSW', 'dxWm'], ['atSW', 'dzSc'], ['atSE', 'dxEm'], ['atSE', 'dzSc'],
  ['dxWs', 'sw'], ['dxWs', 's'], ['dxEs', 'se'], ['dxEs', 's'],
  ['sw', 'dzSw'], ['se', 'dzSe'], ['s', 'dzSc'], ['s', 'spS'],
  ['dzSw', 'wa'], ['dzSe', 'eb'],
];
export const GRAPH = {};
for (const name of Object.keys(NODES)) GRAPH[name] = [];
for (const [a, b] of EDGES) {
  if (!GRAPH[a] || !GRAPH[b]) continue;
  const [ax, az] = NODES[a], [bx, bz] = NODES[b];
  const w = Math.hypot(ax - bx, az - bz);
  GRAPH[a].push({ to: b, w }); GRAPH[b].push({ to: a, w });
}

export function nearestNode(x, z) {
  let best = null, bd = Infinity;
  for (const name of Object.keys(NODES)) {
    const [nx, nz] = NODES[name];
    const d = (nx - x) * (nx - x) + (nz - z) * (nz - z);
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

// A* over the waypoint graph; returns a list of [x, z] waypoints (may be []).
// The open set is a binary heap keyed on f = g + h, so a cross-deck route
// costs log(n) per pop instead of a linear scan of every open node. The raw
// node list is then smoothed: greedy line-of-sight shortcuts cut the
// zig-zag, so a bot walks a diagonal across an open bay instead of hugging
// every corner — but only where segmentClear proves the straight line is
// actually walkable, so a shortcut never threads a wall.
export function findPath(x1, z1, x2, z2) {
  const start = nearestNode(x1, z1), goal = nearestNode(x2, z2);
  if (start === goal) return [[x2, z2]];
  const h = (n) => { const [nx, nz] = NODES[n]; return Math.hypot(nx - x2, nz - z2); };
  const heap = []; // [f, node]
  const heapPush = (f, n) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const heapPop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l][0] < heap[smallest][0]) smallest = l;
        if (r < heap.length && heap[r][0] < heap[smallest][0]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  };
  const came = new Map(), gs = new Map([[start, 0]]);
  const closed = new Set();
  heapPush(h(start), start);
  let raw = null;
  while (heap.length) {
    const [, cur] = heapPop();
    if (closed.has(cur)) continue;
    if (cur === goal) {
      raw = [];
      let n = goal;
      while (n !== start) { raw.unshift(NODES[n]); n = came.get(n); }
      raw.push([x2, z2]);
      break;
    }
    closed.add(cur);
    for (const e of GRAPH[cur]) {
      if (closed.has(e.to)) continue;
      const g = gs.get(cur) + e.w;
      if (g < (gs.get(e.to) ?? Infinity)) {
        gs.set(e.to, g); came.set(e.to, cur);
        heapPush(g + h(e.to), e.to);
      }
    }
  }
  if (!raw) return [[x2, z2]];
  // Smooth: from each kept point, jump to the furthest later point whose
  // straight line clears the deck.
  const smooth = [];
  let fromX = x1, fromZ = z1, i = 0;
  while (i < raw.length) {
    let j = raw.length - 1;
    while (j > i && !segmentClear(fromX, fromZ, raw[j][0], raw[j][1])) j--;
    smooth.push(raw[j]);
    fromX = raw[j][0]; fromZ = raw[j][1];
    i = j + 1;
  }
  return smooth.length ? smooth : [[x2, z2]];
}
