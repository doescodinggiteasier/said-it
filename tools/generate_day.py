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

LLM provider is auto-detected from env (provider-agnostic — JSON via prompt, tolerant parse), preferring
Gemini (free GCP credit, CLAUDE.md rule 7) and falling back to Claude if Gemini errors:
  - GEMINI_API_KEY set                         -> Gemini via AI Studio (works in CI; the cron uses this).
  - else GOOGLE_CLOUD_PROJECT / ADC present    -> Gemini via Vertex AI (gemini-3.1-pro-preview; local runs).
  - else ANTHROPIC_API_KEY                     -> Claude Sonnet (fallback).
Hybrid: the strong creative model writes the fakes (the product); a fast model does the mechanical JSON steps.

Usage:  python generate_day.py [--date YYYY-MM-DD] [--force] [--politics] [--category general|sports|music]
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
USED = os.path.join(HERE, "used_quotes.json")     # ledger of every quote ever published — NEVER repeat one

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

# G-C category packs. The shared-daily-instance gate holds PER LANE: everyone in a lane gets the same 6.
# Politics stays OFF (a separate Wes decision). Add lanes here; each gets its own evergreen bank + ledger.
CATEGORIES = {
    "general": {"feeds": FEEDS, "lane": "", "allow_politics": False,
                "figures": "different public figures across sports, tech, science, music, film and food"},
    "sports":  {"feeds": {"sports": ["https://www.espn.com/espn/rss/news", "https://api.foxsports.com/v1/rss"]},
                "lane": "SPORTS ", "allow_politics": False,
                "figures": "different real NON-politician athletes, coaches and sports figures"},
    "music":   {"feeds": {"music": ["https://www.rollingstone.com/music/feed/", "https://pitchfork.com/rss/news/"]},
                "lane": "MUSIC ", "allow_politics": False,
                "figures": "different real musicians, singers, producers and music figures"},
    # The politics LANE (opt-in; the dial is ON). Political figures/process allowed; HARD_DENY still gates
    # crime/violence/slur/scandal/conflict. Fakes must be LIGHT + balanced; reals are cross-validated (strict).
    "politics": {"feeds": {"politics": ["https://feeds.npr.org/1014/rss.xml", "https://www.politico.com/rss/politicopicks.xml"]},
                 "lane": "POLITICS ", "allow_politics": True,
                 "figures": "different real politicians/political figures BALANCED across parties — only LIGHT, "
                            "funny, non-inflammatory lines (gaffes, witty asides), NEVER an attack or hot-take"},
}

def evergreen_path(cat): return EVERGREEN if cat == "general" else os.path.join(HERE, f"evergreen_{cat}.json")
def used_path(cat): return USED if cat == "general" else os.path.join(HERE, f"used_{cat}.json")
def daily_dir(cat): return DAILY if cat == "general" else os.path.join(DAILY, cat)
def target_path(cat, date): return os.path.join(daily_dir(cat), f"{date}.json")

# HARD denylist — ALWAYS dropped, in EVERY lane incl. politics: crime/violence/death/slur/scandal/conflict/
# medical. The no-fabricated-crime/slur/defamation guard never relaxes, even for politicians.
HARD_DENY = [
    "abortion", "shooting", "shooter", "killed", "dead", "death", "died", "suicide", "rape", "assault",
    "war", "hamas", "israel", "gaza", "ukraine", "russia", "putin", "terror", "terrorist", "lawsuit",
    "arrested", "charged", "indicted", "accused", "guilty", "convicted", "racist", "slur", "nazi",
    "overdose", "crash", "victim", "scandal", "impeach", "epstein", "shooting",
    # keep editions light: no health/mental-health/medical topics (real or fake)
    "bipolar", "depression", "diagnosis", "diagnosed", "cancer", "disorder", "rehab", "addiction",
    "mental health", "illness", "tumor", "disease", "suicidal", "anxiety", "therapy",
]
# POLITICAL-topic terms — dropped in EVERY lane EXCEPT the opt-in `politics` lane (the dial). Names + office
# + process; relaxing these is what "politics on" means, while HARD_DENY still gates the dangerous content.
POLITICAL_TERMS = [
    "trump", "biden", "obama", "clinton", "bush", "reagan", "harris", "pence", "president", "senator",
    "congress", "election", "republican", "democrat", "governor", "mayor", "parliament", "minister",
    "prime minister", "campaign", "candidate", "ballot", "politician", "white house", "congressman",
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
FAKE_TMPL = """Write {n} DISTINCT fake quotes for today's {lane}game. Vary them hard: {figures}, and
different comedic registers (a quietly absurd boast; an oddly specific technical detail; a deadpan
admission; a wholesome invented anecdote). Each must be funny-plausible and HARMLESS. Avoid politics entirely.

Output a JSON array; each element EXACTLY:
{{"text": "<the fabricated quote, no surrounding quotes>", "speaker": "<a real non-politician public figure>",
  "context": "<supposedly where/when, short>", "fake_note": "<1-2 sentences for the reveal: what makes it
  plausible + the tell>", "sneaky": <true for the ONE you think is hardest to catch, else false>}}"""

SCREEN_SYS = ("You screen INTENTIONALLY-FABRICATED quotes for a clearly-labeled 'real or fake?' game. "
              "Fabrication is the entire point and is disclosed to players, so do NOT flag a quote merely "
              "for being made up or attributed to a real person. Judge ONLY whether the CONTENT is harmful. "
              "Output STRICT JSON only.")
SCREEN_TMPL = """These are intentionally fabricated, clearly-labeled quotes for a light game (players know they
may be fake). For each, mark "safe": false ONLY if its CONTENT is genuinely harmful — an invented crime,
scandal, sexual content, slur, hate, a medical/health claim, death/tragedy, or a damaging real-world
accusation. Harmless, funny, wholesome, or mundane content is SAFE (true) — even though it is fabricated.

ITEMS:
{items}

Output a JSON array of objects EXACTLY: {{"i": <index>, "safe": <true|false>}}"""

VALIDATE_SYS = ("You are an independent attribution RED-FLAG checker for a 'real or fake?' game. Each quote has "
                "ALREADY been verified to appear verbatim on a cited reputable source — so do NOT re-verify from "
                "memory. Your ONLY job: catch CLEAR problems — an obviously wrong/swapped attribution, a known "
                "satirical or fabricated 'quote', an anachronism, or content that plainly contradicts who the "
                "person is. DEFAULT to ok=true; mark ok=false ONLY with a SPECIFIC concrete reason, never mere "
                "unfamiliarity. Output STRICT JSON only.")
VALIDATE_TMPL = """Each quote below was already confirmed to appear VERBATIM on a reputable source. Flag ok=false
ONLY for a clear red flag (wrong attribution, known fake/satire, anachronism, obvious fabrication). If you simply
don't recognize a quote, that is NOT a reason to flag it — mark ok=true.

ITEMS:
{items}

Output a JSON array EXACTLY: [{{"i": <index>, "ok": <true|false>, "why": "<short reason>"}}]"""


# ---------- LLM (provider-agnostic) ----------
ADC_PATH = os.path.expanduser("~/.config/gcloud/application_default_credentials.json")

def _gemini_mode():
    """Which Gemini transport is available. AI-Studio key wins (works in CI); else Vertex via ADC (local)."""
    if os.environ.get("GEMINI_API_KEY"):
        return "aistudio"
    if os.environ.get("GOOGLE_CLOUD_PROJECT") or os.path.exists(ADC_PATH):
        return "vertex"
    return None

def _vertex_project():
    p = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if p:
        return p
    try:
        return json.load(open(ADC_PATH)).get("quota_project_id")
    except Exception:  # noqa: BLE001
        return None

def _fast_model():
    # Mechanical JSON steps (extraction, safety screen): a fast non-thinking model — more reliable for JSON
    # arrays than a thinking model. IDs differ by transport (Vertex preview IDs vs AI-Studio GA IDs).
    return os.environ.get("SAIDIT_GEMINI_FAST") or ("gemini-3.1-flash-lite" if _gemini_mode() == "vertex" else "gemini-2.5-flash")

def _call_gemini(system: str, prompt: str, model: str | None = None) -> str:
    from google import genai  # type: ignore
    mode = _gemini_mode()
    if mode == "vertex":     # local: Vertex AI via ADC (gcloud auth application-default login) — the working route
        client = genai.Client(vertexai=True, project=_vertex_project(),
                              location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"))
        model = model or os.environ.get("SAIDIT_GEMINI_MODEL", "gemini-3.1-pro-preview")
    else:                    # CI: Gemini Developer API (AI Studio) via GEMINI_API_KEY
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        model = model or os.environ.get("SAIDIT_GEMINI_MODEL", "gemini-3.1-pro")
    r = client.models.generate_content(model=model, contents=system + "\n\n" + prompt)
    return r.text or ""


def _call_claude(system: str, prompt: str, max_tokens: int) -> str:
    import anthropic  # type: ignore
    client = anthropic.Anthropic()
    model = os.environ.get("SAIDIT_MODEL", "claude-sonnet-4-6")
    r = client.messages.create(model=model, max_tokens=max_tokens, system=system,
                                messages=[{"role": "user", "content": prompt}])
    return "".join(b.text for b in r.content if getattr(b, "type", None) == "text")


def llm(system: str, prompt: str, max_tokens: int = 2000, gemini_model: str | None = None) -> str:
    """Prefer Gemini (free GCP credit, CLAUDE.md rule 7); fall back to Claude if Gemini errors or is
    misconfigured — so a bad Gemini key/model can never silently break the unattended cron.
    `gemini_model` overrides the Gemini model for this call (mechanical steps pass the fast model)."""
    order = []
    if _gemini_mode():
        order.append("gemini")
    if os.environ.get("ANTHROPIC_API_KEY"):
        order.append("claude")
    if not order:
        raise RuntimeError("No LLM key: set GEMINI_API_KEY (preferred) or ANTHROPIC_API_KEY.")
    last = None
    for prov in order:
        try:
            return _call_gemini(system, prompt, gemini_model) if prov == "gemini" else _call_claude(system, prompt, max_tokens)
        except Exception as e:  # noqa: BLE001
            last = e
            tail = "falling back to next provider" if prov != order[-1] else "no more providers"
            print(f"  ! LLM '{prov}' failed ({e.__class__.__name__}: {str(e)[:120]}) — {tail}", file=sys.stderr)
    raise last


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


def deny_hit(*parts, allow_politics=False):
    blob = " " + _norm(" ".join(p or "" for p in parts)) + " "
    terms = HARD_DENY if allow_politics else (HARD_DENY + POLITICAL_TERMS)
    return any((" " + w + " ") in blob for w in terms)


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
def gather_reals(feeds, days, used, cat="general", want=6):
    ap = CATEGORIES.get(cat, {}).get("allow_politics", False)
    items = []
    for domain, urls in feeds.items():
        for u in urls:
            for g in fetch_feed(u, days):
                g["domain"] = domain
                items.append(g)
    random.shuffle(items)
    # screen feed-level by denylist, then ask the LLM to extract candidate quotes from a batch
    items = [it for it in items if not deny_hit(it["title"], it["summary"], allow_politics=ap)][:30]
    if not items:
        return []
    block = "\n".join(f'{i} | {it["domain"]} | {it["title"]}. {it["summary"][:400]}' for i, it in enumerate(items))
    try:
        cands = largest_json(llm(REAL_SYS, REAL_TMPL.format(k=12, items=block), max_tokens=2500, gemini_model=_fast_model())) or []
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
        if not q or not sp or deny_hit(q, sp, c.get("context"), allow_politics=ap):
            continue
        if not named_speaker(sp):           # a quote game needs a named human, not "Scientists"
            continue
        if q.lower() in seen or _norm(q) in used:   # never repeat a quote that's already been published
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
    verified = validate_reals(verified, strict=ap)   # cross-LLM attribution check (replaces the human fact-check)
    print(f"  reals: {len(verified)} verified verbatim + cross-validated (of {len(cands) if isinstance(cands, list) else 0} proposed)")
    return verified


def forge_fakes(used, cat="general", n=6):
    meta = CATEGORIES.get(cat, CATEGORIES["general"])
    try:
        fakes = largest_json(llm(FAKE_SYS, FAKE_TMPL.format(n=n, lane=meta["lane"], figures=meta["figures"]), max_tokens=2500)) or []
    except Exception as e:  # noqa: BLE001
        print(f"  ! fakes LLM: {e}", file=sys.stderr); return []
    ap = meta.get("allow_politics", False)
    out = []
    for f in fakes if isinstance(fakes, list) else []:
        if f.get("text") and f.get("speaker") and not deny_hit(f["text"], f["speaker"], f.get("context"), allow_politics=ap) \
                and _norm(f["text"]) not in used:      # never repeat a published quote (real or fake)
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
        verdicts = largest_json(llm(SCREEN_SYS, SCREEN_TMPL.format(items=block), max_tokens=800, gemini_model=_fast_model())) or []
        unsafe = {int(v["i"]) for v in verdicts if isinstance(v, dict) and v.get("safe") is False}
        # guard: a screen that flags MOST items is misfiring (e.g. flagging fabrication itself) — the
        # deterministic denylist already gates real harm, so don't let a bad screen nuke the whole set.
        if len(unsafe) > len(screenable) // 2:
            print(f"  ! screen flagged {len(unsafe)}/{len(screenable)} — likely misfiring; keeping denylist-filtered set", file=sys.stderr)
            return quotes
        return [q for i, q in enumerate(quotes) if i not in unsafe]
    except Exception as e:  # noqa: BLE001
        print(f"  ! screen LLM (keeping set): {e}", file=sys.stderr)
        return quotes


def _call_other(system, prompt):
    """Use a DIFFERENT model/provider than the primary, for an adversarial cross-check. Gemini-primary →
    validate with Claude (cross-provider); otherwise validate with Gemini Pro (≠ the fast extraction model)."""
    if _gemini_mode() and os.environ.get("ANTHROPIC_API_KEY"):
        return _call_claude(system, prompt, 1500)
    if _gemini_mode():
        return _call_gemini(system, prompt, os.environ.get("SAIDIT_GEMINI_MODEL", "gemini-3.1-pro-preview"))
    return _call_claude(system, prompt, 1500)


def validate_reals(reals, strict=False):
    """Independent cross-LLM attribution check on top of the verbatim match (replaces the human fact-check).
    `strict` (politics lane) runs a SECOND, independent reviewer-of-the-reviewer pass and unions the rejects."""
    if not reals:
        return reals
    def _pass():
        block = "\n".join(f'{i}: "{r["text"]}" — {r["speaker"]} ({r.get("context", "")[:80]})' for i, r in enumerate(reals))
        v = largest_json(_call_other(VALIDATE_SYS, VALIDATE_TMPL.format(items=block))) or []
        bad = {int(x["i"]) for x in v if isinstance(x, dict) and x.get("ok") is False and 0 <= int(x["i"]) < len(reals)}
        if len(bad) > len(reals) // 2:                # a pass that flags the majority is misfiring (over-rejecting)
            print(f"  ! cross-validate pass flagged {len(bad)}/{len(reals)} — likely misfiring; ignoring this pass", file=sys.stderr)
            return set()
        return bad
    try:
        bad = _pass()
        if strict:
            bad = bad | _pass()                       # reviewer-of-the-reviewer (a 2nd independent pass)
        kept = [r for i, r in enumerate(reals) if i not in bad]
        if len(kept) < len(reals):
            print(f"  cross-validate: dropped {len(reals) - len(kept)}/{len(reals)} reals (attribution doubt)", file=sys.stderr)
        return kept
    except Exception as e:  # noqa: BLE001
        print(f"  ! cross-validate failed (keeping verbatim-verified reals): {e}", file=sys.stderr)
        return reals


def load_evergreen(cat="general"):
    try:
        return json.load(open(evergreen_path(cat)))
    except Exception:  # noqa: BLE001
        return []


def load_used(cat="general"):
    """Set of normalized texts of every quote ever published in this lane — no repeats, ever, per category."""
    try:
        return set(json.load(open(used_path(cat))))
    except Exception:  # noqa: BLE001
        return set()


def save_used(used, cat="general"):
    json.dump(sorted(used), open(used_path(cat), "w"), indent=0)


def assemble(date, reals_fresh, fakes, evergreen, used, cat="general"):
    n_real = random.choice([2, 3, 3])                      # vary the ratio so it isn't always 3:3
    reals = list(reals_fresh[:n_real])
    pool = [e for e in evergreen if _norm(e["text"]) not in used]   # only evergreen quotes never published
    if len(reals) < n_real and pool:                       # top up from the UNUSED vetted evergreen bank
        for r in random.sample(pool, min(len(pool), n_real - len(reals))):
            r = dict(r); r["real"] = True; r["_vetted"] = True; reals.append(r)
    n_fake = 6 - len(reals)
    fakes = fakes[:n_fake]
    quotes = reals + fakes
    if len(quotes) < 5 or sum(1 for q in quotes if q["real"]) < 2 or sum(1 for q in quotes if not q["real"]) < 2:
        return None                                        # fail-safe: not a quality / non-repeating set
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
    return {"date": date, "edition": None, "category": cat,
            "curator": "auto (generate_day.py — reals verified verbatim vs source + cross-validated)",
            "politics_dial": ("on" if cat == "politics" else "off"), "trickiest_fake": trick, "quotes": out_quotes}


def update_manifest(date, cat="general"):
    path = os.path.join(DAILY, "index.json")        # one manifest at the root; lanes nest under categories
    try:
        idx = json.load(open(path))
    except Exception:  # noqa: BLE001
        idx = {"game": "Said It?", "days": []}
    cats = idx.get("categories") or {}
    cats[cat] = sorted(set(cats.get(cat, []) + [date]))
    idx["categories"] = cats
    if cat == "general":                            # back-compat: `days` mirrors the general lane
        idx["days"] = sorted(set(idx.get("days", []) + [date]))
    json.dump(idx, open(path, "w"), indent=2)
    return len(cats[cat])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--politics", action="store_true")
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--category", default="general", choices=list(CATEGORIES.keys()))
    a = ap.parse_args()
    cat = a.category

    target = target_path(cat, a.date)
    os.makedirs(daily_dir(cat), exist_ok=True)
    if os.path.exists(target) and not a.force:
        print(f"{cat}/{a.date} already exists — skipping (use --force to regenerate)."); return 0

    politics_on = CATEGORIES[cat].get("allow_politics") or (a.politics and cat == "general")
    print(f"== generating [{cat}] {a.date} (politics {'ON' if politics_on else 'OFF'}) ==")
    feeds = dict(CATEGORIES[cat]["feeds"])
    if a.politics and cat == "general":
        feeds["politics"] = POLITICS_FEEDS

    used = load_used(cat)
    print(f"  used-quote ledger [{cat}]: {len(used)} already-published quotes excluded")
    reals = gather_reals(feeds, a.days, used, cat)
    fakes = forge_fakes(used, cat, 8)            # lane-aware, forge extra for headroom
    fakes = safety_screen(fakes)                 # screen the fabricated content UP FRONT (not post-assembly)
    print(f"  fakes: {len(fakes)} forged + screened safe")
    edition = assemble(a.date, reals, fakes, load_evergreen(cat), used, cat)
    if not edition:
        print(f"  FAIL-SAFE [{cat}]: could not assemble a quality, NON-REPEATING set (>=5 quotes, >=2 real, "
              f">=2 fake). Wrote nothing (grow evergreen_{cat if cat!='general' else 'reals'}.json or add "
              "quote-rich feeds for this lane).", file=sys.stderr)
        return 2

    n = update_manifest(a.date, cat)             # edition number = position in this lane's manifest
    edition["edition"] = n
    json.dump(edition, open(target, "w"), indent=2, ensure_ascii=False)
    used |= {_norm(q["text"]) for q in edition["quotes"]}   # never publish these again in this lane
    save_used(used, cat)
    print(f"  WROTE {target}  (edition {n}, {len(edition['quotes'])} quotes, "
          f"{sum(1 for q in edition['quotes'] if q['real'])} real / {sum(1 for q in edition['quotes'] if not q['real'])} fake)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
