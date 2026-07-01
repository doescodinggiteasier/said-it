#!/usr/bin/env python3
"""Said It? — proactive per-lane BANK HEALTH gauge. Catches lane starvation BEFORE a lane goes dark, instead of
reactively (a lane fail-safes, or `generate_day.py --verify` flags a missing edition after the fact).

The real starvation metric is NOT bank size — it's how many FRESH, distinct-speaker REALS a lane can still
publish: bank entries whose text has not already been used in ANY lane (cross-lane no-repeat). A lane needs >=2
distinct-speaker reals to assemble an edition; the bank is the fallback when feeds are thin. When fresh distinct
speakers drop below that, the lane fail-safes on any low-news day (exactly what happened to movies: 35 banked,
~all used).

  python bank_health.py           # print the table + write tools/bank_health.json
  python bank_health.py --json     # machine-readable only (for the admin dashboard / CI)
  python bank_health.py --strict   # exit 3 if any lane is STARVED (use as a CI early-warning gate)

Verdict bands (by fresh distinct-speaker reals still publishable from the bank):
  STARVED  < 2   — cannot self-assemble one edition; WILL fail-safe on a thin-feed day. Seed this bank now.
  LOW      < 8   — under ~one full edition of headroom; leaning on feeds. Seed soon.
  OK      >= 8
General has no evergreen bank (feed-only) and is reported as such.
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_day as g  # noqa: E402

STARVED_BELOW, LOW_BELOW = 2, 8


def _manifest():
    try:
        return json.load(open(os.path.join(g.DAILY, "index.json")))
    except Exception:  # noqa: BLE001
        return {}


def _lane_days(manifest, cat):
    """Sorted list of dates this lane has published, from the manifest (general = top-level `days`)."""
    if cat == "general":
        return sorted(manifest.get("days", []) or [])
    node = (manifest.get("categories", {}) or {}).get(cat, {})
    days = node.get("days") if isinstance(node, dict) else node
    return sorted(days or [])


def _days_since(date_str, today):
    try:
        d = dt.date.fromisoformat(date_str)
        return (today - d).days
    except Exception:  # noqa: BLE001
        return None


def health(today=None):
    today = today or dt.date.today()
    manifest = _manifest()
    all_used = g.load_all_used()   # cross-lane union — the membership test a real must pass to be publishable
    rows = []
    for cat in g.CATEGORIES:
        is_general = (cat == "general")
        bank = [] if is_general else g.load_raw_evergreen(cat)
        # FRESH = bank reals never published in any lane; distinct speakers among them is the true headroom.
        fresh = [e for e in bank if g._norm(e.get("text", "")) not in all_used]
        fresh_speakers = sorted({(e.get("speaker") or "").strip() for e in fresh if (e.get("speaker") or "").strip()})
        days = _lane_days(manifest, cat)
        last = days[-1] if days else None
        since = _days_since(last, today) if last else None
        nfresh = len(fresh_speakers)
        if is_general:
            verdict = "FEED-ONLY"
        elif nfresh < STARVED_BELOW:
            verdict = "STARVED"
        elif nfresh < LOW_BELOW:
            verdict = "LOW"
        else:
            verdict = "OK"
        rows.append({
            "lane": cat,
            "bank_size": len(bank),
            "used_in_lane": len(g.load_used(cat)),
            "fresh_reals": len(fresh),
            "fresh_speakers": nfresh,
            "last_edition": last,
            "days_since_last": since,
            "verdict": verdict,
        })
    return rows


def _fmt_table(rows):
    hdr = f"{'lane':9} {'bank':>5} {'used':>5} {'fresh':>6} {'fresh_spk':>9} {'last_ed':>11} {'age':>4}  verdict"
    out = [hdr, "-" * len(hdr)]
    for r in rows:
        age = "" if r["days_since_last"] is None else f"{r['days_since_last']}d"
        out.append(f"{r['lane']:9} {r['bank_size']:>5} {r['used_in_lane']:>5} {r['fresh_reals']:>6} "
                   f"{r['fresh_speakers']:>9} {str(r['last_edition'] or '—'):>11} {age:>4}  {r['verdict']}")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    ap.add_argument("--strict", action="store_true", help="exit 3 if any lane is STARVED")
    a = ap.parse_args()
    rows = health()
    report = {"generated_at": dt.date.today().isoformat(), "lanes": rows}
    # always persist an artifact the admin dashboard / CI can read
    with open(os.path.join(HERE, "bank_health.json"), "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    if a.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(_fmt_table(rows))
        starved = [r["lane"] for r in rows if r["verdict"] == "STARVED"]
        low = [r["lane"] for r in rows if r["verdict"] == "LOW"]
        if starved:
            print(f"\n⚠ STARVED (seed now): {', '.join(starved)}")
        if low:
            print(f"  LOW (seed soon): {', '.join(low)}")
        if not starved and not low:
            print("\n✓ all banked lanes have healthy real headroom.")
    if a.strict and any(r["verdict"] == "STARVED" for r in rows):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
