// bodies.js — the crew's physical form: a low-poly operative built from
// boxes (legs, torso, helmet with a glowing visor, a held rifle), coloured by
// team so a silhouette reads at a glance across the deck. Bodies are pooled
// per actor for the whole match; this module also runs their walk cycle,
// aim pitch, crouch dip, reload dip, strafe lean and death fall each frame
// from actor state.

import * as THREE from 'three';
import { S } from './state.js';

const GEO = {
  leg: new THREE.BoxGeometry(0.17, 0.78, 0.2),
  torso: new THREE.BoxGeometry(0.52, 0.62, 0.3),
  head: new THREE.BoxGeometry(0.3, 0.3, 0.3),
  visor: new THREE.BoxGeometry(0.26, 0.09, 0.02),
  arm: new THREE.BoxGeometry(0.13, 0.52, 0.15),
  gun: new THREE.BoxGeometry(0.09, 0.16, 0.78),
  pack: new THREE.BoxGeometry(0.4, 0.44, 0.16),
};
const MATS = {
  wardenSuit: new THREE.MeshStandardMaterial({ color: 0x1d4e4a, roughness: 0.8 }),
  wardenTrim: new THREE.MeshBasicMaterial({ color: 0x46e0d4 }),
  reclaimerSuit: new THREE.MeshStandardMaterial({ color: 0x54202f, roughness: 0.8 }),
  reclaimerTrim: new THREE.MeshBasicMaterial({ color: 0xff5d8f }),
  dark: new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.9 }),
  gun: new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.5, metalness: 0.6 }),
};

// Builds the body group for an actor and stashes the moving parts on it.
// The group origin sits at the actor's feet; +Z is the facing direction.
export function makeBody(actor) {
  const suit = actor.team === 'warden' ? MATS.wardenSuit : MATS.reclaimerSuit;
  const trim = actor.team === 'warden' ? MATS.wardenTrim : MATS.reclaimerTrim;
  const g = new THREE.Group();
  const legL = new THREE.Mesh(GEO.leg, MATS.dark); legL.position.set(-0.14, 0.39, 0);
  const legR = new THREE.Mesh(GEO.leg, MATS.dark); legR.position.set(0.14, 0.39, 0);
  const torso = new THREE.Mesh(GEO.torso, suit); torso.position.y = 1.09;
  const pack = new THREE.Mesh(GEO.pack, MATS.dark); pack.position.set(0, 1.12, -0.24);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.07, 0.32), trim); stripe.position.y = 1.3;
  const head = new THREE.Mesh(GEO.head, suit); head.position.y = 1.58;
  const visor = new THREE.Mesh(GEO.visor, trim); visor.position.set(0, 1.6, 0.16);
  const armR = new THREE.Mesh(GEO.arm, suit); armR.position.set(0.34, 1.16, 0.1); armR.rotation.x = -0.5;
  const armL = new THREE.Mesh(GEO.arm, suit); armL.position.set(-0.34, 1.16, 0.1); armL.rotation.x = -0.5;
  const gun = new THREE.Mesh(GEO.gun, MATS.gun); gun.position.set(0.2, 1.24, 0.42);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.2, 1.28, 0.85);
  const lightDot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), trim);
  lightDot.position.set(0, 1.38, -0.33);
  g.add(legL, legR, torso, pack, stripe, head, visor, armR, armL, gun, muzzle, lightDot);
  g.userData = { legL, legR, torso, head, visor, gun, armR, armL, walkPhase: Math.random() * 6, fallT: 0, fallDir: 1, lean: 0 };
  actor.mesh = g; actor.muzzle = muzzle;
  return g;
}

const _v = new THREE.Vector3();
// Per-frame: place the body on its actor, swing the legs with speed, dip for
// crouch, pitch the gun arm with aim, lean into strafes, and topple the dead
// over ~0.5 s — forward when shot from behind, back when shot from the front.
export function animateBody(actor, dt) {
  const g = actor.mesh; if (!g) return;
  const u = g.userData;
  // The human's own body is never drawn: the camera sits inside its head,
  // and the view model in weapons.js stands in for their arms and gun.
  if (actor.isPlayer) { g.visible = false; return; }
  g.position.set(actor.pos.x, actor.pos.y, actor.pos.z);
  g.rotation.y = actor.yaw + Math.PI; // model is built facing +Z; forward is (−sin yaw, −cos yaw)
  const speed = Math.hypot(actor.vel.x, actor.vel.z);
  if (actor.alive) {
    u.fallT = 0;
    g.rotation.x = 0;
    // Lean into a strafe: the sideways velocity against the facing.
    const fxv = -Math.sin(actor.yaw), fzv = -Math.cos(actor.yaw);
    const rxv = Math.cos(actor.yaw), rzv = -Math.sin(actor.yaw);
    const side = (actor.vel.x * rxv + actor.vel.z * rzv) / Math.max(1, speed);
    const wantLean = Math.max(-0.14, Math.min(0.14, side * 0.14 * Math.min(1, speed / 3)));
    u.lean += (wantLean - u.lean) * Math.min(1, dt * 8);
    g.rotation.z = u.lean;
    u.walkPhase += dt * (2.2 + speed * 1.9);
    const swing = Math.min(1, speed / 3) * 0.55;
    u.legL.rotation.x = Math.sin(u.walkPhase) * swing;
    u.legR.rotation.x = -Math.sin(u.walkPhase) * swing;
    const dip = actor.crouch ? 0.34 : 0;
    g.position.y = actor.pos.y - dip + Math.abs(Math.sin(u.walkPhase)) * 0.03 * Math.min(1, speed / 3);
    // Reloading drops the gun arm to the mag well.
    const reloading = actor.reloadingUntil && actor.reloadingUntil > 0;
    u.gun.rotation.x = actor.pitch * 0.8 + (reloading ? 0.6 : 0);
    u.armR.rotation.x = -0.5 + actor.pitch * 0.7 + (reloading ? 0.5 : 0);
    u.armL.rotation.x = -0.5 + actor.pitch * 0.7 + (reloading ? 0.3 : 0);
    // A fresh hit flickers the visor: the body flinches visibly.
    const hurt = actor.lastHurtAt > 0 && (S.time - actor.lastHurtAt) < 0.12;
    u.visor.visible = !hurt || Math.random() < 0.5;
    g.visible = true;
  } else {
    // Death: keel over in the direction the killing shot came from.
    if (u.fallT === 0 && actor.lastHurtBy) {
      const dx = actor.pos.x - actor.lastHurtBy.pos.x, dz = actor.pos.z - actor.lastHurtBy.pos.z;
      const fxv = -Math.sin(actor.yaw), fzv = -Math.cos(actor.yaw);
      u.fallDir = (dx * fxv + dz * fzv) > 0 ? 1 : -1; // shot from behind → fall forward
    }
    u.fallT = Math.min(1, u.fallT + dt * 2.2);
    const e = 1 - (1 - u.fallT) * (1 - u.fallT);
    g.rotation.x = -e * Math.PI / 2 * 0.92 * u.fallDir;
    g.rotation.z = 0;
    g.position.y = actor.pos.y + e * 0.12;
    u.legL.rotation.x = 0.15; u.legR.rotation.x = -0.1;
  }
}

// World position of an actor's muzzle (for tracers and bot shot origins).
export function muzzlePos(actor, out) {
  if (actor.muzzle) return actor.muzzle.getWorldPosition(out);
  out.set(actor.pos.x, actor.pos.y + 1.35, actor.pos.z);
  return out;
}
