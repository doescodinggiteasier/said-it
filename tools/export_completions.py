#!/usr/bin/env python3
"""Said It? — export player completions from Supabase into completions.json, the telemetry difficulty.py grades.
This is the missing link that ACTIVATES the difficulty feedback loop: once real players are logging completions,
CI exports them here → difficulty.py --json grades each fake's live "fooled %" → generate_day.py steers the
fake-writer. Fully graceful: with no service key or no rows it writes an empty list and exits 0, so the daily
run never breaks — the loop simply stays a no-op until data exists.

Env:
  SUPABASE_URL          default https://dqsomxfqvysbostmopvx.supabase.co
  SUPABASE_SERVICE_KEY  service_role key (bypasses RLS to read all completions). If unset → writes [] and exits.

  python export_completions.py            # → tools/completions.json  ([{day, cat, gotme, n}], lane mapped to cat)
"""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "completions.json")
URL = os.environ.get("SUPABASE_URL", "https://dqsomxfqvysbostmopvx.supabase.co").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def _write(rows):
    json.dump(rows, open(OUT, "w"), ensure_ascii=False)
    return rows


def fetch():
    """Page through PostgREST (1000/req) and return [{day, cat, gotme, n}] — lane mapped to cat for difficulty.py."""
    out, offset, PAGE = [], 0, 1000
    while True:
        req = urllib.request.Request(
            f"{URL}/rest/v1/completions?select=day,lane,gotme,n&order=day.asc",
            headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                     "Range-Unit": "items", "Range": f"{offset}-{offset + PAGE - 1}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            batch = json.loads(r.read().decode("utf-8", "ignore"))
        for c in batch:
            out.append({"day": c.get("day"), "cat": c.get("lane") or "general",
                        "gotme": c.get("gotme") or [], "n": c.get("n")})
        if len(batch) < PAGE:
            break
        offset += PAGE
    return out


def main():
    if not KEY:
        _write([])
        print("SUPABASE_SERVICE_KEY unset → wrote empty completions.json (difficulty loop stays a no-op).")
        return 0
    try:
        rows = _write(fetch())
    except urllib.error.HTTPError as e:
        _write([])
        print(f"::warning::completions export failed (HTTP {e.code}) → empty completions.json; difficulty loop skipped this run.")
        return 0
    except Exception as e:  # noqa: BLE001 — never break the daily run over telemetry
        _write([])
        print(f"::warning::completions export error ({e.__class__.__name__}) → empty completions.json; difficulty loop skipped.")
        return 0
    days = len({r["day"] for r in rows})
    print(f"exported {len(rows)} completions across {days} day(s) → completions.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
