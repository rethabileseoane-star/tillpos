/**
 * The shops this phone knows about.
 *
 * One installed app can serve more than one shop. Each shop gets its own
 * IndexedDB database, its own staff roster, its own sync login and its own
 * cloud rows. The registry is the small, device-local map between the shop the
 * owner picked and the database holding that shop's ledger.
 *
 * It is deliberately localStorage rather than Dexie: `db` needs the active
 * database name before it can open IndexedDB, so the registry must not depend
 * on `db`.
 *
 * Shop codes are permanent. They identify the shop's rows in Supabase and must
 * match `app_metadata.shop_id` on that shop's cloud login. The display name is
 * cosmetic and can change.
 */

export const DEFAULT_SHOP_ID = 'shop-a'
export const DEFAULT_SHOP_NAME = 'Shop 1'
export const LEGACY_DB_NAME = 'till-pos'
export const SHOP_DB_PREFIX = 'till-pos'

const REGISTRY_KEY = 'till.shops'
const SHOP_CODE_MAX = 32

export interface ShopProfile {
  /** Stable, lowercase code. Also the cloud `shop_id` claim. */
  id: string
  /** Human-facing name. */
  name: string
  /** IndexedDB database name. Never changes for a shop. */
  dbName: string
  createdAt: number
}

interface ShopRegistry {
  v: 1
  activeId: string
  shops: ShopProfile[]
}

function defaultRegistry(): ShopRegistry {
  return {
    v: 1,
    activeId: DEFAULT_SHOP_ID,
    shops: [
      {
        id: DEFAULT_SHOP_ID,
        name: DEFAULT_SHOP_NAME,
        dbName: LEGACY_DB_NAME,
        createdAt: 0,
      },
    ],
  }
}

/** Lowercase letters, digits and hyphens. The first character is a letter/digit. */
export function cleanShopCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, SHOP_CODE_MAX)
}

/** `null` when the code is usable, otherwise a sentence for the owner. */
export function validateShopCode(input: string): string | null {
  const code = cleanShopCode(input)
  if (!code) return 'Enter a shop code.'
  if (code.length < 2) return 'Use at least two characters for the shop code.'
  if (!/^[a-z0-9]/.test(code)) return 'The shop code must start with a letter or number.'
  if (code.endsWith('-')) return 'The shop code cannot end with a hyphen.'
  return null
}

export function isValidShopCode(input: string): boolean {
  return validateShopCode(input) === null
}

/** The IndexedDB name for a shop. Shop A deliberately keeps the old name. */
export function dbNameForShop(shopId: string): string {
  return shopId === DEFAULT_SHOP_ID ? LEGACY_DB_NAME : `${SHOP_DB_PREFIX}-${shopId}`
}

function isShopProfile(value: unknown): value is ShopProfile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ShopProfile>
  return (
    typeof candidate.id === 'string' &&
    isValidShopCode(candidate.id) &&
    cleanShopCode(candidate.id) === candidate.id &&
    typeof candidate.name === 'string' &&
    typeof candidate.dbName === 'string' &&
    candidate.dbName.length > 0 &&
    typeof candidate.createdAt === 'number'
  )
}

function parseRegistry(raw: string | null): ShopRegistry {
  if (!raw) return defaultRegistry()
  try {
    const value = JSON.parse(raw) as Partial<ShopRegistry>
    if (value.v !== 1 || !Array.isArray(value.shops)) return defaultRegistry()
    const seen = new Set<string>()
    const shops: ShopProfile[] = []
    for (const item of value.shops) {
      if (!isShopProfile(item) || seen.has(item.id)) continue
      seen.add(item.id)
      // Repair a missing/renamed database name to the rule for its code, so a
      // damaged registry entry cannot point one shop at another shop's data.
      shops.push({ ...item, dbName: dbNameForShop(item.id) })
    }
    // The first install and any damaged registry always gets shop A back.
    if (!shops.some((shop) => shop.id === DEFAULT_SHOP_ID)) {
      shops.unshift(defaultRegistry().shops[0]!)
    }
    const activeId =
      typeof value.activeId === 'string' && shops.some((shop) => shop.id === value.activeId)
        ? value.activeId
        : shops[0]!.id
    return { v: 1, activeId, shops }
  } catch {
    return defaultRegistry()
  }
}

function writeRegistry(registry: ShopRegistry): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
  } catch {
    // A phone with storage disabled cannot switch shops, but must not crash.
  }
}

function rawRegistry(): string | null {
  try {
    return localStorage.getItem(REGISTRY_KEY)
  } catch {
    return null
  }
}

/** The current registry, creating the default shop on first use. */
export function loadShopRegistry(): ShopRegistry {
  const raw = rawRegistry()
  const registry = parseRegistry(raw)
  // Persist the implicit shop A so a later add-shop action starts from a real
  // list rather than replacing an in-memory default.
  if (!raw) writeRegistry(registry)
  return registry
}

export function listShops(): ShopProfile[] {
  return loadShopRegistry().shops
}

export function getActiveShopId(): string {
  return loadShopRegistry().activeId
}

export function getActiveShop(): ShopProfile {
  const registry = loadShopRegistry()
  return registry.shops.find((shop) => shop.id === registry.activeId) ?? registry.shops[0]!
}

export function getShop(shopId: string): ShopProfile | undefined {
  return loadShopRegistry().shops.find((shop) => shop.id === shopId)
}

export function getActiveDbName(): string {
  return getActiveShop().dbName
}

/** Persist the active shop. The caller reloads so the Dexie singleton reopens. */
export function setActiveShop(shopId: string): void {
  const registry = loadShopRegistry()
  if (!registry.shops.some((shop) => shop.id === shopId)) {
    throw new Error('That shop is not on this phone.')
  }
  if (registry.activeId === shopId) return
  writeRegistry({ ...registry, activeId: shopId })
}

/** Switch shops and reload. Safe to call from the lock screen or Settings. */
export function switchShopNow(shopId: string): void {
  setActiveShop(shopId)
  if (typeof location !== 'undefined') location.reload()
}

/** Update the display name. The code and database name never change. */
export function updateShopName(shopId: string, name: string): void {
  const registry = loadShopRegistry()
  const clean = name.trim()
  if (!clean) return
  let changed = false
  const shops = registry.shops.map((shop) => {
    if (shop.id !== shopId || shop.name === clean) return shop
    changed = true
    return { ...shop, name: clean }
  })
  if (changed) writeRegistry({ ...registry, shops })
}

/**
 * Add a shop after its database has been prepared. Refuses a duplicate code or
 * a duplicate display name so the picker stays unambiguous.
 */
export function registerShop(shopId: string, name: string): ShopProfile {
  const registry = loadShopRegistry()
  const problem = validateShopCode(shopId)
  if (problem) throw new Error(problem)
  const id = cleanShopCode(shopId)
  const clean = name.trim()
  if (!clean) throw new Error('Enter a shop name.')
  if (clean.length > 60) throw new Error('Use 60 characters or fewer for the shop name.')
  if (registry.shops.some((shop) => shop.id === id)) {
    throw new Error('That shop code is already on this phone.')
  }
  if (registry.shops.some((shop) => shop.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error('That shop name is already in use on this phone.')
  }
  const profile: ShopProfile = {
    id,
    name: clean,
    dbName: dbNameForShop(id),
    createdAt: Date.now(),
  }
  writeRegistry({ v: 1, activeId: registry.activeId, shops: [...registry.shops, profile] })
  return profile
}

/**
 * Register a shop that already has a local database, without renaming it.
 * Used when adding a shop on a fresh phone: the database is created there, so
 * the normal path can be used. Kept for symmetry and tests.
 */
export function registerExistingShop(shopId: string, name: string): ShopProfile {
  return registerShop(shopId, name)
}

/** Every database this app owns, for a factory reset. */
export function shopDbNames(): string[] {
  return listShops().map((shop) => shop.dbName)
}

/** A label for the current shop, falling back to the code. */
export function shopDisplayName(shop: ShopProfile | undefined = getActiveShop()): string {
  return shop?.name.trim() || shop?.id || DEFAULT_SHOP_NAME
}
