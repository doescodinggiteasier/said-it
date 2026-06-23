// Said It? — view + glue (the "thin glue keeping the current screens working").
// The non-view layers (scoring/streak/ranks, store+migrations, data, backend calls) live in the
// sibling ES modules; this file imports them and wires up the screens. Phase 2 rewrites the view on this base.
import { pad, todayStr, weekKey, daysBetween, addDaysStr, esc, clamp01,
  TIERS, STREAK_TIERS, streakRank, computeRank, scoreSet, ratingDelta, rollFreezeWeek, rollStreak } from "./engine.js";
import { STORAGE_KEY, initState, persist, recomputeStats, mergeState } from "./store.js";
import { LANE_LABELS, LANE_HUES, LANE_VIBES, LANE_HOT, LANE_ADULT, LANE_ICONS,
  laneIcon, laneLabel, laneHue, laneName, lanePath, dayKey, laneDaysFrom, availableLanesFrom, fetchDayFrom,
  lanesForDay, laneDoneOn, lanesDoneCount, countLanesDoneByDate } from "./data.js";
import { createLogger, fetchCrewBoard,
  sbFetchCrewBoard, sbFetchMeProfile, sbFetchCohort, sbFetchGlobal,
  sbRecordCompletion, sbRecordCrewMember, sbRecordCrewName, sbRecordEvent, sbRecordLike } from "./api.js";

(function(){
"use strict";

/* ---------- config + tiny helpers ---------- */
var CFG = window.SAIDIT_CONFIG || {};
var LOG_ENDPOINT = CFG.LOG_ENDPOINT || "";          // set in config.js once the endpoint is deployed
var AGG_ENDPOINT = CFG.AGG_ENDPOINT || "";          // optional: "fake that fooled the most" cross-player
/* H-A accounts (Supabase) — OPTIONAL + defensive: if the SDK/keys aren't present (e.g. offline, or in tests),
   SB stays null and the whole app works exactly as before on the local id. Signing in only ADDS cloud sync. */
var SB=null; try{ if(window.supabase && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY){ SB=window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY); } }catch(e){}
var GOOGLE_AUTH=!!CFG.GOOGLE_AUTH;   // only show "Continue with Google" once the Google OAuth client is configured in Supabase
var ACCOUNT=null, PROFILE_SYNCED=false;   // ACCOUNT={uid,email} once signed in; PROFILE_SYNCED gates cloud WRITES until a safe read
var $ = function(id){return document.getElementById(id);};
var el = function(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;};
// make a click-only element keyboard-accessible (role + tab order + Enter/Space) — for the hub's cards/strips
function activate(node, fn, label){ node.setAttribute("role","button"); node.tabIndex=0; if(label)node.setAttribute("aria-label",label);
  node.onclick=fn; node.onkeydown=function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fn(); } }; }
function qsDay(){var m=location.search.match(/[?&]d=([0-9]{4}-[0-9]{2}-[0-9]{2})/);return m?m[1]:null;}
// pad, todayStr, esc imported from engine.js (the ONE escape util — route every untrusted innerHTML through esc)

/* ---------- Mags, the magpie mascot (themeable inline SVG) ----------
   Recreated from coordination/design_handoff_said_it_bright/Magpie.dc.html — one continuous monoline
   silhouette drawn in var(--primary), with three moods. mood: 'happy' | 'delighted' | 'oops'. */
function magpie(mood, size, cls){
  mood=mood||"happy"; size=size||72;
  var eyes;
  if(mood==="delighted"){
    eyes='<path d="M40 32 Q45 26 50 32" stroke="var(--primary)" stroke-width="4" stroke-linecap="round" fill="none"/>'+
      '<path d="M82 20 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6 z" fill="var(--primary)"/>'+
      '<path d="M96 40 l1.2 2.7 2.7 1.2 -2.7 1.2 -1.2 2.7 -1.2 -2.7 -2.7 -1.2 2.7 -1.2 z" fill="var(--primary)"/>';
  } else if(mood==="oops"){
    eyes='<circle cx="45" cy="31" r="3.4" fill="none" stroke="var(--primary)" stroke-width="2.4"/>'+
      '<path d="M39 24 L50 27" stroke="var(--primary)" stroke-width="2.8" stroke-linecap="round"/>';
  } else {
    eyes='<circle cx="45" cy="31" r="3" fill="var(--primary)"/>';
  }
  return '<svg class="mags'+(cls?(" "+cls):"")+'" width="'+size+'" height="'+size+'" viewBox="0 0 112 112" fill="none" aria-hidden="true">'+
    '<path d="M40 52 C58 50 64 70 50 80 C40 76 36 62 40 52 Z" fill="var(--primary)" opacity="0.14"/>'+
    '<g stroke="var(--primary)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none">'+
    '<path d="M18 40 C24 37 29 36 35 35 C40 17 63 15 64 36 C69 52 71 62 66 73 L99 104 L70 82 C60 92 40 91 31 73 C23 60 19 47 26 43 C22 42 20 41 18 40 Z"/>'+
    '<path d="M18 40 L33 44"/>'+
    '<path d="M41 51 C57 50 62 68 49 78"/>'+
    '</g>'+eyes+'</svg>';
}
// app-icon / favicon variant: fixed colors (data-URI SVG gets no page CSS, so no var() here)
function appIconSVG(){
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 112 112'>"+
    "<rect width='112' height='112' rx='26' fill='#EEF1FE'/>"+
    "<path d='M40 52 C58 50 64 70 50 80 C40 76 36 62 40 52 Z' fill='#4C6EF5' opacity='0.16'/>"+
    "<g stroke='#4C6EF5' stroke-width='6' fill='none' stroke-linecap='round' stroke-linejoin='round'>"+
    "<path d='M18 40 C24 37 29 36 35 35 C40 17 63 15 64 36 C69 52 71 62 66 73 L99 104 L70 82 C60 92 40 91 31 73 C23 60 19 47 26 43 C22 42 20 41 18 40 Z'/>"+
    "<path d='M18 40 L33 44'/></g>"+
    "<circle cx='45' cy='31' r='3.6' fill='#4C6EF5'/></svg>";
}
// avatar color, hashed by name (ported from the prototype) — ringed white avatars + colored initials
var AVCOLORS=['#FF8FAB','#20C4A8','#9775FA','#FF922B','#4DABF7','#16B981','#FB5252'];
function avColor(n){ n=String(n||""); var h=0; for(var i=0;i<n.length;i++){ h=(h*31+n.charCodeAt(i))>>>0; } return AVCOLORS[h%AVCOLORS.length]; }
function avInitial(n){ return (String(n||"?").trim().charAt(0)||"?").toUpperCase(); }
// header date label, e.g. "Wed 18 Jun"
function homeDateLabel(){ var d=new Date(); var wd=d.toLocaleDateString(undefined,{weekday:"short"});
  return wd+" "+d.getDate()+" "+d.toLocaleDateString(undefined,{month:"short"}); }
function weekdayShort(dateStr){ return new Date(dateStr+"T12:00:00").toLocaleDateString(undefined,{weekday:"short"}).slice(0,2); }
var CHECK_SVG='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>';
var CHEV_DOWN='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
var CHEV_RIGHT='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
var HEART_SVG='<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5l-1.45-1.32C5.4 14.5 2 11.4 2 7.6 2 5 4.05 3 6.6 3 8.05 3 9.44 3.68 12 6.1 14.56 3.68 15.95 3 17.4 3 19.95 3 22 5 22 7.6c0 3.8-3.4 6.9-8.55 11.58z"/></svg>';
var CHEV_LEFT='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
var BACK_ARROW='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
/* ---------- bottom-sheet infra (spring-up modal; close on backdrop) ---------- */
function closeSheet(){ var bd=document.getElementById("sheetBackdrop"); if(bd&&bd.parentNode) bd.parentNode.removeChild(bd); }
function openSheet(innerHtml){
  closeSheet();
  var bd=el("div","sheet-backdrop"); bd.id="sheetBackdrop";
  var sh=el("div","sheet"); sh.innerHTML='<div class="sheet-grab"></div>'+innerHtml;
  bd.appendChild(sh);
  bd.onclick=function(e){ if(e.target===bd) closeSheet(); };
  document.body.appendChild(bd);
  return sh;
}

/* ---------- persistent store — versioned schema + ordered migrations live in store.js ---------- */
var K=STORAGE_KEY;
function save(s){ persist(s||ST); }
// load-or-create + migrate. Migrations only FILL missing shape (crews, lane, …) — a returning player
// NEVER loses streak/history/crews. The legacy single-crew → multi-crew move is one of those migrations.
var _init=initState({ today: todayStr(), referrer: (typeof document!=="undefined" && document.referrer) || "direct" });
var ST=_init.state, IS_FIRST_RUN=_init.isFresh;   // isFresh drives the one-time how-to-play onboarding
// The one-per-device `install` is fired in boot() — AFTER any device-link sid adoption — so it's tagged with the
// FINAL identity, never a throwaway sid (otherwise it corrupts install/cohort analytics). Capture the backfill
// flag NOW, before any other event is logged. (Pre-G-A devices: sid exists but never instrumented → backfill.)
var INSTALL_BACKFILL = (ST.judged>0 || (ST.log && ST.log.length>0));

/* ---------- instrumentation (beacon transport in api.js) ---------- */
var logEvent = createLogger({ state: ST, getDay: function(){ return DAY; }, save: save, endpoint: LOG_ENDPOINT });

/* ---------- prefs: theme, reduced-motion, haptics (Settings screen flips these) ---------- */
// reduced motion is on if the OS asks for it OR the in-app override is set
function reduceMotionOn(){ if(ST.reduceMotion) return true; try{ return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }catch(e){ return false; } }
function applyTheme(){ var t=ST.theme||CFG.THEME; document.body.classList.toggle("theme-coral", t==="coral"); }   // coral is AA-tuned + user-selectable
function applyMotionPref(){ document.body.classList.toggle("rm", !!ST.reduceMotion); }
function haptic(pattern){ try{ if(ST.haptics!==false && !reduceMotionOn() && typeof navigator!=="undefined" && navigator.vibrate) navigator.vibrate(pattern); }catch(e){} }

/* ---------- Mags reacts (EXTENDS the mags-bob / mags-flip pattern) ----------
   A brief, one-shot animation on a Mags SVG, fired ONLY at real feedback moments (reveal score, streak bump,
   clean sweep) plus an occasional idle "peek" on Home. Always guarded by reduced-motion — Mags goes still then. */
function magsReact(kind, node){
  if(reduceMotionOn()) return;                                   // OS pref OR in-app override → no motion
  if(!node){ var b=$("magsBtn"); node=b&&b.querySelector(".mags"); }   // default target: the header brand bird
  if(!node) return;
  var dur={cheer:900,tilt:600,hop:640,peek:1400}[kind]||640;
  node.classList.remove("mags-react-cheer","mags-react-tilt","mags-react-hop","mags-react-peek");
  void node.offsetWidth;                                         // restart the animation if re-fired
  node.classList.add("mags-react-"+kind);
  setTimeout(function(){ if(node) node.classList.remove("mags-react-"+kind); }, dur);
}
// idle Home peek: a subtle flip every ~20–30s while Home is on screen (NOT constant motion). Self-clears on nav.
function scheduleHomePeek(){
  if(window._homePeek){ clearTimeout(window._homePeek); window._homePeek=null; }
  if(reduceMotionOn()) return;
  var delay=20000+Math.floor(Math.random()*10000);              // ~20–30s, jittered so it never feels mechanical
  window._homePeek=setTimeout(function(){
    if(currentScreen()==="home" && !document.getElementById("sheetBackdrop")) magsReact("peek");   // not over a sheet
    if(currentScreen()==="home") scheduleHomePeek(); else window._homePeek=null;
  }, delay);
}

/* ---------- week / freeze helpers — weekKey + daysBetween imported from engine.js ---------- */

/* ---------- screens ---------- */
var SCREENS=["loading","error","home","magpie","stats","ranks","lanes","play","reveal","settings","archive","crew"];
var SCREEN_NAMES={home:"Home",magpie:"Meet Mags",stats:"Your stats",ranks:"Ranks",lanes:"Pick your lane",play:"Play",reveal:"Results",settings:"Settings",archive:"Past editions",crew:"Crew"};
// a11y: announce to screen readers via the polite live region (clear→set forces a re-announcement)
function liveTo(id, msg){ var r=$(id); if(!r||!msg) return; r.textContent=""; setTimeout(function(){ if(r) r.textContent=msg; }, 40); }   // clear→set forces a re-announce
function live(msg){ liveTo("srLive", msg); }        // polite: screen-name on navigation
function liveAlert(msg){ liveTo("srAlert", msg); }  // assertive: toasts + the score reveal (own region so they don't coalesce with the nav announcement)
function show(name){SCREENS.forEach(function(s){$("screen-"+s).classList.toggle("hide",s!==name);});
  document.body.className=document.body.className.replace(/\bscr-\S+/g,"").trim(); document.body.classList.add("scr-"+name);
  document.body.classList.toggle("rm", !!ST.reduceMotion);
  window.scrollTo(0,0);
  // move focus to the new screen's heading (give it heading semantics + a tab stop) so keyboard/SR users land in context
  try{ var host=$("screen-"+name); var h=host&&(host.querySelector(".scr-title,[data-heading]")||host);
    if(h){ if(!h.getAttribute("role")&&h!==host){ h.setAttribute("role","heading"); h.setAttribute("aria-level","1"); }
      if(!h.hasAttribute("tabindex")) h.setAttribute("tabindex","-1"); h.focus({preventScroll:true}); } }catch(e){}
  if(SCREEN_NAMES[name]) live(SCREEN_NAMES[name]);
}
function toast(msg){var t=$("toast");t.textContent=msg;t.classList.add("show");liveAlert(msg);setTimeout(function(){t.classList.remove("show");},1400);}
function currentScreen(){ for(var i=0;i<SCREENS.length;i++){ if(!$("screen-"+SCREENS[i]).classList.contains("hide")) return SCREENS[i]; } return "home"; }
var BACK_TO="home";   // where the crew/archive "← Back" returns to (captured when you open them)
function navBack(){    // return to the screen you came from: home, or the current lane's reveal/intro
  JUST_JOINED=null;
  if(BACK_TO==="home"||BACK_TO==="detail"){ goHome(); return; }   // detail/home origins → hub (not a play-context resume)
  var d=curDone(); if(d){ renderReveal(d,false); }
  else if(DAY){ renderPlay(); }
  else { goHome(); }
}
// content pages (magpie/stats/ranks) use a small back STACK so back returns to the actual opener — and chains
// (e.g. Home→Stats→Ranks→back→Stats→back→Home) without corrupting BACK_TO or jumping into a stale reveal.
var PAGE_BACK=[];
function pageBack(){
  var prev=PAGE_BACK.pop()||"home";
  if(prev==="stats"){ renderStats(); show("stats"); return; }
  if(prev==="ranks"){ renderRanks(); show("ranks"); return; }
  if(prev==="magpie"){ renderMagpie(); show("magpie"); return; }
  if(prev==="settings"){ renderSettings(); show("settings"); return; }
  if(prev==="crew"){ openCrew(); return; }
  if(prev==="lanes"){ openLanes(); return; }
  if(prev==="reveal" && curDone()){ renderReveal(curDone(),false); return; }
  if(prev==="play" && DAY){ renderPlay(); return; }
  goHome();
}

/* ---------- state for the current play ---------- */
var DAY=null;            // the currently-loaded edition (today's OR an archive one)
var ANS={};             // id -> "real"|"fake"
var LOCK=null;          // id of locked quote
var PLAY_IDX=0;          // index (0-5) of the quote currently on screen (one-card play)
var REPLAY=false;        // "play again" of an already-done lane → submit() shows the result but never touches equity
var LANES_PICK=null;     // lane highlighted in the Lanes picker (committed on "Play {lane}")
var CREW_WHEN="today";   // crew board Today/Week toggle
var MANIFEST={days:[]}; // published editions (daily/index.json)

/* ---------- boot ---------- */
var CREW_INVITE=false, LINKED=false, JUST_JOINED=null, INVITE_BY="", INVITE_CN="";
var PREV_SEEN=null, RECAP_SHOWN=false;   // last_seen BEFORE this session bumped it → drives the returner recap (once/session)
function boot(){
  LINKED=handleDeviceLink();    // ?me=SID → adopt that identity (same person, another device) — BEFORE any logging
  handleCrewInvite();           // ?crew=CODE&inv=SID → join + log invite_opened (k-factor)
  initAuth();                   // H-A: pick up an existing Supabase session + listen for sign-in (magic-link return)
  // fire the single per-device install NOW (after sid adoption), so it's tagged with the final identity
  if(!ST.installed){ ST.installed=true; logEvent("install",{first:ST.first_seen, backfill:INSTALL_BACKFILL}); if(sbWriteOn()) sbRecordEvent(SB, "install", ST.sid, ST.first_seen); save(ST); }
  PREV_SEEN=ST.last_seen;   // capture BEFORE we bump it — the recap needs the day you were LAST here
  if(ST.last_seen!==todayStr()){ ST.last_seen=todayStr(); save(ST); }   // track the last real day the app was opened (updated each load)
  fetch("daily/index.json",{cache:"no-store"}).then(function(r){return r.ok?r.json():null;})
    .then(function(idx){ if(idx&&(idx.days||idx.categories)) MANIFEST=idx; }, function(){})
    .then(function(){
      var dl=qsDay();
      if(dl){ loadAndRoute(dl); }                 // ?d=DATE deep link → straight to that edition
      else if(LINKED){ fetchMeProfile().then(function(){ if(!inCrew()) toast("Device linked — rejoin your crew with its code if it doesn't appear"); openCrew(); }); }  // device-link → pull crews+name from server
      else if(CREW_INVITE){ openCrew(); }         // invite → land on the crew screen (clear "you're in!")
      else { goHome(); }                          // everyone else → the home hub
    });
}
function handleCrewInvite(){       // a ?crew=CODE&inv=SID&by=NAME&cn=CREWNAME link → one-tap join w/ sender context
  var m=location.search.match(/[?&]crew=([A-Za-z0-9]{3,8})/); if(!m) return;
  var inv=(location.search.match(/[?&]inv=([A-Za-z0-9_]+)/)||[])[1]||"";
  var by=(location.search.match(/[?&]by=([^&]+)/)||[])[1], cn=(location.search.match(/[?&]cn=([^&]+)/)||[])[1];
  if(by){ try{ INVITE_BY=decodeURIComponent(by); }catch(e){} }
  if(cn){ try{ INVITE_CN=decodeURIComponent(cn); }catch(e){} }
  if(joinCrew(m[1], inv)){ CREW_INVITE=true; JUST_JOINED=(curCrew()||{}).code;
    // seed the crew NAME from the link ONLY for a genuinely new join (don't clobber an existing/renamed name with a stale link)
    if(INVITE_CN){ var _c=(ST.crews||[]).filter(function(x){return x.code===(curCrew()||{}).code;})[0]; if(_c && !_c.name) setLocalCrewName(_c.code, INVITE_CN); } }
  try{ history.replaceState(null,"",location.pathname); }catch(e){}   // clean URL so a refresh doesn't re-log
}
function loadAndRoute(wanted){
  var lane=ST.lane||"general";
  REPLAY=false;            // a normal set entry is never a replay (clears any stale "play again" intent)
  show("loading");
  fetchDay(wanted, lane).then(function(day){
    DAY=day; DAY._lane=lane; ANS={}; LOCK=null; PLAY_IDX=0;
    var isToday = day.date===todayStr();
    $("editiontag").textContent = (lane!=="general"?(laneLabel(lane).replace(/^\S+\s/,"")+" · "):"")+"No. "+(day.edition||"?")+" · "+prettyDate(day.date);
    $("sub").textContent = "Six quotes" + (lane!=="general"?(" · "+laneLabel(lane).replace(/^\S+\s/,"")):"") + ". Some are real. Some are made up.";
    updatePastBar(isToday, day);
    logEvent("visit",{archive:!isToday, cat:lane});
    if(isToday && ST.last_realday && ST.last_realday!==todayStr() && daysBetween(ST.last_realday,todayStr())>=1)
      logEvent("return",{gap:daysBetween(ST.last_realday,todayStr()), cat:lane});
    var key=dayKey(lane, day.date);
    if(ST.days[key] && ST.days[key].done){ renderReveal(ST.days[key].result, false); }
    else { logEvent("start",{cat:lane, archive:!isToday}); renderPlay(); }
  }).catch(function(e){
    show("error");
    $("screen-error").innerHTML="Couldn't load that set.<br><span style='color:var(--mut);font-size:13px'>"+esc(e.message||e)+"</span>";
  });
}
function prettyDate(s){var d=new Date(s+"T12:00:00");return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});}

/* ---------- category lanes (G-C) — lane defs/paths in data.js; these wrap them with the live MANIFEST ---------- */
function laneDays(lane){ return laneDaysFrom(MANIFEST, lane); }
function availableLanes(){ var ls=availableLanesFrom(MANIFEST); return ST.nsfw_off ? ls.filter(function(l){ return l!=="nsfw"; }) : ls; }   // Settings can hide the Off-the-Record lane
// the 6-lane daily loop's "today" set: lanes published for today, minus a hidden Off-the-Record (the "/N" denominator)
function lanesToday(){ var ls=lanesForDay(MANIFEST, todayStr()); return ST.nsfw_off ? ls.filter(function(l){ return l!=="nsfw"; }) : ls; }
function curDone(){ if(!DAY) return null; var r=ST.days[dayKey(DAY._lane||"general",DAY.date)]; return (r&&r.done)?r.result:null; }

function fetchDay(date, lane){ return fetchDayFrom(date, lane, MANIFEST); }

/* ---------- LANES picker (bright redesign) ---------- */
function openLanes(){
  BACK_TO="home";
  $("editiontag").textContent=""; $("pastbar").classList.add("hide"); $("pastbar").innerHTML="";
  var avail=availableLanes();
  LANES_PICK = (avail.indexOf(ST.lane)>=0) ? ST.lane : "general";
  renderLanesPicker(); show("lanes");
}
function laneDoneToday(lane){ var r=ST.days[dayKey(lane, todayStr())]; return !!(r&&r.done); }
function renderLanesPicker(){
  var host=$("screen-lanes"), avail=availableLanes();
  var cards=avail.map(function(lane){
    var hue=laneHue(lane), sel=(lane===LANES_PICK), nm=laneName(lane), vibe=LANE_VIBES[lane]||"", done=laneDoneToday(lane);
    var badge = LANE_HOT[lane] ? '<span class="lane-badge hot">heated</span>'
              : (LANE_ADULT[lane] ? '<span class="lane-badge adult">NSFW</span>' : '');
    // dot: ring + line icon (hue); when played today → filled hue + white check
    var dot = done
      ? '<span class="lane-dot done" style="background:'+hue+';border-color:'+hue+'"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg></span>'
      : '<span class="lane-dot" style="border-color:'+hue+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="'+hue+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+laneIcon(lane)+'</svg></span>';
    var style = 'border-color:'+hue+(sel?(';background:'+hue+'14;box-shadow:0 8px 20px -12px '+hue):'');   // border = dot colour, always
    return '<button class="lane-card'+(sel?' sel':'')+(done?' done':'')+'" data-lane="'+esc(lane)+'" aria-pressed="'+(sel?"true":"false")+'" aria-label="'+esc(nm+(done?" — played, view results":(", "+vibe)))+'" style="'+style+'">'+
      '<div class="lc-top">'+dot+badge+'</div>'+
      '<div><div class="lane-name">'+esc(nm)+'</div><div class="lane-vibe">'+(done?'<span class="lane-played">✓ View results</span>':esc(vibe))+'</div></div></button>';
  }).join("");
  var pickDone=laneDoneToday(LANES_PICK);
  host.innerHTML =
    '<div class="scr-head"><button class="back-btn" id="lanesBack" aria-label="Back">'+BACK_ARROW+'</button>'+
      '<div class="scr-title">Pick your lane</div>'+
      '<button class="hdr-mags" id="lanesMags" aria-label="Meet Mags">'+magpie("happy",26,"mags-flip")+'</button></div>'+
    '<div class="lanes-sub">Six quotes. Some real, some I faked. Spot the fakes.</div>'+
    '<div class="lane-grid">'+cards+'</div>'+
    '<div class="sticky-cta"><button class="outline-cta" id="lanesPlay">'+(pickDone?'View results':('Play '+esc(laneName(LANES_PICK))))+
      ' <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>';
  $("lanesBack").onclick=goHome;
  $("lanesMags").onclick=openMagpie;
  $("lanesPlay").onclick=function(){ startLane(LANES_PICK); };
  host.querySelectorAll(".lane-card").forEach(function(b){ b.onclick=function(){ pickLaneTile(b.getAttribute("data-lane")); }; });
}
function pickLaneTile(lane){
  if(lane==="nsfw" && !ST.nsfw_ok){ ensureAgeOk(function(){ LANES_PICK="nsfw"; renderLanesPicker(); }); return; }   // Off the Record 18+ sheet
  LANES_PICK=lane; renderLanesPicker();
}
function startLane(lane){ maybeOnboard(function(){ playLane(lane); }); }   // first run → one-card how-to, then playLane (gate + loadAndRoute)

/* ---------- HOME (the hub) ---------- */
function gamesPlayed(){ var d=ST.days||{},n=0; for(var k in d){ if(d[k]&&d[k].done)n++; } return n; }
function accPct(){ return ST.judged? Math.round(100*ST.correct/ST.judged):0; }
function lockPct(){ return ST.locks? Math.round(100*ST.locks_correct/ST.locks):0; }
// per-category aggregates from ST.days history (backfills automatically; legacy results default to general)
function categoryStats(){
  var by={};
  for(var k in (ST.days||{})){ var rec=ST.days[k], r=rec&&rec.done&&rec.result; if(!r) continue;
    var lane=r.lane||"general", b=by[lane]||(by[lane]={score:0,n:0,sets:0,locks:0,locksRight:0});
    b.score+=r.score||0; b.n+=r.n||0; b.sets++;
    if(r.lockCorrect===true||r.lockCorrect===false){ b.locks++; if(r.lockCorrect) b.locksRight++; }
  }
  return by;
}
// last 7 real calendar days — did a `complete` happen that day (from the local event trail)?
function last7(){   // strictly chronological: 7 cells, oldest (left) → today (right); a cell is filled iff a set was played that real day
  var played={}; (ST.log||[]).forEach(function(e){ if(e.ev==="complete"&&e.ts){ try{ played[todayStr(new Date(e.ts))]=1; }catch(x){} } });
  var t=todayStr(), out=[];
  for(var i=6;i>=0;i--){ var d=addDaysStr(t,-i); out.push({date:d, played:!!played[d], today:i===0}); }
  return out;
}
// named rank ladder, earned by accuracy; hidden until 5 sets; seeded partway into the tier (endowed progress)
// TIERS (skill), STREAK_TIERS, streakRank, and computeRank live in engine.js (the two rank ladders).
function rankInfo(){ return computeRank(gamesPlayed(), ST.judged, ST.correct); }
function allResults(){ var out=[]; for(var k in (ST.days||{})){ var r=ST.days[k]&&ST.days[k].done&&ST.days[k].result; if(r) out.push(r); }
  return out.sort(function(a,b){ return (a.date||"")<(b.date||"")?1:-1; }); }   // newest first
// personal "coach" line — keep the ~90% who aren't #1 motivated
function renderCoach(){
  // de-duped: the streak hero already shows the streak, so the coach never restates it (B). Skill/rank nudges only.
  var c=$("homeCoach"); c.className=""; c.innerHTML=""; var msg="";
  if(ST.judged>=18 && accPct()>=70) msg="🎯 "+accPct()+"% accuracy — you've got a genuinely sharp eye.";
  else if(gamesPlayed()>=1 && gamesPlayed()<5) msg="📈 "+(5-gamesPlayed())+" more set"+((5-gamesPlayed())>1?"s":"")+" to earn your rank — you're close.";
  if(msg){ c.className="coach"; c.textContent=msg; }
}
/* ---------- MAGPIE page (D): backstory + why-a-magpie facts + animated Mags ---------- */
function openMagpie(){ PAGE_BACK.push(currentScreen()); renderMagpie(); show("magpie"); logEvent("magpie_view"); }
function renderMagpie(){
  var host=$("screen-magpie");
  host.innerHTML=
    '<div class="play-head"><button class="back-btn" id="magBack" aria-label="Back">'+BACK_ARROW+'</button><div class="scr-title">Meet Mags</div></div>'+
    '<div class="mag-hero"><span id="magAnim">'+magpie("happy",96,"mags-cycle")+'</span>'+
      '<div class="mag-name">Mags</div><div class="mag-tag">your friendly culprit</div></div>'+
    '<div class="mag-card"><div class="mc-h">The story</div>'+
      '<div class="mag-story">Meet Mags. Magpies are nature’s great mimics — they can copy almost any sound they hear, including human speech. They’re also one of the only animals that recognise themselves in a mirror, and they’ve got a reputation for mischief and shiny-thing thievery (a flock is literally called a “mischief” of magpies). So Mags is the perfect culprit: every day he eavesdrops on the news, then slips a few quotes he made up in among the real ones — just to see who’s paying attention. Your job is to out-smart the bird.</div></div>'+
    '<div class="mag-card"><div class="mc-h">Why a magpie?</div><ul class="mag-facts">'+
      '<li><span class="dot"></span><span>They’re <b>expert mimics</b> — wild magpies imitate human speech and other birds’ calls. The perfect voice-faker.</span></li>'+
      '<li><span class="dot"></span><span>They <b>pass the mirror test</b> — one of the very few animals that recognise themselves. A clever bird for a clever game.</span></li>'+
      '<li><span class="dot"></span><span>A group is a <b>“mischief”</b> of magpies — and they can’t resist a shiny thing. Mischief is the whole point.</span></li>'+
      '<li><span class="dot"></span><span>That blue-black <b>iridescent sheen</b> on their wings is where Said It? gets its blue.</span></li>'+
    '</ul></div>';
  $("magBack").onclick=pageBack;
  // gentle happy↔delighted cycle; disabled under prefers-reduced-motion; self-clears when you leave
  if(window._magInt){ clearInterval(window._magInt); window._magInt=null; }
  var reduce=reduceMotionOn();   // honors the in-app override + the OS preference
  if(!reduce){ var moods=["happy","delighted"], i=0;
    window._magInt=setInterval(function(){ var a=$("magAnim"); if(!a||currentScreen()!=="magpie"){ clearInterval(window._magInt); window._magInt=null; return; }
      i=(i+1)%moods.length; a.innerHTML=magpie(moods[i],96,"mags-cycle"); }, 1500); }
}

/* the mascot "fakes" note — spoiler-safe AND count-free: revealing how many fakes are in the set is a tell, so
   Mags only teases. The COUNT is hidden everywhere before/during play; the reveal still shows the full truth. */
var FAKE_PHRASES=[
  "I slipped some fakes in here — don’t let me fool ya.",
  "A few of today’s quotes are mine. Spot the fakes.",
  "Some of these I made up. Think you can tell?",
  "I’ve hidden a few fakes in the mix — good luck.",
  "Not all of these are real. That’s the whole game.",
  "I faked a couple. Catch them if you can.",
];
function weekPhrase(){   // stable per week (weekKey), so the tease rotates weekly without leaking the count
  var wk=weekKey(todayStr()), h=0; for(var i=0;i<wk.length;i++){ h=(h*31+wk.charCodeAt(i))>>>0; }
  return FAKE_PHRASES[h % FAKE_PHRASES.length];
}
function homeFakesNote(){
  var host=$("homeFakes"); if(!host) return;
  // Mags speaks: flipped to face right into the text, with a small speech-tail; whole note opens the Magpie page
  host.innerHTML='<span class="fn-mags">'+magpie("happy",34,"mags-flip")+'<span class="fn-tail"></span></span><span class="fk-txt">'+esc(weekPhrase())+'</span>';
  host.onclick=openMagpie;
}
// TODAY module — the 6-lane daily loop: a lane segment per available lane (filled = done, outline = not),
// a done/total count, and a clean-sweep state once every lane is in. Tapping a segment plays it or reviews it.
function renderHomeToday(){
  var host=$("homeToday"); if(!host) return;
  var today=todayStr(), avail=lanesToday();
  if(!avail.length){ host.className=""; host.innerHTML=""; return; }   // nothing published yet → no card
  var done=lanesDoneCount(ST.days, avail, today), total=avail.length, sweep=(done>=total);
  var segs=avail.map(function(lane){
    var hue=laneHue(lane), isDone=laneDoneOn(ST.days, lane, today), nm=laneName(lane);
    var style=isDone ? ('background:'+hue+';border-color:'+hue) : ('border-color:'+hue);
    return '<button class="today-seg'+(isDone?' done':'')+'" data-lane="'+esc(lane)+'" style="'+style+'" '+
      'aria-label="'+esc(nm+(isDone?" — done, view results":" — play"))+'">'+(isDone?CHECK_SVG:'')+'</button>';
  }).join("");
  if(sweep){
    host.className="today-card swept";
    host.innerHTML='<div class="today-head">'+magpie("delighted",30,"mags-flip")+'<span class="today-title">Clean sweep — all '+total+' today</span></div>'+
      '<div class="today-segs">'+segs+'</div>';
  } else {
    host.className="today-card";
    host.innerHTML='<div class="today-head"><span class="today-title">Today</span><span class="today-count">'+done+' / '+total+' today</span></div>'+
      '<div class="today-segs">'+segs+'</div>';
  }
  host.querySelectorAll(".today-seg").forEach(function(b){ b.onclick=function(){ var lane=b.getAttribute("data-lane");
    if(laneDoneOn(ST.days, lane, today)) openReview(lane, today); else startLane(lane); }; });
}

// streak headline + 7-day strip (mint-outline = played, dashed-primary = today)
function renderHomeStreak(){
  var host=$("homeStreak"); if(!host) return;
  var d7=last7();
  // each cell FILLS proportionally to lanes done that day / lanes available that day (the 6-lane loop's sixths)
  var byDate=countLanesDoneByDate(ST.days, d7.map(function(x){return x.date;}));
  var cells=d7.map(function(x){
    var cls=x.today?"today":(x.played?"hit":"miss");
    var lblCls=x.today?"today":(x.played?"hit":"");
    var den=lanesForDay(MANIFEST,x.date).length, doneN=byDate[x.date]||0;
    var pct=den?Math.min(100,Math.round(doneN/den*100)):(doneN?100:0);
    return '<div class="d7cell"><div class="d7pill '+cls+'">'+
      (pct>0?'<div class="d7fill" style="height:'+pct+'%"></div>':'')+
      (x.played?CHECK_SVG:"")+'</div>'+
      '<span class="d7lbl '+lblCls+'">'+weekdayShort(x.date)+'</span></div>';
  }).join("");
  var sub="";
  if(ST.streak>0 && (ST.best_streak||0)<=ST.streak) sub='<br><span class="best-yet">your best yet</span>';
  else if(ST.streak>0 && ST.best_streak>0) sub='<br><span class="best-num">best: '+ST.best_streak+' day'+(ST.best_streak>1?'s':'')+'</span>';
  // streak-ladder name (commitment axis), by best streak — the skill rank lives on the Rank tile (two axes, B)
  var lad=streakRank(Math.max(ST.streak||0, ST.best_streak||0));
  var ladName = (ST.streak>0 && lad) ? ' <span class="streak-ladder">· '+esc(lad.n)+'</span>' : '';
  var head = ST.streak>0
    ? '<div class="streak-head"><span class="fire">🔥</span><span class="streak-num">'+ST.streak+'</span>'+ladName+'<span class="streak-lbl">day streak'+sub+'</span></div>'
    : '<div class="streak-head"><span class="fire">🔥</span><span class="streak-num zero">0</span><span class="streak-lbl">Play today to start your streak</span></div>';
  // streak-freeze visibility (your safety net): a fresh freeze each week shields one missed day
  var wk=weekKey(todayStr()), fz=(ST.freeze_week===wk)?(ST.freezes_left||0):1;
  var freezeChip = (ST.streak>0)
    ? '<div class="freeze-chip'+(fz>0?'':' spent')+'">🛡️ '+fz+' freeze'+(fz===1?'':'s')+' left this week</div>' : '';
  host.innerHTML=head+'<div class="d7strip">'+cells+'</div>'+freezeChip;
  activate(host, function(){ openStats("overview"); }, "Your stats — streak, accuracy, history");   // streak hero → Stats page
}
function homeStatChip(label,value,which,onTap){
  var b=el("button","stat-chip");
  b.innerHTML='<div class="sc-lbl">'+esc(label)+'</div><div class="sc-val">'+esc(value)+'</div>';
  b.setAttribute("aria-label", label+" — tap for detail");
  b.onclick=onTap || function(){ openStats(which); };
  return b;
}
// hero slot: in-crew standing card, or the solo / new-player crew nudge
function renderHomeHero(){
  var host=$("homeHero"); var cc=curCrew();
  if(!cc || !crewBackend()){
    // solo nudge — no standalone Mags here (header Mags + fakes-note Mags already carry the mascot; one fewer bird)
    host.className="hero-solo"; host.removeAttribute("role"); host.removeAttribute("tabindex"); host.onclick=null; host.onkeydown=null;
    host.innerHTML='<div class="hc-eyebrow">CREWS</div>'+
      '<div class="hs-title">Play with friends</div><div class="hs-sub">Start a crew — compare scores on a shared daily board. No account needed.</div>'+
      '<button class="hs-btn" id="homeStartCrew">+ Create or join a crew</button>'+
      '<div class="hs-solo" id="homeSolo" hidden></div>';   // solo loop (#11): your daily standing, for players with no crew
    var b=$("homeStartCrew"); if(b) b.onclick=openCrew;
    renderSolo($("homeSolo"), todayStr());
    return;
  }
  host.className="hero-crew";
  host.innerHTML='<div class="hc-eyebrow">CREWS</div>'+
    '<div class="hc-row">'+
      '<button class="hc-name" id="homeCrewName"><span>'+esc(crewLabel(cc))+'</span>'+CHEV_DOWN+'</button>'+
      '<span class="hc-week">this week</span></div>'+
    '<div class="hc-rank"><span class="hc-rank-n" id="hcRankN">·</span><span class="hc-rank-of" id="hcRankOf">of —</span></div>'+
    '<div class="hc-gap" id="hcGap">loading your standing…</div>'+
    '<div class="hc-foot"><div class="hc-avs" id="hcAvs"></div><span class="hc-see">See the board ›</span></div>';
  activate(host, openCrew, "Open crew board");
  var nm=$("homeCrewName"); if(nm) nm.onclick=function(e){ if(e&&e.stopPropagation)e.stopPropagation(); openCrewSwitcher(); };  // crew-name → switcher sheet
  fetchCrew(todayStr(), cc.code).then(function(c){
    if(c&&c.name){ setLocalCrewName(cc.code,c.name); var n2=$("homeCrewName"); if(n2){ var sp=n2.querySelector("span"); if(sp) sp.textContent=crewLabel(curCrew()); } }
    // weekly (season) standing — merge this device's own week total so it shows before the server registers it
    var myW=myWeekTotal();
    var week=((c&&c.week)||[]).map(function(s){return {sid:s.sid,name:s.name,total:s.total,you:s.sid===ST.sid};});
    var meW=week.filter(function(s){return s.you;})[0];
    if(meW){ if(myW.total>meW.total) meW.total=myW.total; } else if(myW.days){ week.push({sid:ST.sid,name:ST.displayName||"you",total:myW.total,you:true}); }
    week.sort(function(a,b){return b.total-a.total;});
    var gapEl=$("hcGap"), rnEl=$("hcRankN"), roEl=$("hcRankOf"), avEl=$("hcAvs");
    if(!gapEl) return;   // navigated away before the fetch resolved
    if(!week.length){ rnEl.textContent="–"; roEl.textContent=""; gapEl.textContent="No scores yet this week — play to lead "+crewLabel(cc); return; }
    var yi=0; for(var i=0;i<week.length;i++){ if(week[i].you){ yi=i; break; } }
    rnEl.textContent=(yi+1); roEl.textContent="of "+week.length;
    if(yi>0){ var need=week[yi-1].total-week[yi].total; gapEl.textContent=(need>0?(need+" point"+(need===1?"":"s")+" behind "+week[yi-1].name+" →"):("tied with "+week[yi-1].name)); }
    else { gapEl.textContent="leading the board →"; }
    avEl.innerHTML=week.slice(0,5).map(function(s){ var col=s.you?"var(--primary)":avColor(s.name);
      return '<span class="av" style="border-color:'+col+';color:'+col+'">'+esc(s.you?"Y":avInitial(s.name))+'</span>'; }).join("");
  });
}
/* ---------- returner recap: "great to see you again" when you've been away ≥2 days ---------- */
// new (lane,date) editions published strictly after `since` and up to today — computed from the live MANIFEST.
function newEditionsSince(since){
  if(!since) return [];
  var today=todayStr(), out=[];
  availableLanes().forEach(function(lane){
    laneDays(lane).forEach(function(d){ if(d>since && d<=today) out.push({lane:lane, date:d}); });
  });
  return out;
}
function maybeReturnerRecap(){
  var host=$("homeRecap"); if(!host) return;
  host.className=""; host.innerHTML="";
  if(RECAP_SHOWN) return;                                            // once per session — don't re-pop on every Home visit
  if(!PREV_SEEN) return;                                             // brand-new device → nothing to recap
  var gap=daysBetween(PREV_SEEN, todayStr()); if(gap<2) return;      // only after a real absence (≥2 days)
  var fresh=newEditionsSince(PREV_SEEN); if(!fresh.length) return;   // nothing new published while away
  RECAP_SHOWN=true;
  var dateSet={}; fresh.forEach(function(e){ dateSet[e.date]=1; }); var nDays=Object.keys(dateSet).length;
  var chips=lanesToday().map(function(l){
    return '<button class="rc-chip" data-lane="'+esc(l)+'"><span class="rc-dot" style="background:'+laneHue(l)+'"></span>'+esc(laneName(l))+'</button>'; }).join("");
  host.className="home-recap";
  host.innerHTML=
    '<button class="rc-x" id="recapX" aria-label="Dismiss">'+X_ICON+'</button>'+
    '<div class="rc-head">'+magpie("delighted",30,"mags-flip")+'<span class="rc-title">Great to see you again 👋</span></div>'+
    '<div class="rc-sub">It’s been '+gap+' days — '+nDays+' new edition'+(nDays===1?'':'s')+' dropped while you were away. Jump back in:</div>'+
    (chips?('<div class="rc-chips">'+chips+'</div>'):'')+
    '<div class="rc-foot">Pick up where you left off and keep your streak alive.</div>';
  $("recapX").onclick=function(){ host.className=""; host.innerHTML=""; logEvent("recap_dismiss"); };
  host.querySelectorAll(".rc-chip").forEach(function(b){ b.onclick=function(){ startLane(b.getAttribute("data-lane")); }; });
  logEvent("recap_shown",{gap:gap, editions:fresh.length, days:nDays});
}
function renderHome(){
  $("editiontag").textContent=homeDateLabel();
  $("sub").textContent="";
  $("pastbar").classList.add("hide"); $("pastbar").innerHTML="";
  maybeReturnerRecap();   // "great to see you again" — only when you've been away ≥2 days (once per session)
  renderHomeHero();
  homeFakesNote();
  renderHomeToday();
  renderHomeStreak();
  renderCoach();
  // two competitive axes (B): streak ladder lives on the streak hero; the Rank tile shows the SKILL rank → Ranks page.
  var sg=$("homeStats"); sg.innerHTML="";
  var rk=rankInfo();
  sg.appendChild(homeStatChip("Accuracy", ST.judged?accPct()+"%":"—", "accuracy"));            // → Stats page
  sg.appendChild(homeStatChip("Rank", rk.locked?"—":rk.tier, "standing", openRanks));           // skill rank → Ranks page
  sg.appendChild(homeStatChip("Played", String(gamesPlayed()), "days"));                         // → Stats page
  // footer links: Past editions · Save progress (account link only when Supabase is configured)
  var ha=$("homeAccount"), sep=$("homeLinkSep");
  if(ha){ if(SB){ ha.classList.remove("hide"); if(sep)sep.classList.remove("hide");
      ha.textContent=ACCOUNT?("Synced"+(ACCOUNT.email?(" · "+ACCOUNT.email):"")):"Save progress"; ha.onclick=openCrew; }
    else { ha.classList.add("hide"); if(sep)sep.classList.add("hide"); } }
  show("home");
  scheduleHomePeek();   // start the idle Mags peek loop (self-clears on nav; no-op under reduced motion)
}
function goHome(){ JUST_JOINED=null; REPLAY=false; if(qsDay()){ try{ history.replaceState(null,"",location.pathname); }catch(e){} } renderHome(); logEvent("home_view"); }  // strip a lingering ?d= so Home survives a reload
// Off the Record 18+ gate — styled bottom sheet (replaces window.confirm); keeps the ST.nsfw_ok flag + nsfw_optin event
function ensureAgeOk(onOk){
  if(ST.nsfw_ok){ onOk(); return; }
  var sh=openSheet(
    '<div class="ag-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>'+
    '<div class="ag-title">Off the Record is 18+</div>'+
    '<div class="ag-body">Spicier quotes, same game. Confirm you’re over 18 to play this lane.</div>'+
    '<button class="ag-confirm" id="agOk">I’m 18 or older</button>'+
    '<button class="ag-cancel" id="agNo">Not now</button>');
  $("agOk").onclick=function(){ ST.nsfw_ok=true; save(ST); logEvent("nsfw_optin"); closeSheet(); onOk(); };
  $("agNo").onclick=closeSheet;
}
function playLane(lane){
  if(lane==="nsfw" && !ST.nsfw_ok){ ensureAgeOk(function(){ playLane("nsfw"); }); return; }
  if(ST.lane!==lane){ ST.lane=lane; save(ST); logEvent("lane_switch",{cat:lane}); }
  loadAndRoute(todayStr());
}

/* ---------- STAT DETAIL VIEWS (every home tile → its own detail) ---------- */
function lastNplayed(n){ var played={}; (ST.log||[]).forEach(function(e){ if(e.ev==="complete"&&e.ts){ try{played[todayStr(new Date(e.ts))]=1;}catch(x){} } });
  var t=todayStr(), out=[]; for(var i=n-1;i>=0;i--){ var d=addDaysStr(t,-i); out.push({date:d,played:!!played[d],today:i===0}); } return out; }
// laneName imported from data.js

/* ---------- STATS page (E1) + RANKS page (E2) ---------- */
function rangeResults(range){ var all=allResults(); if(range==="all") return all; var t=todayStr();
  if(range==="today") return all.filter(function(r){return r.date===t;});
  var wk=weekKey(t); return all.filter(function(r){return r.date&&weekKey(r.date)===wk;}); }
function rangeStats(range){ var rs=rangeResults(range), judged=0, correct=0, locks=0, lr=0, byLane={};
  rs.forEach(function(r){ judged+=r.n||0; correct+=r.score||0;
    if(r.lockCorrect===true||r.lockCorrect===false){ locks++; if(r.lockCorrect)lr++; }
    var ln=r.lane||"general", b=byLane[ln]||(byLane[ln]={s:0,n:0}); b.s+=r.score||0; b.n+=r.n||0; });
  return {sets:rs.length, judged:judged, correct:correct, acc:judged?Math.round(100*correct/judged):0,
    locks:locks, lockPct:locks?Math.round(100*lr/locks):0, byLane:byLane, results:rs}; }
var STATS_RANGE="all";
function openStats(){ PAGE_BACK.push(currentScreen()); renderStats(); show("stats"); logEvent("stat_detail",{which:"stats"}); }
function renderStats(){
  var host=$("screen-stats"), s=rangeStats(STATS_RANGE);
  var lad=streakRank(Math.max(ST.streak||0, ST.best_streak||0));
  var recent=s.results.slice(0,10).reverse();   // accuracy over time, oldest→newest
  var sparks=recent.length ? recent.map(function(r){ var p=r.n?Math.round(100*r.score/r.n):0;
      return '<div class="sp-col" title="'+esc(prettyDate(r.date))+': '+r.score+'/'+r.n+'"><div class="sp-bar" style="height:'+Math.max(6,p)+'%"></div></div>'; }).join("")
    : '<div class="sp-empty">No sets in this range yet — play one to start the chart.</div>';
  var laneBars=availableLanes().map(function(ln){ var b=s.byLane[ln], p=(b&&b.n)?Math.round(100*b.s/b.n):0;
    return '<div class="st-bar"><span class="bl">'+esc(laneName(ln))+'</span><div class="bw"><div class="bf" style="width:'+(b&&b.n?p:0)+'%;background:'+laneHue(ln)+'"></div></div><span class="bv">'+(b&&b.n?p+"%":"—")+'</span></div>'; }).join("");
  var rlabel=STATS_RANGE==="all"?"all-time":(STATS_RANGE==="today"?"today":"this week");
  host.innerHTML=
    '<div class="scr-head"><button class="back-btn" id="statsBack" aria-label="Back">'+BACK_ARROW+'</button><div class="scr-title">Your stats</div>'+
      '<button class="hdr-mags" id="statsMags" aria-label="Meet Mags">'+magpie("happy",26,"mags-flip")+'</button></div>'+
    '<div class="seg-toggle stats-range">'+["today","week","all"].map(function(r){ return '<button data-r="'+r+'" class="'+(STATS_RANGE===r?"on":"")+'">'+(r==="all"?"All-time":(r==="week"?"Week":"Today"))+'</button>'; }).join("")+'</div>'+
    '<div class="st-summary">'+
      '<div class="st-cell"><div class="v">'+s.sets+'</div><div class="k">sets · '+rlabel+'</div></div>'+
      '<div class="st-cell"><div class="v">'+(s.judged?s.acc+"%":"—")+'</div><div class="k">accuracy</div></div>'+
      '<div class="st-cell"><div class="v">'+(s.locks?s.lockPct+"%":"—")+'</div><div class="k">lock record</div></div></div>'+
    '<div class="mag-card"><div class="mc-h">Your journey</div>'+
      '<div class="st-jrow"><span>First played</span><b>'+(ST.first_seen?esc(prettyDate(ST.first_seen)):"—")+'</b></div>'+
      '<div class="st-jrow"><span>Days played</span><b>'+gamesPlayed()+'</b></div>'+
      '<div class="st-jrow"><span>Current streak</span><b>🔥 '+(ST.streak||0)+(lad&&(ST.streak||ST.best_streak)?(" · "+esc(lad.n)):"")+'</b></div>'+
      '<div class="st-jrow"><span>Best streak</span><b>'+(ST.best_streak||0)+' day'+((ST.best_streak||0)===1?"":"s")+'</b></div></div>'+
    '<div class="mag-card"><div class="mc-h">Accuracy over time</div><div class="spark">'+sparks+'</div></div>'+
    '<div class="mag-card"><div class="mc-h">By category ('+rlabel+')</div><div class="st-bars">'+laneBars+'</div></div>'+
    '<button class="st-link" id="statsRanks">See how ranks work →</button>'+
    '<div class="mag-card st-cohort"><div class="mc-h">How you compare</div>'+
      '<div class="st-blurb">See how you stack up against players who started the same week as you.</div>'+
      '<div class="st-cohort-ph" id="statCohort">📊 Cohort comparison — '+(useSbCrew()?'loading…':'play a few days to unlock')+'</div></div>';
  $("statsBack").onclick=pageBack; $("statsMags").onclick=openMagpie; $("statsRanks").onclick=openRanks;
  host.querySelectorAll(".stats-range button").forEach(function(b){ b.onclick=function(){ STATS_RANGE=b.getAttribute("data-r"); renderStats(); }; });
  loadCohort();   // v2 cohort — aggregate-only (no individuals/PII), via the Supabase board fn
}
// Stats v2 cohort: players who joined your week → avg days/sets vs you (motivating framing, never individuals)
function loadCohort(){
  if(!useSbCrew()) return;
  sbFetchCohort(SB, ST.sid).then(function(c){
    var host=$("statCohort"); if(!host || currentScreen()!=="stats") return;
    if(!c || !c.n_players || c.n_players<2){ host.textContent="Cohort comparison unlocks once a few of your week-mates have played."; return; }
    var pct=c.my_days_pct||0, lead = pct>=100;
    host.innerHTML=
      '<div class="st-summary" style="margin-top:0">'+
        '<div class="st-cell"><div class="v">'+c.my_days+'</div><div class="k">your days</div></div>'+
        '<div class="st-cell"><div class="v">'+c.avg_days+'</div><div class="k">week-mate avg</div></div>'+
        '<div class="st-cell"><div class="v">'+c.n_players+'</div><div class="k">in your cohort</div></div></div>'+
      '<div class="st-blurb" style="margin-top:10px">'+(lead
        ? ('🎯 You’re ahead — '+pct+'% of your cohort’s average days played. Keep the lead.')
        : ('You’re at '+pct+'% of your cohort’s average — a couple more days catches them.'))+'</div>';
  });
}
function openRanks(){ PAGE_BACK.push(currentScreen()); renderRanks(); show("ranks"); logEvent("ranks_view"); }
function renderRanks(){
  var host=$("screen-ranks"), rk=rankInfo();
  var ci=-1; if(!rk.locked){ for(var i=0;i<TIERS.length;i++){ if(TIERS[i].n===rk.tier) ci=i; } }
  var skillRows=TIERS.map(function(tt,i){ var cur=(i===ci), done=(ci>=0&&i<ci);
    return '<div class="ld-row'+(cur?" cur":"")+'"><span class="ld-badge skill'+((done||cur)?" on":"")+'">'+(done?"✓":(i+1))+'</span>'+
      '<span class="ld-name">'+esc(tt.n)+(cur?" · you":"")+'</span><span class="ld-thr">'+(tt.a?(Math.round(tt.a*100)+"%+"):"start")+'</span></div>'; }).join("");
  var bestStreak=Math.max(ST.streak||0, ST.best_streak||0), streakCur=streakRank(bestStreak);
  var streakRows=STREAK_TIERS.map(function(tt,i){ var hi=(i+1<STREAK_TIERS.length)?(STREAK_TIERS[i+1].lo-1):null, cur=!!(streakCur&&streakCur.n===tt.n), done=(bestStreak>=tt.lo&&!cur);
    return '<div class="ld-row'+(cur?" cur":"")+'"><span class="ld-badge streak'+((done||cur)?" on":"")+'">🔥</span>'+
      '<span class="ld-name">'+esc(tt.n)+(cur?" · you":"")+'</span><span class="ld-thr">'+tt.lo+(hi?("–"+hi):"+")+' days</span></div>'; }).join("");
  host.innerHTML=
    '<div class="scr-head"><button class="back-btn" id="ranksBack" aria-label="Back">'+BACK_ARROW+'</button><div class="scr-title">Ranks</div>'+
      '<button class="hdr-mags" id="ranksMags" aria-label="Meet Mags">'+magpie("happy",26,"mags-flip")+'</button></div>'+
    '<div class="rk-intro">Two ways to climb: <b>skill</b> rises with your accuracy; <b>streak</b> rises the more days you show up.</div>'+
    '<div class="mag-card"><div class="mc-h">Skill rank — accuracy</div>'+
      '<div class="rk-cur">'+(rk.locked?("Play "+rk.need+" more set"+(rk.need===1?"":"s")+" to earn your first rank."):("You’re <b>"+esc(rk.tier)+"</b>"+(rk.next?(" — raise accuracy to reach <b>"+esc(rk.next)+"</b>."):" — top rank, keep it sharp.")))+'</div>'+
      '<div class="ld">'+skillRows+'</div></div>'+
    '<div class="mag-card"><div class="mc-h">Streak rank — commitment</div>'+
      '<div class="rk-cur">'+(streakCur?("You’re <b>"+esc(streakCur.n)+"</b> — play more days in a row to climb."):"Not lit yet — play today to spark your streak.")+'</div>'+
      '<div class="ld">'+streakRows+'</div></div>';
  $("ranksBack").onclick=pageBack; $("ranksMags").onclick=openMagpie;
}

/* ---------- SETTINGS (theme · reduced-motion · Off the Record · reminders · haptics · account · reset · disclaimer) ---------- */
function settingSwitch(id, on, label){
  return '<button class="switch" id="'+id+'" role="switch" aria-checked="'+(on?"true":"false")+'" aria-label="'+esc(label)+'"><span class="track"><span class="knob"></span></span></button>';
}
function openSettings(){ PAGE_BACK.push(currentScreen()); renderSettings(); show("settings"); logEvent("settings_view"); }
function renderSettings(){
  var host=$("screen-settings"), theme=ST.theme||CFG.THEME||"blue";
  host.innerHTML=
    '<div class="scr-head"><button class="back-btn" id="setBack" aria-label="Back">'+BACK_ARROW+'</button>'+
      '<div class="scr-title">Settings</div>'+
      '<button class="hdr-mags" id="setMags" aria-label="Meet Mags">'+magpie("happy",26,"mags-flip")+'</button></div>'+
    '<div class="set-sec">Appearance</div><div class="set-card">'+
      '<div class="set-row"><div><div class="sl">Theme</div><div class="ss">Accent colour</div></div>'+
        '<div class="set-ctl"><div class="seg-mini" id="setTheme">'+
          '<button data-t="blue" class="'+(theme!=="coral"?"on":"")+'" aria-pressed="'+(theme!=="coral")+'">Blue</button>'+
          '<button data-t="coral" class="'+(theme==="coral"?"on":"")+'" aria-pressed="'+(theme==="coral")+'">Coral</button>'+
        '</div></div></div>'+
      '<div class="set-row"><div><div class="sl">Reduce motion</div><div class="ss">Calm the animations</div></div>'+
        '<div class="set-ctl">'+settingSwitch("setRM", !!ST.reduceMotion, "Reduce motion")+'</div></div></div>'+
    '<div class="set-sec">Play</div><div class="set-card">'+
      '<div class="set-row"><div><div class="sl">Off the Record</div><div class="ss">Show the 18+ lane</div></div>'+
        '<div class="set-ctl">'+settingSwitch("setAdult", !ST.nsfw_off, "Show the Off the Record lane")+'</div></div>'+
      '<div class="set-row"><div><div class="sl">Daily reminder</div><div class="ss">A nudge when a new set is live</div></div>'+
        '<div class="set-ctl">'+settingSwitch("setNotif", !!ST.notif, "Daily reminder")+'</div></div>'+
      '<div class="set-row"><div><div class="sl">Haptics</div><div class="ss">A tap on lock, correct &amp; streak</div></div>'+
        '<div class="set-ctl">'+settingSwitch("setHaptics", ST.haptics!==false, "Haptics")+'</div></div></div>'+
    (SB ? ('<div class="set-sec">Account</div><div id="setAccount"></div>') : '')+
    ((!isStandalone() && (DEFERRED_INSTALL || isIOS())) ? ('<div class="set-sec">App</div><button class="set-link" id="setInstall">📲 Add Said It? to your home screen</button>') : '')+
    '<div class="set-sec">Data</div>'+
    '<button class="set-link danger" id="setReset">Reset my data on this device</button>'+
    '<div class="set-foot">Mags makes up the fakes; real quotes link to their source. A quote shown as “made up” is part of the game — never a claim anyone actually said it.<br><button id="setDisclaimer">Read the full disclaimer</button></div>';
  $("setBack").onclick=pageBack; $("setMags").onclick=openMagpie;
  host.querySelectorAll("#setTheme button").forEach(function(b){ b.onclick=function(){ ST.theme=b.getAttribute("data-t"); save(ST); applyTheme(); logEvent("theme_set",{theme:ST.theme}); renderSettings(); }; });
  function wire(id, cur, apply){ var s=$(id); if(!s) return; s.onclick=function(){ var nv=!cur(); s.setAttribute("aria-checked", nv?"true":"false"); apply(nv); save(ST); }; }
  wire("setRM", function(){ return !!ST.reduceMotion; }, function(nv){ ST.reduceMotion=nv; applyMotionPref(); });
  wire("setAdult", function(){ return !ST.nsfw_off; }, function(nv){ ST.nsfw_off=!nv; });
  wire("setNotif", function(){ return !!ST.notif; }, function(nv){ ST.notif=nv; logEvent("notif_pref",{on:nv}); if(nv) enablePush(); else disablePush(); });
  wire("setHaptics", function(){ return ST.haptics!==false; }, function(nv){ ST.haptics=nv; if(nv) haptic(12); });
  if(SB){ var ac=$("setAccount"); if(ac){ ac.innerHTML=accountHTML(); wireAccount(); } }
  var si=$("setInstall"); if(si) si.onclick=promptInstall;
  $("setReset").onclick=function(){ if(window.confirm && !window.confirm("Erase your streak, rating and history on this device?")) return; try{ localStorage.removeItem(K); }catch(e){} location.reload(); };
  $("setDisclaimer").onclick=function(){ var sh=openSheet('<div class="sheet-title">About the fakes</div>'+
    '<div class="ag-body">Each day, Mags (our magpie mascot) writes a few made-up quotes and mixes them in with real ones. Fakes are clearly labelled “made up” on the results screen — they are part of the game and are <b>never</b> a claim that any real person actually said them. Real quotes link to their published source so you can check. Out-smarting the bird is the whole point.</div>'+
    '<button class="sheet-close" id="discClose">Got it</button>'); var dc=$("discClose"); if(dc) dc.onclick=closeSheet; };
}

/* ---------- first-run onboarding: ONE interactive example quote (first run, before the first set) ----------
   Faster first play — instead of a wall of text, the player tries the actual mechanic on a single safe, real
   example (swipe or tap Real/Fake, NO scoring), then sees the framing and continues into their chosen lane.
   Once-only (the ST.onboarded gate) and skippable (Skip link + backdrop both proceed → never strand). */
function maybeOnboard(then){
  if(ST.onboarded || gamesPlayed()>0){ then(); return; }
  var fired=false;
  function done(){ if(fired) return; fired=true; ST.onboarded=true; save(ST); logEvent("onboarded"); closeSheet(); then(); }  // ANY dismissal proceeds → never strand, always mark onboarded
  openSheet(
    '<div class="ob-title">Real, or made up?</div>'+
    '<div class="ob-sub">Each day you get six quotes — some real, some I faked. Call this one to see how it works:</div>'+
    '<div class="ob-ex" id="obCard">'+
      '<div class="ob-tint real" id="obTintReal"></div><div class="ob-tint fake" id="obTintFake"></div>'+
      '<div class="ob-ex-q">“That’s one small step for man, one giant leap for mankind.”</div>'+
      '<div class="ob-ex-spk"><span class="ob-ex-av">N</span><span>Neil Armstrong · on the Moon, 1969</span></div>'+
    '</div>'+
    '<div class="ob-ex-row" id="obRow">'+
      '<button class="rfbtn real" id="obReal"><span class="ic">'+RF_CHECK+'</span><span class="lbl">Real</span></button>'+
      '<button class="rfbtn fake" id="obFake"><span class="ic">'+X_ICON+'</span><span class="lbl">Fake</span></button>'+
    '</div>'+
    '<div class="ob-hint" id="obHint">Swipe right for Real, left for Fake — or tap.</div>'+
    '<button class="ob-skip" id="obSkip">Skip — just let me play</button>');
  function reveal(){
    var row=$("obRow"), hint=$("obHint"), sk=$("obSkip");
    if(!row) return;   // already revealed
    row.outerHTML='<div class="ob-reveal"><b>That’s the idea.</b> Some quotes are real, some I made up — your job is to catch my fakes. '+
      '(That one was real: Neil Armstrong really said it.)</div>'+
      '<button class="ob-go" id="obGo">Let’s play →</button>';
    if(hint && hint.parentNode) hint.parentNode.removeChild(hint);
    if(sk && sk.parentNode) sk.parentNode.removeChild(sk);
    var go=$("obGo"); if(go){ go.onclick=done; try{ go.focus({preventScroll:true}); }catch(e){} }
    haptic(12);
  }
  var r=$("obReal"); if(r) r.onclick=reveal;
  var f=$("obFake"); if(f) f.onclick=reveal;
  var sk0=$("obSkip"); if(sk0) sk0.onclick=done;
  // swipe the example card (mirrors Play: right=Real, left=Fake; live tint), reveal on a decisive swipe
  var card=$("obCard"), tR=$("obTintReal"), tF=$("obTintFake");
  if(card){ var ds=null, dx=0, dy=0;
    card.onpointerdown=function(e){ ds={x:e.clientX,y:e.clientY}; try{ card.setPointerCapture(e.pointerId); }catch(_){} card.style.transition="none"; };
    card.onpointermove=function(e){ if(!ds)return; dx=e.clientX-ds.x; dy=e.clientY-ds.y;
      card.style.transform="translate("+dx+"px,"+dy+"px) rotate("+(dx*0.035)+"deg)";
      if(tR)tR.style.opacity=clamp01(dx/120)*0.16; if(tF)tF.style.opacity=clamp01(-dx/120)*0.16; };
    card.onpointerup=card.onpointercancel=function(){ if(!ds)return; var ax=Math.abs(dx), decided=ax>80;
      card.style.transition="transform .3s cubic-bezier(.34,1.56,.64,1)"; card.style.transform=""; if(tR)tR.style.opacity=0; if(tF)tF.style.opacity=0;
      ds=null; dx=0; dy=0; if(decided) reveal(); }; }
  var bd=$("sheetBackdrop"); if(bd) bd.onclick=function(e){ if(e.target===bd) done(); };   // backdrop tap also proceeds (was: strand)
}

/* ---------- crew switcher bottom sheet ---------- */
function openCrewSwitcher(){
  if(!inCrew()){ openCrew(); return; }
  var rows=(ST.crews||[]).map(function(c){ var active=c.code===(curCrew()||{}).code;
    return '<button class="sw-row'+(active?' active':'')+'" data-code="'+esc(c.code)+'">'+
      '<div><div class="nm">'+esc(crewLabel(c))+'</div><div class="sub">tap to view standings</div></div>'+
      '<div style="display:flex;align-items:center;gap:12px"><span class="code">'+esc(c.code)+'</span>'+(active?'<span class="chk">'+CHECK_SVG+'</span>':'')+'</div></button>'; }).join("");
  var sh=openSheet('<div class="sheet-title">Your crews</div>'+rows+
    '<button class="sw-add" id="swAdd">+ Create or join a crew</button>'+
    '<button class="sheet-close" id="swClose">Close</button>');
  sh.querySelectorAll(".sw-row").forEach(function(b){ b.onclick=function(){ setActiveCrew(b.getAttribute("data-code")); closeSheet(); JUST_JOINED=null; openCrew(); }; });
  $("swAdd").onclick=function(){ closeSheet(); joinAnotherCrew(); };
  $("swClose").onclick=closeSheet;
}

/* ---------- PLAY (bright redesign — one card at a time, swipe + tap + lock) ---------- */
function curQ(){ return DAY.quotes[PLAY_IDX]; }
function answeredCount(){ return DAY.quotes.filter(function(q){return ANS[q.id];}).length; }
function firstUnanswered(){ for(var i=0;i<DAY.quotes.length;i++){ if(!ANS[DAY.quotes[i].id]) return i; } return 0; }
// clamp01 imported from engine.js
function playNext(){ if(PLAY_IDX<DAY.quotes.length-1){ PLAY_IDX++; paintPlay(); window.scrollTo(0,0); } }
function playPrev(){ if(PLAY_IDX>0){ PLAY_IDX--; paintPlay(); window.scrollTo(0,0); } }   // mirrors playNext; disabled at the ends
function playJump(i){ PLAY_IDX=i; paintPlay(); window.scrollTo(0,0); }
var LOCK_ICON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
var X_ICON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="3.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
var RF_CHECK='<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>';

function renderPlay(){ paintPlay(); show("play"); }
function paintPlay(){
  var host=$("screen-play"), q=curQ(), lane=DAY._lane||"general", hue=laneHue(lane), n=DAY.quotes.length;
  host.innerHTML =
    '<h1 class="sr-only" data-heading tabindex="-1">Play — '+esc(laneName(lane))+', quote '+(PLAY_IDX+1)+' of '+n+'</h1>'+
    '<div class="play-head">'+
      '<button class="back-btn" id="playBack" aria-label="Quit"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
      '<div class="pbar" id="playProgress"></div>'+
      '<div class="pstep" id="playStep">'+(PLAY_IDX+1)+'/'+n+'</div>'+
    '</div>'+
    '<div class="play-cat">'+   // category always visible in the top bar (J) + small brand Mags (A)
      '<span class="qchip" style="color:'+hue+';border-color:'+hue+'"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="'+hue+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+laneIcon(lane)+'</svg>'+esc(laneName(lane))+'</span>'+
      '<button class="hdr-mags" id="playMags" aria-label="Meet Mags">'+magpie("happy",24,"mags-flip")+'</button></div>'+
    '<div class="qcard" id="playCard">'+
      '<div class="qtint real" id="tintReal"></div><div class="qtint fake" id="tintFake"></div>'+
      '<div class="qcard-top"><span class="qdate">'+esc(prettyDate(DAY.date))+'</span></div>'+
      '<div class="qtext">“'+esc(q.text)+'”</div>'+
      '<div class="qspk"><span class="qav" style="color:'+hue+';border-color:'+hue+'">'+esc(avInitial(q.speaker))+'</span>'+
        '<div><div class="nm">'+esc(q.speaker)+'</div>'+(q.context?('<div class="rl">'+esc(trunc(q.context,42))+'</div>'):'')+'</div></div>'+
    '</div>'+
    '<div class="play-nav">'+
      '<button class="pnav prev" id="playPrevBtn" aria-label="Previous quote">'+CHEV_LEFT+'</button>'+
      '<span class="swipe-hint">Swipe the card — or tap below</span>'+
      '<button class="pnav next" id="playNextBtn" aria-label="Next quote">'+CHEV_RIGHT+'</button>'+
    '</div>'+
    '<div class="rf-row">'+
      '<button class="rfbtn real" id="btnReal" data-v="real"><span class="ic" id="popReal">'+RF_CHECK+'</span><span class="lbl">Real</span></button>'+
      '<button class="rfbtn fake" id="btnFake" data-v="fake"><span class="ic" id="popFake">'+X_ICON+'</span><span class="lbl">Fake</span></button>'+
    '</div>'+
    '<button class="lockbtn2" id="btnLock"><span class="ic">'+LOCK_ICON+'</span><span class="lbl" id="lockLbl">Lock it in</span></button>'+
    '<div class="lock-sub">Lock your one most-confident call to bet it all.</div>'+
    '<div class="cta-wrap"><button class="cta-btn" id="playCTA"></button></div>';

  var card=$("playCard"), tintR=$("tintReal"), tintF=$("tintFake");
  var btnR=$("btnReal"), btnF=$("btnFake"), iconR=$("popReal"), iconF=$("popFake");
  var lockBtn=$("btnLock"), cta=$("playCTA"), prog=$("playProgress");
  var BASE_SHADOW='0 14px 34px -20px rgba(40,50,90,.5)';

  function refreshProgress(){
    var html="";
    DAY.quotes.forEach(function(qq,i){
      var cls="pseg"; if(LOCK===qq.id)cls+=" lck"; else if(i===PLAY_IDX)cls+=" cur"; else if(ANS[qq.id])cls+=" ans";
      var st=(LOCK===qq.id?", locked":(ANS[qq.id]?", answered":(i===PLAY_IDX?", current":"")));
      html+='<button class="'+cls+'" data-i="'+i+'" aria-label="Quote '+(i+1)+' of '+DAY.quotes.length+st+'"'+(i===PLAY_IDX?' aria-current="true"':'')+'><span class="bar"></span>'+
        (LOCK===qq.id?'<span class="lockico">'+LOCK_ICON.replace(/width="16" height="16"/,'width="12" height="12"')+'</span>':'')+'</button>';
    });
    prog.innerHTML=html;
    prog.querySelectorAll(".pseg").forEach(function(b){ b.onclick=function(){ playJump(+b.getAttribute("data-i")); }; });
  }
  function refreshRF(){ var a=ANS[q.id];
    btnR.className="rfbtn real"+(a==="real"?" sel":"");
    btnF.className="rfbtn fake"+(a==="fake"?" sel":""); }
  function refreshLock(){ var isLocked=LOCK===q.id, ready=(answeredCount()===DAY.quotes.length && LOCK===null);
    lockBtn.className="lockbtn2"+(isLocked?" on":(ready?" ready":""));
    $("lockLbl").textContent=isLocked?"Locked in":"Lock it in"; }
  function refreshCTA(){
    var curAns=ANS[q.id], ac=answeredCount(), all=ac===DAY.quotes.length, last=PLAY_IDX>=DAY.quotes.length-1;
    cta.className="cta-btn"; cta.onclick=null;
    if(!curAns){ cta.textContent="Real or fake?"; cta.classList.add("disabled"); }
    else if(!last){ cta.textContent="Next quote →"; cta.classList.add("next"); cta.onclick=playNext; }
    else if(!all){ cta.textContent="Answer all six ("+ac+"/"+DAY.quotes.length+")"; cta.classList.add("next"); cta.onclick=function(){ playJump(firstUnanswered()); }; }
    else if(LOCK===null){ cta.textContent="Lock your top pick first"; cta.classList.add("lockfirst"); }
    else { cta.textContent="See the results"; cta.onclick=submit; }
  }
  function popIcon(v){ var ic=(v==="real")?iconR:iconF; if(!ic)return; ic.classList.remove("pop"); void ic.offsetWidth; ic.classList.add("pop"); setTimeout(function(){ if(ic)ic.classList.remove("pop"); },340); }
  function pulseLock(){ lockBtn.classList.remove("pulse"); void lockBtn.offsetWidth; lockBtn.classList.add("pulse"); setTimeout(function(){ if(lockBtn)lockBtn.classList.remove("pulse"); },440); }
  function setAns(v){ ANS[q.id]=v; refreshRF(); refreshProgress(); refreshCTA(); }
  function tapAnswer(v){ setAns(v); popIcon(v); }
  function swipeAnswer(v){ var wasEmpty=!ANS[q.id], last=PLAY_IDX>=DAY.quotes.length-1; setAns(v); popIcon(v); if(wasEmpty && !last){ setTimeout(playNext,230); } }
  function toggleLock(){ if(LOCK===q.id){ LOCK=null; } else { LOCK=q.id; } refreshLock(); refreshProgress(); refreshCTA(); if(LOCK===q.id){ pulseLock(); haptic(14); } }

  $("playBack").onclick=goHome;
  var pm=$("playMags"); if(pm) pm.onclick=openMagpie;
  btnR.onclick=function(){ tapAnswer("real"); };
  btnF.onclick=function(){ tapAnswer("fake"); };
  lockBtn.onclick=toggleLock;
  // explicit in-set nav (swipe stays the primary input); disabled at the ends
  var pv=$("playPrevBtn"), nx=$("playNextBtn");
  if(pv){ pv.disabled=(PLAY_IDX===0); pv.onclick=playPrev; }
  if(nx){ nx.disabled=(PLAY_IDX>=DAY.quotes.length-1); nx.onclick=playNext; }

  // swipe: right=Real, left=Fake, up=Lock (80px threshold; live tint + glow; auto-advance on a fresh swipe)
  var ds=null, dx=0, dy=0;
  card.onpointerdown=function(e){ ds={x:e.clientX,y:e.clientY}; try{ card.setPointerCapture(e.pointerId); }catch(_){} card.style.transition="none"; };
  card.onpointermove=function(e){ if(!ds)return; dx=e.clientX-ds.x; dy=e.clientY-ds.y;
    card.style.transform="translate("+dx+"px,"+dy+"px) rotate("+(dx*0.035)+"deg)";
    tintR.style.opacity=clamp01(dx/120)*0.16; tintF.style.opacity=clamp01(-dx/120)*0.16;
    var sh=BASE_SHADOW;
    if(dx>40) sh="0 0 0 2px var(--mint),0 16px 30px -16px var(--mint)";
    else if(dx<-40) sh="0 0 0 2px var(--fake),0 16px 30px -16px var(--fake)";
    else if(dy<-40) sh="0 0 0 2px var(--amber),0 16px 30px -16px var(--amber)";
    card.style.boxShadow=sh; };
  card.onpointerup=card.onpointercancel=function(e){ if(!ds)return; var ax=Math.abs(dx), ay=Math.abs(dy), TH=80;
    card.style.transition="transform .3s cubic-bezier(.34,1.56,.64,1)"; card.style.transform=""; tintR.style.opacity=0; tintF.style.opacity=0; card.style.boxShadow=BASE_SHADOW;
    var act=null; if(dy<-TH && ay>ax) act="lock"; else if(dx>TH) act="real"; else if(dx<-TH) act="fake";
    ds=null; dx=0; dy=0;
    if(act==="lock") toggleLock(); else if(act) swipeAnswer(act); };

  refreshProgress(); refreshRF(); refreshLock(); refreshCTA();
}

/* ---------- SUBMIT / SCORING ---------- */
// clean-sweep reward: when TODAY's last available lane is completed, award a capped streak-freeze AND mint one earned
// repair token (Batch 6), and tally the sweep. Once per day (ST.swept guard). Does NOT change the core streak rules
// (engine.js) — only the safety-net counts (freeze = auto weekly shield; repair token = manual earned rescue).
function checkCleanSweep(date, realToday){
  if(date!==realToday) return false;               // only today's FRESH editions count toward today's sweep
  var avail=lanesToday(); if(!avail.length) return false;
  if(lanesDoneCount(ST.days, avail, realToday) < avail.length) return false;   // not every lane is in yet
  ST.swept=ST.swept||{};
  if(ST.swept[realToday]) return false;            // already rewarded today → no double award
  ST.swept[realToday]=true;
  ST.sweeps=(ST.sweeps||0)+1;
  ST.best_sweeps=Math.max(ST.best_sweeps||0, ST.sweeps);
  ST.freezes_left=Math.min(2, (ST.freezes_left||0)+1);     // +1 streak-freeze, capped at 2 (additive)
  ST.repair_tokens=Math.min(2, (ST.repair_tokens||0)+1);   // +1 earned repair token, capped at 2 (Batch 6 — manual rescue)
  return true;
}
function submit(){
  var quotes=DAY.quotes, date=DAY.date, realToday=todayStr();
  // pure scoring (engine.js): correct count, per-quote grid, the fakes believed (gotme), lock outcome
  var sc=scoreSet(quotes, ANS, LOCK);
  var n=sc.n, correct=sc.correct, lockCorrect=sc.lockCorrect, gotme=sc.gotme, grid=sc.grid, perq=sc.perq;
  var lane=(DAY&&DAY._lane)||"general";
  var lockIdx=(function(){for(var i=0;i<quotes.length;i++)if(quotes[i].id===LOCK)return i+1;return null;})();
  if(REPLAY){   // "play again" of an already-done lane: show the fresh result but NEVER touch equity (streak/stats/record)
    REPLAY=false;
    renderReveal({date:date, edition:DAY.edition, lane:lane, score:correct, n:n, grid:grid, perq:perq, gotme:gotme,
      lockCorrect:lockCorrect, lockIdx:lockIdx, streak:ST.streak, rating:ST.rating, frozen:false}, false);
    return;
  }

  // equity: STREAK tracks consecutive real CALENDAR days you showed up (any edition counts),
  // so replaying old editions can never corrupt or inflate it. Rating/accuracy count for any set.
  var fw=rollFreezeWeek(ST.freeze_week, realToday); if(fw){ ST.freeze_week=fw.freeze_week; ST.freezes_left=fw.freezes_left; }
  var prevReal=ST.last_realday||ST.last_played||null;   // migrate the legacy field
  var roll=rollStreak({prevReal:prevReal, today:realToday, streak:ST.streak, freezesLeft:ST.freezes_left});
  var streakBumped=roll.advanced;                       // this play advanced today's streak → animate the bump
  ST.streak=roll.streak; ST.freezes_left=roll.freezesLeft;
  if(roll.advanced){ ST.last_realday=realToday; ST.last_played=realToday; }
  if(roll.frozen) ST._frozen=true;
  ST.best_streak=Math.max(ST.best_streak||0,ST.streak);

  // rating: transparent — ±score around the 3/6 baseline, the lock swings double.
  ST.rating = Math.max(100, Math.round(ST.rating + ratingDelta(correct, lockCorrect)));
  ST.judged += n; ST.correct += correct;
  if(LOCK){ST.locks+=1; if(lockCorrect)ST.locks_correct+=1;}

  var result={date:date, edition:DAY.edition, lane:lane, score:correct, n:n, grid:grid, perq:perq,
    gotme:gotme, lockCorrect:lockCorrect, lockIdx:lockIdx,
    streak:ST.streak, rating:ST.rating, frozen:!!ST._frozen};
  ST.days[dayKey(lane,date)]={done:true,result:result};
  delete ST._frozen;
  var swept=checkCleanSweep(date, realToday);   // last lane of today done → award the clean-sweep freeze (once/day)
  save(ST);
  logEvent("complete",{score:correct,n:n,streak:ST.streak,rating:ST.rating,lock:lockCorrect,gotme:gotme,
    archive:(date!==realToday),returning:(ST.judged>n),crew:((curCrew()||{}).code||""),
    crews:(ST.crews||[]).map(function(c){return c.code;}).join(","),   // self-heals membership for EVERY crew you're in
    name:ST.displayName||"",cat:lane});
  saveProfile();   // H-A: push the updated streak/stats up to the account (no-op when signed out)
  if(sbWriteOn()) sbRecordCompletion(SB, { sid:ST.sid, day:date, lane:lane, score:correct, n:n, gotme:gotme,   // Phase 3: dual-write the score row
    name:ST.displayName||"", crews:(ST.crews||[]).map(function(c){return c.code;}) });
  renderReveal(result,true,streakBumped,swept);
}

/* ---------- likes (#6 — capture-only reactions on reveal truth cards) ----------
   LOCAL ST.likes = [{day, lane, qid, reason, real, ts}] is the SOURCE OF TRUTH and works fully offline (additive
   migration: ST.likes is created on first like). Supabase quote_likes is a best-effort, INSERT-only MIRROR. NOT wired
   into quote generation yet — this only captures the signal. Natural key (day,lane,qid) — one like per quote. */
function findLikeIdx(day,lane,qid){ var ls=ST.likes||[]; for(var i=0;i<ls.length;i++){ var l=ls[i]; if(l.day===day && l.lane===lane && String(l.qid)===String(qid)) return i; } return -1; }
function isLiked(day,lane,qid){ return findLikeIdx(day,lane,qid)>=0; }
function recordLikeLocal(day,lane,qid,real){   // turn a like ON (reason filled in later via the chooser). Local-only; the mirror fires once we know the reason.
  ST.likes=ST.likes||[];
  var row={day:day,lane:lane,qid:String(qid),reason:"",real:!!real,ts:Date.now()};
  var i=findLikeIdx(day,lane,qid); if(i>=0) ST.likes[i]=row; else ST.likes.push(row);
  save(ST); logEvent("quote_like",{lane:lane,real:!!real});
}
function setLikeReason(day,lane,qid,reason){ var i=findLikeIdx(day,lane,qid); if(i<0) return; ST.likes[i].reason=reason||""; save(ST); }
function removeLike(day,lane,qid){   // un-like: LOCAL is the source of truth. The mirror is INSERT-only (no anon delete), so it keeps any sent row — harmless.
  var i=findLikeIdx(day,lane,qid); if(i<0) return; ST.likes.splice(i,1); save(ST); logEvent("quote_unlike",{lane:lane});
}
// a brief pop on the heart at like-time — guarded by reduced-motion (OS pref OR in-app override), like every other animation here
function heartPop(el){ if(!el || reduceMotionOn()) return; el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); setTimeout(function(){ if(el) el.classList.remove("pop"); }, 420); }
// reason chooser: every dismissal path (pick / skip / backdrop) funnels through finish() → updates the local reason
// AND mirrors the like exactly ONCE (so the INSERT-only mirror lands a single row carrying the final reason).
function openLikeReason(day,lane,qid,real){
  var REASONS=[["funny","😄 Funny"],["surprising","😮 Surprising"],["insightful","💡 Insightful"],["other","✶ Other"]];
  var done=false;
  function finish(reason){ if(done) return; done=true;
    setLikeReason(day,lane,qid,reason);
    if(sbWriteOn()) sbRecordLike(SB,{ sid:ST.sid, day:day, lane:lane, qid:String(qid), reason:reason||"", real:!!real });
    liveAlert("Liked"+(reason?(" — "+reason):"")+".");
    closeSheet();
  }
  var btns=REASONS.map(function(r){ return '<button class="like-reason" data-r="'+esc(r[0])+'">'+esc(r[1])+'</button>'; }).join("");
  var sh=openSheet('<div class="sheet-title">What did you like about it?</div>'+
    '<div class="like-reasons" role="group" aria-label="Pick a reason">'+btns+'</div>'+
    '<button class="sheet-close" id="likeSkip">Skip</button>');
  sh.querySelectorAll(".like-reason").forEach(function(b){ b.onclick=function(){ b.classList.add("sel"); finish(b.getAttribute("data-r")); }; });
  var sk=$("likeSkip"); if(sk) sk.onclick=function(){ finish(""); };
  var bd=$("sheetBackdrop"); if(bd) bd.onclick=function(e){ if(e.target===bd) finish(""); };   // backdrop dismiss = liked, no reason (still captured)
}

/* ---------- solo competitive loop (#11) ----------
   Two purely-local signals (work offline) + one async global. "Daily score" = SUM of the day's lane scores. */
function dayScoreTotal(date){ var t=0, any=false; availableLanes().forEach(function(lane){ var r=ST.days[dayKey(lane,date)]; if(r && r.done && r.result){ t+=r.result.score||0; any=true; } }); return any?t:null; }
function soloDeltaText(delta){ if(delta>0) return "📈 +"+delta+" vs yesterday"; if(delta<0) return "📉 "+delta+" vs yesterday"; return "➖ even with yesterday"; }
// Render the solo standing into `el` for `day`: local "vs yesterday" first (instant, offline), then async "you beat X%".
// Hides gracefully (stays empty) when there's nothing to show — no yesterday to compare AND no/!offline global.
function renderSolo(el, day){
  if(!el) return;
  el.innerHTML=""; el.hidden=true;
  if(lanesDoneCount(ST.days, lanesForDay(MANIFEST,day), day)<=0) return;   // only once you've played that day
  var s=dayScoreTotal(day), p=dayScoreTotal(addDaysStr(day,-1)), delta=(s!=null && p!=null)?(s-p):null;
  if(delta!=null){ el.innerHTML='<span class="solo-delta">'+soloDeltaText(delta)+'</span>'; el.hidden=false; }
  if(!useSbCrew()) return;   // global standing needs the Supabase board backend; offline/endpoint → local only
  sbFetchGlobal(SB, day, ST.sid).then(function(g){
    if(!el || !el.isConnected) return;
    if(!g || !g.viewer_completed || g.beat_pct==null) return;   // null / offline / only-player-so-far → stay local-only
    el.insertAdjacentHTML("beforeend", '<span class="solo-beat">🏆 You beat <b>'+g.beat_pct+'%</b> of players today</span>');
    el.hidden=false;
  });
}

/* ---------- REVEAL (bright redesign) ---------- */
function trunc(t,nn){ t=String(t); return t.length>nn ? t.slice(0,nn).replace(/[\s,.;:]+$/,"")+"…" : t; }
// spoiler-free share text: score, streak, 🟩/⬜ grid (right/miss — never which were fake), a tap-to-play link
function shareGrid(res){
  var grid=res.perq.map(function(p){ return p.right?"🟩":"⬜"; }).join("");
  var link=(res.date===todayStr())?baseURL():editionLink(res.date);
  return "Said It? — "+res.score+"/"+res.n+"\n🔥 "+res.streak+"-day streak\n"+grid+"\n"+link;
}
// optional "quote of the day": an editorial flag in the day JSON (a quote id), else the first REAL quote. Reals only.
function quoteOfDayId(){
  if(!DAY) return null;
  if(DAY.quote_of_day){ var q=(DAY.quotes||[]).filter(function(x){return x.id===DAY.quote_of_day && x.real;})[0]; if(q) return q.id; }
  var fr=(DAY.quotes||[]).filter(function(x){return x.real;})[0]; return fr?fr.id:null;
}
// PER-QUOTE viral share (#12): challenge the group chat with ONE quote, reusing the navigator.share → clip path.
// REAL quotes ONLY — we never expose a fake, and the text never states the answer, so it stays a fair, spoiler-safe dare.
function shareOneQuote(i, btn){
  var q=DAY&&DAY.quotes[i]; if(!q || !q.real) return;   // guard: reals only — never leak which were fake
  var link=(DAY.date===todayStr())?baseURL():editionLink(DAY.date);
  var txt="Did "+q.speaker+" really say this?\n“"+q.text+"”\n— real or fake? "+link;
  function ok(){ if(btn){ btn.textContent="Shared ✓"; btn.className="tr-share shared"; } logEvent("quote_share",{cat:(DAY&&DAY._lane)||"general", kind:"one"}); }
  if(navigator.share){ navigator.share({text:txt}).then(ok,function(err){ if(err&&err.name==="AbortError")return; clip(txt,ok); }); return; }
  clip(txt,ok);
}
function fireConfetti(){
  var host=el("div","rv-confetti"); var cols=["var(--primary)","#16B981","#FBA94C","#FF8FAB","#9775FA","#4DABF7"], html="";
  for(var i=0;i<42;i++){ var left=Math.round(Math.random()*100), bg=cols[i%cols.length], w=7+(i%3)*2, h=9+(i%4)*2, rad=(i%2)?2:7,
      dur=(1.8+(i%5)*0.28).toFixed(2), delay=((i%9)*0.12).toFixed(2);
    html+='<i style="left:'+left+'%;width:'+w+'px;height:'+h+'px;background:'+bg+';border-radius:'+rad+'px;animation-duration:'+dur+'s;animation-delay:'+delay+'s"></i>'; }
  host.innerHTML=html; document.body.appendChild(host);
  setTimeout(function(){ if(host.parentNode) host.parentNode.removeChild(host); },4600);
}
// "Bait the group chat": send the fake that got you (or the set's sneakiest fake) as a SPOILER-FREE challenge
function baitGroupChat(res, btn){
  var idx = (res.gotme && res.gotme.length) ? (res.gotme[0]-1) : DAY.quotes.findIndex(function(q){return q.id===DAY.trickiest_fake;});
  if(idx<0) idx = DAY.quotes.findIndex(function(q){return !q.real;});
  if(idx<0) idx = 0;
  var q=DAY.quotes[idx], cc=curCrew();
  var lines=["Said It?"+(cc?(" — "+crewLabel(cc)):""), "“"+q.text+"”", "— "+q.speaker+(q.context?(" · "+q.context):""),
    "Real or fake? Can you spot it?", baseURL()];
  var txt=lines.join("\n");
  function ok(){ if(btn){ btn.textContent=cc?("Sent to "+crewLabel(cc)+" ✓"):"Sent ✓"; btn.className="sent"; } logEvent("quote_share",{cat:(DAY&&DAY._lane)||"general", kind:"bait"}); }
  if(navigator.share){ navigator.share({text:txt}).then(ok,function(err){ if(err&&err.name==="AbortError")return; clip(txt,ok); }); return; }
  clip(txt,ok);
}
function capFor(s,n){
  var miss=n-s;
  if(miss===0) return "Nothing fooled you today.";
  if(miss===1) return "So close — one slipped past you.";
  if(miss===2) return "Two slipped past you.";
  return "I had a good day — get it back tomorrow.";
}
// reveal = hub: one-tap chips for the lanes you haven't played TODAY, or the clean-sweep block once none remain.
function revealTodayHubHtml(res, swept){
  if(!DAY || DAY.date!==todayStr()) return "";   // only for today's editions (past editions keep their back-to-today link)
  var today=todayStr(), avail=lanesToday(); if(!avail.length) return "";
  var remaining=avail.filter(function(l){ return !laneDoneOn(ST.days, l, today); });
  if(!remaining.length){
    var fz=(ST.freeze_week===weekKey(today))?(ST.freezes_left||0):1;
    return '<div class="rv-today swept"><div class="rt-head"><span class="rt-title">'+(swept?"Clean sweep!":"All done today")+'</span></div>'+
      '<div class="rt-sub">'+(swept
        ? ("You cleared all "+avail.length+" lane"+(avail.length===1?"":"s")+" today — 🛡️ streak-freeze earned ("+fz+" now). New sets land tomorrow.")
        : "You’ve played every lane today. New sets land tomorrow.")+'</div></div>';
  }
  var chips=remaining.map(function(l){ return '<button class="rt-chip" data-lane="'+esc(l)+'">'+
    '<span class="rt-dot" style="background:'+laneHue(l)+'"></span>'+esc(laneName(l))+'</button>'; }).join("");
  return '<div class="rv-today"><div class="rt-head"><span class="rt-title">Today</span>'+
    '<span class="rt-left">'+remaining.length+' left today</span></div><div class="rt-chips">'+chips+'</div></div>';
}
// DONE-LANE REVIEW: render the read-only reveal for an already-completed lane. Mirrors the archive replay path —
// fetch the day for the quote text, pair it with the stored result (answers/verdicts). "Play again" (in renderReveal)
// lets you replay it without touching your streak.
function openReview(lane, date){
  date=date||todayStr();
  var rec=ST.days[dayKey(lane,date)];
  if(!rec || !rec.done){ startLane(lane); return; }   // not actually done → just play it
  BACK_TO="home"; REPLAY=false;
  show("loading");
  fetchDay(date, lane).then(function(day){
    DAY=day; DAY._lane=lane; ANS={}; LOCK=null; PLAY_IDX=0;
    updatePastBar(date===todayStr(), day);
    renderReveal(rec.result, false);
  }).catch(function(e){
    show("error");
    $("screen-error").innerHTML="Couldn't load that set.<br><span style='color:var(--mut);font-size:13px'>"+esc(e.message||e)+"</span>";
  });
}
function renderReveal(res, fresh, bumped, swept){
  var isToday = DAY.date===todayStr(), clean=(res.score===res.n);
  var mood = (clean||swept) ? "delighted" : "oops";
  var rvLane = res.lane||"general";   // lane of THIS reveal — the like's natural key (with res.date + quote id)

  // fake-that-got-you / clean-sweep card
  var topCard="";
  if(res.gotme && res.gotme.length){
    var fq=DAY.quotes[res.gotme[0]-1];
    topCard='<div class="rv-gotme"><div class="k">The fake that got you</div>'+
      '<div class="q">“'+esc(fq.text)+'”</div>'+
      '<div class="m">'+esc(fq.speaker)+' — I made this one up. You called it real.</div></div>';
  } else {
    // one magpie per screen (G): the rv-head reaction bird is it — clean card uses a check, no second bird
    topCard='<div class="rv-clean"><span class="rv-clean-ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1C6B4F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg></span><span>A clean sweep — you didn’t let me fool you once.</span></div>';
  }

  // truth rows — F: truth = mint/coral stamp (left); your result = worded blue/amber verdict chip (right). Uniform citation footprint.
  var qotdId=quoteOfDayId();   // the one real quote to spotlight for sharing (editorial flag, else first real)
  var rowsHtml=DAY.quotes.map(function(q,i){
    var pq=res.perq[i], real=q.real, right=pq.right, guess=pq.guess, skipped=!guess;
    var cite = real
      ? (q.source ? ('<a class="tr-cite" href="'+esc(q.source.url)+'" target="_blank" rel="noopener">Source ›</a>') : '<span class="tr-cite muted">On the record</span>')
      : ('<div class="tr-cite fake"><b>I made this one up.</b>'+(q.fake_note?(' '+esc(q.fake_note)):'')+'</div>');
    var verdict = skipped
      ? '<span class="vchip skip">– Skipped</span>'
      : (right ? '<span class="vchip right">'+CHECK_SVG+' Nailed it</span>'
               : '<span class="vchip wrong">'+X_ICON+' Got me</span>');
    // PER-QUOTE share (#12) — REAL quotes only: a "challenge a friend" CTA. Never rendered on a fake, so nothing
    // that gets shared can leak which were fake. The day's spotlight quote gets the prominent ⭐ variant.
    var isQotd=(real && q.id===qotdId);
    var share = real ? ('<button class="tr-share'+(isQotd?' qotd':'')+'" data-i="'+i+'">'+(isQotd?'⭐ Quote of the day — challenge a friend':'Share this one')+'</button>') : '';
    // double-tap-to-like (#6) — visible heart toggle too, for accessibility. Captured on REAL and FAKE alike.
    var liked=isLiked(res.date,rvLane,q.id);
    var heart='<button class="tr-like'+(liked?' liked':'')+'" data-i="'+i+'" aria-pressed="'+(liked?'true':'false')+'" aria-label="'+(liked?'Liked — tap to remove':'Like this quote')+'">'+HEART_SVG+'</button>';
    return '<div class="tr"><div class="tr-row">'+
      '<div class="tr-stamp"><span class="stamp '+(real?"real":"fake")+'">'+(real?"REAL":"FAKE")+'</span></div>'+
      '<div class="tr-body"><div class="tr-q">“'+esc(trunc(q.text,72))+'”</div>'+
        '<div class="tr-meta">'+esc(q.speaker)+(q.context?(' · '+esc(trunc(q.context,30))):'')+'</div>'+cite+
        '<div class="tr-acts">'+share+heart+'</div></div>'+
      '<div class="tr-verdict">'+verdict+'</div>'+
    '</div></div>';
  }).join("");

  // share-card pips
  var pips=res.perq.map(function(p){ return '<div class="sc-pip'+(p.right?" right":"")+'">'+(p.right?CHECK_SVG:"")+'</div>'; }).join("");

  var host=$("screen-reveal");
  host.innerHTML =
    '<h1 class="sr-only" data-heading tabindex="-1">Results — '+res.score+' out of '+res.n+'</h1>'+
    '<div class="rv-head">'+magpie(mood,68)+'<div class="rv-score"><span class="n">'+res.score+'</span><span class="of">/ '+res.n+'</span></div></div>'+
    '<div class="rv-cap">'+esc(capFor(res.score,res.n))+(fresh?"":' <span class="replayed">· already played</span>')+'</div>'+
    '<div class="rv-streak"><span class="fire">🔥</span><span class="num" id="rvStreakNum">'+res.streak+'</span><span>day streak — keep it rolling</span></div>'+
    (res.frozen?'<div class="rv-freeze">🛡️ Streak-freeze used — your streak survived a missed day. One freeze per week.</div>':"")+
    '<div class="rv-solo" id="rvSolo" hidden></div>'+   // solo loop (#11): "vs yesterday" (local) + "you beat X%" (async, gated) — hidden until filled
    topCard+
    '<div class="rv-truth-label">The truth</div><div class="rv-truth" id="rvTruth">'+rowsHtml+'</div>'+
    // reveal = hub: jump straight into the lanes left to play today (or celebrate the clean sweep)
    revealTodayHubHtml(res, swept)+
    // share card (tap → PNG image share; spoiler-free text grid is the fallback)
    '<button class="share-card" id="rvShareCard" aria-label="Share your result as an image"><div class="sc-row"><div class="sc-brand"><span class="wm">Said It?</span></div>'+
      '<span class="sc-date">'+esc(prettyDate(res.date))+'</span></div>'+
      '<div class="sc-score"><span class="big">'+res.score+'/'+res.n+'</span><span class="st">🔥 '+res.streak+'-day streak</span></div>'+
      '<div class="sc-pips">'+pips+'</div>'+
      '<div class="sc-legend"><span class="lg"><span class="sw caught"></span> caught it</span>'+
        '<span class="lg"><span class="sw fooled"></span> fooled</span><span class="url">saidit.app</span></div></button>'+
    '<div class="play-sub" style="margin-top:9px"><span id="rvShareHint">📸 Tap the card to share an image</span></div>'+
    // actions
    '<div class="rv-actions"><button class="copy" id="copyBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span id="copyLbl">Copy result</span></button>'+
      '<button class="board" id="revealCrewBtn">Crew board →</button></div>'+
    '<div class="rv-preview"><div class="k">Copies to your group chat</div><div class="t" id="tokenBox"></div></div>'+
    // bait
    '<div class="rv-bait"><div class="h">Bait the group chat</div><div class="s">Send the fake that got you — no spoilers.</div>'+
      '<button id="baitBtn">'+(curCrew()?("Send to "+esc(crewLabel(curCrew()))):"Send to your group chat")+'</button></div>'+
    '<div class="rv-count" id="countdown"></div>'+
    // done-lane review (read-only reveal) → replay for fun; the replay flow never touches your streak/stats
    (!fresh ? '<button class="rv-replay" id="rvReplay">Play again <span class="rv-replay-sub">won’t affect your streak</span></button>' : '')+
    '<div class="rv-links"><button id="revealArchiveBtn">Past editions</button><span style="opacity:.5">·</span><button id="revealLinkBtn">Copy link to this set</button></div>'+
    '<div class="rv-foot">Mags makes up the fakes; real quotes link to their source. A quote shown as “made up” is part of the game — never a claim anyone said it.<br><a id="resetLink">reset my data</a></div>';

  $("tokenBox").textContent = shareGrid(res);
  $("copyBtn").onclick=copyToken;
  var shc=$("rvShareCard"); if(shc) shc.onclick=function(){ shareResultImage(res, $("rvShareHint")); };
  $("revealCrewBtn").onclick=openCrew;
  $("baitBtn").onclick=function(){ baitGroupChat(res, $("baitBtn")); };
  $("revealArchiveBtn").onclick=openArchive;
  $("revealLinkBtn").onclick=function(){ if(DAY) copyEditionLink(DAY.date); };
  $("resetLink").onclick=function(){ if(confirm("Erase your streak, rating and history on this device?")){ localStorage.removeItem(K); location.reload(); } };
  // reveal hub: one-tap into a remaining lane
  host.querySelectorAll(".rt-chip").forEach(function(b){ b.onclick=function(){ startLane(b.getAttribute("data-lane")); }; });
  // per-quote viral share (#12): "Share this one" on REAL truth cards
  host.querySelectorAll(".tr-share").forEach(function(b){ b.onclick=function(){ shareOneQuote(+b.getAttribute("data-i"), b); }; });
  // double-tap-to-like + heart toggle (#6). Capture-only — like is stored LOCAL (offline-first), then mirrored once a reason is set.
  function setHeart(el, on){ if(!el) return; el.classList.toggle("liked", on); el.setAttribute("aria-pressed", on?"true":"false"); el.setAttribute("aria-label", on?"Liked — tap to remove":"Like this quote"); }
  function likeOn(i, el){   // idempotent ON: record local + pop + open the reason chooser (which mirrors once)
    var q=DAY.quotes[i]; if(!q || isLiked(res.date,rvLane,q.id)) return;
    recordLikeLocal(res.date, rvLane, q.id, q.real); setHeart(el, true); heartPop(el);
    openLikeReason(res.date, rvLane, q.id, q.real);
  }
  function toggleLike(i, el){   // the explicit heart toggles both ways (accessibility)
    var q=DAY.quotes[i]; if(!q) return;
    if(isLiked(res.date,rvLane,q.id)){ removeLike(res.date, rvLane, q.id); setHeart(el, false); } else likeOn(i, el);
  }
  host.querySelectorAll(".tr-like").forEach(function(b){ b.onclick=function(e){ if(e&&e.stopPropagation)e.stopPropagation(); toggleLike(+b.getAttribute("data-i"), b); }; });
  host.querySelectorAll("#rvTruth .tr").forEach(function(row,i){   // double-tap the card → like (Instagram-style; never un-likes)
    var last=0;
    row.addEventListener("click", function(e){
      if(e.target.closest("a,button")) return;                    // taps on the heart/share/source handle themselves
      var t=Date.now(); if(t-last<320){ last=0; likeOn(i, row.querySelector(".tr-like")); } else last=t;
    });
  });
  // "play again" — re-enter play in REPLAY mode (submit() shows the result but mutates nothing)
  var rp=$("rvReplay"); if(rp) rp.onclick=function(){ REPLAY=true; ANS={}; LOCK=null; PLAY_IDX=0; renderPlay(); };

  // countdown: today → live timer; past edition → back-to-today link
  if(isToday){ tickCountdown(); }
  else { clearInterval(window._cd);
    $("countdown").innerHTML='<a class="rv-foot" id="backTodayLink" style="cursor:pointer">← back to today’s set</a>';
    var bl=$("backTodayLink"); if(bl) bl.onclick=backToToday; }

  show("reveal");
  // a11y: announce the result + streak through the assertive region (show() focuses the heading; this speaks the score)
  liveAlert("You scored "+res.score+" out of "+res.n+". "+capFor(res.score,res.n)+" Streak: "+res.streak+" day"+(res.streak===1?"":"s")+".");
  // solo competitive loop (#11): "vs yesterday" (local, instant) + "you beat X%" (async, gated). Hides if there's nothing to show.
  renderSolo($("rvSolo"), res.date);

  // sequential truth flip-in (200ms × index)
  var rows=host.querySelectorAll("#rvTruth .tr");
  rows.forEach(function(r,i){ setTimeout(function(){ if(r) r.classList.add("shown"); }, 200*i); });
  // Mags reacts to the verdict — a high score (5/6+) or clean sweep gets a cheer; getting fooled gets a cheeky tilt
  var revealBird=host.querySelector(".rv-head .mags");
  if(fresh && revealBird){
    var high=(clean||swept||res.score>=res.n-1);
    if(high) setTimeout(function(){ magsReact("cheer", revealBird); }, 450);
    else if(res.gotme && res.gotme.length) setTimeout(function(){ magsReact("tilt", revealBird); }, 360);
  }
  // streak bump (+1 with a bounce) only when this play advanced the daily streak — Mags hops along with it
  if(fresh && bumped && res.streak>0){
    var num=$("rvStreakNum"); if(num){ num.textContent=(res.streak-1);
      setTimeout(function(){ var n2=$("rvStreakNum"); if(!n2)return; n2.textContent=res.streak; n2.classList.add("bump"); haptic(18); magsReact("hop", revealBird); setTimeout(function(){ if(n2)n2.classList.remove("bump"); },650); }, 1650); }
  }
  // haptic + confetti for a perfect score (6/6) OR a clean sweep of every lane today (reduced-motion hides confetti via CSS)
  if(fresh){ haptic((clean||swept) ? [16,55,16] : 10); }
  if(fresh && (clean||swept)){ setTimeout(fireConfetti, 500); }
}
function baseURL(){ return location.origin+location.pathname.replace(/index\.html?$/,""); }
function editionLink(date){ return baseURL()+"?d="+date; }
function copyToken(){
  var txt=$("tokenBox").textContent;
  function ok(){ var l=$("copyLbl"); if(l){ l.textContent="Copied ✓"; setTimeout(function(){ var l2=$("copyLbl"); if(l2) l2.textContent="Copy result"; },1800); } else { toast("Copied — go paste it"); } logEvent("token_copy"); }
  if(navigator.clipboard && navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(ok,fallbackCopy);}
  else fallbackCopy();
  function fallbackCopy(){var ta=el("textarea");ta.value=txt;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");ok();}catch(e){toast("Select &amp; copy");}document.body.removeChild(ta);}
}
function tickCountdown(){
  var now=new Date(); var nxt=new Date(now); nxt.setHours(24,0,0,0);
  function upd(){var d=new Date(),left=nxt-d;if(left<0){$("countdown").innerHTML="New set is live — refresh.";return;}
    var h=Math.floor(left/3.6e6),m=Math.floor(left%3.6e6/6e4),s=Math.floor(left%6e4/1e3);
    $("countdown").innerHTML="Next set in <b>"+pad(h)+":"+pad(m)+":"+pad(s)+"</b>";}
  upd(); clearInterval(window._cd); window._cd=setInterval(upd,1000);
}

/* ---------- archive / past editions ---------- */
function updatePastBar(isToday, day){
  var pb=$("pastbar");
  if(isToday){ pb.classList.add("hide"); pb.innerHTML=""; return; }
  pb.classList.remove("hide");
  pb.innerHTML="<span>📅 Past edition · No."+(day.edition||"?")+" · "+prettyDate(day.date)+"</span><a id='pbBack'>today →</a>";
  var b=$("pbBack"); if(b) b.onclick=backToToday;
}
function backToToday(){ history.replaceState(null,"",location.pathname); loadAndRoute(todayStr()); }
function goToEdition(date){ history.replaceState(null,"","?d="+date); loadAndRoute(date); }
function openArchive(){ BACK_TO=currentScreen(); renderArchive(); show("archive"); }
function renderArchive(){
  var host=$("archiveList"); host.innerHTML="";
  var lane=ST.lane||"general";
  var days=laneDays(lane).slice().sort();                 // current lane's editions, ascending → index+1 = edition number
  if(!days.length){ host.innerHTML="<div class='card'>No editions published yet.</div>"; return; }
  var today=todayStr();
  days.slice().reverse().forEach(function(date){
    var ed=days.indexOf(date)+1;
    var done=(ST.days[dayKey(lane,date)]&&ST.days[dayKey(lane,date)].done)?ST.days[dayKey(lane,date)].result:null;
    var status=done ? ("✓ you scored "+done.score+"/"+done.n)
      : (date===today?"● today's set — not played yet":(date>today?"upcoming":"▶ not played yet"));
    var row=el("div","arc-row");
    row.innerHTML="<div class='meta'><div class='ed'>No. "+ed+" · "+prettyDate(date)+"</div><div class='st'>"+status+"</div></div>"+
      "<button data-link='"+date+"' title='copy a link to send'>🔗</button>"+
      "<button class='play' data-go='"+date+"'>"+(done?"view":"play")+"</button>";
    host.appendChild(row);
  });
  host.querySelectorAll("button[data-go]").forEach(function(b){ b.onclick=function(){ goToEdition(b.dataset.go); }; });
  host.querySelectorAll("button[data-link]").forEach(function(b){ b.onclick=function(){ copyEditionLink(b.dataset.link); }; });
}
function copyEditionLink(date){
  var url=editionLink(date);
  function ok(){ toast("Link copied — send it 📨"); logEvent("edition_link_copy",{ed:date}); }
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(ok,function(){window.prompt("Copy this link:",url);}); }
  else { window.prompt("Copy this link:",url); }
}

/* ---------- crew (G-B) ----------
   Guardrails: renewable equity ONLY (shared streak + standing). NO trait-polling (no "rate your friends"),
   NO live/synchronous tournaments (that's the tbh/Gas graph-fragile death) — async leaderboard + weekly
   season standing only. Consent-native (you opt in with a code). Spoiler-free is ENFORCED: the endpoint
   returns scores/standings only, never per-quote answers, so a crew-mate who hasn't played stays safe. */
function inCrew(){ return !!(ST.crews && ST.crews.length); }
function hasCrew(code){ return (ST.crews||[]).some(function(c){return c.code===code;}); }
function curCrew(){ var cs=ST.crews||[]; return cs.filter(function(c){return c.code===ST.activeCrew;})[0] || cs[0] || null; }
function setActiveCrew(code){ ST.activeCrew=code; save(ST); }
function addCrew(code){ if(!hasCrew(code)){ ST.crews.push({code:code, joined:todayStr()}); } ST.activeCrew=code; }
function genCode(){ var s="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",c=""; for(var i=0;i<5;i++)c+=s[Math.floor(Math.random()*s.length)]; return c; }
function askName(def){ var n=(window.prompt && window.prompt("Your name in the crew?", def||ST.displayName||"")) || ST.displayName || "you"; n=String(n).slice(0,16).trim()||"you"; ST.displayName=n; save(ST); return n; }
function crewLabel(c){ return c ? (c.name || c.code) : ""; }
function setLocalCrewName(code, nm){ var c=(ST.crews||[]).filter(function(x){return x.code===code;})[0]; if(c){ if(nm) c.name=nm; save(ST); } }
function createCrew(){ askName(); var code=genCode();
  var cn=((ST.displayName||"My")+"’s crew").slice(0,24);   // friendly default name (editable by anyone via ✏️)
  addCrew(code); setLocalCrewName(code,cn); save(ST);
  logEvent("crew_create",{crew:code, name:ST.displayName});
  logEvent("crew_name",{crew:code, name:cn});              // shared, editable crew name (separate from the join code)
  if(sbWriteOn()){ sbRecordCrewMember(SB, {crew:code, sid:ST.sid, name:ST.displayName||"", joined_day:todayStr()}); sbRecordCrewName(SB, code, cn); }
  toast("Crew created 🎉 — tap ✏️ to rename"); JUST_JOINED=null; renderCrew(); }
function renameCrew(code){ var c=(ST.crews||[]).filter(function(x){return x.code===code;})[0]; if(!c)return;
  var cn=(window.prompt && window.prompt("Rename crew — everyone in "+code+" sees this:", c.name||"")); if(cn===null)return;
  cn=String(cn).slice(0,24).trim(); if(!cn){ toast("Name can't be empty"); return; }   // endpoints can't store an empty name
  c.name=cn; save(ST); logEvent("crew_name",{crew:code, name:cn}); if(sbWriteOn()) sbRecordCrewName(SB, code, cn); toast("Renamed to "+cn); renderCrew(); }
function joinCrew(code, inviter){ code=String(code||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6); if(!code){toast("Enter a code");return false;}
  var already=hasCrew(code);
  if(!ST.displayName) askName();
  addCrew(code); save(ST);
  if(!already) logEvent("crew_join",{crew:code, name:ST.displayName, inviter:inviter||""});   // membership is server-derived from this
  if(!already && sbWriteOn()) sbRecordCrewMember(SB, {crew:code, sid:ST.sid, name:ST.displayName||"", joined_day:todayStr()});   // Phase 3 membership row
  if(inviter && inviter!==ST.sid) logEvent("invite_opened",{crew:code, inviter:inviter, invitee:ST.sid});  // <-- k-factor instrument
  toast("Joined "+code+" 👥"); return true; }
function leaveCrew(code){ code=code||(curCrew()||{}).code; if(!code) return;
  if(window.confirm && !window.confirm("Leave crew "+code+"?")) return;
  ST.crews=(ST.crews||[]).filter(function(c){return c.code!==code;});
  if(ST.activeCrew===code) ST.activeCrew=(ST.crews[0]||{}).code||null;
  save(ST); logEvent("crew_leave",{crew:code}); JUST_JOINED=null; renderCrew(); }
function crewEndpoint(){ return AGG_ENDPOINT||LOG_ENDPOINT; }
// Phase 3: prefer the Supabase backend when configured (CREW_BACKEND:"supabase"); else the Apps Script endpoint.
var CREW_BACKEND = CFG.CREW_BACKEND || "endpoint";
function useSbCrew(){ return CREW_BACKEND==="supabase" && !!SB; }                 // READ the board from Supabase
function sbWriteOn(){ return !!SB && (useSbCrew() || CFG.SB_DUAL_WRITE===true); } // WRITE crew/score rows to Supabase (opt-in so we never hit undeployed tables)
function crewBackend(){ return useSbCrew() || crewEndpoint(); }   // truthy when ANY crew backend is available
function liveCrew(){ return curCrew() && crewBackend(); }   // in a crew AND able to load a live board

/* ---------- H-A accounts: anonymous-first, sign in to SAVE + SYNC across devices (Supabase) ---------- */
// recomputeStats + mergeState live in store.js (pure; the cloud merge maxes streaks + unions history — never loses progress).
function profileBlob(){ return { streak:ST.streak, best_streak:ST.best_streak, rating:ST.rating, days:ST.days,
  crews:ST.crews, activeCrew:ST.activeCrew, displayName:ST.displayName, last_realday:ST.last_realday, crewSeasons:ST.crewSeasons }; }
function saveProfile(){ if(!SB||!ACCOUNT||!PROFILE_SYNCED) return;   // never write until we've safely READ the cloud row first (no clobber)
  try{ SB.from("profiles").upsert({ id:ACCOUNT.uid, sid:ST.sid, state:profileBlob(), updated_at:new Date().toISOString() }).then(function(){},function(){}); }catch(e){} }
function onSignedIn(user){ if(!user) return; ACCOUNT={uid:user.id, email:user.email||""}; logEvent("signed_in");
  try{ SB.from("profiles").select("sid,state").eq("id",user.id).maybeSingle().then(function(res){
    if(res && res.error){ logEvent("profile_read_failed"); return; }   // read FAILED → do NOT overwrite possibly-existing cloud state
    var row=res&&res.data;
    if(row){ if(row.sid) ST.sid=row.sid; if(row.state) mergeState(ST, row.state); save(ST); }   // existing account → adopt its play-id + merge
    PROFILE_SYNCED=true;   // read CONFIRMED (no error) — now it's safe to write
    saveProfile();         // capture this device's (merged) state
    if(currentScreen()==="crew") renderCrew(); else if(currentScreen()==="home") renderHome();
  }, function(){ logEvent("profile_read_failed"); }); }catch(e){} }   // a failed read must never trigger a cloud write
function initAuth(){ if(!SB) return;
  try{ SB.auth.getSession().then(function(res){ var s=res&&res.data&&res.data.session; if(s&&s.user && (!ACCOUNT||ACCOUNT.uid!==s.user.id)) onSignedIn(s.user); }); }catch(e){}
  try{ SB.auth.onAuthStateChange(function(ev,session){ if(session&&session.user){ if(!ACCOUNT||ACCOUNT.uid!==session.user.id) onSignedIn(session.user); } else if(ev==="SIGNED_OUT"){ ACCOUNT=null; PROFILE_SYNCED=false; } }); }catch(e){}
}
function signInEmail(email){ if(!SB) return; email=String(email||"").trim();
  if(!/.+@.+\..+/.test(email)){ toast("Enter a valid email"); return; }
  SB.auth.signInWithOtp({ email:email, options:{ emailRedirectTo: baseURL() } }).then(function(res){
    if(res&&res.error){ toast("Couldn't send the link — try again"); } else { toast("Check your email for a sign-in link 📧"); logEvent("signin_link_sent"); } }, function(){ toast("Sign-in unavailable right now"); }); }
function signInGoogle(){ if(!SB) return;
  SB.auth.signInWithOAuth({ provider:"google", options:{ redirectTo: baseURL() } }).then(function(res){ if(res&&res.error) toast("Google sign-in isn't set up yet"); }, function(){ toast("Google sign-in isn't set up yet"); }); }
function signOutAcct(){ if(!SB) return; SB.auth.signOut().then(function(){ ACCOUNT=null; toast("Signed out"); if(currentScreen()==="crew") renderCrew(); }); }
function accountHTML(){ if(!SB) return "";
  if(ACCOUNT) return "<div class='acct'><div class='h'>☁️ Synced across your devices</div>"+
    "<div class='s'>Signed in as "+esc(ACCOUNT.email||"your account")+" — streak, stats &amp; crews follow you everywhere.</div>"+
    "<button class='ghost' id='acctOut'>Sign out</button></div>";
  return "<div class='acct'><div class='h'>☁️ Save your progress</div>"+
    "<div class='s'>Sign in to keep your streak &amp; crews and play on your other devices. No password — we email you a link.</div>"+
    "<input class='fld' id='acctEmail' type='email' placeholder='you@email.com' autocomplete='email' autocapitalize='off'>"+
    "<button class='primary' id='acctEmailBtn'>Email me a sign-in link</button>"+
    (GOOGLE_AUTH?"<button class='ghost' id='acctGoogle'>Continue with Google</button>":"")+"</div>";
}
function wireAccount(){ var e=$("acctEmailBtn"); if(e) e.onclick=function(){ signInEmail($("acctEmail")&&$("acctEmail").value); };
  var g=$("acctGoogle"); if(g) g.onclick=signInGoogle; var o=$("acctOut"); if(o) o.onclick=signOutAcct; }
function clip(txt,ok){ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(ok,function(){window.prompt("Copy:",txt);if(ok)ok();}); } else { window.prompt("Copy:",txt); if(ok)ok(); } }
function crewNameFor(code){ var c=(ST.crews||[]).filter(function(x){return x.code===code;})[0]; return (c&&c.name)||code; }
function crewInviteLink(code){ code=code||(curCrew()||{}).code;   // carry sender + crew NAME so the recipient sees context
  var c=(ST.crews||[]).filter(function(x){return x.code===code;})[0], u=baseURL()+"?crew="+code+"&inv="+ST.sid;
  if(ST.displayName) u+="&by="+encodeURIComponent(ST.displayName);
  if(c&&c.name) u+="&cn="+encodeURIComponent(c.name);
  return u; }
function copyCrewInvite(code){ code=code||(curCrew()||{}).code; if(!code)return;
  var url=crewInviteLink(code), cn=crewNameFor(code), who=ST.displayName||"A friend";
  var msg=who+" invited you to "+cn+" on Said It? — tap to join:";
  function ok(){ toast("Invite ready — send it 👥"); logEvent("invite_created",{crew:code}); }
  if(navigator.share){ navigator.share({title:"Join "+cn+" on Said It?",text:msg,url:url}).then(ok,function(err){ if(err&&err.name==="AbortError") return; clip(msg+" "+url,ok); }); return; }
  clip(msg+" "+url,ok); }
/* device-link (no login): play as the same person across phone+laptop. Short, clean link — your crews + name are
   derived server-side from the id on arrival (no long querystring), so it stays tidy and always current. */
function myDeviceLink(){ return baseURL()+"?me="+ST.sid; }
function copyDeviceLink(){    // COPY ONLY (no share sheet) so the clipboard gets exactly the URL, nothing appended
  clip(myDeviceLink(), function(){ toast("Link copied — text it to yourself, open on your other device 📱"); logEvent("device_link_created"); }); }
function fetchMeProfile(){
  var src;
  if(useSbCrew()){ src = sbFetchMeProfile(SB, ST.sid); }
  else { var ep=crewEndpoint(); if(!ep) return Promise.resolve();
    src = fetch(ep+(ep.indexOf("?")>=0?"&":"?")+"me="+encodeURIComponent(ST.sid),{cache:"no-store"}).then(function(r){return r.ok?r.json():null;}); }
  return src.then(function(p){
      if(!p) return;
      if(p.name && !ST.displayName){ ST.displayName=p.name; }
      (p.crews||[]).forEach(function(code){ code=String(code).toUpperCase().replace(/[^A-Z0-9]/g,""); if(code && !hasCrew(code)) ST.crews.push({code:code,joined:todayStr()}); });
      if(!ST.activeCrew) ST.activeCrew=(ST.crews[0]||{}).code||null;
      save(ST);
    }).catch(function(){}); }
function handleDeviceLink(){ var m=location.search.match(/[?&]me=([A-Za-z0-9_]+)/); if(!m) return false;
  var sid=m[1];
  if(sid===ST.sid){ try{ history.replaceState(null,"",location.pathname); }catch(e){} return false; }
  var hadHistory=(ST.judged>0)||(ST.crews&&ST.crews.length>0);
  if(hadHistory && window.confirm && !window.confirm("Play as your other device here? Crew play across your devices will merge under one player.")){ try{ history.replaceState(null,"",location.pathname); }catch(e){} return false; }
  ST.sid=sid;
  var nm=(location.search.match(/[?&]nm=([^&]+)/)||[])[1]; if(nm){ try{ ST.displayName=decodeURIComponent(nm); }catch(e){} }
  var mc=(location.search.match(/[?&]mc=([^&]+)/)||[])[1];
  if(mc){ try{ decodeURIComponent(mc).split(",").forEach(function(code){ code=String(code).toUpperCase().replace(/[^A-Z0-9]/g,""); if(code && !hasCrew(code)){ ST.crews.push({code:code,joined:todayStr()}); } }); }catch(e){} }
  if(!ST.activeCrew) ST.activeCrew=(ST.crews[0]||{}).code||null;
  ST.installed=true;   // this sid already installed on its origin device → don't emit a duplicate install
  save(ST); try{ history.replaceState(null,"",location.pathname); }catch(e){}
  toast("Device linked 📱"); logEvent("device_linked"); return true; }
// &me=<sid> lets the server gate "who got got" (fooledBy) to requesters who've completed today — spoiler-safe (api.js)
function fetchCrew(day, code){ code=code||(curCrew()||{}).code;
  if(useSbCrew()) return sbFetchCrewBoard(SB, code, day, ST.sid);   // Phase 3: gated board Edge Function
  return fetchCrewBoard(crewEndpoint(), code, day, ST.sid); }
function mergeYou(standings, res){          // standings carry scores only; match self by sid (spoiler-free)
  var list=(standings||[]).map(function(s){return {sid:s.sid,name:s.name,score:s.score,you:s.sid===ST.sid};});
  var mine=list.filter(function(s){return s.you;})[0];
  if(mine){ if(res) mine.score=res.score; } else if(res){ list.push({sid:ST.sid,name:ST.displayName||"you",score:res.score,you:true}); }
  return list.sort(function(a,b){return b.score-a.score;});
}
function medal(i){ return i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1)+"."; }
// addDaysStr imported from engine.js
// the player's OWN plays from local state — so the crew board reflects what this device knows even if the
// server hasn't registered today's beacon yet (network lag, a dropped sendBeacon, or just-finished play)
function myResult(date){ var best=null; for(var k in (ST.days||{})){ var r=ST.days[k]&&ST.days[k].done&&ST.days[k].result; if(r&&r.date===date) best=r; } return best; }
function myWeekTotal(){ var wk=weekKey(todayStr()), byDay={}; for(var k in (ST.days||{})){ var r=ST.days[k]&&ST.days[k].done&&ST.days[k].result;
  if(r&&r.date&&weekKey(r.date)===wk) byDay[r.date]=r.score||0; } var t=0,d=0; for(var dd in byDay){ t+=byDay[dd]; d++; } return {total:t,days:d}; }

function crewToken(c,res,code){ var list=mergeYou(c&&c.standings,res); var lines=[];
  var cobj=(ST.crews||[]).filter(function(x){return x.code===code;})[0];
  var label=(c&&c.name)||(cobj&&cobj.name)||code;     // share the crew NAME ("The fam"), not the raw code
  lines.push("Said It? — "+label+(c&&c.crew_streak?" · 🔥 "+c.crew_streak:""));
  list.slice(0,6).forEach(function(s,i){ lines.push(medal(i)+" "+s.name+(s.you?" (me)":"")+" "+s.score+"/"+(res?res.n:6)); });
  lines.push(baseURL()+"?crew="+code);                // the link still carries the code (that's how friends join)
  return lines.join("\n"); }
function shareCrewToken(c,res,code){ var txt=crewToken(c,res,code);
  function ok(){ toast("Standings copied 👥"); logEvent("token_copy",{kind:"crew",crew:code}); }
  if(navigator.share){ navigator.share({text:txt}).then(ok,function(){}); return; }
  clip(txt,ok); }
function openCrew(){ BACK_TO=currentScreen(); renderCrew(); show("crew"); }
function joinAnotherCrew(){
  var code=window.prompt && window.prompt("Enter a crew code to join (leave blank to create a new crew):","");
  if(code===null) return;
  code=String(code).toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(code){ if(joinCrew(code,"")){ JUST_JOINED=null; renderCrew(); } } else { createCrew(); }
}
function renderCrew(){
  var host=$("screen-crew");
  var headHtml='<div class="play-head"><button class="back-btn" id="crewBack" aria-label="Back">'+BACK_ARROW+'</button>'+
    ((inCrew()&&crewBackend())
      ? '<button class="cr-name" id="crewNameBtn"><span class="nm">'+esc(crewLabel(curCrew()))+'</span><span class="chev">'+CHEV_DOWN+'</span></button>'
      : '<div class="scr-title">Crew</div>')+
    '<button class="hdr-mags" id="crewMags" aria-label="Meet Mags">'+magpie("happy",26,"mags-flip")+'</button></div>';
  if(!crewBackend()){
    host.innerHTML=headHtml+'<div class="cr-empty"><div class="h">👥 Crews need the shared backend</div>'+
      '<div class="s">Deploy the backend (see <code>supabase/</code> or <code>endpoint/</code>) to compare with friends. Solo play works fine without it.</div></div>';
    $("crewBack").onclick=navBack; return;
  }
  var html=headHtml;
  if(JUST_JOINED){
    var jn=INVITE_CN||crewLabel(curCrew())||JUST_JOINED;
    var lead=INVITE_BY?(esc(INVITE_BY)+" added you to "):"You’re in ";
    html+='<div class="cr-joined"><b>'+lead+esc(jn)+'</b><div class="s">Play today’s set and you’ll show up on the board.</div>'+
      '<button id="crewPlay">Play today’s set →</button></div>';
  }
  if(!inCrew()){
    html+='<div class="cr-empty"><div class="h">Play with your friends</div>'+
      '<div class="s">Everyone gets the same six quotes — compare scores and build a shared streak. No accounts needed.</div>'+
      '<button class="start" id="crewCreate">Start a crew</button>'+
      '<div class="eh">Got an invite? Just open the link your friend sent you.</div>'+
      '<button class="codebtn" id="crewJoinCode">Have a code? Enter it</button></div>'+accountHTML();
    host.innerHTML=html;
    $("crewBack").onclick=navBack;
    var cm0=$("crewMags"); if(cm0) cm0.onclick=openMagpie;
    if($("crewPlay"))$("crewPlay").onclick=function(){ JUST_JOINED=null; playLane(ST.lane||"general"); };
    $("crewCreate").onclick=createCrew;
    $("crewJoinCode").onclick=function(){ var code=window.prompt&&window.prompt("Enter your crew's code:",""); if(code===null)return;
      if(joinCrew(code,"")){ JUST_JOINED=null; INVITE_BY=INVITE_CN=""; renderCrew(); } };
    wireAccount(); return;
  }
  var cc=curCrew(), today=todayStr();
  html+='<div class="cr-toggle-row"><span class="cr-seclabel">Standings</span>'+
    '<div class="seg-toggle"><button id="crewToday">Today</button><button id="crewWeek">Week</button></div></div>'+
    '<div class="cr-gap" id="crewGap"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span>loading…</span></div>'+
    '<div class="cr-rows" id="crewRows"><div class="cr-foot" style="margin-top:0">loading standings…</div></div>'+
    '<div class="cr-tiles" id="crewTiles"></div>'+
    '<button class="cr-invite" id="crewInviteBtn">Invite your people</button>'+
    '<div class="cr-code">or share code <b>'+esc(cc.code)+'</b></div>'+
    '<button class="cr-join2" id="crewJoin2">+ Create or join another crew</button>'+   // visible on the board, not buried behind the chevron (H)
    '<div class="cr-foot">Play today’s set to see who got fooled — no spoilers before you do.</div>'+
    '<div class="cr-meta"><button id="crewRename">rename</button><span style="opacity:.5">·</span><button id="crewShare">share standings</button><span style="opacity:.5">·</span><button id="crewLeave">leave</button></div>'+
    accountHTML();
  host.innerHTML=html;
  $("crewBack").onclick=navBack;
  var cm=$("crewMags"); if(cm) cm.onclick=openMagpie;
  $("crewNameBtn").onclick=openCrewSwitcher;
  $("crewJoin2").onclick=joinAnotherCrew;
  if($("crewPlay"))$("crewPlay").onclick=function(){ JUST_JOINED=null; playLane(ST.lane||"general"); };
  $("crewInviteBtn").onclick=function(){ copyCrewInvite(cc.code); };
  $("crewRename").onclick=function(){ renameCrew(cc.code); };
  $("crewLeave").onclick=function(){ leaveCrew(cc.code); };
  wireAccount();

  var CREW_DATA=null;
  function paintBoard(){
    var t=$("crewToday"), w=$("crewWeek"); if(!t||!w) return;
    t.className=(CREW_WHEN==="week"?"":"on"); w.className=(CREW_WHEN==="week"?"on":"");
    if(CREW_DATA===null){ $("crewRows").innerHTML='<div class="cr-foot" style="margin-top:0">loading standings…</div>'; return; }
    var c=CREW_DATA;
    var mine=myResult(today), iDoneToday=!!mine;
    // TODAY — carry each member's fooledBy (the FAKES they called real) for "who got got"
    var stand=(c.standings||[]).map(function(s){ return {sid:s.sid,name:s.name,val:(s.score!=null?s.score:0),fooledBy:s.fooledBy||null,you:s.sid===ST.sid}; });
    var meRow=stand.filter(function(s){return s.you;})[0];
    if(meRow){ if(mine){ meRow.val=mine.score; meRow.fooledBy=mine.gotme||meRow.fooledBy; } }
    else if(mine){ stand.push({sid:ST.sid,name:ST.displayName||"you",val:mine.score,fooledBy:mine.gotme||null,you:true}); }
    stand.sort(function(a,b){return b.val-a.val;});
    var myW=myWeekTotal();
    var week=(c.week||[]).map(function(s){ return {sid:s.sid,name:s.name,val:s.total,you:s.sid===ST.sid}; });
    var meW=week.filter(function(s){return s.you;})[0];
    if(meW){ if(myW.total>meW.val) meW.val=myW.total; } else if(myW.days){ week.push({sid:ST.sid,name:ST.displayName||"you",val:myW.total,you:true}); }
    week.sort(function(a,b){return b.val-a.val;});
    if(week.length && c.week_key){ ST.crewSeasons[c.week_key]=week[0].name; save(ST); }   // memorialize the weekly champ
    var weekRank=week.findIndex(function(s){return s.you;});
    var rows=(CREW_WHEN==="week") ? week : stand;
    var top=rows.length?Math.max.apply(null,rows.map(function(r){return r.val;})):1; if(top<=0)top=1;
    var yi=rows.findIndex(function(r){return r.you;});
    // gap-to-next headline
    var gapEl=$("crewGap"), gapTxt;
    if(!rows.length) gapTxt="No scores yet — play to lead "+crewLabel(cc);
    else if(yi<=0) gapTxt="Leading "+crewLabel(cc);
    else { var need=rows[yi-1].val-rows[yi].val+1; gapTxt="Beat "+rows[yi-1].name+" by "+need+" to move up"; }
    if(gapEl){ var gs=gapEl.querySelector("span"); if(gs) gs.textContent=gapTxt; }
    // "moved up" only on Today, and only when your today rank beats your week rank (data-backed, not faked)
    var movedUp=(CREW_WHEN==="today" && yi>=0 && weekRank>=0 && yi<weekRank);
    var rowsHtml=rows.length ? rows.map(function(r,i){
      var col=r.you?"var(--primary)":avColor(r.name);
      var unit=(CREW_WHEN==="week")?"":"/6";
      var moved=(r.you&&movedUp)?'<span class="moved">▲ moved up</span>':'';
      // "who got got": the fakes this crewmate called real — ONLY shown once YOU'VE completed today (server also enforces)
      var fooled=(CREW_WHEN==="today" && iDoneToday && r.fooledBy && r.fooledBy.length)
        ? '<div class="fooled-tag">🪶 fell for '+r.fooledBy.map(function(x){return "#"+x;}).join(", ")+'</div>' : '';
      return '<div class="cr-row'+(r.you?" you":"")+'"><span class="rk">'+(i+1)+'</span>'+
        '<span class="av" style="border-color:'+col+';color:'+col+'">'+esc(r.you?"Y":avInitial(r.name))+'</span>'+
        '<div class="who"><div class="nm">'+esc(r.you?"You":r.name)+moved+'</div>'+
          '<div class="barwrap"><div class="bar" style="width:'+Math.round(r.val/top*100)+'%"></div></div>'+fooled+'</div>'+
        '<span class="sc">'+r.val+unit+'</span></div>';
    }).join("") : '<div class="cr-foot" style="margin-top:0">No one’s played '+(CREW_WHEN==="week"?"this week":"today")+' yet — play to top the board.</div>';
    $("crewRows").innerHTML=rowsHtml;
    var champ=ST.crewSeasons[weekKey(addDaysStr(today,-7))];
    $("crewTiles").innerHTML='<div class="cr-tile streak"><div class="big">🔥 '+(c.crew_streak||0)+'</div><div class="lbl">crew streak</div></div>'+
      '<div class="cr-tile champ"><div class="big">'+esc(champ||"—")+'</div><div class="lbl">last week’s champ</div></div>';
  }
  $("crewToday").onclick=function(){ CREW_WHEN="today"; paintBoard(); };
  $("crewWeek").onclick=function(){ CREW_WHEN="week"; paintBoard(); };
  $("crewShare").onclick=function(){ var dk=dayKey(ST.lane||"general",today); var r=(ST.days[dk]&&ST.days[dk].done)?ST.days[dk].result:{n:6,score:0,date:today}; shareCrewToken(CREW_DATA||{},r,cc.code); };
  paintBoard();
  fetchCrew(today, cc.code).then(function(c){
    CREW_DATA=c||{};
    if(CREW_DATA.name){ setLocalCrewName(cc.code,CREW_DATA.name); var nm=document.querySelector("#crewNameBtn .nm"); if(nm) nm.textContent=CREW_DATA.name; }
    paintBoard();
  });
}

/* ---------- brand chrome (bright redesign) ---------- */
// coral is the one-token alt theme; blue is the default/lead
applyTheme(); applyMotionPref();   // theme = ST.theme (user choice) ?? CFG.THEME; honor the reduced-motion override
// header Mags: flipped to face the wordmark, gentle bob, a real button → the Magpie page (brand bird per screen)
try{ var mb=$("magsBtn"); if(mb){ mb.innerHTML=magpie("happy",30,"mags-flip"); mb.addEventListener("click",openMagpie); } }catch(e){}
try{ var fav=$("favicon"); if(fav) fav.setAttribute("href","data:image/svg+xml,"+encodeURIComponent(appIconSVG())); }catch(e){}

/* ---------- PWA: offline shell + installability (Phase 4) ---------- */
if(typeof navigator!=="undefined" && "serviceWorker" in navigator){ try{ navigator.serviceWorker.register("sw.js").catch(function(){}); }catch(e){} }
var DEFERRED_INSTALL=null;
try{ window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); DEFERRED_INSTALL=e; logEvent("pwa_installable"); if(currentScreen()==="settings") renderSettings(); }); }catch(e){}
try{ window.addEventListener("appinstalled", function(){ DEFERRED_INSTALL=null; logEvent("pwa_installed"); if(currentScreen()==="settings") renderSettings(); }); }catch(e){}
function isStandalone(){ try{ return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone===true; }catch(e){ return false; } }
function isIOS(){ try{ return /iphone|ipad|ipod/i.test(navigator.userAgent); }catch(e){ return false; } }
function promptInstall(){
  if(DEFERRED_INSTALL){ DEFERRED_INSTALL.prompt(); DEFERRED_INSTALL.userChoice.then(function(c){ logEvent("pwa_prompt",{outcome:(c&&c.outcome)||""}); DEFERRED_INSTALL=null; if(currentScreen()==="settings") renderSettings(); }); return; }
  if(isIOS()){ openSheet('<div class="sheet-title">Add to Home Screen</div><div class="ag-body">Tap the <b>Share</b> button in Safari, then <b>“Add to Home Screen.”</b> Said It? opens full-screen, like an app.</div><button class="sheet-close" id="iosClose">Got it</button>'); var ic=$("iosClose"); if(ic) ic.onclick=closeSheet; return; }
  toast("Use your browser’s “Add to Home Screen”");
}

/* ---------- image share: render the result card → PNG → Web Share (spoiler-free text grid is the fallback) ---------- */
function getCssVar(name, dflt){ try{ var v=getComputedStyle(document.body).getPropertyValue(name).trim(); return v||dflt; }catch(e){ return dflt; } }
function roundRectPath(x,X,Y,W,H,R){ x.beginPath(); x.moveTo(X+R,Y); x.arcTo(X+W,Y,X+W,Y+H,R); x.arcTo(X+W,Y+H,X,Y+H,R); x.arcTo(X,Y+H,X,Y,R); x.arcTo(X,Y,X+W,Y,R); x.closePath(); }
function shareResultImage(res, btn){
  var ctx=null; try{ var probe=document.createElement("canvas"); ctx=probe.getContext&&probe.getContext("2d"); }catch(e){}
  var fileOk=false; try{ fileOk=(typeof File!=="undefined" && navigator.canShare); }catch(e){}
  if(!ctx || !fileOk){ copyToken(); return; }   // no canvas / no file-share → spoiler-free text grid (copyToken)
  var primary=getCssVar("--primary","#4C6EF5"), mint="#16B981", ink="#23253A", ink3="#6B6F8C";
  var W=1080,H=1080, c=document.createElement("canvas"); c.width=W; c.height=H; var x=c.getContext("2d"); var FAM="'Plus Jakarta Sans',system-ui,sans-serif";
  x.fillStyle="#F7F8FC"; x.fillRect(0,0,W,H);
  roundRectPath(x,80,140,W-160,H-340,48); x.fillStyle="#fff"; x.fill(); x.lineWidth=10; x.strokeStyle=primary; x.stroke();
  var PAD=150;
  x.fillStyle=primary; x.font="700 60px "+FAM; x.fillText("Said It?", PAD, 300);
  x.fillStyle=ink3; x.font="600 36px "+FAM; x.fillText(prettyDate(res.date), PAD, 358);
  x.fillStyle=primary; x.font="800 200px "+FAM; x.fillText(res.score+"/"+res.n, PAD, 590);
  x.fillStyle=ink; x.font="700 44px "+FAM; x.fillText("🔥 "+res.streak+"-day streak", PAD, 670);
  var n=res.perq.length, gap=22, pw=(W-2*PAD-(n-1)*gap)/n, py=730, ph=92;   // pips: caught (mint ✓) vs fooled (grey) — spoiler-free
  res.perq.forEach(function(p,i){ var px=PAD+i*(pw+gap); roundRectPath(x,px,py,pw,ph,18);
    x.fillStyle=p.right?"#E7F8F1":"#EFF0F6"; x.fill(); x.lineWidth=6; x.strokeStyle=p.right?mint:"#D7DAE6"; x.stroke();
    if(p.right){ x.strokeStyle=mint; x.lineWidth=11; x.lineCap="round"; x.lineJoin="round"; x.beginPath(); x.moveTo(px+pw*0.30,py+ph*0.52); x.lineTo(px+pw*0.45,py+ph*0.68); x.lineTo(px+pw*0.72,py+ph*0.34); x.stroke(); } });
  x.fillStyle=ink3; x.font="600 34px "+FAM; x.fillText("caught it ✓    fooled ▫", PAD, 900);
  x.fillStyle=primary; x.font="700 40px "+FAM; x.textAlign="right"; x.fillText("saidit.app", W-PAD, 900); x.textAlign="left";
  var svg=magpie(res.score===res.n?"delighted":"happy",240).replace(/var\(--primary\)/g, primary);
  function finish(){ try{ c.toBlob(function(blob){
      if(!blob){ copyToken(); return; }
      var file=new File([blob],"said-it-"+res.date+".png",{type:"image/png"});
      try{ if(navigator.canShare && navigator.canShare({files:[file]})){
        navigator.share({files:[file], text:"Said It? "+res.score+"/"+res.n+" — real or fake, daily. "+baseURL(), title:"Said It?"})
          .then(function(){ logEvent("image_share"); if(btn) btn.textContent="Shared ✓"; },
                function(err){ if(!(err&&err.name==="AbortError")) copyToken(); });
      } else { copyToken(); } }catch(e){ copyToken(); }
    },"image/png"); }catch(e){ copyToken(); } }
  var img=new Image();
  img.onload=function(){ try{ x.drawImage(img, W-340, 240, 220,220); }catch(e){} finish(); };
  img.onerror=finish;
  img.src="data:image/svg+xml,"+encodeURIComponent(svg);
}

/* ---------- web push: daily "new set is live / keep your streak" (gated on the Settings toggle) ---------- */
var VAPID_PUBLIC=CFG.VAPID_PUBLIC_KEY||"";
function urlB64ToU8(b64){ var pad="=".repeat((4-b64.length%4)%4); var s=(b64+pad).replace(/-/g,"+").replace(/_/g,"/");
  var raw=atob(s), out=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out; }
function pushSupported(){ try{ return ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window); }catch(e){ return false; } }
function enablePush(){
  if(!pushSupported()){ toast("Reminders aren’t supported on this browser"); ST.notif=false; save(ST); if(currentScreen()==="settings") renderSettings(); return; }
  Notification.requestPermission().then(function(perm){
    if(perm!=="granted"){ toast("Allow notifications to get the daily nudge"); ST.notif=false; save(ST); if(currentScreen()==="settings") renderSettings(); return; }
    if(!VAPID_PUBLIC){ toast("Reminders on — they’ll start once the daily push is live"); logEvent("push_optin",{pending:true}); return; }   // backend not deployed yet
    navigator.serviceWorker.ready.then(function(reg){
      reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:urlB64ToU8(VAPID_PUBLIC) }).then(function(sub){
        var j=sub.toJSON()||{}; var keys=j.keys||{};
        if(sbWriteOn()) try{ SB.from("push_subscriptions").upsert({ sid:ST.sid, endpoint:j.endpoint, p256dh:keys.p256dh, auth:keys.auth, tz:(new Date()).getTimezoneOffset(), updated_at:new Date().toISOString() }, { onConflict:"endpoint" }); }catch(e){}
        logEvent("push_subscribed"); toast("Daily reminder on 🔔");
      }, function(){ toast("Couldn’t turn on reminders"); ST.notif=false; save(ST); if(currentScreen()==="settings") renderSettings(); });
    });
  });
}
function disablePush(){ logEvent("push_optout");
  try{ if(pushSupported()) navigator.serviceWorker.ready.then(function(reg){ reg.pushManager.getSubscription().then(function(sub){ if(sub){ var ep=sub.endpoint; sub.unsubscribe();
    if(sbWriteOn()) try{ SB.from("push_subscriptions").delete().eq("endpoint",ep); }catch(e){} } }); }); }catch(e){}
}

/* ---------- wire up (reveal controls are wired inside renderReveal, which rebuilds that screen) ---------- */
// Home "Play today's set" → the Lanes picker
$("homePlay").addEventListener("click",openLanes);
// home is reachable from everywhere: the logo (header) is the persistent home control
$("logoBtn").addEventListener("click",goHome);
$("homeArchive").addEventListener("click",openArchive);
$("homeSettings").addEventListener("click",openSettings);
$("archiveBack").addEventListener("click",navBack);

boot();
})();
