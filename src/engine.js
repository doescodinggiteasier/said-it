// Said It? — pure game engine (NO DOM, NO browser globals).
//
// Everything here is a pure function of its inputs (the only ambient dependency is Date/Math,
// and date-taking helpers accept an explicit argument so tests are deterministic). This is the
// single source of truth for scoring, the streak/freeze rollover, and the two rank ladders.
// It is imported by both the browser app (src/main.js) and the Node unit tests (tests/unit.mjs).

/* ---------- date helpers ---------- */
export function pad(n){ return n < 10 ? "0" + n : "" + n; }

// local-calendar YYYY-MM-DD for a Date (defaults to now). The streak is anchored to this, never UTC.
export function todayStr(d){ d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// ISO-ish week bucket (Monday-anchored) from a YYYY-MM-DD — used for freeze refresh + weekly seasons.
export function weekKey(dateStr){
  var d = new Date(dateStr + "T12:00:00"); var day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
  return todayStr(d);
}

// whole calendar days from a -> b (noon-anchored so DST never produces a fractional/-off-by-one day).
export function daysBetween(a, b){ return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000); }

export function addDaysStr(s, n){ var d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return todayStr(d); }

export function clamp01(v){ return Math.max(0, Math.min(1, v)); }

/* ---------- escaping (the ONE escape util; route every innerHTML insertion of untrusted text through it) ---------- */
export function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }

/* ---------- rank ladders (two independent axes) ---------- */
// SKILL ladder (accuracy) — eye/detective themed. Hidden until 5 sets.
export var TIERS = [{ n:"Rookie" }, { n:"Skeptic", a:.55 }, { n:"Sharp Eye", a:.65 }, { n:"Truth Hound", a:.75 }, { n:"Lie Detector", a:.85 }, { n:"Mind Reader", a:.92 }];
// STREAK ladder (commitment, by BEST streak) — fire themed.
export var STREAK_TIERS = [{ n:"Spark", lo:1 }, { n:"Kindling", lo:3 }, { n:"Campfire", lo:7 }, { n:"Bonfire", lo:14 }, { n:"Wildfire", lo:30 }, { n:"Inferno", lo:60 }, { n:"Eternal Flame", lo:100 }];

export function streakRank(best){ best = best || 0; var t = null; for(var i=0;i<STREAK_TIERS.length;i++){ if(best >= STREAK_TIERS[i].lo) t = STREAK_TIERS[i]; } return t; }   // null below 1

// pure core of the old rankInfo(): given games played + judged/correct counts, return the skill-rank view-model.
export function computeRank(games, judged, correct){
  if(games < 5) return { locked:true, need: 5 - games };
  var acc = judged ? correct / judged : 0, ti = 0;
  for(var i=0;i<TIERS.length;i++){ if(acc >= (TIERS[i].a || 0)) ti = i; }
  var cur = TIERS[ti], next = TIERS[ti + 1];
  if(!next) return { locked:false, tier:cur.n, prog:1, line:"Top rank · " + Math.round(acc * 100) + "% over " + games + " sets" };
  var prog = Math.max(.08, Math.min(.97, (acc - (cur.a || 0)) / (next.a - (cur.a || 0))));
  return { locked:false, tier:cur.n, next:next.n, prog:prog, line: Math.round(acc * 100) + "% over " + games + " sets — climb to " + next.n };
}

/* ---------- scoring ---------- */
// Pure scoring of a played set. `answers` is { quoteId: "real"|"fake" }, `lockId` is the locked quote id (or null).
// Returns the per-quote breakdown the reveal + result record are built from. No state mutation.
export function scoreSet(quotes, answers, lockId){
  answers = answers || {};
  var correct = 0, lockCorrect = null, grid = [], perq = [], gotme = [];
  quotes.forEach(function(q, i){
    var guess = answers[q.id]; var truth = q.real ? "real" : "fake"; var right = (guess === truth);
    if(right) correct++;
    grid.push(right ? "✅" : "❌");
    if(!q.real && guess === "real") gotme.push(i + 1);          // a fake the player believed (1-indexed)
    if(lockId === q.id) lockCorrect = right;
    perq.push({ i:i+1, id:q.id, guess:guess, truth:truth, right:right, locked: lockId === q.id });
  });
  return { correct:correct, n:quotes.length, grid:grid, perq:perq, gotme:gotme, lockCorrect:lockCorrect };
}

// transparent rating delta: ±score around the 3/6 baseline, the lock swings double.
export function ratingDelta(correct, lockCorrect){
  return (correct - 3) * 8 + (lockCorrect === true ? 12 : (lockCorrect === false ? -12 : 0));
}

/* ---------- streak + freeze rollover ---------- */
// Weekly freeze refresh: returns the new {freeze_week, freezes_left} when the week rolled over, else null (no-op).
export function rollFreezeWeek(freezeWeek, today){
  var wk = weekKey(today);
  return freezeWeek === wk ? null : { freeze_week: wk, freezes_left: 1 };
}

// The streak transition. STREAK counts consecutive real CALENDAR days the player showed up (any edition),
// so replaying old editions can never corrupt it (caller passes the same `prevReal===today` and nothing moves).
//   prevReal     - last real calendar day the player advanced the streak (or null/"" for a brand-new player)
//   today        - this real calendar day
//   streak       - current streak value
//   freezesLeft  - freezes available this week
// Returns { streak, freezesLeft, frozen, advanced }.
export function rollStreak(opts){
  var prevReal = opts.prevReal || null, today = opts.today, streak = opts.streak || 0, freezesLeft = opts.freezesLeft || 0;
  var frozen = false, advanced = false;
  if(prevReal !== today){
    advanced = true;
    if(!prevReal){ streak = 1; }
    else {
      var gap = daysBetween(prevReal, today);
      if(gap === 1){ streak += 1; }
      else if(gap > 1){
        // Batch 12 P1: a freeze shields exactly ONE missed day — not an arbitrary gap. The missed days lie strictly
        // between prevReal and today; the streak survives only if there's a freeze for EACH of them (else it resets).
        var missed = gap - 1;
        if(freezesLeft >= missed){ freezesLeft -= missed; streak += 1; frozen = true; }
        else { streak = 1; }
      }
      // gap <= 0 can't happen: a real calendar day never precedes a prior real day
    }
  }
  return { streak:streak, freezesLeft:freezesLeft, frozen:frozen, advanced:advanced };
}

// Earned streak REPAIR (Batch 6): spend ONE token to rescue a streak broken by EXACTLY ONE missed day (yesterday).
// Pure + additive — it never touches rollStreak. Think of it as a manual, earned freeze: it bridges the missed day so
// today's play continues the chain (parity with the auto freeze, which also covers one gap day). It does NOT itself
// advance the streak — playing today does that. Returns the patched fields, or null (no-op) when NOT eligible:
//   - tokens < 1, or
//   - no prior streak day (prevReal falsy / streak 0), or
//   - the gap from the last streak day to `today` is not exactly 2 (i.e. not a single missed day = yesterday).
// opts: { prevReal, today, streak, tokens } → { streak, last_realday, tokens, repaired } | null
export function repairStreak(opts){
  var prevReal = opts.prevReal || null, today = opts.today;
  var streak = opts.streak || 0, tokens = opts.tokens || 0;
  if(tokens < 1 || !prevReal || streak < 1) return null;
  if(daysBetween(prevReal, today) !== 2) return null;        // only a single missed day (yesterday) is repairable
  return { streak: streak, last_realday: addDaysStr(today, -1), tokens: tokens - 1, repaired: true };
}
