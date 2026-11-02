import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { copyText, generateLicenseKey, hashLicenseKey, isDeviceCode, normalizeDeviceCode } from '@/licensing/format'
import { adminSession, adminSignIn, adminSignOut, getAdminClient } from '@/licensing/adminClient'

/**
 * Seller-only licence admin. Not linked from the till: open /#/admin.
 *
 * This screen uses the public anon key plus a Supabase Auth login. The licence
 * tables have RLS policies that only allow members of `license_admins`; the
 * service-role key never reaches this page.
 */

interface LicenseRow {
  id: string
  key_hash: string
  business_name: string
  customer_name: string | null
  status: 'active' | 'suspended' | string
  max_devices: number
  max_shops: number
  offline_hours: number
  expires_at: string
  notes: string | null
  created_at: string
  updated_at: string
}

interface DeviceRow {
  id: string
  license_id: string
  device_code: string
  label: string | null
  status: 'active' | 'revoked' | string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

interface EventRow {
  id: number
  license_id: string | null
  device_code: string | null
  event: string
  detail: Record<string, unknown> | null
  created_at: string
}

interface RevealedKey {
  key: string
  business: string
}

export function LicenseAdminScreen() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [adminOk, setAdminOk] = useState<boolean | null>(null)
  const [client, setClient] = useState<SupabaseClient | null>(null)
  const [licenses, setLicenses] = useState<LicenseRow[]>([])
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)

  useEffect(() => {
    let alive = true
    let unsubscribe: (() => void) | null = null
    void (async () => {
      try {
        const c = await getAdminClient()
        if (!alive) return
        setClient(c)
        const s = await adminSession()
        if (!alive) return
        setSession(s)
        const { data } = c.auth.onAuthStateChange((_event, next) => {
          if (alive) setSession(next)
        })
        unsubscribe = () => data.subscription.unsubscribe()
        setChecking(false)
      } catch {
        if (alive) {
          setError('The licence project could not be reached.')
          setChecking(false)
        }
      }
    })()
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let alive = true
    if (!session || !client) {
      setAdminOk(null)
      setLicenses([])
      setDevices([])
      setEvents([])
      return
    }
    setAdminOk(null)
    void (async () => {
      const { data, error: adminError } = await client
        .from('license_admins')
        .select('user_id')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (!alive) return
      if (adminError || !data) {
        setAdminOk(false)
        return
      }
      setAdminOk(true)
      await loadAll(client)
    })()
    return () => {
      alive = false
    }
  }, [client, session])

  const loadAll = async (c: SupabaseClient) => {
    setLoading(true)
    setError(null)
    const [licenseResult, deviceResult, eventResult] = await Promise.all([
      c.from('licenses').select('*').order('created_at', { ascending: false }),
      c.from('license_devices').select('*').order('created_at', { ascending: true }),
      c
        .from('license_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(40),
    ])
    if (licenseResult.error) setError(licenseResult.error.message)
    else setLicenses((licenseResult.data ?? []) as LicenseRow[])
    if (!deviceResult.error) setDevices((deviceResult.data ?? []) as DeviceRow[])
    if (!eventResult.error) setEvents((eventResult.data ?? []) as EventRow[])
    setLoading(false)
  }

  const reload = async () => {
    if (client) await loadAll(client)
  }

  const signOut = async () => {
    await adminSignOut()
    setSession(null)
    setAdminOk(null)
  }

  if (checking) {
    return (
      <AdminShell>
        <p className="text-sm text-slate-400">Opening licence admin…</p>
      </AdminShell>
    )
  }

  if (!session) {
    return (
      <AdminShell>
        <AdminLogin onSignedIn={() => window.location.reload()} />
      </AdminShell>
    )
  }

  if (adminOk === null) {
    return (
      <AdminShell>
        <p className="text-sm text-slate-400">Checking admin access…</p>
      </AdminShell>
    )
  }

  if (adminOk === false) {
    return (
      <AdminShell>
        <div className="card">
          <h1 className="text-lg font-semibold">Not an admin</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            This account is signed in, but it is not listed in the licence
            admins table. Ask the database owner to add it.
          </p>
          <button className="btn-ghost mt-4 w-full" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </AdminShell>
    )
  }

  return (
    <AdminShell>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Licence admin</h1>
          <p className="mt-1 text-xs text-slate-500">{session.user.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <a className="btn-ghost !px-3 !py-2 text-xs" href="#/">
            Back to till
          </a>
          <button className="btn-ghost !px-3 !py-2 text-xs" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>

      <CreateLicenseCard
        client={client}
        onCreated={async (key, business) => {
          setRevealed({ key, business })
          await reload()
        }}
      />

      {error && (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
      )}
      {note && (
        <p className="mt-3 rounded-xl bg-ink-800 px-3 py-2 text-xs text-slate-300">{note}</p>
      )}

      <div className="mt-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Licences</h2>
        <button className="btn-ghost !px-3 !py-2 text-xs" disabled={loading} onClick={() => void reload()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {licenses.length === 0 && !loading ? (
        <p className="mt-3 rounded-xl border border-ink-700 bg-ink-800 p-4 text-sm text-slate-400">
          No licences yet. Create one above.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {licenses.map((license) => (
            <LicenseAdminCard
              key={license.id}
              license={license}
              devices={devices.filter((d) => d.license_id === license.id)}
              client={client}
              onChanged={reload}
              onRevealed={(key, business) => setRevealed({ key, business })}
              onNote={setNote}
            />
          ))}
        </div>
      )}

      <div className="mt-6">
        <h2 className="text-sm font-semibold">Recent activity</h2>
        {events.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No licence events yet.</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-xl border border-ink-700">
            {events.slice(0, 15).map((event) => (
              <div
                key={event.id}
                className="flex items-start justify-between gap-3 border-b border-ink-700/70 bg-ink-800/70 px-3 py-2 text-xs last:border-0"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-200">{event.event}</p>
                  <p className="truncate text-slate-500">
                    {event.device_code ?? '—'} ·{' '}
                    {licenses.find((l) => l.id === event.license_id)?.business_name ?? 'unknown'}
                  </p>
                </div>
                <span className="shrink-0 text-slate-500">{relative(event.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {revealed && (
        <RevealedKeyModal
          value={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
    </AdminShell>
  )
}

function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await adminSignIn(email, password)
    if (!result.ok) {
      setError(result.error ?? 'Sign-in failed.')
      setBusy(false)
      return
    }
    onSignedIn()
  }

  return (
    <div className="card">
      <h1 className="text-lg font-semibold">Licence admin</h1>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">
        Sign in with the seller’s Supabase admin account. This is separate from
        the shop’s staff password and cloud-sync login.
      </p>
      <div className="mt-4 space-y-2">
        <input
          className="field !py-2.5 text-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Admin email"
          type="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <input
          className="field !py-2.5 text-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && email && password) void submit()
          }}
        />
      </div>
      <button
        className="btn-primary mt-3 w-full !py-2.5 text-sm"
        disabled={busy || !email || !password}
        onClick={() => void submit()}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
      )}
      <a
        className="mt-4 block text-center text-xs text-slate-500 underline decoration-slate-700 underline-offset-2"
        href="#/"
      >
        Back to the till
      </a>
    </div>
  )
}

function CreateLicenseCard({
  client,
  onCreated,
}: {
  client: SupabaseClient | null
  onCreated: (key: string, business: string) => Promise<void>
}) {
  const [business, setBusiness] = useState('')
  const [customer, setCustomer] = useState('')
  const [maxDevices, setMaxDevices] = useState(1)
  const [maxShops, setMaxShops] = useState(1)
  const [offlineHours, setOfflineHours] = useState(24)
  const [expires, setExpires] = useState(() => oneYearFromNow())
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!client || !business.trim()) return
    if (!expires) {
      setError('Choose a subscription end date.')
      return
    }
    if (new Date(`${expires}T23:59:59`).getTime() <= Date.now()) {
      setError('The subscription end date must be in the future.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const key = generateLicenseKey()
      const keyHash = await hashLicenseKey(key)
      const { error: insertError } = await client.from('licenses').insert({
        key_hash: keyHash,
        business_name: business.trim(),
        customer_name: customer.trim() || null,
        status: 'active',
        max_devices: Math.min(50, Math.max(1, maxDevices)),
        max_shops: Math.min(20, Math.max(1, maxShops)),
        offline_hours: Math.min(720, Math.max(1, offlineHours)),
        expires_at: new Date(`${expires}T23:59:59`).toISOString(),
        notes: notes.trim() || null,
      })
      if (insertError) {
        setError(insertError.message)
        return
      }
      await onCreated(key, business.trim())
      setBusiness('')
      setCustomer('')
      setNotes('')
      setMaxDevices(1)
      setMaxShops(1)
      setOfflineHours(24)
      setExpires(oneYearFromNow())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the licence.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card mt-4">
      <h2 className="text-sm font-semibold">Create a licence</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        One key covers one business. Add each phone’s device code before the
        customer can activate it. The key is shown only once.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          className="field !py-2.5 text-sm"
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          placeholder="Business name"
        />
        <input
          className="field !py-2.5 text-sm"
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          placeholder="Contact name (optional)"
        />
        <label className="text-xs text-slate-400">
          Max devices
          <input
            className="field mt-1 !py-2.5 text-sm"
            type="number"
            min={1}
            max={50}
            value={maxDevices}
            onChange={(e) => setMaxDevices(Number(e.target.value) || 1)}
          />
        </label>
        <label className="text-xs text-slate-400">
          Max shops
          <input
            className="field mt-1 !py-2.5 text-sm"
            type="number"
            min={1}
            max={20}
            value={maxShops}
            onChange={(e) => setMaxShops(Number(e.target.value) || 1)}
          />
        </label>
        <label className="text-xs text-slate-400">
          Offline hours
          <input
            className="field mt-1 !py-2.5 text-sm"
            type="number"
            min={1}
            max={720}
            value={offlineHours}
            onChange={(e) => setOfflineHours(Number(e.target.value) || 24)}
          />
        </label>
        <label className="text-xs text-slate-400">
          Subscription ends
          <input
            className="field mt-1 !py-2.5 text-sm"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
        <input
          className="field !py-2.5 text-sm sm:col-span-2"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
        />
      </div>
      <button
        className="btn-primary mt-3 w-full !py-2.5 text-sm"
        disabled={busy || !business.trim() || !client}
        onClick={() => void submit()}
      >
        {busy ? 'Creating…' : 'Create licence and show key'}
      </button>
      {error && (
        <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
      )}
    </div>
  )
}

function LicenseAdminCard({
  license,
  devices,
  client,
  onChanged,
  onRevealed,
  onNote,
}: {
  license: LicenseRow
  devices: DeviceRow[]
  client: SupabaseClient | null
  onChanged: () => Promise<void>
  onRevealed: (key: string, business: string) => void
  onNote: (message: string) => void
}) {
  const [deviceCode, setDeviceCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maxDevices, setMaxDevices] = useState(license.max_devices)
  const [maxShops, setMaxShops] = useState(license.max_shops)
  const [offlineHours, setOfflineHours] = useState(license.offline_hours)
  const activeDevices = devices.filter((d) => d.status === 'active')

  useEffect(() => {
    setMaxDevices(license.max_devices)
    setMaxShops(license.max_shops)
    setOfflineHours(license.offline_hours)
  }, [license.max_devices, license.max_shops, license.offline_hours])

  const saveLimits = async () => {
    const nextMaxDevices = Math.min(50, Math.max(1, maxDevices))
    if (nextMaxDevices < activeDevices.length) {
      setError('Remove devices before setting a limit below the active count.')
      return
    }
    const ok = await updateLicense({
      max_devices: nextMaxDevices,
      max_shops: Math.min(20, Math.max(1, maxShops)),
      offline_hours: Math.min(720, Math.max(1, offlineHours)),
    })
    if (ok) onNote(`Limits saved for ${license.business_name}.`)
  }

  const updateLicense = async (patch: Partial<LicenseRow>): Promise<boolean> => {
    if (!client) return false
    setBusy(true)
    setError(null)
    const { error: updateError } = await client.from('licenses').update(patch).eq('id', license.id)
    if (updateError) setError(updateError.message)
    else await onChanged()
    setBusy(false)
    return !updateError
  }

  const addDevice = async () => {
    if (!client) return
    const code = normalizeDeviceCode(deviceCode)
    if (!isDeviceCode(code)) {
      setError('Enter a device code like D-7F3A-92K1.')
      return
    }
    if (activeDevices.length >= license.max_devices) {
      setError('This licence has reached its device limit. Increase the limit first.')
      return
    }
    const existing = devices.find((d) => d.device_code === code)
    if (existing?.status === 'active') {
      setError('That device code is already on this licence.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: insertError } = existing
      ? await client
          .from('license_devices')
          .update({ status: 'active', revoked_at: null })
          .eq('id', existing.id)
      : await client.from('license_devices').insert({
          license_id: license.id,
          device_code: code,
          status: 'active',
        })
    if (insertError) setError(insertError.message)
    else {
      setDeviceCode('')
      onNote(`Added ${code} to ${license.business_name}.`)
      await onChanged()
    }
    setBusy(false)
  }

  const revokeDevice = async (device: DeviceRow) => {
    if (!client) return
    if (!window.confirm(`Remove ${device.device_code} from this licence?`)) return
    setBusy(true)
    setError(null)
    const { error: updateError } = await client
      .from('license_devices')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('id', device.id)
    if (updateError) setError(updateError.message)
    else {
      onNote(`Removed ${device.device_code}.`)
      await onChanged()
    }
    setBusy(false)
  }

  const regenerateKey = async () => {
    if (!client) return
    if (
      !window.confirm(
        'Generate a new key? The old key can no longer activate new devices. Devices already activated keep their session until their next licence check.',
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    const key = generateLicenseKey()
    const keyHash = await hashLicenseKey(key)
    const { error: updateError } = await client
      .from('licenses')
      .update({ key_hash: keyHash })
      .eq('id', license.id)
    if (updateError) setError(updateError.message)
    else {
      onRevealed(key, license.business_name)
      await onChanged()
    }
    setBusy(false)
  }

  const extend = async () => {
    const current = new Date(license.expires_at).getTime()
    const base = Math.max(Date.now(), current)
    const next = new Date(base)
    next.setFullYear(next.getFullYear() + 1)
    const ok = await updateLicense({ expires_at: next.toISOString(), status: 'active' })
    if (ok) onNote(`Extended ${license.business_name} for one year.`)
  }

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{license.business_name}</h3>
            <span
              className={`chip ${
                license.status === 'active'
                  ? 'bg-cash-500/15 text-cash-400'
                  : 'bg-red-500/15 text-red-300'
              }`}
            >
              {license.status}
            </span>
            {new Date(license.expires_at).getTime() < Date.now() && (
              <span className="chip bg-amber-500/15 text-amber-300">expired</span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {license.customer_name ? `${license.customer_name} · ` : ''}
            {license.max_devices} device{license.max_devices === 1 ? '' : 's'} ·{' '}
            {license.max_shops} shop{license.max_shops === 1 ? '' : 's'} ·{' '}
            {license.offline_hours}h offline
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Ends {formatDate(license.expires_at)} · id {license.id.slice(0, 8)}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <p className="label">Allowed devices</p>
        {devices.length === 0 ? (
          <p className="rounded-lg bg-ink-900 px-3 py-2 text-xs text-slate-500">
            No devices yet. Add the code shown on the phone’s activation screen.
          </p>
        ) : (
          <div className="space-y-1">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-ink-900 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-mono text-slate-200">{device.device_code}</p>
                  <p className="text-[10px] text-slate-500">
                    {device.status === 'revoked'
                      ? 'removed'
                      : device.last_seen_at
                        ? `last seen ${relative(device.last_seen_at)}`
                        : 'not activated yet'}
                  </p>
                </div>
                {device.status === 'active' && (
                  <button
                    className="text-[11px] text-red-300 underline decoration-red-900 underline-offset-2"
                    disabled={busy}
                    onClick={() => void revokeDevice(device)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <input
            className="field !py-2 text-xs"
            value={deviceCode}
            onChange={(e) => setDeviceCode(e.target.value.toUpperCase())}
            placeholder="D-XXXX-XXXX"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button className="btn-ghost !px-3 !py-2 text-xs" disabled={busy} onClick={() => void addDevice()}>
            Add device
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-ink-700/70 p-2">
        <p className="label">Limits</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-[10px] text-slate-500">
            Devices
            <input
              className="field mt-1 !py-1.5 text-xs"
              type="number"
              min={1}
              max={50}
              value={maxDevices}
              onChange={(e) => setMaxDevices(Number(e.target.value) || 1)}
            />
          </label>
          <label className="text-[10px] text-slate-500">
            Shops
            <input
              className="field mt-1 !py-1.5 text-xs"
              type="number"
              min={1}
              max={20}
              value={maxShops}
              onChange={(e) => setMaxShops(Number(e.target.value) || 1)}
            />
          </label>
          <label className="text-[10px] text-slate-500">
            Offline h
            <input
              className="field mt-1 !py-1.5 text-xs"
              type="number"
              min={1}
              max={720}
              value={offlineHours}
              onChange={(e) => setOfflineHours(Number(e.target.value) || 24)}
            />
          </label>
        </div>
        <button
          className="btn-ghost mt-2 w-full !py-1.5 text-xs"
          disabled={busy}
          onClick={() => void saveLimits()}
        >
          Save limits
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="btn-ghost !px-3 !py-2 text-xs"
          disabled={busy}
          onClick={() => void extend()}
        >
          Extend 1 year
        </button>
        <button
          className="btn-ghost !px-3 !py-2 text-xs"
          disabled={busy}
          onClick={() =>
            void updateLicense({
              status: license.status === 'active' ? 'suspended' : 'active',
            })
          }
        >
          {license.status === 'active' ? 'Suspend' : 'Reactivate'}
        </button>
        <button
          className="btn-ghost !px-3 !py-2 text-xs"
          disabled={busy}
          onClick={() => void regenerateKey()}
        >
          New key
        </button>
      </div>

      {license.notes && <p className="mt-2 text-[11px] text-slate-500">{license.notes}</p>}
      {error && (
        <p className="mt-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">{error}</p>
      )}
    </div>
  )
}

function RevealedKeyModal({ value, onClose }: { value: RevealedKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-800 p-4">
        <h2 className="text-lg font-semibold">Licence key for {value.business}</h2>
        <p className="mt-1 text-xs leading-relaxed text-amber-200">
          Copy this now. It is not stored and cannot be shown again.
        </p>
        <code className="mt-3 block break-all rounded-xl bg-ink-900 p-3 font-mono text-sm text-cash-300">
          {value.key}
        </code>
        <button
          className="btn-primary mt-3 w-full !py-2.5 text-sm"
          onClick={async () => {
            const ok = await copyText(value.key)
            setCopied(ok)
          }}
        >
          {copied ? 'Copied' : 'Copy key'}
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Give it to the customer only after their device codes are added. They
          enter the key on each approved phone.
        </p>
        <button className="btn-ghost mt-2 w-full !py-2.5 text-sm" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-ink-900 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  )
}

function oneYearFromNow(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function relative(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}
