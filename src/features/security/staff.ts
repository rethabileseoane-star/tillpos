import { getSetting, setSetting } from '@/db'
import {
  loadCredential,
  parseCredentialValue,
  removeBiometric,
  removeCredential,
  saveCredentialRecord,
} from './credentialService'
import {
  attemptKey,
  clearAttempts,
  createCredential,
  validateSecret,
  verifySecret,
  type SecretKind,
  type StoredCredential,
} from './secret'

/**
 * Staff accounts for this device.
 *
 * The shop has one owner and any number of cashiers. They are local, not
 * Supabase users: the only cloud login is the shared shop account that syncs
 * the ledger. Keeping staff local means a cashier phone does not need its own
 * mailbox, and a cashier's PIN never travels to another till.
 *
 * The roster lives under `security.staff`, which `sync/shared.ts` and
 * `backup.ts` both refuse to export. The owner's credential is also written to
 * the legacy `security.credential` row so an older build (or a rollback) still
 * opens with the same secret.
 *
 * Roles are a UI boundary, not encryption. A cashier phone still contains the
 * whole local database; hiding History and cost in the interface stops a
 * cashier on the shop floor, not someone with developer tools and the device.
 */

export type StaffRole = 'owner' | 'cashier'

export interface StaffAccount {
  id: string
  name: string
  role: StaffRole
  credential: StoredCredential
  createdAt: number
  updatedAt: number
}

export interface StaffSummary {
  id: string
  name: string
  role: StaffRole
  kind: SecretKind
  length: number
}

export interface StaffSession {
  id: string
  name: string
  role: StaffRole
}

export const STAFF_KEY = 'security.staff'
export const OWNER_ACCOUNT_ID = 'owner'
export const STAFF_NAME_MAX = 40

interface StaffRoster {
  v: 1
  accounts: StaffAccount[]
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

function assertName(name: string, accounts: StaffAccount[], exceptId?: string): string {
  const clean = cleanName(name)
  if (!clean) throw new Error('Enter a name.')
  if (clean.length > STAFF_NAME_MAX) {
    throw new Error(`Use ${STAFF_NAME_MAX} characters or fewer.`)
  }
  const clash = accounts.some(
    (a) => a.id !== exceptId && a.name.toLowerCase() === clean.toLowerCase(),
  )
  if (clash) throw new Error('That name is already in use on this device.')
  return clean
}

function parseAccount(value: unknown): StaffAccount | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StaffAccount>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null
  if (typeof candidate.name !== 'string') return null
  const name = cleanName(candidate.name)
  if (!name || name.length > STAFF_NAME_MAX) return null
  if (candidate.role !== 'owner' && candidate.role !== 'cashier') return null
  const credential = parseCredentialValue(candidate.credential)
  if (!credential) return null
  return {
    id: candidate.id,
    name,
    role: candidate.role,
    credential,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  }
}

/**
 * Parse a roster, dropping damaged accounts and keeping at most one owner.
 *
 * A damaged cashier row must not lock the phone, so it is simply ignored. An
 * owner row is the opposite: without one the app would open unlocked, so
 * `loadStaff` repairs the roster from the legacy credential when it can.
 */
export function parseStaffRoster(raw: string | null): StaffAccount[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<StaffRoster>
    if (parsed.v !== 1 || !Array.isArray(parsed.accounts)) return []
    const ids = new Set<string>()
    const names = new Set<string>()
    const accounts: StaffAccount[] = []
    for (const item of parsed.accounts) {
      const account = parseAccount(item)
      if (!account) continue
      if (ids.has(account.id)) continue
      const key = account.name.toLowerCase()
      if (names.has(key)) continue
      ids.add(account.id)
      names.add(key)
      accounts.push(account)
    }
    const owners = accounts.filter((a) => a.role === 'owner')
    const cashiers = accounts.filter((a) => a.role === 'cashier')
    // Only one owner is supported. Keeping the first keeps every device that
    // reads the same roster arriving at the same answer.
    return owners.length > 0 ? [owners[0]!, ...cashiers] : cashiers
  } catch {
    return []
  }
}

/** Encode a roster exactly as it is stored under `security.staff`. */
export function serializeStaffRoster(accounts: StaffAccount[]): string {
  return accounts.length > 0
    ? JSON.stringify({ v: 1, accounts } satisfies StaffRoster)
    : ''
}

async function writeRoster(accounts: StaffAccount[]): Promise<void> {
  await setSetting(STAFF_KEY, serializeStaffRoster(accounts))
}

/**
 * A copy of the owner for a newly added shop.
 *
 * A fresh id keeps lockout attempt keys from crossing shops. The credential
 * hash is copied, so the owner opens the new shop with the same password
 * without the secret ever being available in plain text.
 */
export function cloneOwnerForShop(owner: StaffAccount): StaffAccount {
  const now = Date.now()
  return {
    ...owner,
    id: crypto.randomUUID(),
    role: 'owner',
    createdAt: now,
    updatedAt: now,
    credential: { ...owner.credential },
  }
}

/** Write the roster and keep the legacy owner credential in step. */
export async function saveStaffRoster(accounts: StaffAccount[]): Promise<void> {
  const owner = ownerOf(accounts)
  if (accounts.length > 0 && !owner) {
    throw new Error('A staff roster must include an owner.')
  }
  await writeRoster(accounts)
  if (owner) await saveCredentialRecord(owner.credential)
  else await removeCredential()
}

export function ownerOf(accounts: StaffAccount[]): StaffAccount | undefined {
  return accounts.find((a) => a.role === 'owner')
}

export function staffSummaries(accounts: StaffAccount[]): StaffSummary[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    role: account.role,
    kind: account.credential.kind,
    length: account.credential.length,
  }))
}

export function sessionFor(account: StaffAccount): StaffSession {
  return { id: account.id, name: account.name, role: account.role }
}

/** The name stamped on every new sale. Legacy unlocked mode counts as owner. */
export function saleCashierName(session: StaffSession | null): string {
  return session?.name.trim() || 'Owner'
}

/**
 * Load the roster, migrating the old single app-lock credential if needed.
 *
 * Migration is automatic and additive: an existing PIN/password becomes the
 * owner account. If the roster lost its owner but a legacy credential remains,
 * the owner is rebuilt and any surviving cashiers are kept. With neither an
 * owner nor a legacy credential the app stays open, which is the safe failure
 * for a damaged setting.
 */
export async function loadStaff(): Promise<StaffAccount[]> {
  const raw = await getSetting(STAFF_KEY)
  const parsed = parseStaffRoster(raw)
  if (ownerOf(parsed)) return parsed

  const legacy = await loadCredential()
  if (!legacy) return []

  const now = Date.now()
  const owner: StaffAccount = {
    id: OWNER_ACCOUNT_ID,
    name: 'Owner',
    role: 'owner',
    credential: legacy,
    createdAt: now,
    updatedAt: now,
  }
  const repaired = [owner, ...parsed.filter((a) => a.role === 'cashier')]
  // Do not touch the legacy row or biometrics here: the owner may already have
  // a fingerprint enrolled, and the credential is the one we just read.
  await writeRoster(repaired)
  return repaired
}

/** First-run setup. The owner must use a password, not a four-digit PIN. */
export async function createOwner(name: string, password: string): Promise<StaffAccount> {
  const accounts = await loadStaff()
  if (ownerOf(accounts)) throw new Error('An owner account already exists.')
  const clean = assertName(name, accounts)
  const problem = validateSecret('password', password)
  if (problem) throw new Error(problem)

  const now = Date.now()
  const owner: StaffAccount = {
    id: OWNER_ACCOUNT_ID,
    name: clean,
    role: 'owner',
    credential: await createCredential('password', password),
    createdAt: now,
    updatedAt: now,
  }
  await saveStaffRoster([owner, ...accounts.filter((a) => a.role === 'cashier')])
  return owner
}

/**
 * Add a cashier. The owner must already have a password: on a cashier phone a
 * four-digit owner PIN is both guessable and likely to be shared.
 */
export async function addCashier(
  name: string,
  kind: SecretKind,
  secret: string,
): Promise<StaffAccount> {
  const accounts = await loadStaff()
  const owner = ownerOf(accounts)
  if (!owner) throw new Error('Set up the owner account before adding a cashier.')
  if (owner.credential.kind !== 'password') {
    throw new Error('Set the owner password before adding a cashier.')
  }
  const clean = assertName(name, accounts)
  const problem = validateSecret(kind, secret)
  if (problem) throw new Error(problem)

  const now = Date.now()
  const cashier: StaffAccount = {
    id: crypto.randomUUID(),
    name: clean,
    role: 'cashier',
    credential: await createCredential(kind, secret),
    createdAt: now,
    updatedAt: now,
  }
  await saveStaffRoster([...accounts, cashier])
  return cashier
}

/**
 * Change a secret.
 *
 * The owner must prove the current password; the owner is already trusted to
 * reset a cashier without knowing the old PIN. Either way the account's failed
 * attempt streak is cleared, so a cashier who forgot their PIN can try again
 * immediately after the owner resets it.
 */
export async function changeStaffSecret(input: {
  accountId: string
  currentSecret?: string
  kind: SecretKind
  secret: string
}): Promise<void> {
  const accounts = await loadStaff()
  const account = accounts.find((a) => a.id === input.accountId)
  if (!account) throw new Error('Account not found.')
  if (account.role === 'owner' && input.kind !== 'password') {
    throw new Error('The owner must use a password.')
  }

  if (account.role === 'owner') {
    if (!input.currentSecret) throw new Error('Enter the current password.')
    const ok = await verifySecret(account.credential, input.currentSecret)
    if (!ok) throw new Error('The current secret is incorrect.')
  }

  const problem = validateSecret(input.kind, input.secret)
  if (problem) throw new Error(problem)

  const updated: StaffAccount = {
    ...account,
    credential: await createCredential(input.kind, input.secret),
    updatedAt: Date.now(),
  }
  await saveStaffRoster(
    accounts.map((a) => (a.id === account.id ? updated : a)),
  )
  if (account.role === 'owner') {
    // A changed owner secret must not leave an old fingerprint enrolled.
    await removeBiometric()
  }
  clearAttempts(localStorage, attemptKey(account.id))
}

export async function removeCashier(accountId: string): Promise<void> {
  const accounts = await loadStaff()
  const account = accounts.find((a) => a.id === accountId)
  if (!account || account.role !== 'cashier') throw new Error('Cashier not found.')
  await saveStaffRoster(accounts.filter((a) => a.id !== accountId))
  clearAttempts(localStorage, attemptKey(account.id))
}

/**
 * Turn the app lock off. Only possible with no cashiers: otherwise the owner
 * account is the only thing separating a cashier from History and Settings.
 */
export async function removeAllStaff(currentSecret: string): Promise<void> {
  const accounts = await loadStaff()
  const owner = ownerOf(accounts)
  if (!owner) return
  if (accounts.some((a) => a.role === 'cashier')) {
    throw new Error('Remove every cashier account before turning off the app lock.')
  }
  const ok = await verifySecret(owner.credential, currentSecret)
  if (!ok) throw new Error('The current secret is incorrect.')
  await writeRoster([])
  await removeCredential()
  clearAttempts(localStorage, attemptKey(owner.id))
}
