# Said It? — deploy notes

The site is a single static file (`index.html`) + `config.js` (runtime config, no build). Two optional backends:

1. **Apps Script endpoint** (already deployed) — anonymous events + crew leaderboard. See `../endpoint/apps_script.gs`.
2. **Supabase** (H-A accounts) — magic-link / Google sign-in to **save + sync** streak, stats and crews across devices.
   Guests play with **no login**; signing in is purely additive. $0 on the free tier.

---

## H-A — Supabase setup (one time)

`config.js` already has `SUPABASE_URL` + `SUPABASE_ANON_KEY` (the anon key is **public-safe _with_ the RLS below** —
never put the `service_role`/secret key in `config.js`).

### 1. Run this SQL  (Supabase dashboard → **SQL Editor** → paste → **Run**)

```sql
-- one row per signed-in account: their canonical play id + a synced state blob
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  sid         text,                      -- the account's canonical "play id" (carried across devices)
  state       jsonb,                     -- the player's own ST blob (streak, days, crews, stats, name)
  updated_at  timestamptz default now()
);

alter table public.profiles enable row level security;

-- a user can read/write ONLY their own row. No one can read anyone else's state (spoiler-free + private).
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);
```

Why this is spoiler-free + safe: a player's per-quote answers only ever live in **their own** `state` row, which
RLS makes readable **only by that user**. The crew leaderboard (Apps Script endpoint) carries **scores only**, never
answers. So no one can ever read another player's answers. Crews themselves stay on the endpoint, keyed by the
account's synced `sid`, so the same account on a second device sees the same crews automatically.

### 2. Auth providers  (Authentication → Providers)
- **Email** (magic link): **enabled** ✓ (you did this).
- **Google**: add a free Google OAuth client when ready (the in-app "Continue with Google" button lights up once it's on).
- **Apple**: deferred (needs a paid $99/yr Apple Developer account).

### 3. Redirect URL  (Authentication → URL Configuration)
Add the live site as an allowed redirect so the magic-link returns to the app:
`https://doescodinggiteasier.github.io/said-it/`  (and `http://localhost*` if you test locally).

### (Optional) Anonymous sign-ins
Not required — guests use a local id and still play fully. If you enable **Authentication → Anonymous sign-ins**,
signed-out users also get a Supabase session; the app falls back to local-only if it's off.

---

## Live test checklist (after the SQL + redirect URL are set)
1. Open the site, play a set as a guest → streak/stats show (no login needed).
2. Crew page → **Sign in to save & sync** → enter your email → open the magic link → you're back, signed in.
3. On a **second device/browser**, sign in with the same email → same streak, stats, and crews appear.
4. (RLS) In the Supabase SQL editor, confirm a query as another user can't read your `profiles` row.
