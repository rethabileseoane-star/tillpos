-- Till POS: multi-device sync schema.
--
-- Run this once, in the Supabase dashboard's SQL editor, against a project that
-- is dedicated to one shop. It is safe to run again: every statement either
-- creates something if it is missing or replaces a policy or trigger.
--
-- Column names match the client rows exactly (camelCase, quoted) so an outbox
-- payload can be upserted with no translation layer in between.

-- ---------------------------------------------------------------------------
-- The pull cursor
-- ---------------------------------------------------------------------------
--
-- Every write gets a strictly increasing sequence number. Devices pull
-- "everything above my cursor", which is what makes an interrupted sync resume
-- rather than start again, and what keeps a phone that was offline for a day
-- from missing an edit made in the middle of it.

create sequence if not exists till_seq;

create or replace function till_touch()
returns trigger
language plpgsql
as $$
begin
  new."serverSeq" := nextval('till_seq');
  new."serverUpdatedAt" := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists products (
  id                 text primary key,
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
  "serverUpdatedAt"  timestamptz not null default now()
);

create table if not exists sales (
  id              text primary key,
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
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null,
  "deletedAt"     bigint,
  rev             integer not null default 1,
  "deviceId"      text not null,
  "serverSeq"     bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now()
);

create table if not exists sale_lines (
  id            text primary key,
  "saleId"      text not null references sales (id) on delete cascade,
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
  "serverUpdatedAt" timestamptz not null default now()
);

create table if not exists stock_movements (
  id           text primary key,
  "productId"  text not null,
  delta        integer not null default 0,
  reason       text not null default 'adjust',
  "refId"      text,
  note         text not null default '',
  "createdAt"  bigint not null,
  "updatedAt"  bigint not null,
  "deletedAt"  bigint,
  rev          integer not null default 1,
  "deviceId"   text not null,
  "serverSeq"  bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now()
);

create table if not exists cash_movements (
  id            text primary key,
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
  "serverUpdatedAt" timestamptz not null default now()
);

-- Only shop-wide settings are ever written here (currently the shop name used
-- on report headers). The app lock and a device's own session bookkeeping are
-- never sent, so there is no row for them to leak from.
--
-- The primary key is the client's id, which is the setting key itself: two
-- devices editing the shop name therefore upsert one row instead of racing to
-- create two, which the key index below would otherwise reject.
create table if not exists settings (
  id           text primary key,
  key          text not null,
  value        text not null default '',
  "createdAt"  bigint not null,
  "updatedAt"  bigint not null,
  "deletedAt"  bigint,
  rev          integer not null default 1,
  "deviceId"   text not null,
  "serverSeq"  bigint not null default nextval('till_seq'),
  "serverUpdatedAt" timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The cursor index is the one that matters: every pull is
-- `where "serverSeq" > cursor order by "serverSeq"`.

create index if not exists products_barcode_idx on products (barcode);
create index if not exists products_seq_idx on products ("serverSeq");

create index if not exists sales_date_idx on sales ("businessDate");
create index if not exists sales_receipt_idx on sales ("receiptNo");
create index if not exists sales_seq_idx on sales ("serverSeq");

create index if not exists sale_lines_sale_idx on sale_lines ("saleId");
create index if not exists sale_lines_seq_idx on sale_lines ("serverSeq");

create index if not exists stock_movements_product_idx on stock_movements ("productId");
create index if not exists stock_movements_seq_idx on stock_movements ("serverSeq");

create index if not exists cash_movements_date_idx on cash_movements ("businessDate");
create index if not exists cash_movements_seq_idx on cash_movements ("serverSeq");

create unique index if not exists settings_key_idx on settings (key);
create index if not exists settings_seq_idx on settings ("serverSeq");

-- ---------------------------------------------------------------------------
-- Triggers: stamp the cursor on every insert and update
-- ---------------------------------------------------------------------------

drop trigger if exists products_touch on products;
create trigger products_touch before insert or update on products
  for each row execute function till_touch();

drop trigger if exists sales_touch on sales;
create trigger sales_touch before insert or update on sales
  for each row execute function till_touch();

drop trigger if exists sale_lines_touch on sale_lines;
create trigger sale_lines_touch before insert or update on sale_lines
  for each row execute function till_touch();

drop trigger if exists stock_movements_touch on stock_movements;
create trigger stock_movements_touch before insert or update on stock_movements
  for each row execute function till_touch();

drop trigger if exists cash_movements_touch on cash_movements;
create trigger cash_movements_touch before insert or update on cash_movements
  for each row execute function till_touch();

drop trigger if exists settings_touch on settings;
create trigger settings_touch before insert or update on settings
  for each row execute function till_touch();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Signed-in users of this project can read and write the shop's ledger; nobody
-- anonymous can. The project is used by one shop, so "any signed-in user sees
-- the ledger" is the intent — that is what makes a second till see the first
-- till's sales.
--
-- If you later host several shops in one project, add a `shopId` column plus a
-- claim on the JWT and replace these policies with a `shopId = auth.jwt()`
-- check. Every row already carries `deviceId` for the same reason.

alter table products        enable row level security;
alter table sales           enable row level security;
alter table sale_lines      enable row level security;
alter table stock_movements enable row level security;
alter table cash_movements  enable row level security;
alter table settings        enable row level security;

drop policy if exists "shop members" on products;
create policy "shop members" on products
  for all to authenticated using (true) with check (true);

drop policy if exists "shop members" on sales;
create policy "shop members" on sales
  for all to authenticated using (true) with check (true);

drop policy if exists "shop members" on sale_lines;
create policy "shop members" on sale_lines
  for all to authenticated using (true) with check (true);

drop policy if exists "shop members" on stock_movements;
create policy "shop members" on stock_movements
  for all to authenticated using (true) with check (true);

drop policy if exists "shop members" on cash_movements;
create policy "shop members" on cash_movements
  for all to authenticated using (true) with check (true);

drop policy if exists "shop members" on settings;
create policy "shop members" on settings
  for all to authenticated using (true) with check (true);
