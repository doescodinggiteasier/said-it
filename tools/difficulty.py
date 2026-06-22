#!/usr/bin/env python3
"""Said It? — difficulty feedback loop (Phase 5). Grades every published FAKE by its LIVE "fooled %"
(how often players called it real) so generation can be calibrated: retire styles that are too obvious
(~0% — nobody's fooled) or unfair (~100% — everybody is), and aim for the satisfying 40–70% catch band.

Fakes are never repeated, so this doesn't blacklist individual lines — it surfaces which KINDS of fakes land,
as a signal back into the prompt + a daily quality readout.

Telemetry in = a JSON array of completions [{ "day": "YYYY-MM-DD", "cat": "general", "n": 6, "gotme": [2,5] }]
(gotme = 1-indexed positions the player called REAL but were FAKE). Export it from Supabase `completions`
(gotme jsonb) or the Apps Script sheet.

  python difficulty.py completions.json            # report across all editions
  python difficulty.py completions.json --json      # machine-readable, writes difficulty_report.json
"""
import glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DAILY = os.path.abspath(os.path.join(HERE, "..", "daily"))

TOO_EASY, UNFAIR, BAND_LO, BAND_HI, MIN_PLAYS = 15, 85, 40, 70, 5

def band(pct):
    if pct < TOO_EASY: return "too_easy"      # nobody's fooled → too obvious, drop the style
    if pct > UNFAIR:   return "unfair"        # everybody's fooled → indistinguishable from real, too hard
    if BAND_LO <= pct <= BAND_HI: return "on_target"
    return "ok"

def load_editions():
    eds = {}
    for p in glob.glob(os.path.join(DAILY, "*.json")) + glob.glob(os.path.join(DAILY, "*", "*.json")):
        if os.path.basename(p) == "index.json":
            continue
        try:
            ed = json.load(open(p))
        except Exception:
            continue
        eds[(ed.get("date"), ed.get("category", "general"))] = ed
    return eds

def grade_fakes(editions, completions):
    """Pure. editions: {(date,cat): edition}. completions: [{day,cat,gotme,[n]}]. → per-fake difficulty records."""
    # plays-per-(day,cat) and fooled-count-per-(day,cat,pos)
    plays, fooled = {}, {}
    for c in completions:
        key = (c.get("day"), c.get("cat", "general"))
        plays[key] = plays.get(key, 0) + 1
        for pos in (c.get("gotme") or []):
            fooled[(key[0], key[1], int(pos))] = fooled.get((key[0], key[1], int(pos)), 0) + 1
    out = []
    for (date, cat), ed in editions.items():
        total = plays.get((date, cat), 0)
        for i, q in enumerate(ed.get("quotes", [])):
            if q.get("real"):
                continue
            pos = i + 1
            f = fooled.get((date, cat, pos), 0)
            pct = round(100 * f / total) if total else None
            out.append({"date": date, "cat": cat, "pos": pos, "speaker": q.get("speaker", ""),
                        "text": (q.get("text", "")[:80]), "plays": total, "fooled": f,
                        "fooled_pct": pct, "band": (band(pct) if (pct is not None and total >= MIN_PLAYS) else "insufficient")})
    return out

def main(argv):
    if not argv:
        sys.exit("Usage: difficulty.py <completions.json> [--json]")
    completions = json.load(open(argv[0]))
    recs = grade_fakes(load_editions(), completions)
    graded = [r for r in recs if r["band"] != "insufficient"]
    counts = {b: sum(1 for r in graded if r["band"] == b) for b in ("too_easy", "ok", "on_target", "unfair")}
    if "--json" in argv:
        json.dump({"summary": counts, "fakes": recs}, open(os.path.join(HERE, "difficulty_report.json"), "w"), indent=2)
        print(json.dumps(counts))
        return
    print(f"Graded {len(graded)} fakes (≥{MIN_PLAYS} plays). Target band {BAND_LO}–{BAND_HI}% catch.")
    for b, label in (("too_easy", "TOO OBVIOUS (retire the style)"), ("unfair", "TOO HARD (looks real — ease off)"),
                     ("on_target", "ON TARGET"), ("ok", "acceptable")):
        rows = sorted([r for r in graded if r["band"] == b], key=lambda r: r["fooled_pct"])
        if rows:
            print(f"\n[{label}] {len(rows)}")
            for r in rows[:12]:
                print(f"  {r['fooled_pct']:>3}%  {r['date']}/{r['cat']} #{r['pos']}  {r['speaker']}: {r['text']}")

if __name__ == "__main__":
    main(sys.argv[1:])
