-- Credit sales and bad debts: additive upgrade for an existing till project.
--
-- Run this once in Supabase -> SQL Editor before installing the build that
-- supports credit. It is safe to run again: every column is added only if it
-- is missing, and existing rows get the defaults.
--
-- The app never sends a service_role key. This is only the project's own SQL
-- editor; the mobile app still uses the anon/public key with RLS.

alter table public.sales add column if not exists "customerName" text not null default '';
alter table public.sales add column if not exists "writtenOffAt" bigint;
alter table public.sales add column if not exists "writeOffDate" date;
alter table public.sales add column if not exists "writtenOffAmount" bigint not null default 0;
alter table public.sales add column if not exists "writeOffReason" text not null default '';
alter table public.sales add column if not exists "writtenOffBy" text not null default '';

alter table public.cash_movements add column if not exists "staffName" text not null default '';

-- Quick check: this should list the seven new columns.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'sales' and column_name in (
      'customerName', 'writtenOffAt', 'writeOffDate',
      'writtenOffAmount', 'writeOffReason', 'writtenOffBy'
    ))
    or (table_name = 'cash_movements' and column_name = 'staffName')
  )
order by table_name, column_name;
