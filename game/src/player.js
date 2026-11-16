// player.js — the human operative: raw input capture (keys, mouse, pointer
// lock deltas) and the movement model. Movement is acceleration-based with a
// hard stop on release, crouching lowers the eye and the spread, walking is
// slow and quiet, sprinting is loud enough for bots to hear through doors.
// A heavy gun slows you down; landing from a jump dips the view for a beat.

import { S } from './state.js';
import { collideCircle } from './world.js';
import * as audio from './audio.js';

export const input = {
  keys: {},            // held keys by KeyboardEvent.code
  pressed: [],         // codes pressed since the last drain (discrete actions)
  mouseDX: 0, mouseDY: 0,
  firing: false, aiming: false,
  locked: false,
};

export function initInput(dom) {
  addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    if (!e.repeat) input.pressed.push(e.code);
    input.keys[e.code] = true;
  });
  addEventListener('keyup', (e) => { input.keys[e.code] = false; });
  addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mouseDX += e.movementX || 0;
    input.mouseDY += e.movementY || 0;
  });
  addEventListener('mousedown', (e) => {
    if (!input.locked) return;
    if (e.button === 0) input.firing = true;
    if (e.button === 2) input.aiming = true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) input.firing = false;
    if (e.button === 2) input.aiming = false;
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === dom;
    if (!input.locked) { input.firing = false; input.aiming = false; }
  });
}
export function drainPressed() {
  const p = input.pressed;
  input.pressed = [];
  return p;
}
export function lookSensitivity() {
  // The player's own setting (M cycles it, main.js persists it); default 1.0.
  let f = 1;
  try {
    const v = Number(localStorage.getItem('ringfall.sens') || '1');
    if (Number.isFinite(v)) f = Math.max(0.4, Math.min(2.5, v));
  } catch { /* storage unavailable: play at default sensitivity */ }
  return 0.0021 * f;
}

// How much a held weapon weighs on the feet: the longshot drags, the knife frees.
function weaponSpeedFactor(actor) {
  if (actor.slot === 'knife') return 1.08;
  if (actor.slot === 'grenade') return 1.0;
  if (actor.slot === 'primary') {
    if (actor.primary === 'osprey') return 0.88;
    if (actor.primary === 'mule') return 0.94;
    return 0.97;
  }
  return 1.0;
}

// One fixed step of human movement. `frozen` (buy phase) allows looking but
// not travelling. Sets actor.noise (metres) for bot hearing, and actor.landDip
// (seconds since landing) for the camera dip in main.js.
export function updatePlayer(actor, dt, frozen) {
  // Look first: mouse deltas always apply outside menus.
  const sens = lookSensitivity() * (actor.scoped ? 0.45 : 1);
  actor.yaw -= input.mouseDX * sens;
  actor.pitch -= input.mouseDY * sens;
  actor.pitch = Math.max(-1.45, Math.min(1.45, actor.pitch));
  input.mouseDX = 0; input.mouseDY = 0;
  if (!actor.alive) return;

  // C toggles the crouch (this runs before main.js drains the press queue);
  // either Ctrl key holds it the classic way.
  for (const code of input.pressed) if (code === 'KeyC') actor.crouchToggle = !actor.crouchToggle;
  actor.crouch = !!(input.keys['ControlLeft'] || input.keys['ControlRight'] || actor.crouchToggle);
  const walking = !!(input.keys['AltLeft'] || input.keys['AltRight']);
  let fwd = 0, strafe = 0;
  if (!frozen) {
    if (input.keys['KeyW'] || input.keys['ArrowUp']) fwd += 1;
    if (input.keys['KeyS'] || input.keys['ArrowDown']) fwd -= 1;
    if (input.keys['KeyD'] || input.keys['ArrowRight']) strafe += 1;
    if (input.keys['KeyA'] || input.keys['ArrowLeft']) strafe -= 1;
  }
  const len = Math.hypot(fwd, strafe) || 1;
  fwd /= len; strafe /= len;
  // Sprint: Shift while pushing forward, gun lowered — it costs spread and
  // quiet, and the bots hear it. Alt walks slow and quiet instead.
  const shift = !!(input.keys['ShiftLeft'] || input.keys['ShiftRight']);
  const sprinting = shift && !walking && !actor.crouch && !actor.scoped && fwd > 0 && Math.abs(strafe) < 0.1;
  let speed = actor.crouch ? 1.9 : walking ? 2.6 : 4.6;
  if (sprinting) speed = 5.6;
  if (actor.slot === 'knife') speed += 0.35;
  if (actor.scoped) speed *= 0.55;
  speed *= weaponSpeedFactor(actor);
  actor.sprinting = sprinting;
  // Wish direction in world space from yaw.
  const sy = Math.sin(actor.yaw), cy = Math.cos(actor.yaw);
  const wx = (-sy * fwd + cy * strafe) * speed;
  const wz = (-cy * fwd - sy * strafe) * speed;
  // Acceleration: snappy on the ground, drifty in the air — but air control
  // still lets you steer a jump a little instead of locking the arc.
  const k = actor.grounded ? 1 - Math.exp(-11 * dt) : 1 - Math.exp(-2.4 * dt);
  actor.vel.x += (wx - actor.vel.x) * k;
  actor.vel.z += (wz - actor.vel.z) * k;
  // Gravity and jumping. A jump out of a crouch is a hop, not a launch.
  actor.vel.y -= 22 * dt;
  if (actor.grounded && !frozen && input.keys['Space']) {
    actor.vel.y = actor.crouch ? 4.6 : 6.4;
    actor.grounded = false;
  }
  actor.pos.x += actor.vel.x * dt;
  actor.pos.z += actor.vel.z * dt;
  const wasAirborne = !actor.grounded;
  const fallSpeed = actor.vel.y;
  actor.pos.y += actor.vel.y * dt;
  if (actor.pos.y <= 0) {
    actor.pos.y = 0; actor.vel.y = 0;
    if (wasAirborne && fallSpeed < -6) actor.landDip = 0.22; // hard landing dips the view
    actor.grounded = true;
  }
  actor.landDip = Math.max(0, (actor.landDip || 0) - dt);
  collideCircle(actor.pos, actor.radius);
  // Hearing profile for the bots, and the player's own footstep sounds.
  const planar = Math.hypot(actor.vel.x, actor.vel.z);
  actor.noise = actor.crouch ? 1.5 : walking ? 3.5 : sprinting ? 13 : planar > 1 ? 9.5 : 0;
  actor.stepAcc = (actor.stepAcc || 0) + planar * dt;
  const stride = walking || actor.crouch ? 2.1 : sprinting ? 3.4 : 2.9;
  if (actor.grounded && actor.stepAcc > stride) {
    actor.stepAcc = 0;
    audio.stepSound(planar > 3);
  }
}
