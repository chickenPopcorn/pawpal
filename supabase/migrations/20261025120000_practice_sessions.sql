-- PawPal practice time: one row per practice session, so the calendar can
-- mark each day the daily goal was met, on every device. A session is one
-- page visit on one local calendar day; the browser makes up its id and
-- re-sends its running total, so a repeated upload never counts twice and two
-- devices add up.
--
-- The live project already has the table, its triggers and its policy, made
-- before the app synced practice: everything here is written to leave what
-- exists as it is, and only adds the session limit.

create table if not exists public.practice_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The player's local calendar day, which the browser decides.
  day date not null,
  started_at timestamptz not null,
  seconds integer not null check (seconds between 0 and 86400),
  -- Seconds per song id.
  songs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(songs) = 'object' and octet_length(songs::text) <= 16384),
  updated_at timestamptz not null default now()
);
create index if not exists practice_sessions_user_day
  on public.practice_sessions (user_id, day);

drop trigger if exists practice_sessions_stamp on public.practice_sessions;
create trigger practice_sessions_stamp before insert or update on public.practice_sessions
  for each row execute function public.stamp_updated_at();

-- A practice session only grows, but two tabs or devices can upload copies
-- of the same session out of order. An update never lowers a session's time:
-- an older, smaller copy leaves the row as it was.
create or replace function public.keep_practice_session_growing() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.seconds < old.seconds then
    new.seconds := old.seconds;
    new.songs := old.songs;
  end if;
  return new;
end;
$$;

drop trigger if exists practice_sessions_never_shrink on public.practice_sessions;
create trigger practice_sessions_never_shrink before update on public.practice_sessions
  for each row execute function public.keep_practice_session_growing();

-- A new session's day is near today (the calendar keeps 92 days; a time zone
-- can be a day ahead), and each account keeps at most 50 sessions a day. The
-- app makes a few a day, so more can only come from calling the Data API
-- directly; without a limit, one account could fill the database for
-- everyone.
create or replace function public.limit_practice_sessions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.day = old.day then
    return new;
  end if;
  if new.day < current_date - 100 or new.day > current_date + 1 then
    raise exception 'A practice session must be from the last 100 days.'
      using errcode = 'check_violation';
  end if;
  -- One insert at a time per account, so concurrent ones cannot both slip
  -- under the limit.
  perform pg_advisory_xact_lock(hashtext('practice:' || new.user_id::text));
  if (
    select count(*) from public.practice_sessions
    where user_id = new.user_id and day = new.day and id <> new.id
  ) >= 50 then
    raise exception 'This account already has 50 practice sessions on %.', new.day
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists practice_sessions_quota on public.practice_sessions;
create trigger practice_sessions_quota before insert or update on public.practice_sessions
  for each row execute function public.limit_practice_sessions();

alter table public.practice_sessions enable row level security;

drop policy if exists "Users manage their own practice sessions" on public.practice_sessions;
create policy "Users manage their own practice sessions" on public.practice_sessions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.practice_sessions from anon;
grant select, insert, update, delete on public.practice_sessions to authenticated;
