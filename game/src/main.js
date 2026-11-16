// main.js — the conductor: builds the renderer and camera, wires input to
// the simulation, runs the fixed-step loop (60 Hz sim, render decoupled),
// drives the player's gun and channel key, positions the camera (with recoil
// shake, landing dip and a scoped FOV), and exposes the ?shot= / ?auto= hooks
// the maker uses to screenshot and playtest the game headlessly. ?fps=1 adds
// a frame-rate readout; mouse sensitivity persists in localStorage.

import * as THREE from 'three';
import { S, TEAM, RULES, isAttacker } from './state.js';
import { scene, buildWorld, animateWorld, sites } from './world.js';
import { animateBody } from './bodies.js';
import { initInput, input, drainPressed, updatePlayer } from './player.js';
import { fire, startReload, tickWeapon, tickGrenades, buildViewModel, animateViewModel, heldId, WEAPONS } from './weapons.js';
import { updateBot, makeBrain } from './bots.js';
import { setupMatch, startMatch, tickRounds, requestChannel, cancelChannel } from './rounds.js';
import { initHud, hud, updateHud, setBuyOpen, tryBuyKey, setScoreboard, showEndcard, hideEndcard } from './hud.js';
import * as fx from './fx.js';
import * as audio from './audio.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const AUTO = params.has('auto');
const FPS = params.has('fps');
let shotFrozen = false; // staged screenshots hold their pose: the sim stops, the render does not

// Sensitivity: the player's own setting survives reloads; player.js reads it
// through lookSensitivity's multiplier (default 1.0, range 0.4–2.5).
const sensStored = Number(localStorage.getItem('ringfall.sens') || '1');
export const sensFactor = Number.isFinite(sensStored) ? Math.max(0.4, Math.min(2.5, sensStored)) : 1;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.24;
document.getElementById('game').appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 300);
scene.add(camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

buildWorld();
setupMatch();
if (AUTO) makeBrain(S.player, 0); // the playtest driver crews the human slot
buildViewModel(camera);
initHud();
initInput(renderer.domElement);

// Optional FPS readout, top-right, updated twice a second.
let fpsEl = null, fpsFrames = 0, fpsAt = performance.now();
if (FPS) {
  fpsEl = document.createElement('div');
  fpsEl.style.cssText = 'position:fixed;right:12px;top:12px;z-index:9;color:#9fd8d2;font:12px ui-monospace,monospace;background:rgba(8,12,20,0.6);padding:3px 8px;border-radius:4px;pointer-events:none';
  document.body.appendChild(fpsEl);
}

let matchStarted = false;
let endShown = false;
let wasScoped = false;
let landSounded = false;
const menuEl = document.getElementById('menu');
const hudEl = document.getElementById('hud');

function lockPointer() {
  if (!SHOT) renderer.domElement.requestPointerLock();
}
hud.onPlay = () => {
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  if (!matchStarted) { startMatch(); matchStarted = true; }
  lockPointer();
};
hud.onAgain = () => {
  hideEndcard();
  endShown = false;
  startMatch();
  lockPointer();
};
renderer.domElement.addEventListener('click', () => {
  if (matchStarted && !input.locked && S.phase !== 'over') lockPointer();
});

// ---------- per-step player actions ----------
let wasFiring = false;
function playerActions(dt) {
  const p = S.player;
  // Discrete keys.
  for (const code of drainPressed()) {
    if (hud.buyOpen) {
      if (/^Digit[1-9]$/.test(code)) tryBuyKey(code.slice(5));
      if (code === 'KeyB' || code === 'Escape') setBuyOpen(false);
      continue;
    }
    if (code === 'Digit1' && p.primary) p.slot = 'primary';
    else if (code === 'Digit2') p.slot = 'sidearm';
    else if (code === 'Digit3') p.slot = 'knife';
    else if (code === 'Digit4' && p.grenades.length) p.slot = 'grenade';
    else if (code === 'KeyR') startReload(p);
    else if (code === 'KeyB' && S.phase === 'buy') setBuyOpen(true);
    else if (code === 'KeyM') { // M cycles mouse sensitivity in five steps
      const steps = [0.5, 0.75, 1, 1.5, 2];
      const cur = steps.indexOf(sensFactor);
      const next = steps[(cur + 1) % steps.length];
      localStorage.setItem('ringfall.sens', String(next));
      location.reload();
    }
  }
  setScoreboard(!!input.keys['Tab'] && matchStarted);
  if (!p.alive || S.phase !== 'live') { wasFiring = input.firing; return; }
  // The E key channels: dock as carrier, purge as defender.
  const useHeld = !!input.keys['KeyE'];
  if (useHeld) {
    if (S.leech.carrier === p) {
      for (const id of ['A', 'B']) {
        if (Math.hypot(p.pos.x - sites[id].dockX, p.pos.z - sites[id].dockZ) < 2.4) requestChannel(p, 'dock', id);
      }
    } else if (!isAttacker(p) && S.leech.state === 'docked') {
      const s = sites[S.leech.site];
      if (Math.hypot(p.pos.x - s.dockX, p.pos.z - s.dockZ) < 2.4) requestChannel(p, 'purge', S.leech.site);
    }
  } else if (S.channel && S.channel.actor === p) cancelChannel(p);
  // Trigger discipline: automatics may be held; the rest need a fresh press.
  const id = heldId(p);
  const w = id ? WEAPONS[id] : null;
  const wantFire = input.firing && input.locked || (input.firing && SHOT);
  if (wantFire && (w?.auto || !wasFiring || p.slot === 'grenade')) fire(p);
  wasFiring = input.firing;
  // Scope: right mouse with a scoped gun.
  p.scoped = !!(input.aiming && (id === 'osprey' || id === 'lance') && p.alive);
  if (p.scoped !== wasScoped) { audio.scopeSound(p.scoped); wasScoped = p.scoped; }
}

// ---------- simulation ----------
const STEP = 1 / 60;
let accumulator = 0, lastTs = performance.now();
let prevPhase = 'menu';
let orbitT = 0;
let deathT = 0; // seconds since the player died, drives the death cam

function simStep() {
  tickRounds(STEP);
  const p = S.player;
  if (matchStarted) {
    if (AUTO) { if (p.alive) updateBot(p, STEP); }
    else updatePlayer(p, STEP, S.phase === 'buy');
    playerActions(STEP);
    // A hard landing thuds once, at the moment the dip starts.
    if (p.landDip > 0.2 && !landSounded) { audio.landSound(true); landSounded = true; }
    if (p.landDip <= 0) landSounded = false;
  }
  for (const a of S.actors) {
    if (!a.isPlayer) updateBot(a, STEP);
    tickWeapon(a);
  }
  tickGrenades(STEP);
  // Phase transitions the HUD reacts to.
  if (S.phase !== prevPhase) {
    if (S.phase === 'buy' && matchStarted && !AUTO) setBuyOpen(true);
    if (S.phase === 'live') { setBuyOpen(false); audio.roundHorn(); }
    if (S.phase === 'over' && !endShown) {
      endShown = true;
      document.exitPointerLock && document.exitPointerLock();
      showEndcard();
    }
    prevPhase = S.phase;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - lastTs) / 1000);
  lastTs = now;
  accumulator += dt;
  let steps = 0;
  if (shotFrozen) accumulator = 0;
  while (accumulator >= STEP && steps < 5) { simStep(); accumulator -= STEP; steps++; }
  if (steps === 5) accumulator = 0;

  animateWorld(dt);
  for (const a of S.actors) animateBody(a, dt);
  fx.tickFx(dt);

  // Camera.
  const p = S.player;
  if (p.alive) deathT = 0;
  if (SHOT === 'menu' || (!matchStarted && !SHOT)) {
    orbitT += dt * 0.07;
    camera.position.set(Math.sin(orbitT) * 13, 5.2, Math.cos(orbitT) * 13);
    camera.lookAt(0, 1.2, 0);
    camera.fov = 62; camera.updateProjectionMatrix();
  } else if (p) {
    const dip = p.crouch ? 0.34 : 0;
    const landDip = (p.landDip || 0) / 0.22 * 0.12;
    if (!p.alive) {
      // Death cam: rise above the body and slowly orbit it, so the player
      // watches the round they just left instead of staring at the floor.
      deathT += dt;
      const r = 3.2 + Math.min(2.5, deathT * 0.8);
      camera.position.set(
        p.pos.x + Math.sin(deathT * 0.45) * r,
        Math.min(3.2, 1.2 + deathT * 0.9),
        p.pos.z + Math.cos(deathT * 0.45) * r);
      camera.lookAt(p.pos.x, p.pos.y + 0.8, p.pos.z);
      camera.fov = 62; camera.updateProjectionMatrix();
      animateViewModel(p, dt);
    } else {
      const eyeY = p.pos.y + p.eye - dip - landDip;
      camera.position.set(p.pos.x, eyeY, p.pos.z);
      if (fx.shake > 0.003) {
        camera.position.x += (Math.random() - 0.5) * fx.shake * 0.14;
        camera.position.y += (Math.random() - 0.5) * fx.shake * 0.14;
      }
      camera.rotation.order = 'YXZ';
      camera.rotation.y = p.yaw;
      camera.rotation.x = p.pitch;
      camera.rotation.z = 0;
      const targetFov = p.scoped ? 75 / (WEAPONS[heldId(p)]?.zoom || 1) : 75;
      if (Math.abs(camera.fov - targetFov) > 0.2) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
        camera.updateProjectionMatrix();
      }
      animateViewModel(p, dt);
    }
  }
  if (matchStarted) updateHud();
  renderer.render(scene, camera);
  if (fpsEl) {
    fpsFrames++;
    if (now - fpsAt >= 500) {
      fpsEl.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsAt))} fps`;
      fpsFrames = 0; fpsAt = now;
    }
  }
}
requestAnimationFrame(frame);

// ---------- screenshot & playtest hooks ----------
function stageShot() {
  if (!SHOT || SHOT === 'menu') return; // the menu shot is just the menu, orbiting
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  startMatch();
  matchStarted = true;
  const p = S.player;
  if (SHOT === 'buy') {
    setBuyOpen(true);
    return;
  }
  S.phase = 'live'; S.phaseT = 84;
  if (SHOT === 'action') {
    // A mid-atrium firefight: the player trades bursts with a reclaimer.
    p.pos.x = 1.8; p.pos.z = 8.5; p.yaw = 0.25; p.pitch = -0.02;
    p.primary = 'lance'; p.slot = 'primary'; p.mag.lance = 24; p.reserve.lance = 90; p.armor = 100;
    const foe = S.actors.find((a) => a.team === TEAM.RECLAIMER);
    foe.pos.x = -1.4; foe.pos.z = -5.5; foe.yaw = Math.PI - 0.2;
    foe.primary = 'lance'; foe.slot = 'primary'; foe.mag.lance = 30; foe.reserve.lance = 90;
    foe.brain.enemy = p; foe.brain.seenAt = S.time;
    fire(foe); fire(p);
    fx.explosionFx(6.5, 0.6, -14); // a spent splinter charge down the north spoke
  }
  if (SHOT === 'dock') {
    // A reclaimer mid-dock on Helios while the player covers the west door.
    const s = sites.A;
    p.pos.x = -13.5; p.pos.z = 3.6; p.yaw = 1.15; p.pitch = -0.03; // looking WNW at the dock pylon
    p.primary = 'lance'; p.slot = 'primary'; p.mag.lance = 30; p.reserve.lance = 120;
    const carrier = S.actors.find((a) => a.team === TEAM.RECLAIMER);
    carrier.pos.x = s.dockX; carrier.pos.z = s.dockZ; carrier.yaw = Math.PI / 2; // facing the core, west
    S.leech.state = 'carried'; S.leech.carrier = carrier;
    requestChannel(carrier, 'dock', 'A');
    if (S.channel) S.channel.t = 2.1;
  }
  shotFrozen = true; // every staged scene holds still for its portrait
}
if (SHOT) stageShot();

// The headless driver reads and pokes the match through here.
window.__ring = {
  S, RULES, sites, scene, camera, startMatch, requestChannel, cancelChannel,
  // Pump the fixed-step simulation directly: under a software renderer the
  // frame rate is low and the frame loop's step cap would slow game time,
  // so the playtest driver advances the sim itself between samples.
  step(n = 1) { for (let i = 0; i < n; i++) simStep(); },
  get phase() { return S.phase; },
  get actors() { return S.actors; },
  get sensFactor() { return sensFactor; },
  stageShot,
};
