#!/usr/bin/env python3
"""Said It? — daily social-post generator (the content-account flywheel; STRATEGY.md long-game "B").

Builds a ready-to-post social card for the PRIOR day's MOST-FOOLED quote — the day's best viral atom
("X% thought this was real — was it?") with a one-tap deep link back into the playable set. It is marketing,
product and a k-seed in one, at ~zero cost.

  *** THIS TOOL POSTS NOTHING. *** It writes the post text + an image/caption spec to stdout and a JSON file
  for a human to review and post. (Posting is a human/ops step — see "Wiring to a daily Action" below.)

Source of the fooled-rate, best available first:
  1. --completions <export.json>   a completions export in the difficulty.py shape
                                    [{ "day": "YYYY-MM-DD", "cat"|"lane": "general", "n": 6, "gotme": [2,5] }]
  2. env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   → fetch that day's completions via PostgREST (gotme jsonb)
  3. fallback: the edition's editorial `trickiest_fake` flag (no live data needed — works today, day one)

The chosen quote is always a FAKE (most-fooled = most-often called real but wasn't). The post is SPOILER-SAFE
(it asks "was it real?", never reveals) and always carries the game frame + the "some quotes are invented by
Mags" disclaimer, so a fabricated line never goes out as an unlabeled assertion (see CONTENT_RISK_POLICY.md §3).

Usage:
  python daily_social_post.py [--date YYYY-MM-DD] [--category all|general|sports|music|politics|movies|nsfw]
                              [--completions export.json] [--base https://saidit.app]
                              [--out daily_post_<date>.json] [--min-plays 5]

Wiring to a daily GitHub Action later (NOT set up here — distribution is a deliberate human decision):
  - Add a step AFTER the daily-editions job that runs:  python tools/daily_social_post.py --date <yesterday>
    --completions <export>  (or with SUPABASE_* secrets in env to read live fooled-rate).
  - Upload the JSON (and a rendered PNG once an image renderer is added) as an artifact, OR pipe to a
    review channel (Slack/email). Keep a HUMAN in the loop before anything is posted — the post shows a
    fabricated quote on a real person; a person must confirm it's innocuous + on-brand first.
  - When ready to auto-post, hand the JSON to your platform's API in a separate, clearly-gated step.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(HERE, ".."))
DAILY = os.path.join(WEB, "daily")

# lane display + the brand hue per lane (mirrors web/src/data.js LANE_HUES so cards stay on-brand)
LANE_NAME = {"general": "Said It?", "sports": "Sports", "music": "Music", "politics": "Politics",
             "movies": "Movies", "nsfw": "Off the Record"}
LANE_HUE = {"general": "#4C6EF5", "sports": "#20C4A8", "music": "#9775FA", "politics": "#FF922B",
            "movies": "#FF8FAB", "nsfw": "#7048E8"}
LANES = ["general", "sports", "music", "politics", "movies", "nsfw"]


def edition_path(cat, date):
    return os.path.join(DAILY, f"{date}.json") if cat == "general" else os.path.join(DAILY, cat, f"{date}.json")


def load_edition(cat, date):
    try:
        return json.load(open(edition_path(cat, date)))
    except Exception:  # noqa: BLE001
        return None


# ---------- fooled-rate sources ----------
def fooled_index(comps, date):
    """comps: [{day, cat|lane, gotme:[1-indexed pos]}]. → ({cat: plays}, {(cat,pos): fooled_count}) for `date`."""
    plays, fooled = {}, {}
    for c in comps or []:
        if str(c.get("day")) != date:
            continue
        cat = c.get("cat") or c.get("lane") or "general"
        plays[cat] = plays.get(cat, 0) + 1
        seen = set()  # a quote can fool a player at most ONCE — dedupe positions within a completion
        for pos in (c.get("gotme") or []):
            try:
                pos = int(pos)
            except (TypeError, ValueError):
                continue
            if pos in seen:
                continue
            seen.add(pos)
            fooled[(cat, pos)] = fooled.get((cat, pos), 0) + 1
    return plays, fooled


def fetch_supabase_completions(date):
    """Best-effort PostgREST read of one day's completions (service-role, from env). Returns [] on any problem."""
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return []
    endpoint = url.rstrip("/") + f"/rest/v1/completions?day=eq.{date}&select=lane,n,gotme"
    req = urllib.request.Request(endpoint, headers={"apikey": key, "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 (trusted, env-provided URL)
            return json.load(r)
    except Exception as e:  # noqa: BLE001
        print(f"  ! supabase read failed ({e}); falling back", file=sys.stderr)
        return []


# ---------- pick the most-fooled fake ----------
def most_fooled(date, category, comps, min_plays):
    """Return (cat, edition, quote, fooled_pct, plays, source). fooled_pct/plays are None on editorial fallback."""
    cats = LANES if category == "all" else [category]
    plays, fooled = fooled_index(comps, date)
    best = None  # (pct, plays, cat, edition, quote)
    for cat in cats:
        ed = load_edition(cat, date)
        if not ed:
            continue
        n = plays.get(cat, 0)
        if n < min_plays:
            continue
        for i, q in enumerate(ed.get("quotes", [])):
            if q.get("real"):
                continue  # only a FAKE can be "most fooled"
            pct = min(100, round(100 * fooled.get((cat, i + 1), 0) / n))
            if best is None or pct > best[0]:
                best = (pct, n, cat, ed, q)
    if best:
        pct, n, cat, ed, q = best
        return cat, ed, q, pct, n, "real_fooled_rate"
    # ---- fallback: the edition's editorial trickiest_fake ----
    for cat in cats:
        ed = load_edition(cat, date)
        if not ed:
            continue
        tf = ed.get("trickiest_fake")
        q = next((x for x in ed.get("quotes", []) if x.get("id") == tf and not x.get("real")), None) \
            or next((x for x in ed.get("quotes", []) if not x.get("real")), None)
        if q:
            return cat, ed, q, None, None, "editorial_trickiest_fake"
    return None, None, None, None, None, None


# ---------- build the post ----------
DISCLAIMER = "Said It? mixes real quotes with ones Mags makes up — play to spot the fakes. (Some quotes are invented.)"


def deep_link(base, date, cat):
    # ?d= opens that day's set (the app's existing deep-link); &c= names the lane for when the app parses it
    # (forward-compatible — today it's ignored and the set still opens). See the Batch 3 deep-link note.
    link = base.rstrip("/") + f"/?d={date}&src=social"
    if cat != "general":
        link += f"&c={cat}"
    return link


def build_post(cat, ed, q, pct, plays, source, base, date):
    speaker = q.get("speaker", "")
    text = q.get("text", "")
    link = deep_link(base, date, cat)
    lane_label = LANE_NAME.get(cat, "Said It?")
    if pct is not None:
        hook = f"🤔 {pct}% of players thought this was REAL yesterday. Was it?"
    else:
        hook = "🤔 Real, or made up? Yesterday's trickiest one."
    post_text = (
        f"{hook}\n\n"
        f"“{text}”\n— {speaker}\n\n"
        f"Tap to play and find out 👉 {link}\n\n"
        f"{DISCLAIMER}"
    )
    alt = f"A quote card reading “{text}” attributed to {speaker}, from the daily game Said It?"
    image_spec = {
        "size": "1080x1080",
        "brand": "Said It?",
        "lane": lane_label,
        "accent_hex": LANE_HUE.get(cat, "#4C6EF5"),
        "headline": (f"{pct}% thought this was REAL" if pct is not None else "Real, or made up?"),
        "quote": text,
        "attribution": speaker,
        "context": q.get("context", ""),
        "cta": "Real or fake? Play at saidit.app",
        "footer_disclaimer": DISCLAIMER,
        "reveal_answer": False,   # NEVER reveal real/fake on the card — the hook is the question
        "notes": "Quote in large serif; attribution smaller below; big % headline in the lane accent; Said It? "
                 "wordmark + magpie; spoiler-safe (no REAL/FAKE stamp). Footer disclaimer always present.",
    }
    return {
        "generated_for_date": date,
        "category": cat,
        "lane_label": lane_label,
        "source": source,
        "fooled_pct": pct,
        "plays": plays,
        "quote": {"text": text, "speaker": speaker, "context": q.get("context", ""), "id": q.get("id")},
        "deep_link": link,
        "post_text": post_text,
        "alt_text": alt,
        "image_spec": image_spec,
        "hashtags": ["#SaidIt", "#RealOrFake", "#QuizTime", "#" + lane_label.replace(" ", "")],
        "review_before_posting": [
            "Confirm the quote is INNOCUOUS (not reputation-harming if believed) — see CONTENT_RISK_POLICY.md.",
            "Confirm the disclaimer line is present (a fabricated line must never post as an unlabeled assertion).",
            "Do NOT reveal whether it's real or fake (spoiler-safe drives the click).",
            "Verify the deep link opens the right set.",
        ],
    }


def main(argv):
    ap = argparse.ArgumentParser(description="Generate (do not post) a daily social card for the most-fooled quote.")
    ap.add_argument("--date", default=(dt.date.today() - dt.timedelta(days=1)).isoformat(),
                    help="edition date (default: yesterday)")
    ap.add_argument("--category", default="all", choices=["all"] + LANES)
    ap.add_argument("--completions", help="path to a completions export (difficulty.py shape) for real fooled-rate")
    ap.add_argument("--base", default="https://saidit.app", help="deep-link base URL")
    ap.add_argument("--out", help="output JSON path (default: tools/daily_post_<date>.json)")
    ap.add_argument("--min-plays", type=int, default=5, help="min plays in a lane to trust its fooled-rate")
    a = ap.parse_args(argv)

    comps = []
    if a.completions:
        try:
            comps = json.load(open(a.completions))
        except Exception as e:  # noqa: BLE001
            print(f"  ! could not read {a.completions} ({e}); trying Supabase / fallback", file=sys.stderr)
    if not comps:
        comps = fetch_supabase_completions(a.date)

    cat, ed, q, pct, plays, source = most_fooled(a.date, a.category, comps, a.min_plays)
    if not q:
        print(f"No fake found for {a.date} (category={a.category}). Nothing to post — has that edition published?",
              file=sys.stderr)
        return 2

    post = build_post(cat, ed, q, pct, plays, source, a.base, a.date)
    out = a.out or os.path.join(HERE, f"daily_post_{a.date}.json")
    json.dump(post, open(out, "w"), indent=2, ensure_ascii=False)

    pct_str = f"{pct}% fooled" if pct is not None else "editorial trickiest_fake (no live fooled-rate yet)"
    print(f"== Said It? daily post — {a.date} · {post['lane_label']} · {pct_str} ==")
    print(f"   source: {source}\n")
    print(post["post_text"])
    print(f"\n   [image spec + metadata written to {out}]  — review, then post by hand. THIS TOOL POSTED NOTHING.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
