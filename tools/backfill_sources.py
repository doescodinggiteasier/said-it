#!/usr/bin/env python3
"""Said It? — backfill `source` onto already-published editions whose REAL quotes came from an evergreen bank
but predate that bank carrying sources (e.g. the Off the Record / nsfw reals re-sourced in Phase 5).

For every daily/<...>.json, each REAL quote with no `source` is matched (by normalized text) against its lane's
evergreen bank; if found, the bank's `source` (and richer `context`) is attached. The generator already carries
source forward for new editions — this fixes the ones served right now so the reveal shows a real "Source ›"
link instead of the "On the record" fallback. Idempotent; never touches fakes or already-sourced reals.

  python backfill_sources.py            # all lanes
  python backfill_sources.py nsfw       # one lane
"""
import glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(HERE, ".."))
DAILY = os.path.join(WEB, "daily")

def norm(s):
    s = (s or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"[^a-z0-9 ]+", " ", re.sub(r"\s+", " ", s)).strip()

def evergreen_for(lane):
    name = "evergreen_reals.json" if lane == "general" else f"evergreen_{lane}.json"
    try:
        return json.load(open(os.path.join(HERE, name)))
    except Exception:
        return []

def lane_of(path):
    rel = os.path.relpath(path, DAILY)
    parts = rel.split(os.sep)
    return parts[0] if len(parts) > 1 else "general"

def main(only=None):
    files = []
    for p in glob.glob(os.path.join(DAILY, "*.json")) + glob.glob(os.path.join(DAILY, "*", "*.json")):
        if os.path.basename(p) == "index.json":
            continue
        files.append(p)
    banks = {}
    changed_files = changed_quotes = 0
    for p in sorted(files):
        lane = lane_of(p)
        if only and lane != only:
            continue
        if lane not in banks:
            banks[lane] = {norm(e["text"]): e for e in evergreen_for(lane)}
        bank = banks[lane]
        try:
            ed = json.load(open(p))
        except Exception:
            continue
        touched = False
        for q in ed.get("quotes", []):
            if not q.get("real") or q.get("source"):
                continue
            e = bank.get(norm(q.get("text", "")))
            if e and e.get("source"):
                q["source"] = e["source"]
                if e.get("context"):
                    q["context"] = e["context"]   # the bank's context is richer + carries the curated caveats
                touched = True
                changed_quotes += 1
        if touched:
            json.dump(ed, open(p, "w"), indent=2, ensure_ascii=False)
            changed_files += 1
            print(f"  + {os.path.relpath(p, WEB)}")
    print(f"Backfilled {changed_quotes} real quote(s) across {changed_files} edition(s).")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
