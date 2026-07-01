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
     in-voice; a safety screen drops anything reputationally damaging. The app labels them FAKE (Mags' voice; never 'AI').
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
import subprocess
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
# Politics is ON everywhere (Wes, 2026-06-17): the dedicated lane PLUS mixed into the default general feed.
# HARD_DENY still gates crime/violence/slur/scandal/conflict in every lane; only the political-figure/process
# terms are unblocked. Add lanes here; each gets its own evergreen bank + ledger.
CATEGORIES = {
    "general": {"feeds": {**FEEDS, "politics": POLITICS_FEEDS}, "lane": "", "allow_politics": True,
                "figures": "different public figures across sports, tech, science, music, film, food AND "
                           "politics — but political lines ONLY as LIGHT, balanced, non-inflammatory asides "
                           "(gaffes, witty quips), NEVER an attack or hot-take",
                "topic": "a broad mix of news, culture and well-known personalities (this is the catch-all lane)"},
    "sports":  {"feeds": {"sports": ["https://www.espn.com/espn/rss/news", "https://api.foxsports.com/v1/rss",
                                     "https://www.cbssports.com/rss/headlines/", "https://sports.yahoo.com/rss/",
                                     "https://www.theguardian.com/sport/rss"]},
                "lane": "SPORTS ", "allow_politics": False,
                "figures": "different real NON-politician athletes, coaches and sports figures",
                "topic": "about sport or competition, OR said by an athlete, coach or sports figure"},
    "music":   {"feeds": {"music": ["https://www.rollingstone.com/music/feed/", "https://pitchfork.com/rss/news/",
                                    "https://consequence.net/feed/", "https://www.nme.com/news/music/feed",
                                    "https://www.theguardian.com/music/rss"]},
                "lane": "MUSIC ", "allow_politics": False,
                "figures": "different real musicians, singers, producers and music figures",
                "topic": "about music, OR said by a musician, singer, producer or music-industry figure"},
    # The politics LANE (opt-in; the dial is ON). Political figures/process allowed; HARD_DENY still gates
    # crime/violence/slur/scandal/conflict. Fakes must be LIGHT + balanced; reals are cross-validated (strict).
    "politics": {"feeds": {"politics": ["https://feeds.npr.org/1014/rss.xml", "https://www.politico.com/rss/politicopicks.xml",
                                        "https://thehill.com/homenews/feed/", "https://feeds.washingtonpost.com/rss/politics",
                                        "https://www.theguardian.com/us-news/us-politics/rss"]},
                 "lane": "POLITICS ", "allow_politics": True,
                 "figures": "different real politicians/political figures BALANCED across parties — only LIGHT, "
                            "funny, non-inflammatory lines (gaffes, witty asides), NEVER an attack or hot-take",
                 "topic": "about policy or politics, OR said by a politician or public official"},
    # MOVIES lane: real iconic FILM lines (short, fair-use) vs fabricated film lines. Speaker = the FILM,
    # not a person, so the named-person rule doesn't apply. Evergreen-only (curated, verified real lines).
    "movies":  {"feeds": {}, "lane": "MOVIES ", "allow_politics": False, "kind": "movie",
                "figures": "famous, widely-recognized MOVIES — attribute each line to the FILM and year, "
                           "e.g. 'The Godfather (1972)'; vary genres and eras",
                "topic": "a line of dialogue from a famous film"},
    # OFF THE RECORD lane (UI label "Off the Record"; KEY stays nsfw, path daily/nsfw/*). 18+ behind a gate.
    # Genuinely ADULT: crude humour, profanity, partying/booze references, brash personality — NOT General-with-edge.
    # RE-SKIN (CONTENT_RISK_POLICY.md §5, decision A): FAKES may be attributed ONLY to DECEASED people, FILMS, or
    # SONGS — NEVER a living person (crude fabrications on the living are the biggest defamation surface). LIVING
    # people appear in this lane ONLY as real, verbatim-verified quotes. HARD LAWSUIT LINE still never relaxes:
    # never fabricate a CONFESSION to a crime, a sexual act/allegation, or any defamatory/harmful claim. No minors.
    "nsfw":    {"feeds": {}, "lane": "OFF-THE-RECORD ", "allow_politics": False, "kind": "nsfw", "nsfw": True,
                "figures": "different DECEASED public figures where crude is IN CHARACTER (late comedians, rock "
                           "legends, brash departed personalities) in unfiltered, profane, party-hard moments — "
                           "ONLY deceased people (or a film/song), NEVER a living person",
                "topic": "genuinely adult life and crude humour — partying, booze, sex/relationships banter, "
                         "off-colour jokes, blunt outbursts — in the speaker's real voice"},
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
REAL_TMPL = """From these news snippets, extract up to {k} VERBATIM direct quotes that are genuinely
ENTERTAINING to read — funny, witty, insightful, wise, or surprising — the kind of line people enjoy
regardless of whether it's real or fake. SKIP mundane, dull, procedural news soundbites. Copy the quoted
words EXACTLY as they appear — do not fix grammar, do not paraphrase, do not merge sentences.

HARD RULES:
- The speaker must be a SPECIFIC NAMED PERSON (a real human's name). Reject quotes attributed to
  "scientists", "researchers", "the study", "experts", "officials", "a spokesperson", etc.
- The text must be a quotation that person actually SAID (ideally shown in quotation marks in the snippet),
  not the article's own summary sentence about a finding.
- LANE FIT: the quote must clearly belong to this lane — {topic}. Skip anything off-topic for the lane.
- Non-political, non-tragic, non-defamatory only.

SNIPPETS (id | source | text):
{items}

Output a JSON array; each element EXACTLY:
{{"src_id": <the id>, "text": "<the exact quoted words, no surrounding quotes>", "speaker": "<the named person>",
  "context": "<short, where/when>"}}
Only include a quote whose words literally appear in that snippet AND has a named-person speaker. Prefer fewer."""

FAKE_SYS = ("You fabricate MAXIMALLY BELIEVABLE fake quotes for a 'real or fake?' daily game. The whole point "
            "is to FOOL sharp players, so each quote must sound EXACTLY like something the real person would "
            "actually say: match their documented voice, cadence, vocabulary and the subjects they really talk "
            "about, and stay strictly WITHIN their real-life plausibility — NO dead giveaways (no absurd numbers, "
            "wild exaggerations, or on-the-nose details that let people instantly call 'fake'). It must still be "
            "INNOCUOUS: never an invented crime, scandal, slur, medical/financial claim, or anything reputationally "
            "damaging. The bar is HARM-IF-BELIEVED — if a reader who believed it would think LESS of the person, do "
            "not write it: no drinking/drug PATTERN or dependency (a one-off 'I got hammered once' is fine, 'I drink "
            "every night' is NOT), no implied dishonesty/incompetence/hypocrisy, no cruelty or contempt, no false "
            "endorsement, and never drag in a private relationship (an ex, an affair). Attribute ONLY to a WIDELY-KNOWN "
            "public figure — never a private individual or someone obscure. Output STRICT JSON only.")
FAKE_TMPL = """Write {n} DISTINCT, HIGHLY BELIEVABLE fake quotes for today's {lane}game. {figures}.

LANE — every quote MUST clearly belong to this lane: {topic}. Reject anything off-topic for the lane.

Each quote MUST:
- sound like the REAL person — their actual tone, phrasing, vocabulary and the topics they genuinely discuss;
- stay WITHIN plausible reality — a thing they really COULD have said. NO dead giveaways: avoid oddly specific
  numbers, absurd exaggerations, or winking details. (Bad: "I spent forty hours studying long-snapper spin rates."
  Better: "I've definitely lost sleep over a long snapper's technique." Dial it to where a fan would HESITATE.)
- be genuinely ENTERTAINING — funny, insightful or wise, a pleasure to read either way — in a SUBTLE,
  true-to-character way (not a caricature or an obvious joke);
- AVOID THE TIDY APHORISM (this is the #1 style tell): no fortune-cookie wisdom, no "X isn't about Y, it's about Z",
  no "the secret is there's no secret", no "pressure is a privilege", no "the ocean doesn't care". Real off-the-cuff
  speech is MESSIER, more specific and idiosyncratic than a tweetable maxim — lean into concrete personal detail over
  elegant universal truths. And vary the SHAPE: do NOT reuse one rhetorical skeleton across your quotes;
- CONTEXT PARITY (kill the tell): the "context" must be a CONCRETE, SPECIFIC where/when — a named outlet, show,
  event, venue or year — as specific and similar in LENGTH as a real citation would be. NEVER vague, hedged or
  shorter than a real ("in an interview" / "supposedly" / "reportedly" are BANNED). It must read like a genuine source.
- be HARMLESS — pass the HARM-IF-BELIEVED test: if someone believed it, it must NOT lower the person's reputation.
  No crime/scandal/slur/medical/financial claim; NO drinking/drug PATTERN or dependency (one-off banter is fine, a
  habit is not); no implied dishonesty, incompetence, hypocrisy, cruelty, or false endorsement; never invent a private
  relationship (an ex/affair). Avoid politics entirely.
- attribute ONLY to a WIDELY-KNOWN public figure (a real non-politician everyone would recognize) — NEVER a private
  individual or an obscure person.
Use DIFFERENT, varied people — NEVER repeat a speaker, and mix the kinds of people you pick.
The bar: a real fan of that person would genuinely struggle to tell it's fake.

Output a JSON array; each element EXACTLY:
{{"text": "<the fabricated quote, no surrounding quotes>", "speaker": "<a real non-politician public figure>",
  "context": "<a concrete, specific where/when — outlet/show/event/year — comparable in length to a real citation>",
  "fake_note": "<1-2 sentences for the reveal, FIRST PERSON as the mischievous magpie 'Mags' (e.g. 'I made this one
  up — …'): why it's so plausible for this person + the SUBTLE giveaway. Never say 'AI', 'robot' or 'machine'.>",
  "sneaky": <true for the ONE hardest to catch, else false>}}"""

# MOVIES — fabricate BELIEVABLE film lines (speaker = the FILM, not a person)
FAKE_SYS_MOVIE = ("You fabricate MAXIMALLY BELIEVABLE fake MOVIE LINES for a 'real or fake?' game. Each must read "
                  "like a genuine line from the named film — match its genre, era, tone and a character's voice — "
                  "and stay plausible (no anachronisms, no plot-explaining giveaways). Keep it general-audience "
                  "(no slurs/graphic content). Output STRICT JSON only.")
FAKE_TMPL_MOVIE = """Write {n} DISTINCT, BELIEVABLE fake movie lines for today's game. {figures}.
Each line MUST:
- sound like a REAL line from that specific film — its genre, era, and a character's natural voice;
- be SHORT and quotable (one sentence), and plausibly something actually said in that movie;
- have NO dead giveaways (don't over-explain the plot; no anachronisms or winking meta);
- NOT be a fortune-cookie life-maxim dropped into a scene — real film lines are in-character and situational, not
  detachable inspirational quotes; avoid the over-polished aphorism;
- be clean enough for a general audience.
Use DIFFERENT, well-known films — NEVER repeat a film. The bar: a fan of that movie would hesitate.

Output a JSON array; each element EXACTLY:
{{"text": "<the fabricated line>", "speaker": "<Film Title (Year)>", "context": "<the character or scene, short>",
  "fake_note": "<1-2 sentences, FIRST PERSON as Mags the magpie ('I made this one up — …'): why it's plausible for
  that film + the SUBTLE giveaway. Never say 'AI', 'robot' or 'machine'.>", "sneaky": <true for the hardest, else false>}}"""

# OFF THE RECORD — genuinely ADULT, but lawsuit-safe. The hard line never relaxes.
FAKE_SYS_NSFW = ("You fabricate BELIEVABLE, genuinely ADULT (18+) fake quotes for an 'Off the Record' 'real or fake?' "
                 "game. Make them actually adult — crude humour, profanity, partying/booze/drugs references, "
                 "sex/relationships banter, brash personality — NOT just a clean quote with one swear. "
                 "RE-SKIN RULE (decision A): attribute every fake ONLY to a DECEASED public figure, a FILM, or a SONG "
                 "— NEVER a living person (living people appear in this lane only as real, verified quotes). "
                 "HARD LAWSUIT LINE (never relaxes): NEVER fabricate a CONFESSION to or description of a crime, a "
                 "sexual act or allegation, drug dealing, or anything defamatory/harmful — that is a lawsuit, not edgy. "
                 "Lean crude/party-hard braggadocio in a plausible in-character voice. No minors, ever; no private "
                 "individuals. Output STRICT JSON only.")
FAKE_TMPL_NSFW = """Write {n} DISTINCT, BELIEVABLE, genuinely ADULT (18+) fake quotes for today's Off the Record game. {figures}.

LANE — every quote MUST be properly adult: {topic}. Crude/profane/party-hard is the POINT — not General-with-one-swear.

Each MUST:
- be attributed ONLY to a DECEASED public figure (or a Film Title (Year) / a Song) — NEVER a living person. This is
  the lane's re-skin: crude fabrications about the living are off-limits; only the dead/fictional get fabricated lines.
- sound like the REAL (departed) person in a crude, unfiltered, party-hard or filthy-funny moment — their voice/cadence;
- be genuinely adult: swearing, blunt outbursts, one-off booze/party references, sex/relationship banter, off-colour
  jokes — all WELCOME — but NOT a substance DEPENDENCY/PATTERN framing (a one-off is fine, "I drink every day" is not);
- HARD LAWSUIT LINE: NEVER have the person confess to or describe a CRIME, a SEXUAL ACT or sexual ALLEGATION,
  drug dealing, or anything defamatory/harmful. "I got hammered at the afterparty" = fine (one-off braggadocio).
  "I [committed a crime / did <sex act> / dealt drugs]" = BANNED. No minors. No private individuals. NO living people.
- CONTEXT PARITY: "context" is a CONCRETE, SPECIFIC where/when (named show/podcast/event/year), as specific and
  similar in LENGTH as a real citation — never "in an interview"/"supposedly"/"reportedly".
- stay WITHIN plausibility — a crude thing they really COULD have said; NO dead giveaways.
- AVOID THE TIDY APHORISM — crude does not mean a polished maxim with a swear bolted on. No fortune-cookie wisdom
  ("X isn't about Y, it's about Z"); real filthy off-the-cuff speech is messy and specific. Vary the SHAPE across quotes.
Use DIFFERENT, varied people — NEVER repeat a speaker.

Output a JSON array; each element EXACTLY:
{{"text": "<the fabricated, genuinely-adult-but-lawsuit-safe quote>", "speaker": "<a DECEASED public figure, or a Film Title (Year) / Song>",
  "context": "<a concrete, specific where/when — named show/podcast/event/year — comparable in length to a real citation>",
  "fake_note": "<1-2 sentences, FIRST PERSON as Mags the magpie ('I made this one up — …'): why it's plausible + the
  SUBTLE giveaway. Never say 'AI', 'robot' or 'machine'.>", "sneaky": <true for the ONE hardest to catch, else false>}}"""

SCREEN_SYS = ("You screen INTENTIONALLY-FABRICATED quotes for a clearly-labeled 'real or fake?' game. "
              "Fabrication is the entire point and is disclosed to players, so do NOT flag a quote merely "
              "for being made up or attributed to a real person. Judge whether the CONTENT is harmful AND whether the "
              "named person is a genuine public figure. The governing test is HARM-IF-BELIEVED. Output STRICT JSON only.")
SCREEN_TMPL = """These are intentionally fabricated, clearly-labeled quotes for a light game (players know they
may be fake). Mark "safe": false if EITHER:
 (1) the CONTENT is harmful — an invented crime, scandal, sexual content, slur, hate, a medical/health claim,
     death/tragedy, or a damaging real-world accusation; OR
 (2) it is REPUTATION-HARMING IF BELIEVED (the key test): if a reader who believed it would think LESS of the
     person — a drinking/drug PATTERN or dependency (a one-off mention is fine, a habit is not), implied
     dishonesty/incompetence/hypocrisy, cruelty/contempt, a false endorsement, or an invented private
     relationship (an ex/affair); OR
 (3) the named person is NOT a widely-known public figure (a private individual or an obscure name).
Harmless, funny, wholesome, mundane content about a clear public figure is SAFE (true) — even though fabricated.

ITEMS:
{items}

Output a JSON array of objects EXACTLY: {{"i": <index>, "safe": <true|false>}}"""

# NSFW screen — profanity/crudeness is ALLOWED; only genuinely harmful, reputation-harming-if-believed, or
# non-public-figure content is dropped (the hard guards + Tier-B).
SCREEN_TMPL_NSFW = """These are intentionally fabricated, clearly-labeled quotes for an ADULT (18+) game where
profanity, crudeness, blunt outbursts and adult humor are EXPECTED and fine. Do NOT flag a quote for swearing,
rudeness, innuendo, or being crude/unsophisticated. Mark "safe": false if EITHER:
 (1) the CONTENT is genuinely HARMFUL — a slur or hate speech, an invented crime, sexual misconduct/assault, a drug
     crime, a medical/health claim, a death/tragedy, or a damaging real-world accusation about a real person; OR
 (2) it is REPUTATION-HARMING IF BELIEVED — a drinking/drug PATTERN or dependency (not a one-off), implied
     dishonesty/hypocrisy/cruelty, a false endorsement, or an invented private relationship (an ex/affair); OR
 (3) the named person is NOT a widely-known public figure; OR
 (4) the speaker is a LIVING person — in this lane (re-skin), a fabricated quote may ONLY be attributed to a
     DECEASED person, a film, or a song. A fabricated line on anyone still living = UNSAFE (false).
Crude-but-harmless content about a clear DECEASED public figure (or a film/song) = SAFE (true).

ITEMS:
{items}

Output a JSON array of objects EXACTLY: {{"i": <index>, "safe": <true|false>}}"""

VALIDATE_SYS = ("You are an independent attribution + QUALITY RED-FLAG checker for a 'real or fake?' game. Each quote "
                "has ALREADY been verified to appear verbatim on a cited reputable source — so do NOT re-verify from "
                "memory. Catch CLEAR problems: an obviously wrong/swapped attribution, a known satirical/fabricated "
                "'quote', an anachronism, content that plainly contradicts who the person is, a speaker who is NOT a "
                "widely-known PUBLIC FIGURE (a private individual / obscure name → flag), or a speaker who clearly "
                "belongs to a DIFFERENT lane than this one. ALSO flag QUALITY duds: an instantly-recognizable "
                "canonical line where RECOGNITION alone gives the game away (the iconic poster quote everyone knows), "
                "or a bland headline fragment / procedural soundbite that is NOT a surprising, self-contained thing a "
                "person actually SAID. DEFAULT to ok=true; mark ok=false ONLY with a SPECIFIC reason, never mere "
                "unfamiliarity. Output STRICT JSON only.")
VALIDATE_TMPL = """Each quote below was already confirmed to appear VERBATIM on a reputable source. Flag ok=false
ONLY for a clear red flag:
- wrong attribution, known fake/satire, anachronism, obvious fabrication;
- the speaker is NOT a widely-known public figure (a private individual or obscure name);
- the speaker clearly belongs to a different lane (this lane is "{lane}");
- QUALITY: it is an instantly-recognizable CANONICAL line where mere recognition is the giveaway (the famous poster
  quote) — we want surprising deep cuts, not warhorses;
- QUALITY: it reads as a bland headline fragment, ad slogan, or procedural soundbite rather than a surprising,
  self-contained thing the person SAID (the "wait, they really said that?" test).
If you simply don't recognize a quote, that is NOT a reason to flag it — an unfamiliar but plausible line is GOOD
(it's a surprising deep cut). Mark ok=true.

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


class LLMUnavailable(RuntimeError):
    """EVERY configured LLM provider failed (or none is configured). This is an OPS/config failure, NOT a
    content fail-safe — pipeline stages must let it PROPAGATE (never swallow it as an empty result) so the run
    fails LOUD (red) instead of silently writing nothing. See daily.yml: exit 2 = fail-safe (tolerated), any
    other non-zero = a real error. Root-cause of the 06-26→ silent outage: this used to be swallowed."""


def llm(system: str, prompt: str, max_tokens: int = 2000, gemini_model: str | None = None) -> str:
    """Prefer Gemini (free GCP credit, CLAUDE.md rule 7); fall back to Claude if Gemini errors or is
    misconfigured — so a bad Gemini key/model can never silently break the unattended cron.
    `gemini_model` overrides the Gemini model for this call (mechanical steps pass the fast model).
    Raises LLMUnavailable if NO provider succeeds (so a total provider outage is loud, not a silent fail-safe)."""
    order = []
    if _gemini_mode():
        order.append("gemini")
    if os.environ.get("ANTHROPIC_API_KEY"):
        order.append("claude")
    if not order:
        raise LLMUnavailable("No LLM key: set GEMINI_API_KEY (preferred) or ANTHROPIC_API_KEY.")
    last = None
    for prov in order:
        try:
            return _call_gemini(system, prompt, gemini_model) if prov == "gemini" else _call_claude(system, prompt, max_tokens)
        except Exception as e:  # noqa: BLE001
            last = e
            tail = "falling back to next provider" if prov != order[-1] else "no more providers"
            print(f"  ! LLM '{prov}' failed ({e.__class__.__name__}: {str(e)[:120]}) — {tail}", file=sys.stderr)
    raise LLMUnavailable(f"all LLM providers failed ({', '.join(order)}); last error: {last.__class__.__name__}: {str(last)[:160]}") from last


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
    # Punctuation-to-space (below) can ITSELF create new multi-space runs (e.g. an HTML citation-marker artifact
    # like "Lincoln<sup>[1]</sup>." strips to "Lincoln  ." -> "Lincoln   "), so whitespace must be collapsed AFTER
    # punctuation removal, not before — collapsing first (the old order) left those runs uncollapsed, which made
    # quote_is_verbatim's `run in nc` substring check silently fail on genuinely-matching quotes whenever the
    # fetched source had ANY such artifact (a bank_audit false "not-verbatim" that looked like link rot but wasn't).
    s = (s or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s)).strip()


# ---------- near-duplicate detection (Batch 7b: catch paraphrase + length variants exact-match misses) ----------
_STOP = {"the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was",
         "were", "be", "been", "at", "as", "by", "it", "its", "that", "this", "these", "those", "so", "just",
         "not", "no", "do", "did", "you", "your", "we", "our", "they", "their", "he", "she", "his", "her",
         "i", "im", "ive", "my", "me", "im", "from", "into", "out", "up", "if", "then", "than", "all", "any",
         "who", "what", "when", "where", "how", "why", "about", "have", "has", "had", "will", "would", "can"}


def _content_toks(norm_text):
    """Meaningful tokens of an ALREADY-normalized string (drop stopwords + 1-2 char tokens) — the near-dup signal."""
    return {t for t in norm_text.split() if t not in _STOP and len(t) > 2}


def build_dup_index(used_set):
    """Precompute a fast index over the (possibly large, cross-lane) used ledger: the exact normalized set plus the
    content-token-set of each entry. Built ONCE per run so is_dup() is cheap to call against every candidate."""
    exact = used_set if isinstance(used_set, set) else set(used_set or [])
    toksets = []
    for u in exact:
        ut = _content_toks(u)
        if len(ut) >= 5:
            toksets.append(ut)
    return (exact, toksets)


def is_dup(text, index, thresh=0.8):
    """True if `text` repeats something already published: exact normalized match, OR high content-token overlap
    with any published quote (containment vs the smaller set → catches paraphrase AND truncation/expansion variants,
    e.g. the Cory Booker republish that slipped past exact-match). `index` comes from build_dup_index()."""
    exact, toksets = index
    n = _norm(text)
    if n in exact:
        return True
    qt = _content_toks(n)
    if len(qt) < 5:                                   # too few content words to fuzzy-match safely → exact only
        return False
    for ut in toksets:
        inter = len(qt & ut)
        if inter and inter / min(len(qt), len(ut)) >= thresh:
            return True
    return False


def _spk_str(speaker):
    """Canonical speaker key for de-dup. People → first+last only, so naming variants collapse
    ('John F. Kennedy' == 'John Kennedy' == 'JFK'→'jfk' single-token). Films (a year in the name) → full title,
    since the year disambiguates ('The Terminator (1984)' vs 'Terminator 2 (1991)')."""
    n = _norm(speaker)
    if re.search(r"\b(18|19|20)\d{2}\b", n):    # contains a year → treat as a film title, keep full
        return n
    toks = n.split()
    return (toks[0] + " " + toks[-1]) if len(toks) >= 2 else n


def _spk(q):
    """Canonical speaker key for an item (no two of the same person — or naming-variant — in one edition)."""
    return _spk_str(q.get("speaker", ""))


def quote_is_verbatim(quote, corpus):
    """True only if (most of) the quote appears VERBATIM in the source corpus. Batch 7b TIGHTENED the fallback:
    a loosely-paraphrased 'real' that shared only its opening fragment (the Cory Booker case) used to pass on a
    first-12-words match; now the contiguous run must cover >=70% of the quote, so mid/late paraphrase is rejected."""
    nq, nc = _norm(quote), _norm(corpus)
    if len(nq) < 25:
        return False
    if nq in nc:                                       # whole quote verbatim → strongest signal
        return True
    words = nq.split()
    if len(words) < 8:
        return False
    # fallback tolerates a minor trailing edit ONLY: require a long contiguous run from the start covering >=70%
    # of the quote's words (was: just the first 12 → ~40% on a long quote, which let paraphrases through).
    need = max(12, int(round(len(words) * 0.7)))
    run = " ".join(words[:need])
    return run in nc and len(run) >= 30


def deny_hit(*parts, allow_politics=False):
    blob = " " + _norm(" ".join(p or "" for p in parts)) + " "
    terms = HARD_DENY if allow_politics else (HARD_DENY + POLITICAL_TERMS)
    return any((" " + w + " ") in blob for w in terms)


# Defamation guard for FAKES (every lane, incl. Off the Record): NEVER put a first-person CONFESSION of a crime,
# sexual act/allegation, drug offence, medical condition, or serious wrongdoing in a real named person's mouth —
# that is a lawsuit, not a game. Deterministic (never depends on an LLM), on top of HARD_DENY + the LLM screen.
# Recreational banter ("I got hammered", "I love a good party") is NOT matched — only damaging assertions are.
DEFAMATORY_RE = re.compile(
    r"\b(i|i'?ve|i'?m|we|my)\b[^.?!]{0,45}\b("
    r"killed|murder\w*|stabb\w*|shot|rap\w+|assault\w*|abus\w+|molest\w+|"
    r"cheated\s+on|slept\s+with|had\s+an\s+affair|"
    r"deal(t|ing)?\s+\w*\s*(drugs|coke|cocaine|heroin|meth|dope)|sold\s+\w*\s*(drugs|coke|cocaine|heroin|meth)|smuggl\w+|trafficked|"
    r"stole|embezzl\w+|defraud\w*|committed\s+fraud|launder\w+|bribed|"
    r"diagnosed\s+with|overdos\w+|relaps\w+|"
    r"never\s+paid\s+(my\s+)?taxes|evad\w+\s+taxes|tax\s+evasion"
    r")\b", re.I)


def defamatory(text):
    """True if a FAKE makes a first-person damaging assertion (crime/sex/drugs/medical/fraud) — block it outright.
    NOTE: this is a deterministic FLOOR (English keyword + first-person), not a ceiling — the LLM screen (safety_screen)
    catches euphemism/implication. See CONTENT_RISK_POLICY.md §8 gap 4."""
    return bool(DEFAMATORY_RE.search(text or ""))


# Tier-B "harm-if-believed" deterministic FLOOR (CONTENT_RISK_POLICY.md §2 Tier B). Beyond Tier-A crime/sex/fraud,
# block fabrications that would lower a person's esteem IF BELIEVED: a substance/drinking PATTERN or dependency (not
# one-off banter), a booze quantity, or dragging a private relationship in. The LLM screen does the semantic rest
# (dishonesty, hypocrisy, cruelty, false endorsement) — this catches the clearest repeat offenders deterministically.
_BOOZE = r"(jameson|whiskey|whisky|vodka|tequila|bourbon|jack\s+daniel|patr[oó]n|negroni|gin|rum|scotch|liquor|booze)"
REPUTATIONAL_RE = re.compile(
    r"\b\d+\s+bottles?\s+(of\s+)?(wine|" + _BOOZE + r")\b"              # a quantity of BOOZE ("three bottles of jameson"), not generic bottles
    r"|\bbottles?\s+(of|deep)\b[^.?!]{0,25}\b(wine|" + _BOOZE + r")\b"
    r"|\b(wine|" + _BOOZE + r"|martinis?)\b[^.?!]{0,30}\b(every\s+(night|day|morning)|each\s+(night|day)|before\s+(noon|breakfast|lunch|soundcheck|the\s+show|every\s+show)|for\s+\w+\s+years|thirty\s+years|a\s+decade|daily|nightly)\b"   # CONSUMPTION frequency, not 'every year'
    r"|\b(committed|addicted|hooked|dependent)\b[^.?!]{0,25}\b(wine|" + _BOOZE + r"|drinking|the\s+bottle)\b"
    r"|\b(fell\s+off\s+the\s+wagon|sober\s+since)\b"                    # relapse / recovery = a dependency PATTERN (one-off 'I got hammered' is NOT matched — policy permits it)
    r"|\bbloodwork\b"
    r"|\bmy\s+doctor\b[^.?!]{0,30}\b(liver|tequila|whiskey|whisky|booze|drinking)\b"   # a drinking-health concern, not 'drink more water'
    r"|\b(my|her|his)\s+ex-(wife|husband|girlfriend|boyfriend)\b"       # fabricating a real person's private relationship
    , re.I)


def reputational_harm(text):
    """True if a FAKE makes a CLEAR Tier-B reputation-harm-if-believed assertion (substance PATTERN/dependency, a
    booze quantity, a named ex / private relationship). Deterministic FLOOR; the LLM screen judges the subtler cases."""
    return bool(REPUTATIONAL_RE.search(text or ""))


# BATCH 12 — General/non-nsfw cleanliness. Profanity (even MILD) belongs ONLY in Off the Record; it must never
# surface in general/sports/music/politics/movies (a real "get your ass to Mars" leaked into General). Word-boundary
# matched so it never trips inside a clean word (class/pass/asset/shell/Michelle/hello/damnation stay clean). A good
# but profane real is routed to Off the Record instead of shown in a family lane.
# Short stems that are PREFIXES of real names/words use enumerated forms, not \w*, so we don't drop legitimate
# reals: crap\w* hit Sen. Crapo / Thomas Crapper; piss\w* hit (Camille) Pissarro; prick\w* hit Prickett; bare
# `dick` hit Dick Cheney/Clark/Van Dyke/Butkus/Vitale, Philip K. Dick, Moby Dick — so `dick` is dropped and only
# `dickhead` is kept. \w* is retained only where it can't collide (fuck/shit/bitch/goddamn/asshole/bastard/whore).
PROFANITY_RE = re.compile(
    r"\b(ass|asses|asshole\w*|asshat|jackass|dumbass|badass|hell|hells|damn|damned|damnit|goddamn\w*|"
    r"shit\w*|bull\s?shit|bitch\w*|fuck\w*|motherfuck\w*|crap|craps|crappy|crapped|crapping|"
    r"piss|pissed|pisses|pissing|pisser|pissy|prick|pricks|dickhead\w*|"
    r"bastard\w*|cock|bollocks|bugger|wank|wanker|wankers|wanking|wanked|twat|slut|sluts|slutty|"
    r"whore\w*|douche\w*)\b", re.I)


def has_profanity(text):
    """True if the text contains profanity (even mild). Applied to REALS + FAKES in every NON-nsfw lane."""
    return bool(PROFANITY_RE.search(text or ""))


def is_nsfw_lane(cat):
    return bool(CATEGORIES.get(cat, {}).get("nsfw"))


# ---------- content-quality floors (CONTENT_QUALITY_REVIEW.md REC 1-4) ----------
# REC 1 — the canonical movie "warhorses": a casual viewer recognizes these on sight, so RECOGNITION (not
# plausibility) becomes the tell. Reject them as movies REALS so the lane biases toward deep-cut lines instead.
CANON_MOVIE_RE = re.compile("|".join([
    r"may the force be with you", r"i'?ll be back", r"the need for speed", r"one does not simply",
    r"here'?s johnny", r"to infinity and beyond", r"hakuna matata", r"are you not entertained",
    r"houston,? we (have|ve got) a problem", r"king of the world", r"i am iron man",
    r"you can'?t handle the truth", r"say hello to my little friend", r"i see dead people",
    r"life (is|was) like a box of chocolates", r"why so serious", r"frankly,? my dear,? i don'?t give a damn",
    r"e\.?\s?t\.? phone home", r"show me the money", r"you'?re gonna need a bigger boat",
    r"there'?s no place like home", r"my precious", r"go ahead,? make my day", r"yippee.?ki.?yay",
    r"with great power comes great responsibility", r"wax on,? wax off", r"i'?ll have what she'?s having",
    r"keep your friends close", r"i'?m gonna make him an offer he can'?t refuse", r"toto,? i'?ve a feeling",
]), re.I)


def is_canon_movie_line(text):
    """True if a movie line IS an instantly-recognizable 'warhorse' (recognition, not plausibility, is the giveaway).
    Coverage-anchored: the canon phrase must DOMINATE the line (>=60%), so a longer line that merely contains a canon
    fragment ('my precious memories of that summer') is NOT a warhorse — only the line that essentially IS the quote."""
    t = (text or "").strip().lower()                 # lowercased RAW (apostrophes intact — the patterns use '?); NOT _norm, which spaces apostrophes out
    if not t:
        return False
    m = CANON_MOVIE_RE.search(t)
    return bool(m) and (m.end() - m.start()) >= 0.6 * len(t)


# REC 2 — a REAL should be a surprising, self-contained thing a person SAID ("they really said that?"), not a
# headline fragment / truncated clip / chyron. Deterministic floor; the LLM cross-validate adds the semantic judgement.
_TRUNC_RE = re.compile(r"\[\s*[.…]+\s*\]|\.\.\.|…|\[\s*\w+\s*\]|\[\s*sic\s*\]", re.I)


def looks_like_headline_or_fragment(text):
    t = (text or "").strip()
    if not t:
        return True
    words = t.split()
    if len(words) < 6:                                   # too short to be a self-contained spoken line
        return True
    if _TRUNC_RE.search(t):                               # ellipsis / editorial brackets = a truncated clip, not speech
        return True
    letters = [c for c in t if c.isalpha()]
    if letters and sum(1 for c in letters if c.isupper()) / len(letters) > 0.6:   # SHOUTY CHYRON / all-caps headline
        return True
    # a properly-extracted standalone line is always capitalized; lowercase-initial means it was clipped out of the
    # MIDDLE of a sentence (e.g. "expecting just to get drunk, really" — a trailing dependent clause, not the quote)
    first_letter = next((c for c in t if c.isalpha()), None)
    if first_letter and first_letter.islower():
        return True
    return False


def real_quality_ok(text, cat="general"):
    """Deterministic 'surprise/quality' floor for a REAL (REC 2): reject headline fragments / truncated clips / chyrons
    in the NEWS-sourced lanes. MOVIES are exempt from this floor — film dialogue is legitimately short and may use a
    dramatic ellipsis ('I never drink... wine'), so the news-fragment heuristic doesn't apply; canonical-WARHORSE
    handling for movies is a SOFT deprioritization in assemble() (deep cuts preferred, warhorses as fallback), never a
    hard reject — so the unreplenishable movies bank can never be starved below the fail-safe. The LLM cross-validate
    adds the semantic surprise/recognition judgement (incl. movies canon) on top for every lane."""
    if cat == "movies":
        return True
    return not looks_like_headline_or_fragment(text)


# REC 4a — observed fake "crutch" phrases: over-used rhetorical skeletons the audit flagged. A fabricated line that
# leans on one reads as template/machine-made. forge_fakes rejects these (and the fake-writer is told to avoid them).
STOP_PHRASE_RE = re.compile("|".join([
    r"\bevery clock\b", r"the ocean does ?n.?t (care|apologi[sz]e)", r"\ba man who won.?t (die|bleed|fight) for\b",
    r"\bpressure is (just|like|nothing|a privilege)\b", r"is ?n.?t about .{1,30}\bit.?s about\b",
    r"\bwas ?n.?t about .{1,30}\bit was about\b", r"the secret is there.?s no secret",
    r"they do ?n.?t (build|make) .{1,20} like (that|they used to)", r"\bthe (real )?magic (is|happens)\b.{0,30}\bbetween\b",
]), re.I)


def is_template_cliche(text):
    """True if a FAKE leans on a known over-used rhetorical skeleton / fortune-cookie aphorism (the style tell)."""
    return bool(STOP_PHRASE_RE.search(text or ""))


def _stem(t):
    for suf in ("ing", "edly", "ed", "ly", "es", "s"):
        if len(t) > len(suf) + 2 and t.endswith(suf):
            return t[:-len(suf)]
    return t


def skeleton(text):
    """REC 4b — the rhetorical SKELETON of a quote: its opening function-word frame (where templates live, content
    words blanked) + the stemmed first content token + a coarse length bucket. Two lines built on the SAME opening
    scaffold with different content words collide (e.g. 'A man who won't ___ for ___ isn't fit to ___' reused), which
    token-overlap dedup (is_dup) misses when the nouns differ. The trailing content token is deliberately NOT in the
    key (it pins the ending and defeats same-frame matching). A backstop to the precise STOP_PHRASE_RE ban-list."""
    n = _norm(text)
    toks = n.split()
    if len(toks) < 5:
        return ""
    content = [t for t in toks if t not in _STOP and len(t) > 2]
    first = _stem(content[0]) if content else ""
    frame = " ".join(t if t in _STOP else "_" for t in toks[:12])   # opening rhetorical frame (content words blanked)
    return f"{first}|{frame}|{len(toks) // 6}"


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
def gather_reals(feeds, days, dup_idx, cat="general", want=6):
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
        cands = largest_json(llm(REAL_SYS, REAL_TMPL.format(k=12, items=block, topic=CATEGORIES.get(cat, {}).get("topic", "a broad mix of news and culture")), max_tokens=2500, gemini_model=_fast_model())) or []
    except LLMUnavailable:
        raise                                          # total provider outage → propagate (loud), NEVER a silent empty-reals fail-safe
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
        if not real_quality_ok(q, cat):     # REC 1+2: drop headline fragments / truncated clips / canonical movie warhorses
            continue
        if not is_nsfw_lane(cat) and has_profanity(q):   # BATCH 12: profanity (even mild) belongs ONLY in Off the Record — keep family lanes clean
            continue
        if q.lower() in seen or is_dup(q, dup_idx):   # never repeat a published quote — ANY lane, incl. near-duplicates (7b)
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
    verified = validate_reals(verified, strict=ap, cat=cat)   # cross-LLM attribution + public-figure + lane-fit check
    print(f"  reals: {len(verified)} verified verbatim + cross-validated (of {len(cands) if isinstance(cands, list) else 0} proposed)")
    return verified


def voice_refs(cat, k=5):
    """Real, in-lane sample lines (from the evergreen bank) showing how people in this lane genuinely phrase
    things — fed to the fake-writer so fakes are IN-VOICE (kills style tells, complements context-parity)."""
    bank = [e for e in load_evergreen(cat) if e.get("text")]
    if not bank:
        return ""
    random.shuffle(bank)
    refs = "\n".join(f'- {e.get("speaker","?")}: "{e["text"][:160]}"' for e in bank[:k])
    return ("\n\nVOICE REFERENCES — real lines showing how people in this lane actually sound (match this cadence, "
            "vocabulary and attitude; do NOT reuse these speakers or lines):\n" + refs)


# Batch 10 — difficulty feedback loop. Pure: given a difficulty.py report (per-fake live fooled-rate bands), if THIS
# lane's recent fakes skewed TOO EASY (players caught them instantly — e.g. movies being a gimme), steer the fake-writer
# to make them subtler. Never fabricates a difficulty; it only nudges the PROMPT, and is a no-op until enough data exists.
def _difficulty_hint_from(report, cat):
    fakes = [r for r in (report.get("fakes") or [])
             if r.get("cat") == cat and r.get("band") in ("too_easy", "unfair", "on_target")]
    if len(fakes) < 5:
        return ""
    too_easy = sum(1 for r in fakes if r["band"] == "too_easy")
    on_target = sum(1 for r in fakes if r["band"] == "on_target")
    if too_easy > on_target and too_easy >= 3:
        return ("\n\nDIFFICULTY FEEDBACK — recent fabricated lines in this lane were TOO EASY to spot (players caught "
                "them instantly). Make these SUBTLER: match how the real person actually phrases things, drop any "
                "exaggeration or obvious 'tell', and aim for a believable line a fan would genuinely have to debate.")
    return ""


def difficulty_hint(cat):
    try:
        rep = json.load(open(os.path.join(HERE, "difficulty_report.json")))
    except Exception:  # noqa: BLE001 — no report yet → no-op (the loop activates once difficulty.py runs over live data)
        return ""
    return _difficulty_hint_from(rep, cat)


def forge_fakes(dup_idx, cat="general", n=6, skel_seen=None):
    meta = CATEGORIES.get(cat, CATEGORIES["general"])
    kind = meta.get("kind", "person")
    sysp, tmpl = {"movie": (FAKE_SYS_MOVIE, FAKE_TMPL_MOVIE),
                  "nsfw": (FAKE_SYS_NSFW, FAKE_TMPL_NSFW)}.get(kind, (FAKE_SYS, FAKE_TMPL))
    try:
        prompt = tmpl.format(n=n, lane=meta["lane"], figures=meta["figures"], topic=meta.get("topic", "")) + voice_refs(cat) + difficulty_hint(cat)
        fakes = largest_json(llm(sysp, prompt, max_tokens=2800)) or []
    except LLMUnavailable:
        raise                                          # total provider outage → propagate (loud), NEVER a silent empty-fakes fail-safe
    except Exception as e:  # noqa: BLE001
        print(f"  ! fakes LLM: {e}", file=sys.stderr); return []
    ap = meta.get("allow_politics", False)
    skel_seen = set() if skel_seen is None else skel_seen   # REC 4b: rhetorical skeletons already used (recent ledger + this batch)
    out = []
    for f in fakes if isinstance(fakes, list) else []:
        t, sp = f.get("text"), f.get("speaker")
        if not (t and sp):
            continue
        if deny_hit(t, sp, f.get("context"), allow_politics=ap) or defamatory(t) or reputational_harm(t) \
                or is_template_cliche(t) \
                or (not is_nsfw_lane(cat) and has_profanity(t)) \
                or is_dup(t, dup_idx):              # never repeat a published quote — ANY lane, incl. near-duplicates (7b)
            continue
        sk = skeleton(t)                            # REC 4b: reject a fake that repeats a recent OR in-batch rhetorical shape
        if sk and sk in skel_seen:
            continue
        if sk:
            skel_seen.add(sk)
        out.append({"text": t, "speaker": sp, "context": f.get("context", ""),
                    "real": False, "fake_note": f.get("fake_note") or "I made this one up.",  # Mags voice; never "AI" (copy rule)
                    "_sneaky": bool(f.get("sneaky"))})
    return out


def safety_screen(quotes, nsfw=False):
    """Final LLM gate over LLM-SOURCED items only (fakes + fresh reals). Pre-vetted evergreen reals are
    never screened out (they're hand-checked). Drops only on an explicit `safe: false`. In the NSFW lane the
    screen ALLOWS profanity/crudeness and drops only genuinely harmful content (the hard guards never relax)."""
    screenable = [(i, q) for i, q in enumerate(quotes) if not q.get("_vetted")]
    if not screenable:
        return quotes
    try:
        block = "\n".join(f'{i}: "{q["text"]}" — {q["speaker"]} ({q.get("context","")})' for i, q in screenable)
        tmpl = SCREEN_TMPL_NSFW if nsfw else SCREEN_TMPL
        verdicts = largest_json(llm(SCREEN_SYS, tmpl.format(items=block), max_tokens=800, gemini_model=_fast_model())) or []
        unsafe = {int(v["i"]) for v in verdicts if isinstance(v, dict) and v.get("safe") is False}
        if len(unsafe) > len(screenable) // 2:
            if nsfw:
                # The NSFW screen is ALREADY permissive (profanity passes) — a majority-harmful flag is REAL, not a
                # misfire. FAIL SAFE: drop the flagged items; assemble's >=2-fake fail-safe writes nothing if too few
                # survive. (Never ship an unscreened edgy batch unattended — deny_hit can't catch keyword-free harm.)
                print(f"  ! nsfw screen flagged {len(unsafe)}/{len(screenable)} — DROPPING them (fail-safe)", file=sys.stderr)
                return [q for i, q in enumerate(quotes) if i not in unsafe]
            # SFW lanes: a majority flag usually means the screen is misreading fabrication-itself as harm; the
            # deterministic denylist already gates real harm, so keep the denylist-filtered set rather than nuke it.
            print(f"  ! screen flagged {len(unsafe)}/{len(screenable)} — likely misfiring; keeping denylist-filtered set", file=sys.stderr)
            return quotes
        return [q for i, q in enumerate(quotes) if i not in unsafe]
    except LLMUnavailable:
        raise                                          # never ship UNSCREENED fakes on a provider outage → propagate (loud)
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


def validate_reals(reals, strict=False, cat="general"):
    """Independent cross-LLM attribution check on top of the verbatim match (replaces the human fact-check). Also flags
    a non-public-figure speaker or a wrong-lane speaker (CONTENT_RISK_POLICY.md §8 gap 2; CONTENT_QUALITY_REVIEW REC 5).
    `strict` (politics lane) runs a SECOND, independent reviewer-of-the-reviewer pass and unions the rejects."""
    if not reals:
        return reals
    def _pass():
        block = "\n".join(f'{i}: "{r["text"]}" — {r["speaker"]} ({r.get("context", "")[:80]})' for i, r in enumerate(reals))
        v = largest_json(_call_other(VALIDATE_SYS, VALIDATE_TMPL.format(items=block, lane=cat))) or []
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
        bank = json.load(open(evergreen_path(cat)))
    except Exception:  # noqa: BLE001
        bank = []
    if cat == "general":  # politics is ON in the default feed too — mix the verified politics bank into general
        try:
            pol = [dict(e, _politics=True) for e in json.load(open(evergreen_path("politics")))]
            bank = bank + pol                         # tagged so assemble can keep ≥1 visible per edition
        except Exception:  # noqa: BLE001
            pass
    return bank


def load_used(cat="general"):
    """Set of normalized texts of every quote ever published in this lane — no repeats, ever, per category."""
    try:
        return set(json.load(open(used_path(cat))))
    except Exception:  # noqa: BLE001
        return set()


def load_all_used():
    """Union of EVERY lane's published-quote ledger (Batch 7b cross-lane dedup): a quote published in ANY lane must
    never reappear in another. Per-lane files stay lane-scoped for saving; this union is only the membership test."""
    allu = set()
    for c in CATEGORIES:
        allu |= load_used(c)
    return allu


def load_raw_evergreen(cat):
    """This lane's OWN evergreen bank file only (NO cross-lane mixing) — used when WRITING the surplus bank so we
    never accidentally fold the general view's mixed-in politics entries back into evergreen_reals.json."""
    try:
        return json.load(open(evergreen_path(cat)))
    except Exception:  # noqa: BLE001
        return []


def bank_surplus_reals(reals, edition, cat, dup_idx):
    """Batch 7a — the bank fills itself with REAL, verified quotes. Every quote in `reals` already passed the
    verbatim-vs-source gate AND the cross-LLM attribution check, so appending the ones NOT used in today's edition
    to this lane's evergreen bank is zero-integrity-risk (NEVER fabricates a real). On a thin-news day the lane can
    then still reach the floor from its own bank instead of going silent. Deduped vs the bank + the used ledger.
    Also runs the SAME real_quality_ok() gate assemble()/gather_reals() apply — a candidate can be genuinely
    verbatim+attributed and STILL be a weak conversational fragment not worth banking (a 2026-07-01 incident: a
    lowercase-initial dependent clause like "expecting just to get drunk, really" got harvested here); reject it
    at harvest time instead of relying on manual review before commit."""
    if not reals:
        return 0
    used_today = {_norm(q["text"]) for q in (edition.get("quotes", []) if edition else [])}
    bank = load_raw_evergreen(cat)
    bank_norms = {_norm(e.get("text", "")) for e in bank}
    added = 0
    for r in reals:
        nt = _norm(r["text"])
        if nt in used_today or nt in bank_norms:           # published today, or already banked
            continue
        if not real_quality_ok(r["text"], cat):            # same quality floor as live generation — reject weak fragments
            continue
        if is_dup(r["text"], dup_idx):                     # already published in some lane (incl. near-dup)
            continue
        if is_dup(r["text"], build_dup_index(bank_norms)): # near-dup of something already in the bank
            continue
        entry = {"text": r["text"], "speaker": r["speaker"], "context": r.get("context", ""), "real": True}
        if r.get("source"):
            entry["source"] = r["source"]
        bank.append(entry); bank_norms.add(nt); added += 1
    if added:
        json.dump(bank, open(evergreen_path(cat), "w"), indent=2, ensure_ascii=False)
    return added


def speakers_path(cat):
    return os.path.join(HERE, "used_speakers.json" if cat == "general" else f"used_speakers_{cat}.json")


def load_recent_speakers(cat, date, days=21):
    """{normalized_speaker: last_used_date}; returns (recent_set, full_dict) — bias new editions AWAY from recent names."""
    try:
        d = json.load(open(speakers_path(cat)))
    except Exception:  # noqa: BLE001
        d = {}
    cutoff = (dt.date.fromisoformat(date) - dt.timedelta(days=days)).isoformat()
    return {sp for sp, dy in d.items() if str(dy) >= cutoff}, d


def save_recent_speakers(d, edition, date, cat):
    for q in edition["quotes"]:
        s = _spk_str(q.get("speaker", ""))
        if s:
            d[s] = date
    json.dump(d, open(speakers_path(cat), "w"), indent=0)


def today_speakers(date, exclude_cat):
    """Speakers ALREADY used in OTHER lanes' editions for the same day → avoid cross-lane same-day repeats."""
    spk = set()
    for c in CATEGORIES:
        if c == exclude_cat:
            continue
        try:
            ed = json.load(open(target_path(c, date)))
        except Exception:  # noqa: BLE001
            continue
        for q in ed.get("quotes", []):
            s = _spk_str(q.get("speaker", ""))
            if s:
                spk.add(s)
    return spk


def save_used(used, cat="general"):
    json.dump(sorted(used), open(used_path(cat), "w"), indent=0)


def skeleton_path(cat):
    return os.path.join(HERE, "used_skeletons.json" if cat == "general" else f"used_skeletons_{cat}.json")


def load_recent_skeletons(cat):
    """REC 4b — rolling list of recently-published FAKE rhetorical skeletons for this lane; forge_fakes avoids
    repeating a shape across editions (complements the text-level dedup ledger). Missing file → empty (no-op)."""
    try:
        return [s for s in json.load(open(skeleton_path(cat))) if s]
    except Exception:  # noqa: BLE001
        return []


def save_skeletons(skels, cat, cap=200):
    json.dump([s for s in skels if s][-cap:], open(skeleton_path(cat), "w"), indent=0)


def spot_check_summary(edition, cat):
    """REC 7 — emit a compact per-edition 6x6 summary to the run log (the Action captures stdout) so a human can
    eyeball a set before/after publish, plus an auto quality-floor residue readout (canon/fragment/cliche)."""
    if not edition:
        return
    qs = edition.get("quotes", [])
    canon = sum(1 for q in qs if q.get("real") and cat == "movies" and is_canon_movie_line(q.get("text", "")))
    frag = sum(1 for q in qs if q.get("real") and looks_like_headline_or_fragment(q.get("text", "")))
    clich = sum(1 for q in qs if not q.get("real") and is_template_cliche(q.get("text", "")))
    print(f"  SPOT-CHECK [{cat} {edition.get('date','?')}] — eyeball: REAL recognizable-on-sight? FAKE a polished aphorism? a template/cliche repeat?")
    for q in qs:
        rf = "R" if q.get("real") else "F"
        tick = "" if q.get("id") != edition.get("trickiest_fake") else "  <- trickiest"
        print(f"    {str(q.get('id','?')):>3} {rf}  {q.get('speaker','?')[:24]:<24} | {q.get('text','')[:62]}{tick}")
    print(f"    auto-floor residue: canon={canon} fragment={frag} cliche={clich} (each should be 0)")


def bank_recency(cat):
    """Most-recent publish date per REAL text for this lane, read from the editions on disk. Drives the bank-FLOOR
    recycle in assemble() (least-recently-used first). The used ledger is stored SORTED (save_used), so it can't
    give recency — the editions are the authoritative record of when a real was last shown. {norm_text: 'YYYY-MM-DD'}."""
    import glob
    rec = {}
    for p in glob.glob(os.path.join(daily_dir(cat), "*.json")):
        if os.path.basename(p) == "index.json":
            continue
        try:
            ed = json.load(open(p))
        except Exception:  # noqa: BLE001
            continue
        d = ed.get("date") or os.path.basename(p)[:-5]
        for q in ed.get("quotes", []):
            if q.get("real"):
                nt = _norm(q.get("text", ""))
                if nt and (nt not in rec or d > rec[nt]):
                    rec[nt] = d
    return rec


def assemble(date, reals_fresh, fakes, evergreen, dup_idx, cat="general", recent=None, recency=None):
    recent = recent or set()                               # speakers used in recent days → bias AGAINST (variety)
    n_real = random.choice([2, 3, 3])                      # vary the ratio so it isn't always 3:3
    reals, seen_spk = [], set()
    def take(q):                                           # add only if this speaker isn't already in the edition
        s = _spk(q)
        if not s or s in seen_spk: return False
        seen_spk.add(s); reals.append(q); return True
    for r in sorted(reals_fresh, key=lambda x: _spk(x) in recent):   # fresh feed reals, fresh-name first
        if len(reals) >= n_real: break
        take(r)
    pool = [e for e in evergreen if not is_dup(e["text"], dup_idx) and _spk(e) not in seen_spk
            and real_quality_ok(e["text"], cat)
            and (is_nsfw_lane(cat) or not has_profanity(e["text"]))]   # unused, distinct, quality floor + BATCH 12 non-nsfw cleanliness
    if len(reals) < n_real and pool:                       # top up from the UNUSED vetted evergreen bank
        pol = [e for e in pool if e.get("_politics")]
        if cat == "general" and pol and not any(r.get("_politics") for r in reals):
            pol.sort(key=lambda x: _spk(x) in recent)
            cand = dict(pol[0]); cand["real"] = True; cand["_vetted"] = True; take(cand)   # keep ≥1 politics in general
        rest = [e for e in pool if _spk(e) not in seen_spk]
        random.shuffle(rest)
        rest.sort(key=lambda x: (_spk(x) in recent, is_canon_movie_line(x["text"])))   # prefer fresh names, then DEEP CUTS over canonical warhorses (REC 1 — soft: warhorses stay a fallback so the movies lane never starves)
        for e in rest:
            if len(reals) >= n_real: break
            e = dict(e); e["real"] = True; e["_vetted"] = True; take(e)
    if len(reals) < n_real:                                # BANK FLOOR — a lane must NEVER go dark when its bank has reals.
        # The UNUSED pool is exhausted: every banked real is a near-dup of the ever-growing no-repeat ledger, so the
        # dedup has starved the bank (movies hit this first — bank-only, no feeds). RECYCLE already-published banked
        # reals, LEAST-RECENTLY-USED first (oldest last-publish date; never-shown entries first). A repeated real every
        # few weeks is fine; a blank day is not. Same distinct-speaker + quality + family-lane-clean rules; recent
        # names and canon warhorses stay last. This is the guaranteed floor — after it, fail-safe means a genuinely
        # empty bank or a provider outage, never dedup starvation.
        recency = recency or {}
        recyc = [e for e in evergreen if _spk(e) and _spk(e) not in seen_spk
                 and real_quality_ok(e["text"], cat)
                 and (is_nsfw_lane(cat) or not has_profanity(e["text"]))]
        recyc.sort(key=lambda e: (_spk(e) in recent, is_canon_movie_line(e["text"]), recency.get(_norm(e["text"]), "")))
        for e in recyc:
            if len(reals) >= n_real: break
            e = dict(e); e["real"] = True; e["_vetted"] = True; e["_recycled"] = True; take(e)
    n_fake = 6 - len(reals)                                # fakes: distinct speakers, not overlapping the reals
    chosen_fakes = []
    for f in sorted(fakes, key=lambda x: _spk(x) in recent):
        if len(chosen_fakes) >= n_fake: break
        s = _spk(f)
        if not s or s in seen_spk: continue
        seen_spk.add(s); chosen_fakes.append(f)
    quotes = reals + chosen_fakes
    # fail-safe: a real 6-quote set with all-distinct speakers and ≥2 real / ≥2 fake (else publish nothing)
    if len(quotes) < 6 or sum(1 for q in quotes if q["real"]) < 2 or sum(1 for q in quotes if not q["real"]) < 2:
        return None
    if len({_spk(q) for q in quotes}) < len(quotes):
        return None                                        # belt-and-suspenders: never two of the same person
    random.shuffle(quotes)
    sneaky_idx = next((i for i, q in enumerate(quotes) if q.get("_sneaky")), None)
    out_quotes, trick = [], None
    for i, q in enumerate(quotes):
        qid = f"q{i+1}"
        item = {"id": qid, "text": q["text"], "speaker": q["speaker"], "context": q.get("context", ""), "real": q["real"]}
        if q["real"] and q.get("source"):
            item["source"] = q["source"]
        if not q["real"]:
            item["fake_note"] = q.get("fake_note") or "I made this one up."   # Mags voice; never "AI" (copy rule)
            if trick is None and (sneaky_idx == i or sneaky_idx is None):
                trick = qid
        out_quotes.append(item)
    if trick is None:
        trick = next((it["id"] for it in out_quotes if not it["real"]), None)
    return {"date": date, "edition": None, "category": cat,
            "curator": "auto (generate_day.py — reals verified verbatim vs source + cross-validated)",
            "politics_dial": ("on" if CATEGORIES.get(cat, {}).get("allow_politics") else "off"), "trickiest_fake": trick, "quotes": out_quotes}


def update_manifest(date, cat="general"):
    path = os.path.join(DAILY, "index.json")        # one manifest at the root; lanes nest under categories
    try:
        idx = json.load(open(path))
    except Exception:  # noqa: BLE001
        idx = {"game": "Said It?", "days": []}
    cats = idx.get("categories") or {}
    if cat == "general":                            # general IS the back-compat `days` array; it has NO
        idx["days"] = sorted(set(idx.get("days", []) + [date]))   # categories.general key (the app reads
        idx["categories"] = cats                    # `days` for the default lane — keep it that way)
        json.dump(idx, open(path, "w"), indent=2)
        return len(idx["days"])
    cats[cat] = sorted(set(cats.get(cat, []) + [date]))
    idx["categories"] = cats
    json.dump(idx, open(path, "w"), indent=2)
    return len(cats[cat])


def verify_manifest(date):
    """Batch 7a skip-alert. After the daily run, EVERY enabled lane must have an edition for `date` in the manifest.
    Return non-zero (the CI step then fails, loud + visible) if any lane stalled to nothing — so a silent gap like
    politics-06-19 / sports-06-20 can never go unnoticed again. Run AFTER the commit so published lanes still ship."""
    try:
        idx = json.load(open(os.path.join(DAILY, "index.json")))
    except Exception:  # noqa: BLE001
        idx = {}
    cats = idx.get("categories") or {}
    missing = []
    for cat in CATEGORIES:                              # the enabled lanes == the CATEGORIES the CI loop generates
        days = idx.get("days", []) if cat == "general" else cats.get(cat, [])
        if date not in days:
            missing.append(cat)
    if missing:
        print(f"  SKIP-ALERT [{date}]: lane(s) with NO edition today: {', '.join(missing)}. A lane stalled "
              f"(fresh verified reals below the floor AND a thin evergreen bank). Grow the bank or add feeds.",
              file=sys.stderr)
        return 1
    print(f"  manifest OK [{date}]: all {len(CATEGORIES)} enabled lanes published.")
    return 0


def _git(args, timeout=15):
    """Run a git command inside the web/ repo. Never raises: (returncode, stdout) — None returncode means git/network
    was unavailable (no repo, no remote, offline, timeout), which callers must treat as 'cannot verify', not 'clean'."""
    try:
        r = subprocess.run(["git"] + args, cwd=WEB, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception:  # noqa: BLE001 — no git binary, no network, hang: never let this crash generation
        return None, ""


def origin_has_diverged(head_exists, head_blob, origin_exists, origin_blob):
    """Pure decision (unit-testable without git/network): has another writer already published a DIFFERENT edition
    for this lane+date than the local checkout knows about? True only when origin has real content this checkout
    can't already account for — i.e. origin has it and either we don't (yet), or ours differs byte-for-byte."""
    if not origin_exists:
        return False                                    # nothing on origin to race against
    return (not head_exists) or (head_blob != origin_blob)


def check_not_stale(cat, date):
    """BATCH 12 follow-up (closes the 2026-07-01 incident): a local `generate_day.py` run and the nightly bot can
    both target the same lane+date independently — since generation is randomized, they diverge, and reconciling
    that after the fact means hand-repairing merge conflicts in the used-ledgers (exactly what Phase 1 fixed).
    Close the race INSTEAD OF merging around it: fetch origin (best-effort — silently skip if git/network isn't
    available, this must never block offline dev) and refuse LOUD if origin already has a different edition for
    this lane+date than local HEAD knows about. Applies even under --force (that's exactly the case that raced)."""
    rel = os.path.relpath(target_path(cat, date), WEB)
    rc, _ = _git(["rev-parse", "--is-inside-work-tree"])
    if rc != 0:
        return                                           # not a git checkout — nothing to verify against
    rc, branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    branch = branch.strip()
    if rc != 0 or not branch or branch == "HEAD":
        return                                           # detached HEAD / unknown — can't safely compare
    rc, _ = _git(["fetch", "origin", branch, "--quiet"])
    if rc != 0:
        print(f"  (origin-freshness check skipped for {cat}/{date}: git fetch failed — offline or no remote)")
        return
    rc_head, head_blob = _git(["show", f"HEAD:{rel}"])
    rc_origin, origin_blob = _git(["show", f"origin/{branch}:{rel}"])
    if origin_has_diverged(rc_head == 0, head_blob, rc_origin == 0, origin_blob):
        print(f"::error::origin/{branch} already has a DIFFERENT edition for {cat}/{date} than this checkout knows "
              f"about — another writer (the nightly bot, or another manual run) published it first. Refusing to "
              f"generate a diverging duplicate (this is exactly the 2026-07-01 race). Run `git pull` and re-run.",
              file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--politics", action="store_true")
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--category", default="general", choices=list(CATEGORIES.keys()))
    ap.add_argument("--verify", action="store_true",
                    help="skip-alert: exit non-zero if any enabled lane lacks an edition for --date (run AFTER the loop)")
    a = ap.parse_args()
    cat = a.category

    if a.verify:                                        # Batch 7a: post-run manifest check (no generation)
        return verify_manifest(a.date)

    target = target_path(cat, a.date)
    os.makedirs(daily_dir(cat), exist_ok=True)
    check_not_stale(cat, a.date)                         # refuse loud if origin already raced ahead of this checkout (even under --force)
    if os.path.exists(target) and not a.force:
        print(f"{cat}/{a.date} already exists — skipping (use --force to regenerate)."); return 0

    politics_on = CATEGORIES[cat].get("allow_politics") or (a.politics and cat == "general")
    print(f"== generating [{cat}] {a.date} (politics {'ON' if politics_on else 'OFF'}) ==")
    feeds = dict(CATEGORIES[cat]["feeds"])
    if a.politics and cat == "general":
        feeds["politics"] = POLITICS_FEEDS

    used_lane = load_used(cat)                                   # this lane's OWN published ledger — saved back at the end
    used_all = load_all_used()                                   # cross-lane union — the no-repeat membership test (Batch 7b)
    dup_idx = build_dup_index(used_all)                          # built once; near-dup-aware
    recent_spk, spk_ledger = load_recent_speakers(cat, a.date)   # names used in the last ~21 days → vary away from them
    recent_spk |= today_speakers(a.date, cat)                    # + names already used in OTHER lanes today (cross-lane variety)
    recent_skels = load_recent_skeletons(cat)                    # REC 4b: rhetorical shapes recently used in this lane → vary away
    skel_seen = set(recent_skels)
    print(f"  used-quote ledger [{cat}]: {len(used_lane)} this lane / {len(used_all)} all lanes excluded · recent speakers to vary from: {len(recent_spk)} · recent fake-skeletons: {len(recent_skels)}")
    reals = gather_reals(feeds, a.days, dup_idx, cat)
    fakes = forge_fakes(dup_idx, cat, 10, skel_seen=skel_seen)   # lane-aware, forge extra for headroom (distinct-speaker + skeleton dedup needs slack)
    fakes = safety_screen(fakes, nsfw=CATEGORIES[cat].get("nsfw", False))   # screen UP FRONT (NSFW lane: profanity OK, harm not)
    print(f"  fakes: {len(fakes)} forged + screened safe")
    edition = assemble(a.date, reals, fakes, load_evergreen(cat), dup_idx, cat, recent=recent_spk, recency=bank_recency(cat))
    # Batch 7a: bank the verified-but-unused fresh reals (zero fabrication — already verbatim+cross-validated) so a
    # thin-news day can still reach the floor from this lane's own bank instead of going silent. Runs even on fail-safe.
    banked = bank_surplus_reals(reals, edition, cat, dup_idx)
    if banked:
        print(f"  banked {banked} surplus verified real(s) → evergreen_{'reals' if cat == 'general' else cat}.json (self-filling bank)")
    if not edition:
        print(f"  FAIL-SAFE [{cat}]: could not assemble a quality, NON-REPEATING set (6 quotes, ALL distinct "
              f"speakers, >=2 real, >=2 fake). Wrote nothing (grow evergreen_{cat if cat!='general' else 'reals'}.json "
              "or add quote-rich feeds for this lane).", file=sys.stderr)
        return 2

    n = update_manifest(a.date, cat)             # edition number = position in this lane's manifest
    edition["edition"] = n
    json.dump(edition, open(target, "w"), indent=2, ensure_ascii=False)
    used_lane |= {_norm(q["text"]) for q in edition["quotes"]}   # never publish these again (this lane's file; cross-lane via load_all_used)
    save_used(used_lane, cat)
    save_recent_speakers(spk_ledger, edition, a.date, cat)   # record today's speakers → cross-day name variety
    save_skeletons(recent_skels + [skeleton(q["text"]) for q in edition["quotes"] if not q["real"]], cat)  # REC 4b: record this edition's fake shapes
    print(f"  WROTE {target}  (edition {n}, {len(edition['quotes'])} quotes, "
          f"{sum(1 for q in edition['quotes'] if q['real'])} real / {sum(1 for q in edition['quotes'] if not q['real'])} fake)")
    spot_check_summary(edition, cat)                         # REC 7: compact 6x6 readout for the human morning spot-check
    return 0


if __name__ == "__main__":
    sys.exit(main())
