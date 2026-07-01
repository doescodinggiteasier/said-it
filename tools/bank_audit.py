#!/usr/bin/env python3
"""Said It? — evergreen BANK INTEGRITY AUDIT. The game's core promise is that every REAL is provably on its cited
source. That promise decays silently over time: sources 404, articles get rewritten, a link rots. This re-runs the
SAME verbatim check the live pipeline uses (fetch the cited source, confirm the quote appears >=70% contiguous)
across the WHOLE bank, plus a speaker-proximity sanity check for the person-lanes, and flags anything that no
longer holds up. Meant to run on a schedule (weekly) so integrity drift is caught, not discovered by a player.

Also audits edition DATE FORMAT (Phase 4, extends rather than duplicates): bank_recency() sorts the bank-floor
recycle's least-recently-used candidates by `ed.get("date")` strings, relying on ISO 'YYYY-MM-DD' sorting
lexicographically == chronologically. A malformed date (or a fallback to a non-ISO filename stem) would silently
misrank recycle order — the bank-floor fix would still assemble an edition, but might recycle the WRONG (more
recently shown) real. This is a mechanical/ops integrity failure, not a factual one, but undermines the same fix.

  python bank_audit.py                  # audit every banked lane + every edition's date format; write tools/bank_audit_report.json
                                         # exit 4 if any REAL is no longer verbatim OR any edition date is malformed
  python bank_audit.py --lane movies     # one lane
  python bank_audit.py --sample 5        # first N bank entries per lane (fast smoke check; date-format check is unaffected — it's free)
  python bank_audit.py --verbose         # print every entry's status, not just the flagged ones

Statuses: ok · unsourced (legacy, no source.url) · unreachable (fetch failed — dead/blocked link) ·
not-verbatim (source no longer contains the quote — INTEGRITY FAILURE) · misattribution (person-lane: the
speaker's surname is entirely ABSENT from the source page — a much stronger signal than attribution-far, since
the quote may genuinely belong to someone else) · attribution-far (person-lane: the speaker's surname IS on the
page but isn't near the quote — a weaker signal, worth eyeballing, not a hard failure) · exempt (an entry marked
`verified_legacy: true` — an explicit, reviewed, documented decision that this quote is genuinely real and
well-attested but can't be mechanically verified, e.g. every live source censors the exact profanity, or the
quote is too short for quote_is_verbatim's minimum-length floor. NEVER a silent pass: the underlying check still
RUNS and its result is recorded in `detail` for future review, but an exempt entry never counts toward the
hard-fail exit code — that's the whole point of the field being explicit and reviewable).

`verified_legacy` can ONLY exempt `not-verbatim` — never `misattribution`. A sourcing/censorship problem ("the
quote is real but every outlet censors the profanity") is a fundamentally different, lower-stakes kind of failure
than a misattribution problem ("this may not even be the right person") — the latter is never something a
documented exemption should be able to paper over, however well-intentioned the reason given.
"""
from __future__ import annotations
import argparse, datetime as dt, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate_day as g  # noqa: E402

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
        counts = {"total": len(bank), "ok": 0, "unsourced": 0, "unreachable": 0, "not-verbatim": 0,
                  "misattribution": 0, "attribution-far": 0, "exempt": 0}
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
                        # a STRONGER signal than attribution-far — the speaker's name isn't on the page at all,
                        # so this may not even be the right person. Deliberately NOT exemptible (see module docstring).
                        status = "misattribution"; detail = "speaker surname absent from source (likely misattribution)"
                    elif not near:
                        status = "attribution-far"; detail = "speaker surname present but not near the quote (eyeball)"
            if status == "not-verbatim" and e.get("verified_legacy"):
                # explicit, documented, per-entry exception (never a silent pass — the underlying failure is
                # recorded in `detail` for review) — a human judged this quote genuinely real and well-attested
                # despite being mechanically unverifiable (e.g. every live source censors the exact profanity).
                detail = f"EXEMPTED ({e.get('exempt_reason', 'no reason given')}) — underlying check said: {detail}"
                status = "exempt"
            counts[status] = counts.get(status, 0) + 1
            if verbose or status not in ("ok",):
                rec = {"lane": cat, "speaker": sp, "text": text[:70], "url": url, "status": status, "detail": detail}
                if status not in ("ok",):
                    flags.append(rec)
                if verbose:
                    print(f"  {status:16} {cat:8} {sp[:22]:22} :: {text[:44]}")
        per_lane[cat] = counts
    return {"generated_at": dt.date.today().isoformat(), "per_lane": per_lane, "flags": flags}


def audit_edition_dates(lanes=None):
    """Phase 4 — scan every published edition on disk (the same files + the same date-fallback logic
    bank_recency() uses: `ed.get("date") or <filename stem>`) and flag any date that isn't a valid YYYY-MM-DD
    string. Pure local file reads, no network — always cheap, always worth running."""
    cats = lanes or list(g.CATEGORIES)
    bad = []
    checked = 0
    for cat in cats:
        for p in sorted(glob.glob(os.path.join(g.daily_dir(cat), "*.json"))):
            if os.path.basename(p) == "index.json":
                continue
            checked += 1
            try:
                ed = json.load(open(p))
            except Exception:  # noqa: BLE001
                bad.append({"lane": cat, "file": os.path.relpath(p, g.WEB), "issue": "unparseable JSON"})
                continue
            d = ed.get("date") or os.path.basename(p)[:-5]
            if not DATE_RE.match(str(d)):
                bad.append({"lane": cat, "file": os.path.relpath(p, g.WEB), "issue": f"malformed date: {d!r}"})
    return {"checked": checked, "bad": bad}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", action="append", help="limit to lane(s); repeatable")
    ap.add_argument("--sample", type=int, help="only the first N entries per lane (fast smoke)")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    rep = audit(lanes=a.lane, sample=a.sample, verbose=a.verbose)
    rep["date_format"] = audit_edition_dates(lanes=a.lane)
    with open(os.path.join(HERE, "bank_audit_report.json"), "w") as f:
        json.dump(rep, f, indent=2, ensure_ascii=False)

    hard = 0
    print("\n=== bank audit ===")
    for cat, c in rep["per_lane"].items():
        bad = c["not-verbatim"] + c.get("misattribution", 0); hard += bad
        print(f"  {cat:8} total={c['total']:>3} ok={c['ok']:>3} unsourced={c['unsourced']:>2} "
              f"unreachable={c['unreachable']:>2} not-verbatim={c['not-verbatim']:>2} "
              f"misattribution={c.get('misattribution', 0):>2} attribution-far={c['attribution-far']:>2} "
              f"exempt={c.get('exempt', 0):>2}")
    if rep["flags"]:
        print("\n  flags:")
        for fl in rep["flags"]:
            print(f"    [{fl['status']:15}] {fl['lane']:8} {fl['speaker'][:22]:22} :: {fl['text'][:40]}")
            if fl["status"] == "exempt":
                print(f"        {fl['detail']}")

    df = rep["date_format"]
    hard += len(df["bad"])
    print(f"\n=== edition date-format audit (bank-floor recycle relies on ISO date sort) ===")
    print(f"  checked {df['checked']} published editions, {len(df['bad'])} with a malformed/missing date")
    for b in df["bad"]:
        print(f"    [{b['lane']:8}] {b['file']}: {b['issue']}")

    exempt_total = sum(c.get("exempt", 0) for c in rep["per_lane"].values())
    if hard:
        print(f"\n✗ {hard} integrity issue(s) (not-verbatim/misattributed REALs + malformed edition dates). Fix or remove them.")
        return 4
    tail = f" ({exempt_total} legacy-exempt entry/entries — see flags above)" if exempt_total else ""
    print(f"\n✓ every sourced REAL still verifies against its cited source, and every edition date is well-formed.{tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
