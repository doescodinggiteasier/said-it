#!/usr/bin/env python3
"""Said It? — evergreen BANK INTEGRITY AUDIT. The game's core promise is that every REAL is provably on its cited
source. That promise decays silently over time: sources 404, articles get rewritten, a link rots. This re-runs the
SAME verbatim check the live pipeline uses (fetch the cited source, confirm the quote appears >=70% contiguous)
across the WHOLE bank, plus a speaker-proximity sanity check for the person-lanes, and flags anything that no
longer holds up. Meant to run on a schedule (weekly) so integrity drift is caught, not discovered by a player.

  python bank_audit.py                  # audit every banked lane; write tools/bank_audit_report.json; exit 4 if any REAL is no longer verbatim
  python bank_audit.py --lane movies     # one lane
  python bank_audit.py --sample 5        # first N entries per lane (fast smoke check)
  python bank_audit.py --verbose         # print every entry's status, not just the flagged ones

Statuses: ok · unsourced (legacy, no source.url) · unreachable (fetch failed — dead/blocked link) ·
not-verbatim (source no longer contains the quote — INTEGRITY FAILURE) · attribution-far (person-lane: the
speaker's surname isn't near the quote on the page — a weak misattribution signal, worth eyeballing).
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_day as g  # noqa: E402


def _surname(sp):
    parts = [p for p in re.sub(r"[.\"]", "", sp or "").split() if len(p) > 1]
    return parts[-1].lower() if parts else (sp or "").lower()


def _proximity_ok(text, speaker, corpus):
    """Person-lanes only: is the speaker's surname within ~600 chars of the quote? Catches a quote credited to a
    different person on a multi-name page. Returns (near, anywhere)."""
    low = corpus.lower()
    sn = _surname(speaker)
    if not sn:
        return True, True
    frag = re.sub(r"\s+", " ", (text or "").lower())[:24]
    idx = low.find(frag)
    anywhere = sn in low
    near = anywhere and idx >= 0 and sn in low[max(0, idx - 600): idx + 600]
    return near, anywhere


def audit(lanes=None, sample=None, verbose=False):
    cats = lanes or [c for c in g.CATEGORIES]
    corpus_cache = {}
    flags = []
    per_lane = {}
    for cat in cats:
        try:
            bank = g.load_raw_evergreen(cat)
        except Exception:  # noqa: BLE001 — general's EVERGREEN may not exist
            bank = []
        if sample:
            bank = bank[:sample]
        is_person = g.CATEGORIES.get(cat, {}).get("kind") != "movie"
        counts = {"total": len(bank), "ok": 0, "unsourced": 0, "unreachable": 0, "not-verbatim": 0, "attribution-far": 0}
        for e in bank:
            text = e.get("text", "")
            sp = e.get("speaker", "")
            url = ((e.get("source") or {}).get("url") or "").strip()
            status, detail = "ok", ""
            if not url:
                status = "unsourced"; detail = "no source.url (legacy entry)"
            else:
                corpus = corpus_cache.get(url)
                if corpus is None:
                    corpus = g.fetch_article_text(url) or ""
                    corpus_cache[url] = corpus
                if not corpus:
                    status = "unreachable"; detail = "source fetch returned nothing (dead/blocked link)"
                elif not g.quote_is_verbatim(text, corpus):
                    status = "not-verbatim"; detail = "quote no longer found verbatim at source"
                elif is_person:
                    near, anywhere = _proximity_ok(text, sp, corpus)
                    if not anywhere:
                        status = "not-verbatim"; detail = "speaker surname absent from source (likely misattribution)"
                    elif not near:
                        status = "attribution-far"; detail = "speaker surname present but not near the quote (eyeball)"
            counts[status] = counts.get(status, 0) + 1
            if verbose or status not in ("ok",):
                rec = {"lane": cat, "speaker": sp, "text": text[:70], "url": url, "status": status, "detail": detail}
                if status != "ok":
                    flags.append(rec)
                if verbose:
                    print(f"  {status:16} {cat:8} {sp[:22]:22} :: {text[:44]}")
        per_lane[cat] = counts
    return {"generated_at": dt.date.today().isoformat(), "per_lane": per_lane, "flags": flags}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", action="append", help="limit to lane(s); repeatable")
    ap.add_argument("--sample", type=int, help="only the first N entries per lane (fast smoke)")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    rep = audit(lanes=a.lane, sample=a.sample, verbose=a.verbose)
    with open(os.path.join(HERE, "bank_audit_report.json"), "w") as f:
        json.dump(rep, f, indent=2, ensure_ascii=False)

    hard = 0
    print("\n=== bank audit ===")
    for cat, c in rep["per_lane"].items():
        bad = c["not-verbatim"]; hard += bad
        print(f"  {cat:8} total={c['total']:>3} ok={c['ok']:>3} unsourced={c['unsourced']:>2} "
              f"unreachable={c['unreachable']:>2} not-verbatim={bad:>2} attribution-far={c['attribution-far']:>2}")
    if rep["flags"]:
        print("\n  flags:")
        for fl in rep["flags"]:
            print(f"    [{fl['status']:15}] {fl['lane']:8} {fl['speaker'][:22]:22} :: {fl['text'][:40]}")
    if hard:
        print(f"\n✗ {hard} REAL(s) no longer verify against their source — INTEGRITY FAILURE. Fix or remove them.")
        return 4
    print("\n✓ every sourced REAL still verifies against its cited source.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
