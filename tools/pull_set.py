#!/usr/bin/env python3
"""Said It? — kill switch (Phase 5). Pull a bad LIVE edition FAST: drop it from the manifest (so the app
falls back to the previous edition) and quarantine the file (reversible). For when a generated set slips a
bad / inflammatory / off-policy line live and you need it gone now.

  python pull_set.py 2026-06-19              # pull the general edition
  python pull_set.py 2026-06-19 politics     # pull a lane edition
  python pull_set.py 2026-06-19 --restore    # undo
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DAILY = os.path.abspath(os.path.join(HERE, "..", "daily"))
MANIFEST = os.path.join(DAILY, "index.json")

def edition_path(daily, cat, date):
    return os.path.join(daily, f"{date}.json") if cat == "general" else os.path.join(daily, cat, f"{date}.json")

def pull(date, cat="general", daily=DAILY, manifest=MANIFEST, restore=False):
    """Pure-ish: quarantine/restore the file + add/remove the date from the manifest. Returns a status dict."""
    p = edition_path(daily, cat, date)
    quar = p + ".pulled"
    try:
        idx = json.load(open(manifest))
    except Exception:
        idx = {"game": "Said It?", "days": [], "categories": {}}
    if restore:
        if os.path.exists(quar):
            os.rename(quar, p)
        arr = (idx.setdefault("days", []) if cat == "general" else idx.setdefault("categories", {}).setdefault(cat, []))
        if date not in arr:
            arr.append(date); arr.sort()
        action = "restored"
    else:
        if os.path.exists(p):
            os.replace(p, quar)                       # quarantine (reversible)
        if cat == "general":
            idx["days"] = [d for d in idx.get("days", []) if d != date]
        else:
            cats = idx.setdefault("categories", {})
            cats[cat] = [d for d in cats.get(cat, []) if d != date]
        action = "pulled"
    json.dump(idx, open(manifest, "w"), indent=2)
    return {"action": action, "date": date, "cat": cat, "file_present": os.path.exists(p)}

def main(argv):
    if not argv:
        sys.exit("Usage: pull_set.py <date> [category] [--restore]")
    date = argv[0]
    restore = "--restore" in argv
    cat = next((a for a in argv[1:] if not a.startswith("--")), "general")
    r = pull(date, cat, restore=restore)
    if restore:
        print(f"Restored {r['cat']}/{date}.")
    else:
        print(f"Pulled {r['cat']}/{date} — quarantined to *.pulled, removed from the manifest; the app now serves the previous edition.")

if __name__ == "__main__":
    main(sys.argv[1:])
