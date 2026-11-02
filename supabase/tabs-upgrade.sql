-- Customer tabs: additive upgrade for an existing till project.
--
-- A tab is money the shop owes a customer, usually change kept when the drawer
-- had none. Run this once in Supabase -> SQL Editor before using tabs with
-- cloud sync. It is safe to run again: tables, columns, indexes, triggers and
-- policies are all created only when missing.
--
-- The app never sends a service_role key. This is only the project's own SQL
-- editor; the mobile app still uses the anon/public key with RLS.

create table if not exists public.customer_tabs (
  "shopId"      text not null,
  id            text not null,
  name          text not null,
  phone         text not null default '',
  note          text not null default '',
  "createdAt"   bigint not null,
  "updatedAt"   bigint not null,
  "deletedAt"   bigint,
  rev           integer not null default 1,
  "deviceId"    text not null,
  "serverSeq"   bigint not null default nextval('public.till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

create table if not exists public.tab_entries (
  "shopId"        text not null,
  id              text not null,
  "tabId"         text not null,
  kind            text not null default 'credit',
  amount          bigint not null default 0,
  "saleId"        text,
  "cashMovementId" text,
  "businessDate"  date not null,
  note            text not null default '',
  "staffName"     text not null default '',
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null,
  "deletedAt"     bigint,
  rev             integer not null default 1,
  "deviceId"      text not null,
  "serverSeq"     bigint not null default nextval('public.till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

-- A tab sale carries the tab it used and any change the customer left on it.
alter table public.sales add column if not exists "tabId" text;
alter table public.sales add column if not exists "tabApplied" bigint;
alter table public.sales add column if not exists "tabChangeKept" bigint;

create index if not exists customer_tabs_shop_name_idx
  on public.customer_tabs ("shopId", name);
create index if not exists customer_tabs_shop_seq_idx
  on public.customer_tabs ("shopId", "serverSeq");
create index if not exists tab_entries_shop_tab_idx
  on public.tab_entries ("shopId", "tabId");
create index if not exists tab_entries_shop_date_idx
  on public.tab_entries ("shopId", "businessDate");
create index if not exists tab_entries_shop_seq_idx
  on public.tab_entries ("shopId", "serverSeq");

drop trigger if exists customer_tabs_touch on public.customer_tabs;
create trigger customer_tabs_touch before insert or update on public.customer_tabs
  for each row execute function public.till_touch();

drop trigger if exists tab_entries_touch on public.tab_entries;
create trigger tab_entries_touch before insert or update on public.tab_entries
  for each row execute function public.till_touch();

alter table public.customer_tabs enable row level security;
alter table public.tab_entries enable row level security;

drop policy if exists "shop members" on public.customer_tabs;
drop policy if exists "shop rows" on public.customer_tabs;
create policy "shop rows" on public.customer_tabs
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on public.tab_entries;
drop policy if exists "shop rows" on public.tab_entries;
create policy "shop rows" on public.tab_entries
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

revoke all on table public.customer_tabs, public.tab_entries
  from anon, authenticated, service_role;
grant select, insert, update, delete on table public.customer_tabs, public.tab_entries
  to authenticated, service_role;

-- Quick check: three sales columns and two tab tables.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'sales' and column_name in ('tabId', 'tabApplied', 'tabChangeKept'))
    or table_name in ('customer_tabs', 'tab_entries')
  )
order by table_name, ordinal_position;
