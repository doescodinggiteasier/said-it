// Said It? — backend calls (instrumentation beacon + crew-board read). Decoupled from the view so the
// transport is swappable (Phase 3 moves these onto Supabase). Factories take their dependencies explicitly.

// Build the logEvent() function. deps: { state, getDay, save, endpoint }.
//   - always keeps a local event trail (so the return signal survives with no server)
//   - best-effort POST to the endpoint (sendBeacon, falling back to keepalive fetch)
export function createLogger(deps){
  var state = deps.state, getDay = deps.getDay, save = deps.save, endpoint = deps.endpoint;
  return function logEvent(name, extra){
    var DAY = getDay && getDay();
    var payload = Object.assign({ ev:name, sid:state.sid, day:(DAY && DAY.date) || null, ts:Date.now(),
      ref:state.referrer, first:state.first_seen, tz:(new Date()).getTimezoneOffset() }, extra || {});
    (state.log = state.log || []).push({ ev:name, day:payload.day, ts:payload.ts });
    if(state.log.length > 400) state.log = state.log.slice(-400);
    save(state);
    if(endpoint){ try{
      if(typeof navigator !== "undefined" && navigator.sendBeacon){ navigator.sendBeacon(endpoint, new Blob([JSON.stringify(payload)], { type:"text/plain" })); }
      else { fetch(endpoint, { method:"POST", mode:"no-cors", keepalive:true, headers:{ "Content-Type":"text/plain" }, body:JSON.stringify(payload) }); }
    }catch(e){} }
  };
}

// Read a crew's board for `day`. `&me=<sid>` lets the server gate "who got got" (fooledBy) to requesters who've
// completed today — spoiler-safe. Returns the JSON payload, or null on any error (caller renders local-only).
export function fetchCrewBoard(endpoint, code, day, sid){
  if(!endpoint || !code) return Promise.resolve(null);
  var url = endpoint + (endpoint.indexOf("?") >= 0 ? "&" : "?") +
    "crew=" + encodeURIComponent(code) + "&day=" + encodeURIComponent(day) + "&me=" + encodeURIComponent(sid);
  return fetch(url, { cache:"no-store" }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
}

/* ---------- Phase 3: Supabase crew backend (the gated `board` Edge Function is the only read path) ---------- */
function sbData(p){ return p && !p.error ? p.data : null; }   // PostgREST/functions return {data,error}
// READS — all go through the `board` function (service role, applies the spoiler gate)
export function sbFetchCrewBoard(SB, code, day, sid){
  if(!SB || !code) return Promise.resolve(null);
  return SB.functions.invoke("board", { body: { crew:code, day:day, me:sid } }).then(sbData, function(){ return null; });
}
export function sbFetchMeProfile(SB, sid){
  if(!SB || !sid) return Promise.resolve(null);
  return SB.functions.invoke("board", { body: { me:sid } }).then(sbData, function(){ return null; });
}
export function sbFetchCohort(SB, sid){
  if(!SB || !sid) return Promise.resolve(null);
  return SB.functions.invoke("board", { body: { me:sid, cohort:1 } }).then(sbData, function(){ return null; });
}
// WRITES — fire-and-forget upserts (idempotent on natural keys); errors swallowed (the app works offline too)
function fire(thenable){ try{ return Promise.resolve(thenable).then(function(){}, function(){}); }catch(e){ return Promise.resolve(); } }
export function sbRecordCompletion(SB, row){ if(!SB) return Promise.resolve(); return fire(SB.from("completions").upsert(row, { onConflict:"sid,day,lane" })); }
export function sbRecordCrewMember(SB, row){ if(!SB) return Promise.resolve(); return fire(SB.from("crew_members").upsert(row, { onConflict:"crew,sid" })); }
export function sbRecordCrewName(SB, crew, name){ if(!SB) return Promise.resolve(); return fire(SB.from("crew_meta").upsert({ crew:crew, name:name, updated_at:new Date().toISOString() }, { onConflict:"crew" })); }
export function sbRecordEvent(SB, ev, sid, first){ if(!SB) return Promise.resolve(); return fire(SB.from("events").insert({ ev:ev, sid:sid, first:first||null })); }
