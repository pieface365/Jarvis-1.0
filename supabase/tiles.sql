-- Vitality Base — MCP-built tiles (the "make a tile from Claude" store)
--
-- Run this ONCE in your own Supabase project (Dashboard → SQL Editor → paste → Run).
-- It creates the table that holds tiles Claude builds for you through the connector
-- (see app/api/mcp). Your dashboard reads this table on load and shows any tile it
-- finds here, so a tile made from Claude — on your laptop or your phone — appears
-- without a redeploy. A static file at public/tiles/<slot>.html still works; a row
-- here for the same slot wins (it's the live, editable copy).
--
-- This is a PERSONAL deployment with no login, so the policy below is open: the
-- table only ever holds YOUR tiles, reached with your project's public anon key.
-- The connector itself is guarded by a secret token (MCP_TOKEN), so only you can
-- write to it. (Lock the table down later with Supabase Auth if you add accounts.)

create table if not exists public.tiles (
  slot       text primary key,       -- one of: train, fuel, vitals, vee, brand, peak, finance
  name       text,                    -- optional display name
  html       text not null,           -- the sealed, self-contained tile HTML
  updated_at timestamptz not null default now()
);

alter table public.tiles enable row level security;

-- Open access for the anon key (personal instance). Raw SQL doesn't auto-grant,
-- so the grant is explicit.
drop policy if exists "tiles open" on public.tiles;
create policy "tiles open" on public.tiles
  for all using (true) with check (true);

grant select, insert, update, delete on table public.tiles to anon, authenticated;
