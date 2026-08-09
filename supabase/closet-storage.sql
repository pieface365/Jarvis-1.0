-- Vitality — closet photo storage (optional)
--
-- Run this ONCE in your own Supabase project (Dashboard → SQL Editor → paste →
-- Run), AFTER supabase/sync.sql, if you want closet item photos to scale past
-- the ~2MB per-tile data budget. With this in place, photos snapped in the
-- Closet tile are uploaded to a public 'closet' Storage bucket and the tile
-- stores only the URL — so your wardrobe can hold as many photographed items as
-- you like. WITHOUT this, the closet still works; it just keeps one small photo
-- inline per item (which is fine for a modest wardrobe).
--
-- Personal-instance model (same as sync.sql): the bucket is public-read and the
-- project's public anon key may upload/delete. Only your own dashboard writes to
-- it. (Lock it down later with Supabase Auth if you ever want to.)

-- The bucket. Public so <img src> and getPublicUrl() work without signing.
insert into storage.buckets (id, name, public)
values ('closet', 'closet', true)
on conflict (id) do update set public = true;

-- Anon-key access, scoped to just this bucket. Public buckets are readable
-- without a policy, but the explicit read policy is harmless and clear.
drop policy if exists "closet anon read" on storage.objects;
create policy "closet anon read" on storage.objects
  for select using (bucket_id = 'closet');

drop policy if exists "closet anon insert" on storage.objects;
create policy "closet anon insert" on storage.objects
  for insert with check (bucket_id = 'closet');

drop policy if exists "closet anon delete" on storage.objects;
create policy "closet anon delete" on storage.objects
  for delete using (bucket_id = 'closet');
