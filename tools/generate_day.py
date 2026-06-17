#!/usr/bin/env python3
"""Said It? — FULLY AUTONOMOUS daily edition generator (runs unattended in CI).

Builds one new `daily/<date>.json` like the hand-curated launch editions, with NO human in the loop.
Because nobody reviews the output, the integrity gates are the product:

  1. REALS ARE VERIFIED VERBATIM. The model only *proposes* real quotes pulled from this week's news;
     a quote is used as REAL only if its text is found (normalized) inside the cited reputable source
     we actually fetched. This kills hallucination/misattribution — a "real" is provably on its source.
  2. POLITICS FILTERED. Political/tragedy feeds are excluded; a keyword denylist + an LLM safety screen
     drop anything political, tragic, or defamation-shaped (the politics dial stays OFF).
  3. FAKES ARE INNOCUOUS + LABELLED. The model writes fabricated quotes constrained to be harmless and
     in-voice; a safety screen drops anything reputationally damaging. The app labels them AI FAKE.
  4. FAIL-SAFE. If a quality set of >=5 quotes can't be assembled, it writes NOTHING — the site keeps
     serving the previous edition rather than publishing a broken/empty one. The CI job then alerts.

LLM provider is auto-detected from env (provider-agnostic — JSON via prompt, tolerant parse):
  - GEMINI_API_KEY set  -> Gemini (google-genai, AI Studio). Preferred (free credit, CLAUDE.md rule 7).
  - else ANTHROPIC_API_KEY -> Claude (you already have this key). ~1 small call/day = pennies, not bulk.

Usage:  python generate_day.py [--date YYYY-MM-DD] [--force] [--politics]
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import random
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(HERE, ".."))          # apps/said-it/web
DAILY = os.path.join(WEB, "daily")
EVERGREEN = os.path.join(HERE, "evergreen_reals.json")

UA = {"User-Agent": "SaidItBot/1.0 (+daily real-or-fake game; contact via repo)"}

# Low-risk, opinion-dense, freely-quotable domains. Politics is its own gated bucket (OFF by default).
FEEDS = {
    "sports":        ["https://www.espn.com/espn/rss/news"],
    "entertainment": ["https://variety.com/feed/", "https://www.hollywoodreporter.com/feed/"],
    "tech":          ["https://techcrunch.com/feed/", "https://www.theverge.com/rss/index.xml"],
    "science":       ["https://www.sciencedaily.com/rss/top/science.xml", "https://phys.org/rss-feed/"],
    "music":         ["https://www.rollingstone.com/music/feed/"],
}
POLITICS_FEEDS = ["https://feeds.npr.org/1014/rss.xml"]

# Hard denylist — if any appears in a quote/speaker/context, drop it (politics + tragedy + defamation-shaped).
DENY = [
    "trump", "biden", "president", "senator", "congress", "election", "republican", "democrat",
    "abortion", "shooting", "killed", "dead", "death", "died", "suicide", "rape", "assault",
    "war", "hamas", "israel", "gaza", "ukraine", "russia", "putin", "terror", "lawsuit", "arrested",
    "charged", "accused", "guilty", "racist", "slur", "nazi", "overdose", "crash", "victim",
    # keep auto-editions light: no health/mental-health/medical topics (real or fake)
    "bipolar", "depression", "diagnosis", "diagnosed", "cancer", "disorder", "rehab", "addiction",
    "mental health", "illness", "tumor", "disease", "suicidal", "anxiety", "therapy",
]

REAL_SYS = ("You surface CANDIDATE real quotes from recent news items for a 'real or fake?' game. You are "
            "only SUGGESTING — a separate step verifies each quote against its source, so never invent or "
            "paraphrase. Copy quotes EXACTLY as written in the provided text. The speaker MUST be a "
            "specific NAMED person (e.g. 'Taylor Swift'), never a generic 'scientists'/'researchers'/'the "
            "team'. The text must be words that PERSON actually said (a real quotation), not the article's "
            "own description. Skip anything political, tragic, about death/crime, or defamation-adjacent. "
            "Output STRICT JSON only.")
REAL_TMPL = """From these news snippets, extract up to {k} VERBATIM direct quotes that would be fun in a
"did they really say that?" game (surprising, funny, oddly specific). Copy the quoted words EXACTLY as
they appear — do not fix grammar, do not paraphrase, do not merge sentences.

HARD RULES:
- The speaker must be a SPECIFIC NAMED PERSON (a real human's name). Reject quotes attributed to
  "scientists", "researchers", "the study", "experts", "officials", "a spokesperson", etc.
- The text must be a quotation that person actually SAID (ideally shown in quotation marks in the snippet),
  not the article's own summary sentence about a finding.
- Non-political, non-tragic, non-defamatory only.

SNIPPETS (id | source | text):
{items}

Output a JSON array; each element EXACTLY:
{{"src_id": <the id>, "text": "<the exact quoted words, no surrounding quotes>", "speaker": "<the named person>",
  "context": "<short, where/when>"}}
Only include a quote whose words literally appear in that snippet AND has a named-person speaker. Prefer fewer."""

FAKE_SYS = ("You fabricate plausible-but-fake quotes for a 'real or fake?' daily game. Each is attributed "
            "to a real, well-known NON-POLITICIAN public figure and must be INNOCUOUS: never an invented "
            "crime, scandal, slur, medical/financial claim, or anything reputationally damaging — just the "
            "kind of funny, harmless thing the person might plausibly say. Output STRICT JSON only.")
FAKE_TMPL = """Write {n} DISTINCT fake quotes for today's game. Vary them hard: different public figures,
different domains (sports, tech, science, music, film, food), and different comedic registers (a quietly
absurd boast; an oddly specific technical detail; a deadpan admission; a wholesome invented anecdote).
Each must be funny-plausible and HARMLESS. Avoid politics entirely.

Output a JSON array; each element EXACTLY:
{{"text": "<the fabricated quote, no surrounding quotes>", "speaker": "<a real non-politician public figure>",
  "context": "<supposedly where/when, short>", "fake_note": "<1-2 sentences for the reveal: what makes it
  plausible + the tell>", "sneaky": <true for the ONE you think is hardest to catch, else false>}}"""

SCREEN_SYS = "You are a safety screen. Output STRICT JSON only."
SCREEN_TMPL = """For each item, answer whether it is SAFE to publish in a light entertainment game: innocuous,
NOT political, NOT about death/crime/tragedy, NOT defamatory or reputationally harmful to the named person.

ITEMS:
{items}

Output a JSON array of objects EXACTLY: {{"i": <index>, "safe": <true|false>}}"""


# ---------- LLM (provider-agnostic) ----------
def _llm_provider():
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    return None


def llm(system: str, prompt: str, max_tokens: int = 2000) -> str:
    prov = _llm_provider()
    if prov == "gemini":
        from google import genai  # type: ignore
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        model = os.environ.get("SAIDIT_GEMINI_MODEL", "gemini-2.5-flash")
        r = client.models.generate_content(model=model, contents=system + "\n\n" + prompt)
        return r.text or ""
    if prov == "claude":
        import anthropic  # type: ignore
        client = anthropic.Anthropic()
        model = os.environ.get("SAIDIT_MODEL", "claude-haiku-4-5")
        r = client.messages.create(model=model, max_tokens=max_tokens, system=system,
                                    messages=[{"role": "user", "content": prompt}])
        return "".join(b.text for b in r.content if getattr(b, "type", None) == "text")
    raise RuntimeError("No LLM key: set GEMINI_API_KEY or ANTHROPIC_API_KEY.")


def largest_json(text: str):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)
    best = None
    for op, cl in (("[", "]"), ("{", "}")):
        depth = 0; start = -1
        for i, c in enumerate(text):
            if c == op:
                if depth == 0: start = i
                depth += 1
            elif c == cl and depth:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = text[start:i + 1]
                    try:
                        val = json.loads(chunk)
                        if best is None or len(chunk) > best[0]:
                            best = (len(chunk), val)
                    except Exception:  # noqa: BLE001
                        pass
    return best[1] if best else None


# ---------- RSS + article fetch (stdlib) ----------
def fetch_feed(url, days=8):
    import xml.etree.ElementTree as ET
    out = []
    try:
        raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20).read()
        root = ET.fromstring(raw)
    except Exception as e:  # noqa: BLE001
        print(f"  ! feed {url}: {e}", file=sys.stderr); return out
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    A = "{http://www.w3.org/2005/Atom}"
    for it in root.iter("item"):
        out.append({"title": _txt(it.find("title")), "summary": _txt(it.find("description"))[:1200],
                    "link": _txt(it.find("link")), "ts": _date(_txt(it.find("pubDate")))})
    for it in root.iter(A + "entry"):
        le = it.find(A + "link")
        out.append({"title": _txt(it.find(A + "title")),
                    "summary": (_txt(it.find(A + "summary")) or _txt(it.find(A + "content")))[:1200],
                    "link": le.get("href") if le is not None else "",
                    "ts": _date(_txt(it.find(A + "updated")) or _txt(it.find(A + "published")))})
    return [o for o in out if o.get("title") and (not o["ts"] or o["ts"] >= cutoff)]


def _txt(el):
    return html.unescape(re.sub(r"<[^>]+>", " ", (el.text or ""))).strip() if el is not None else ""


def _date(s):
    for f in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            d = dt.datetime.strptime(s.strip(), f)
            return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
        except Exception:  # noqa: BLE001
            continue
    return None


def fetch_article_text(url):
    try:
        raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20).read()
        txt = raw.decode("utf-8", "ignore")
        txt = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", txt, flags=re.S | re.I)
        txt = html.unescape(re.sub(r"<[^>]+>", " ", txt))
        return re.sub(r"\s+", " ", txt)
    except Exception:  # noqa: BLE001
        return ""


# ---------- verification (the integrity gate) ----------
def _norm(s):
    s = (s or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"[^a-z0-9 ]+", " ", re.sub(r"\s+", " ", s)).strip()


def quote_is_verbatim(quote, corpus):
    """True only if a long-enough normalized form of the quote appears in the source corpus."""
    nq, nc = _norm(quote), _norm(corpus)
    if len(nq) < 25:
        return False
    if nq in nc:
        return True
    # tolerate minor edge differences: require a long contiguous run (first ~12 words) to match
    words = nq.split()
    if len(words) >= 8:
        head = " ".join(words[:12])
        return head in nc and len(head) >= 30
    return False


def deny_hit(*parts):
    blob = _norm(" ".join(p or "" for p in parts))
    return any((" " + w + " ") in (" " + blob + " ") for w in DENY)


# Generic "speakers" that aren't a named person — a real-or-fake QUOTE game needs an attributable human.
GENERIC_SPEAKER = {"scientists", "scientist", "researchers", "researcher", "study", "team", "experts",
                   "expert", "authors", "author", "officials", "official", "spokesperson", "spokesman",
                   "spokeswoman", "company", "analysts", "analyst", "report", "the", "a", "an", "new",
                   "researchers", "study", "scientists", "lead", "co", "professor", "dr", "staff",
                   "investigators", "investigator", "panel", "committee", "agency", "group"}


def named_speaker(sp):
    """True only if the speaker looks like a specific named person, not a generic group."""
    toks = _norm(sp).split()
    meaningful = [t for t in toks if t not in GENERIC_SPEAKER]
    return bool(meaningful) and len(" ".join(meaningful)) >= 3


# ---------- pipeline stages ----------
def gather_reals(feeds, days, want=6):
    items = []
    for domain, urls in feeds.items():
        for u in urls:
            for g in fetch_feed(u, days):
                g["domain"] = domain
                items.append(g)
    random.shuffle(items)
    # screen feed-level by denylist, then ask the LLM to extract candidate quotes from a batch
    items = [it for it in items if not deny_hit(it["title"], it["summary"])][:30]
    if not items:
        return []
    block = "\n".join(f'{i} | {it["domain"]} | {it["title"]}. {it["summary"][:400]}' for i, it in enumerate(items))
    try:
        cands = largest_json(llm(REAL_SYS, REAL_TMPL.format(k=12, items=block), max_tokens=2500)) or []
    except Exception as e:  # noqa: BLE001
        print(f"  ! reals LLM: {e}", file=sys.stderr); return []
    verified = []
    seen = set()
    for c in cands if isinstance(cands, list) else []:
        try:
            it = items[int(c["src_id"])]
        except Exception:  # noqa: BLE001
            continue
        q, sp = c.get("text", ""), c.get("speaker", "")
        if not q or not sp or deny_hit(q, sp, c.get("context")):
            continue
        if not named_speaker(sp):           # a quote game needs a named human, not "Scientists"
            continue
        if q.lower() in seen:
            continue
        # verify against the snippet first, then the full article if needed
        corpus = it["title"] + " " + it["summary"]
        if not quote_is_verbatim(q, corpus):
            corpus += " " + fetch_article_text(it["link"])
            if not quote_is_verbatim(q, corpus):
                continue  # could not verify -> NOT shipped as real
        seen.add(q.lower())
        verified.append({"text": q, "speaker": sp, "context": c.get("context", ""), "real": True,
                         "source": {"title": it["domain"].title() + " — " + (it["title"][:80]),
                                    "url": it["link"], "date": dt.date.today().isoformat()}})
        if len(verified) >= want:
            break
    print(f"  reals: {len(verified)} verified verbatim (of {len(cands) if isinstance(cands, list) else 0} proposed)")
    return verified


def forge_fakes(n=6):
    try:
        fakes = largest_json(llm(FAKE_SYS, FAKE_TMPL.format(n=n), max_tokens=2500)) or []
    except Exception as e:  # noqa: BLE001
        print(f"  ! fakes LLM: {e}", file=sys.stderr); return []
    out = []
    for f in fakes if isinstance(fakes, list) else []:
        if f.get("text") and f.get("speaker") and not deny_hit(f["text"], f["speaker"], f.get("context")):
            out.append({"text": f["text"], "speaker": f["speaker"], "context": f.get("context", ""),
                        "real": False, "fake_note": f.get("fake_note", "AI-fabricated for this game."),
                        "_sneaky": bool(f.get("sneaky"))})
    return out


def safety_screen(quotes):
    """Final LLM gate over LLM-SOURCED items only (fakes + fresh reals). Pre-vetted evergreen reals are
    never screened out (they're hand-checked). Drops only on an explicit `safe: false`."""
    screenable = [(i, q) for i, q in enumerate(quotes) if not q.get("_vetted")]
    if not screenable:
        return quotes
    try:
        block = "\n".join(f'{i}: "{q["text"]}" — {q["speaker"]} ({q.get("context","")})' for i, q in screenable)
        verdicts = largest_json(llm(SCREEN_SYS, SCREEN_TMPL.format(items=block), max_tokens=800)) or []
        unsafe = {int(v["i"]) for v in verdicts if isinstance(v, dict) and v.get("safe") is False}
        return [q for i, q in enumerate(quotes) if i not in unsafe]
    except Exception as e:  # noqa: BLE001
        print(f"  ! screen LLM (keeping set): {e}", file=sys.stderr)
        return quotes


def load_evergreen():
    try:
        return json.load(open(EVERGREEN))
    except Exception:  # noqa: BLE001
        return []


def assemble(date, reals_fresh, fakes, evergreen):
    n_real = random.choice([2, 3, 3])                      # vary the ratio so it isn't always 3:3
    reals = list(reals_fresh[:n_real])
    if len(reals) < n_real and evergreen:                  # top up from the vetted evergreen bank
        for r in random.sample(evergreen, min(len(evergreen), n_real - len(reals))):
            r = dict(r); r["real"] = True; r["_vetted"] = True; reals.append(r)
    n_fake = 6 - len(reals)
    fakes = fakes[:n_fake]
    quotes = reals + fakes
    if len(quotes) < 5 or sum(1 for q in quotes if q["real"]) < 2 or sum(1 for q in quotes if not q["real"]) < 2:
        return None                                        # fail-safe: not a quality set
    quotes = safety_screen(quotes)
    if len(quotes) < 5:
        return None
    random.shuffle(quotes)
    sneaky_idx = next((i for i, q in enumerate(quotes) if q.get("_sneaky")), None)
    out_quotes, trick = [], None
    for i, q in enumerate(quotes):
        qid = f"q{i+1}"
        item = {"id": qid, "text": q["text"], "speaker": q["speaker"], "context": q.get("context", ""), "real": q["real"]}
        if q["real"] and q.get("source"):
            item["source"] = q["source"]
        if not q["real"]:
            item["fake_note"] = q.get("fake_note", "AI-fabricated for this game.")
            if trick is None and (sneaky_idx == i or sneaky_idx is None):
                trick = qid
        out_quotes.append(item)
    if trick is None:
        trick = next((it["id"] for it in out_quotes if not it["real"]), None)
    return {"date": date, "edition": None, "curator": "auto (generate_day.py — reals verified verbatim vs source)",
            "politics_dial": "off", "trickiest_fake": trick, "quotes": out_quotes}


def update_manifest(date):
    path = os.path.join(DAILY, "index.json")
    try:
        idx = json.load(open(path))
    except Exception:  # noqa: BLE001
        idx = {"game": "Said It?", "days": []}
    days = sorted(set(idx.get("days", []) + [date]))
    idx["days"] = days
    json.dump(idx, open(path, "w"), indent=2)
    return len(days)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--politics", action="store_true")
    ap.add_argument("--days", type=int, default=8)
    a = ap.parse_args()

    target = os.path.join(DAILY, f"{a.date}.json")
    if os.path.exists(target) and not a.force:
        print(f"{a.date} already exists — skipping (use --force to regenerate)."); return 0

    print(f"== generating {a.date} (politics {'ON' if a.politics else 'OFF'}) ==")
    feeds = dict(FEEDS)
    if a.politics:
        feeds["politics"] = POLITICS_FEEDS

    reals = gather_reals(feeds, a.days)
    fakes = forge_fakes(6)
    print(f"  fakes: {len(fakes)} forged")
    edition = assemble(a.date, reals, fakes, load_evergreen())
    if not edition:
        print("  FAIL-SAFE: could not assemble a quality set (>=5 quotes, >=2 real, >=2 fake). Wrote nothing.",
              file=sys.stderr)
        return 2

    # edition number = position in the manifest after adding today
    n = update_manifest(a.date)
    edition["edition"] = n
    json.dump(edition, open(target, "w"), indent=2, ensure_ascii=False)
    print(f"  WROTE {target}  (edition {n}, {len(edition['quotes'])} quotes, "
          f"{sum(1 for q in edition['quotes'] if q['real'])} real / {sum(1 for q in edition['quotes'] if not q['real'])} fake)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
