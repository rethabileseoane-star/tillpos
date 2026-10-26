-- Till POS: multi-device, multi-shop sync schema.
--
-- Run this in the Supabase dashboard's SQL editor. It is safe to run again:
-- columns, indexes and policies are created only when missing, and additive
-- upgrades backfill existing rows to shop A without losing history.
--
-- Column names match the client rows exactly (camelCase, quoted) so an outbox
-- payload can be upserted with no translation layer in between.
--
-- One Supabase project can hold several shops. Every row carries a `shopId`,
-- and RLS only lets a signed-in user touch rows whose `shopId` matches
-- `auth.jwt() -> 'app_metadata' ->> 'shop_id'`. Each shop therefore needs its
-- own Supabase Auth user with that claim. The claim is checked by the app too,
-- so a shop A login cannot accidentally be used on shop B's phone.

-- ---------------------------------------------------------------------------
-- The pull cursor
-- ---------------------------------------------------------------------------
--
-- Every write gets a strictly increasing sequence number. Devices pull
-- "everything above my cursor" for their own shop, which is what makes an
-- interrupted sync resume rather than start again, and what keeps a phone that
-- was offline for a day from missing an edit made in the middle of it.

create sequence if not exists till_seq;

create or replace function public.till_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new."serverSeq" := nextval('public.till_seq');
  new."serverUpdatedAt" := now();
  return new;
end;
$$;

/**
 * The active shop's code from the caller's JWT.
 *
 * Kept as a STABLE function so Postgres can evaluate the claim once per
 * statement instead of once per row. It is not SECURITY DEFINER: it only reads
 * the caller's own token.
 */
create or replace function public.till_shop_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'shop_id', '')
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists products (
  "shopId"           text not null,
  id                 text not null,
  barcode            text not null,
  barcodes           text[] not null default '{}',
  name               text not null,
  details            text,
  price              bigint not null default 0,
  cost               bigint not null default 0,
  "stockQty"         integer not null default 0,
  "lowStockThreshold" integer not null default 0,
  category           text not null default 'Uncategorised',
  active             boolean not null default true,
  "createdAt"        bigint not null,
  "updatedAt"        bigint not null,
  "deletedAt"        bigint,
  rev                integer not null default 1,
  "deviceId"         text not null,
  "serverSeq"        bigint not null default nextval('till_seq'),
  "serverUpdatedAt"  timestamptz not null default now(),
  primary key ("shopId", id)
);

create table if not exists sales (
  "shopId"        text not null,
  id              text not null,
  "receiptNo"     text not null,
  "businessDate"  date not null,
  subtotal        bigint not null default 0,
  total           bigint not null default 0,
  "paymentMethod" text not null default 'cash',
  "amountTendered" bigint,
  change          bigint,
  status          text not null default 'completed',
  "voidedAt"      bigint,
  note            text not null default '',
  "cashierName"   text not null default '',
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null,
  "deletedAt"     bigint,
  rev             integer not null default 1,
  "deviceId"      text not null,
  "serverSeq"     bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

create table if not exists sale_lines (
  "shopId"      text not null,
  id            text not null,
  "saleId"      text not null,
  "productId"   text not null,
  barcode       text not null default '',
  name          text not null default '',
  "unitPrice"   bigint not null default 0,
  qty           integer not null default 0,
  "lineTotal"   bigint not null default 0,
  "adHoc"       boolean not null default false,
  "createdAt"   bigint not null,
  "updatedAt"   bigint not null,
  "deletedAt"   bigint,
  rev           integer not null default 1,
  "deviceId"    text not null,
  "serverSeq"   bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id),
  constraint sale_lines_shop_sale_fkey
    foreign key ("shopId", "saleId") references sales ("shopId", id) on delete cascade
);

create table if not exists stock_movements (
  "shopId"      text not null,
  id            text not null,
  "productId"   text not null,
  delta         integer not null default 0,
  reason        text not null default 'adjust',
  "refId"       text,
  note          text not null default '',
  "createdAt"   bigint not null,
  "updatedAt"   bigint not null,
  "deletedAt"   bigint,
  rev           integer not null default 1,
  "deviceId"    text not null,
  "serverSeq"   bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

create table if not exists cash_movements (
  "shopId"      text not null,
  id            text not null,
  reason        text not null default 'cash_in',
  delta         bigint not null default 0,
  "refId"       text,
  kind          text,
  "businessDate" date not null,
  note          text not null default '',
  "createdAt"   bigint not null,
  "updatedAt"   bigint not null,
  "deletedAt"   bigint,
  rev           integer not null default 1,
  "deviceId"    text not null,
  "serverSeq"   bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

-- Only shop-wide settings are ever written here (currently the shop name used
-- on report headers). The app lock and a device's own session bookkeeping are
-- never sent, so there is no row for them to leak from.
--
-- The primary key is (shopId, id), where id is the setting key itself. Two
-- devices editing the same shop's name upsert one row; two shops can each have
-- a `report.shopName` row without colliding.
create table if not exists settings (
  "shopId"      text not null,
  id            text not null,
  key           text not null,
  value         text not null default '',
  "createdAt"   bigint not null,
  "updatedAt"   bigint not null,
  "deletedAt"   bigint,
  rev           integer not null default 1,
  "deviceId"    text not null,
  "serverSeq"   bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now(),
  primary key ("shopId", id)
);

-- ---------------------------------------------------------------------------
-- Additive upgrades
-- ---------------------------------------------------------------------------
--
-- Projects created before multi-shop already have these tables, so the
-- `create table if not exists` above will not add the new column. Backfill
-- existing rows to shop A, then remove the temporary default so every new row
-- must be tagged explicitly by the app.

alter table products        add column if not exists "shopId" text not null default 'shop-a';
alter table sales           add column if not exists "shopId" text not null default 'shop-a';
alter table sale_lines      add column if not exists "shopId" text not null default 'shop-a';
alter table stock_movements add column if not exists "shopId" text not null default 'shop-a';
alter table cash_movements  add column if not exists "shopId" text not null default 'shop-a';
alter table settings        add column if not exists "shopId" text not null default 'shop-a';

update products        set "shopId" = 'shop-a' where "shopId" is null;
update sales           set "shopId" = 'shop-a' where "shopId" is null;
update sale_lines      set "shopId" = 'shop-a' where "shopId" is null;
update stock_movements set "shopId" = 'shop-a' where "shopId" is null;
update cash_movements  set "shopId" = 'shop-a' where "shopId" is null;
update settings        set "shopId" = 'shop-a' where "shopId" is null;

alter table products        alter column "shopId" set not null;
alter table sales           alter column "shopId" set not null;
alter table sale_lines      alter column "shopId" set not null;
alter table stock_movements alter column "shopId" set not null;
alter table cash_movements  alter column "shopId" set not null;
alter table settings        alter column "shopId" set not null;

alter table products        alter column "shopId" drop default;
alter table sales           alter column "shopId" drop default;
alter table sale_lines      alter column "shopId" drop default;
alter table stock_movements alter column "shopId" drop default;
alter table cash_movements  alter column "shopId" drop default;
alter table settings        alter column "shopId" drop default;

-- The old tables keyed every row by id alone. Re-key them per shop. The old
-- settings_key index must also go: the same setting key is now valid once per
-- shop.
--
-- sale_lines points at sales, so its foreign key has to be dropped before the
-- old sales primary key can be replaced. It is recreated below with shopId in
-- both sides, so a line cannot point at another shop's sale.
alter table sale_lines drop constraint if exists "sale_lines_saleId_fkey";
alter table sale_lines drop constraint if exists sale_lines_shop_sale_fkey;

alter table products        drop constraint if exists products_pkey;
alter table sales           drop constraint if exists sales_pkey;
alter table sale_lines      drop constraint if exists sale_lines_pkey;
alter table stock_movements  drop constraint if exists stock_movements_pkey;
alter table cash_movements   drop constraint if exists cash_movements_pkey;
alter table settings         drop constraint if exists settings_pkey;

alter table products        add constraint products_pkey primary key ("shopId", id);
alter table sales           add constraint sales_pkey primary key ("shopId", id);
alter table sale_lines      add constraint sale_lines_pkey primary key ("shopId", id);
alter table stock_movements add constraint stock_movements_pkey primary key ("shopId", id);
alter table cash_movements  add constraint cash_movements_pkey primary key ("shopId", id);
alter table settings        add constraint settings_pkey primary key ("shopId", id);

alter table sale_lines add constraint sale_lines_shop_sale_fkey
  foreign key ("shopId", "saleId") references sales ("shopId", id) on delete cascade;

-- Keep the cashier-name upgrade from the previous schema.
alter table sales add column if not exists "cashierName" text not null default '';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- Every pull is `where shopId = ... and serverSeq > cursor order by serverSeq`.
-- The shop column comes first because it is an equality condition.

drop index if exists products_barcode_idx;
drop index if exists products_seq_idx;
create index if not exists products_shop_barcode_idx on products ("shopId", barcode);
create index if not exists products_shop_seq_idx on products ("shopId", "serverSeq");

drop index if exists sales_date_idx;
drop index if exists sales_receipt_idx;
drop index if exists sales_seq_idx;
create index if not exists sales_shop_date_idx on sales ("shopId", "businessDate");
create index if not exists sales_shop_receipt_idx on sales ("shopId", "receiptNo");
create index if not exists sales_shop_seq_idx on sales ("shopId", "serverSeq");

drop index if exists sale_lines_sale_idx;
drop index if exists sale_lines_seq_idx;
create index if not exists sale_lines_shop_sale_idx on sale_lines ("shopId", "saleId");
create index if not exists sale_lines_shop_seq_idx on sale_lines ("shopId", "serverSeq");

drop index if exists stock_movements_product_idx;
drop index if exists stock_movements_seq_idx;
create index if not exists stock_movements_shop_product_idx
  on stock_movements ("shopId", "productId");
create index if not exists stock_movements_shop_seq_idx
  on stock_movements ("shopId", "serverSeq");

drop index if exists cash_movements_date_idx;
drop index if exists cash_movements_seq_idx;
create index if not exists cash_movements_shop_date_idx
  on cash_movements ("shopId", "businessDate");
create index if not exists cash_movements_shop_seq_idx
  on cash_movements ("shopId", "serverSeq");

drop index if exists settings_key_idx;
drop index if exists settings_seq_idx;
create unique index if not exists settings_shop_key_idx on settings ("shopId", key);
create index if not exists settings_shop_seq_idx on settings ("shopId", "serverSeq");

-- ---------------------------------------------------------------------------
-- Triggers: stamp the cursor on every insert and update
-- ---------------------------------------------------------------------------

drop trigger if exists products_touch on products;
create trigger products_touch before insert or update on products
  for each row execute function public.till_touch();

drop trigger if exists sales_touch on sales;
create trigger sales_touch before insert or update on sales
  for each row execute function public.till_touch();

drop trigger if exists sale_lines_touch on sale_lines;
create trigger sale_lines_touch before insert or update on sale_lines
  for each row execute function public.till_touch();

drop trigger if exists stock_movements_touch on stock_movements;
create trigger stock_movements_touch before insert or update on stock_movements
  for each row execute function public.till_touch();

drop trigger if exists cash_movements_touch on cash_movements;
create trigger cash_movements_touch before insert or update on cash_movements
  for each row execute function public.till_touch();

drop trigger if exists settings_touch on settings;
create trigger settings_touch before insert or update on settings
  for each row execute function public.till_touch();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Each shop has its own Supabase Auth user. Its JWT carries
-- `app_metadata.shop_id`, and a row is visible only when the row's shopId
-- matches that claim. A missing claim denies everything.

alter table products        enable row level security;
alter table sales           enable row level security;
alter table sale_lines      enable row level security;
alter table stock_movements enable row level security;
alter table cash_movements  enable row level security;
alter table settings        enable row level security;

drop policy if exists "shop members" on products;
drop policy if exists "shop rows" on products;
create policy "shop rows" on products
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on sales;
drop policy if exists "shop rows" on sales;
create policy "shop rows" on sales
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on sale_lines;
drop policy if exists "shop rows" on sale_lines;
create policy "shop rows" on sale_lines
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on stock_movements;
drop policy if exists "shop rows" on stock_movements;
create policy "shop rows" on stock_movements
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on cash_movements;
drop policy if exists "shop rows" on cash_movements;
create policy "shop rows" on cash_movements
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

drop policy if exists "shop members" on settings;
drop policy if exists "shop rows" on settings;
create policy "shop rows" on settings
  for all to authenticated
  using ("shopId" = (select public.till_shop_id()))
  with check ("shopId" = (select public.till_shop_id()));

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
--
-- RLS decides which rows are visible; grants decide whether the table can be
-- reached at all. The app is always authenticated. Anonymous requests get
-- nothing, and the public schema does not need the tables exposed to anon.

revoke all on table products, sales, sale_lines, stock_movements, cash_movements, settings
  from anon, authenticated, service_role;
grant select, insert, update, delete on table
  products, sales, sale_lines, stock_movements, cash_movements, settings
  to authenticated, service_role;

revoke all on sequence public.till_seq from public, anon;
grant usage, select on sequence public.till_seq to authenticated, service_role;

revoke all on function public.till_touch() from public, anon;
grant execute on function public.till_touch() to authenticated, service_role;

revoke all on function public.till_shop_id() from public, anon;
grant execute on function public.till_shop_id() to authenticated, service_role;

-- Tell PostgREST to pick up the new columns, composite keys and policies now,
-- rather than waiting for its next scheduled reload.
notify pgrst, 'reload schema';
