// Said It? — tiny state→render store (no deps, no DOM). A single source of UI truth that re-renders on change.
// Phase 2's rewritten view builds on this; it is intentionally minimal (no framework, no build step).

export function createStore(initial){
  var state = Object.assign({}, initial || {});
  var subs = [];
  function get(){ return state; }
  // shallow-merge a patch (or a (prev)=>patch fn) and notify subscribers
  function set(patch){
    var next = (typeof patch === "function") ? patch(state) : patch;
    state = Object.assign({}, state, next);
    for(var i = 0; i < subs.length; i++){ subs[i](state); }
    return state;
  }
  // subscribe; returns an unsubscribe fn
  function subscribe(fn){ subs.push(fn); return function(){ var i = subs.indexOf(fn); if(i >= 0) subs.splice(i, 1); }; }
  return { get: get, set: set, subscribe: subscribe };
}
