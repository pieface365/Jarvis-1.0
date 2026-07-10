-- Vitality Base — optional cross-device sync
--
-- Run this ONCE in your own Supabase project (Dashboard → SQL Editor → paste → Run).
-- It creates the single table that holds each tile's saved data, so opening your
-- dashboard on another device (your phone) shows the same data.
--
-- This is a PERSONAL deployment with no login, so the policy below is open: the
-- table only ever holds YOUR data, reached with your project's public anon key.
-- (If you want it locked down later, add Supabase Auth and scope the policy to
-- auth.uid() — a topic for a future build.)

create table if not exists public.tile_data (
  tile_id    text primary key,
  data       jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tile_data enable row level security;

-- Open access for the anon key (personal instance). Raw SQL doesn't auto-grant,
-- so the grant is explicit.
drop policy if exists "tile_data open" on public.tile_data;
create policy "tile_data open" on public.tile_data
  for all using (true) with check (true);

grant select, insert, update, delete on table public.tile_data to anon, authenticated;
