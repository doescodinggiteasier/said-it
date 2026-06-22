// Said It? — daily-set data layer: lane definitions, path/key schema, and the resilient day fetch.
// Pure helpers take the manifest explicitly; the browser app wraps them with the live MANIFEST.

/* ---------- lane (category) definitions ---------- */
export var LANE_LABELS = { general:"📰 General", sports:"🏀 Sports", music:"🎵 Music", politics:"🏛️ Politics", movies:"🎬 Movies", nsfw:"🍸 Off the Record" };
export var LANE_HUES   = { general:"#4C6EF5", sports:"#20C4A8", music:"#9775FA", politics:"#FF922B", movies:"#FF8FAB", nsfw:"#7048E8" };
export var LANE_VIBES  = { general:"today’s mixed bag", sports:"athletes’ chit-chat", music:"artists’ gossip", politics:"hot air, fresh daily", movies:"red-carpet ramblings", nsfw:"not safe for your local newspaper" };
export var LANE_HOT    = { politics:true };
export var LANE_ADULT  = { nsfw:true };
// simple line icons (stroke = lane hue), one per lane
export var LANE_ICONS = {
  general:'<path d="M5 5h11v14H5z"/><path d="M16 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 12.5h5M8 16h3"/>',          // newspaper
  sports:'<path d="M4 12a4 4 0 0 0 4 4h4l5 3v-6.5a4.5 4.5 0 0 0-4.5-4.5H8a4 4 0 0 0-4 3z"/><path d="M16.5 8.5 19 5"/>',  // whistle
  music:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4M9 21h6"/>',   // mic
  politics:'<path d="M9 21h6M12 21v-8"/><path d="M7.5 13h9l-1.3-3.5h-6.4z"/><path d="M12 9.5V4M12 4.4l4 1.4-4 1.4z"/>',   // podium + flag
  movies:'<path d="M4 9h16v11H4z"/><path d="M4 9l2.4-4 3.6 1.8L13.6 5l3.6 1.8"/><path d="M8 9 10.4 5M13 9l2.4-4"/>',     // clapperboard
  nsfw:'<path d="M5 5h14l-7 8z"/><path d="M12 13v6M8 21h8"/><path d="M16 7.5l2.5-2.5"/>'                                  // martini
};

export function laneIcon(l){ return LANE_ICONS[l] || LANE_ICONS.general; }
export function laneLabel(l){ return LANE_LABELS[l] || ("# " + l); }
export function laneHue(l){ return LANE_HUES[l] || "#4C6EF5"; }
export function laneName(l){ return laneLabel(l).replace(/^\S+\s/, ""); }   // label without the leading emoji

/* ---------- path + completion-key schema ---------- */
export function lanePath(lane, date){ return lane === "general" ? ("daily/" + date + ".json") : ("daily/" + lane + "/" + date + ".json"); }
export function dayKey(lane, date){ return lane === "general" ? date : (lane + ":" + date); }   // per-lane completion record

/* ---------- manifest queries (manifest passed explicitly) ---------- */
export function laneDaysFrom(manifest, lane){
  var c = manifest && manifest.categories && manifest.categories[lane]; if(c) return c;
  return lane === "general" ? ((manifest && manifest.days) || []) : [];
}
export function availableLanesFrom(manifest){
  var ls = Object.keys((manifest && manifest.categories) || {}); if(ls.indexOf("general") < 0) ls.unshift("general");
  return ls.filter(function(l){ return l === "general" || laneDaysFrom(manifest, l).length; });
}

/* ---------- daily 6-lane loop: per-day progress (pure; reads the same dayKey scheme + manifest) ---------- */
// lanes that have an edition PUBLISHED on `date` — the day's available set (the "/N" denominator; usually 6).
export function lanesForDay(manifest, date){
  return availableLanesFrom(manifest).filter(function(l){ return laneDaysFrom(manifest, l).indexOf(date) >= 0; });
}
// has this lane been completed for `date`? (reads the per-lane completion record from a days map)
export function laneDoneOn(days, lane, date){ var r = (days || {})[dayKey(lane, date)]; return !!(r && r.done); }
// how many of `lanes` are done on `date`
export function lanesDoneCount(days, lanes, date){
  return (lanes || []).reduce(function(n, l){ return n + (laneDoneOn(days, l, date) ? 1 : 0); }, 0);
}
// completed-lane count per date, derived from the days map alone (key === dayKey(lane,date)). For the 7-day strip.
export function countLanesDoneByDate(days, dates){
  var out = {}; (dates || []).forEach(function(d){ out[d] = 0; });
  for(var k in (days || {})){
    var rec = days[k]; if(!rec || !rec.done) continue;
    var d = (rec.result && rec.result.date) || (k.indexOf(":") >= 0 ? k.slice(k.indexOf(":") + 1) : k);   // general key = date; lane key = lane:date
    if(d in out) out[d]++;
  }
  return out;
}

// Fetch a lane's edition for `date`; if that date isn't published, fall back to the lane's latest published day.
export function fetchDayFrom(date, lane, manifest){
  return fetch(lanePath(lane, date), { cache:"no-store" }).then(function(r){
    if(r.ok) return r.json();
    var avail = laneDaysFrom(manifest, lane).slice().sort(); if(!avail.length) throw new Error("no " + lane + " editions yet");
    var latest = avail[avail.length - 1];
    return fetch(lanePath(lane, latest), { cache:"no-store" }).then(function(r3){ if(!r3.ok) throw new Error("set missing"); return r3.json(); });
  });
}
