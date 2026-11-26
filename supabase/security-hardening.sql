-- Security hardening for the licence tables and admin helper.
--
-- Run once in Supabase -> SQL Editor. Safe to run again.
-- The Supabase connection used for this audit applied the GRANT fix already;
-- the admin-helper move still needs to be run here if you want the linter
-- warning about the SECURITY DEFINER function to go away.

-- ---------------------------------------------------------------------------
-- Least privilege on licence tables.
-- RLS governs SELECT/INSERT/UPDATE/DELETE. TRUNCATE, TRIGGER and REFERENCES
-- are not covered by RLS, and no client or edge function needs them: the
-- licence function uses the service-role key, which keeps its own grants.
-- ---------------------------------------------------------------------------

revoke truncate, trigger, references on table
  public.license_admins,
  public.license_devices,
  public.license_events,
  public.licenses
  from authenticated;

-- ---------------------------------------------------------------------------
-- Move the admin helper out of the exposed API schema.
-- It is still SECURITY DEFINER with an empty search_path (safe), but keeping it
-- in `public` lets any signed-in user call it through /rest/v1/rpc. The policies
-- below are updated to use the private copy first, then the old one is dropped.
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_license_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.license_admins a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_license_admin() from public, anon;
grant execute on function private.is_license_admin() to authenticated, service_role;

alter policy "licence admins manage licences" on public.licenses
  using ((select private.is_license_admin()))
  with check ((select private.is_license_admin()));

alter policy "licence admins manage devices" on public.license_devices
  using ((select private.is_license_admin()))
  with check ((select private.is_license_admin()));

alter policy "licence admins read events" on public.license_events
  using ((select private.is_license_admin()));

drop function if exists public.is_license_admin();

-- Quick check: only SELECT/INSERT/UPDATE/DELETE remain for authenticated.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name like 'license%'
  and grantee = 'authenticated'
group by 1, 2
order by 1;

-- Quick check: the helper is private, hardened, and no longer in `public`.
select n.nspname as schema_name, p.proname, p.prosecdef, p.proconfig, p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'is_license_admin'
order by 1;
