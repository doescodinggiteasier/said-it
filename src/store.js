// Said It? — persistent store: localStorage I/O + a VERSIONED schema with ordered, non-destructive migrations.
//
// The ST localStorage equity (streak, best_streak, history, crews, rating) is SACRED. Migrations only ever
// FILL missing shape — they never reset a returning player's progress. A pre-redesign player keeps everything.

import { todayStr } from "./engine.js";

export var STORAGE_KEY = "saidit:v1";   // the localStorage key (kept stable across the redesign — do not rename)

export function uid(){ return 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

/* ---------- ordered migrations ----------
   Each entry brings the state from version i -> i+1. They MUST be idempotent (safe to re-run) and additive
   (never delete or reset equity). `migrate()` runs every migration whose index >= the stored schemaVersion. */
export var MIGRATIONS = [
  // v0 -> v1: normalize the legacy ad-hoc shape (absorbs the old inline boot defaults). Streak/history/rating untouched.
  function(s){
    if(!s.days) s.days = {};
    if(!s.crewSeasons) s.crewSeasons = {};                          // {weekKey: champName} — memorialized weekly champ
    if(s.crew === undefined) s.crew = null;                         // legacy single-crew field
    if(!s.crews) s.crews = s.crew ? [s.crew] : [];                  // -> multi-crew array (be in several groups at once)
    if(s.activeCrew === undefined) s.activeCrew = s.crews.length ? s.crews[0].code : null;
    if(!s.lane) s.lane = "general";                                 // category pack the player last picked
    return s;
  },
  // v1 -> v2: daily 6-lane loop — clean-sweep tracking. ADDITIVE only; streak/best_streak/days/rating/crews untouched.
  function(s){
    if(typeof s.sweeps !== "number") s.sweeps = 0;                  // clean sweeps logged (all of a day's lanes done)
    if(typeof s.best_sweeps !== "number") s.best_sweeps = 0;        // best sweeps tally
    if(!s.swept) s.swept = {};                                      // {date: true} once-per-day clean-sweep guard
    if(s.last_seen === undefined) s.last_seen = null;               // last real day the app was opened
    return s;
  },
  // v2 -> v3: earned streak-repair tokens (Batch 6). ADDITIVE only — minted by clean sweeps (cap 2), spent to repair a
  // one-day streak break. Existing v2 players get the field here; brand-new players get it via this same migration chain.
  function(s){
    if(typeof s.repair_tokens !== "number") s.repair_tokens = 0;    // earned manual streak-rescue tokens (distinct from the auto weekly freeze)
    return s;
  },
];

export var SCHEMA_VERSION = MIGRATIONS.length;   // current version == number of migrations (1)

export function migrate(state){
  var v = state.schemaVersion || 0;
  for(var i = v; i < MIGRATIONS.length; i++){ state = MIGRATIONS[i](state) || state; }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

/* ---------- brand-new player ---------- */
export function freshState(opts){
  opts = opts || {};
  return {
    sid: opts.sid || uid(), first_seen: opts.today || todayStr(), referrer: opts.referrer || "direct",
    days: {}, streak: 0, best_streak: 0, rating: 1000, judged: 0, correct: 0, locks: 0, locks_correct: 0,
    last_played: null, freeze_week: null, freezes_left: 1,
  };
}

/* ---------- localStorage I/O (storage is injectable so the engine stays Node-testable) ---------- */
function getStorage(storage){ return storage || (typeof localStorage !== "undefined" ? localStorage : null); }
export function loadRaw(storage){ var st = getStorage(storage); try{ return JSON.parse(st.getItem(STORAGE_KEY)) || {}; }catch(e){ return {}; } }
export function persist(state, storage){ var st = getStorage(storage); try{ st.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){} }

// Load-or-create + migrate + persist. Returns { state, isFresh }.
export function initState(opts){
  opts = opts || {};
  var s = loadRaw(opts.storage), isFresh = false;
  if(!s.sid){ s = freshState({ sid: opts.sid, today: opts.today, referrer: opts.referrer }); isFresh = true; }
  s = migrate(s);
  persist(s, opts.storage);
  return { state: s, isFresh: isFresh };
}

/* ---------- derived stats + cloud merge (used by accounts; pure, no DOM) ---------- */
function hasCrew(state, code){ return (state.crews || []).some(function(c){ return c.code === code; }); }

// Recompute judged/correct/locks totals from the authoritative play history (no double-count on merge).
export function recomputeStats(state){
  var j = 0, c = 0, l = 0, lc = 0;
  for(var k in (state.days || {})){ var r = state.days[k] && state.days[k].done && state.days[k].result; if(!r) continue;
    j += r.n || 0; c += r.score || 0; if(r.lockCorrect === true || r.lockCorrect === false){ l++; if(r.lockCorrect) lc++; } }
  state.judged = j; state.correct = c; state.locks = l; state.locks_correct = lc;
  return state;
}

// Merge a cloud profile into local state — NEVER lose progress (max streaks, union history + crews).
export function mergeState(state, remote){
  if(!remote) return state;
  state.streak = Math.max(state.streak || 0, remote.streak || 0);
  state.best_streak = Math.max(state.best_streak || 0, remote.best_streak || 0);
  if(typeof remote.rating === "number") state.rating = Math.max(state.rating || 1000, remote.rating);   // absent remote rating = no-op
  state.days = state.days || {}; for(var k in (remote.days || {})){ if(!state.days[k]) state.days[k] = remote.days[k]; }   // union the play history
  state.crews = state.crews || []; (remote.crews || []).forEach(function(rc){ if(rc && rc.code && !hasCrew(state, rc.code)) state.crews.push(rc); });
  // earned repair tokens are spendable equity → max-merge so a returning/fresh device never LOSES one (cap 2, the mint cap)
  if(typeof remote.repair_tokens === "number") state.repair_tokens = Math.min(2, Math.max(state.repair_tokens || 0, remote.repair_tokens));
  if(!state.activeCrew) state.activeCrew = remote.activeCrew || (state.crews[0] || {}).code || null;
  if(remote.displayName && !state.displayName) state.displayName = remote.displayName;
  if(remote.last_realday && (!state.last_realday || remote.last_realday > state.last_realday)) state.last_realday = remote.last_realday;
  if(remote.crewSeasons) state.crewSeasons = Object.assign({}, remote.crewSeasons, state.crewSeasons || {});
  recomputeStats(state);   // derive accuracy/lock totals from the UNIONED history (authoritative)
  return state;
}
