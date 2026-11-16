// state.js — the one place match state lives: teams, scores, the round clock,
// the Leech, and every actor on the deck. Modules read and write through here
// instead of keeping private copies, so a round reset touches exactly one
// object. Nothing in this file touches the DOM or three.js.

export const TEAM = { WARDEN: 'warden', RECLAIMER: 'reclaimer' };

export const RULES = {
  teamSize: 5,
  roundsToWin: 7,
  regulationRounds: 12,
  swapAfterRound: 6,
  buySeconds: 12,
  roundSeconds: 100,
  drainSeconds: 40,
  endSeconds: 4.5,
  dockSeconds: 3.5,
  purgeSeconds: 5,
  purgeKitSeconds: 2.5,
  startMoney: 800,
  moneyCap: 16000,
  killReward: 300,
  assistReward: 150,
  dockTeamBonus: 600,
  dockReward: 300,
  purgeReward: 300,
  winElimination: 2700,
  winObjective: 3000,
  lossBase: 1900,
  lossStreakStep: 500,
  lossStreakMax: 1500,
  // A round tied 6-6 after regulation is settled by overtime: the first crew
  // to 8 takes the ring, and wallets reset for the extra rounds.
  overtimeToWin: 8,
  overtimeMoney: 10000,
};

export const WARDEN_NAMES = ['Voss', 'Ilya', 'Petra', 'Hale', 'Onyx'];
export const RECLAIMER_NAMES = ['Juno', 'Reyes', 'Moth', 'Sable', 'Kip'];

// The whole mutable match. `phase` walks menu → buy → live → end → buy …
// with `docked` as a flag on live (the drain replaces the round clock).
export const S = {
  phase: 'menu',
  paused: false,
  time: 0,               // sim seconds since boot
  round: 0,
  phaseT: 0,             // seconds left in the current phase
  overtime: false,       // true once regulation ends 6-6
  roundWins: { warden: 0, reclaimer: 0 },
  roundHistory: [],      // 'warden' | 'reclaimer' per finished round
  lossStreak: { warden: 0, reclaimer: 0 },
  actors: [],            // every operative, both teams, player included
  player: null,
  leech: {
    state: 'carried',    // carried | dropped | docked | spent
    carrier: null,       // actor ref while carried
    site: null,          // 'A' | 'B' once docked
    pos: { x: 0, z: 0 }, // ground position while dropped
    drainT: 0,           // seconds of drain left once docked
  },
  channel: null,         // { actor, kind: 'dock'|'purge', site, t, need } while someone channels
  lastEvent: null,       // { type, ... } set by rounds.js, read by hud.js each frame
  winner: null,          // match winner once phase === 'over'
  mvp: null,             // actor with the best round, named at round end
  shots: [],             // recent gunfire { x, z, team, t } — bots hear these
  smokes: [],            // live smoke clouds { x, z, r, until }
  feed: [],              // kill feed entries { text, html, until }
};

let nextActorId = 1;

// An operative. Bots and the human share this shape; `brain` is attached by
// bots.js for AI crew, `isPlayer` marks the human. Loadout fields are reset
// every round by rounds.js; career fields (kills/deaths/assists/damage)
// survive the match, while per-round scratch is reset by nextRound.
export function makeActor(team, name, isPlayer) {
  return {
    id: nextActorId++,
    team, name, isPlayer,
    // body
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, crouch: false, grounded: true,
    radius: 0.36, eye: 1.62,
    hp: 100, armor: 0, helm: false, alive: true,
    // loadout
    money: RULES.startMoney,
    primary: null, sidearm: 'wasp', knife: true,
    grenades: [],            // ['splinter' | 'shroud', ...] up to 2
    purgeKit: false,
    slot: 'sidearm',         // currently held: primary | sidearm | knife | grenade
    mag: {}, reserve: {},    // per-weapon ammo, keyed by weapon id
    reloadingUntil: 0, nextShotAt: 0, lastShotAt: -9,
    spreadBloom: 0, scoped: false,
    // career
    kills: 0, deaths: 0, assists: 0,
    damageDealt: 0, damageTaken: 0,
    // per-round scratch for AI and effects
    brain: null, mesh: null, muzzle: null,
    lastHurtAt: -9, lastHurtBy: null, stepAt: 0,
    // Who hurt this actor lately, for assist credit: [{ actor, at }] newest last.
    recentHits: [],
    roundKills: 0, roundDamage: 0,
  };
}

export function foesOf(actor) {
  return S.actors.filter((a) => a.team !== actor.team);
}

export function aliveCount(team) {
  let n = 0;
  for (const a of S.actors) if (a.team === team && a.alive) n++;
  return n;
}

export function pay(actor, amount) {
  actor.money = Math.max(0, Math.min(RULES.moneyCap, actor.money + amount));
}

export function teamPay(team, amount) {
  for (const a of S.actors) if (a.team === team) pay(a, amount);
}

// Attackers are the reclaimers in the first half; after the swap the wardens
// attack. Sides are a property of the round, not of the crew's identity.
export function attackTeam() {
  return S.round <= RULES.swapAfterRound ? TEAM.RECLAIMER : TEAM.WARDEN;
}
export function defendTeam() {
  return attackTeam() === TEAM.WARDEN ? TEAM.RECLAIMER : TEAM.WARDEN;
}
export function isAttacker(actor) { return actor.team === attackTeam(); }

// The round's most valuable operative: most kills, then most damage.
export function roundMvp() {
  let best = null;
  for (const a of S.actors) {
    if (!best || a.roundKills > best.roundKills ||
        (a.roundKills === best.roundKills && a.roundDamage > best.roundDamage)) best = a;
  }
  return best && (best.roundKills > 0 || best.roundDamage > 0) ? best : null;
}

export function pushFeed(html) {
  S.feed.push({ html, until: S.time + 5 });
  if (S.feed.length > 6) S.feed.shift();
}

export function noteShot(x, z, team) {
  S.shots.push({ x, z, team, t: S.time });
  if (S.shots.length > 24) S.shots.shift();
}
