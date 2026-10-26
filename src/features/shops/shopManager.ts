import { TillDatabase, withSyncMeta } from '@/db'
import { CREDENTIAL_KEY } from '@/features/security/credentialService'
import {
  STAFF_KEY,
  cloneOwnerForShop,
  loadStaff,
  ownerOf,
  serializeStaffRoster,
} from '@/features/security/staff'
import {
  cleanShopCode,
  dbNameForShop,
  listShops,
  registerShop,
  validateShopCode,
  type ShopProfile,
} from '@/shops/registry'

/**
 * Creating a second shop on this phone.
 *
 * The new database starts deliberately empty: no products, sales, cash or
 * cashiers are copied from shop A. Only the owner account is seeded, using a
 * copy of the current owner's password hash, so the owner can open the new
 * shop with the password they already know. Shop B then gets its own catalog,
 * sync login and cashier list.
 *
 * The database is prepared before the registry is changed. If seeding fails,
 * the owner is not left with a half-added shop in the picker.
 */

export interface AddShopInput {
  name: string
  code: string
}

export async function addShop(input: AddShopInput): Promise<ShopProfile> {
  const problem = validateShopCode(input.code)
  if (problem) throw new Error(problem)

  const code = cleanShopCode(input.code)
  const name = input.name.trim()
  if (!name) throw new Error('Enter a shop name.')
  if (name.length > 60) throw new Error('Use 60 characters or fewer for the shop name.')

  const shops = listShops()
  if (shops.some((shop) => shop.id === code)) {
    throw new Error('That shop code is already on this phone.')
  }
  if (shops.some((shop) => shop.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('That shop name is already in use on this phone.')
  }

  const accounts = await loadStaff()
  const owner = ownerOf(accounts)
  if (!owner) {
    throw new Error('Set up the owner account before adding another shop.')
  }
  if (owner.credential.kind !== 'password') {
    throw new Error(
      'Set the owner password first. Every shop uses the owner password, not a four-digit PIN.',
    )
  }

  const target = new TillDatabase(dbNameForShop(code))
  try {
    await target.open()

    // Do not overwrite a database that already has its own owner. That happens
    // when an existing shop is being added back to a phone after a registry
    // reset; its own password must keep working. An older shop may have only
    // the legacy credential row and no roster yet, so check both.
    const [existingStaff, existingCredential] = await Promise.all([
      target.settings.where('key').equals(STAFF_KEY).first(),
      target.settings.where('key').equals(CREDENTIAL_KEY).first(),
    ])
    if (!existingStaff && !existingCredential) {
      const copiedOwner = cloneOwnerForShop(owner)
      const staffRow = withSyncMeta(undefined, {
        key: STAFF_KEY,
        value: serializeStaffRoster([copiedOwner]),
      })
      const credentialRow = withSyncMeta(undefined, {
        key: CREDENTIAL_KEY,
        value: JSON.stringify(copiedOwner.credential),
      })
      await target.transaction('rw', target.settings, async () => {
        await target.settings.put(staffRow)
        await target.settings.put(credentialRow)
      })
    }

    // Seed the display name. It is a shared setting, so queue it rather than
    // waiting for the owner to press Send all records on an otherwise empty shop.
    const existingName = await target.settings
      .where('key')
      .equals('report.shopName')
      .first()
    if (!existingName) {
      const nameRow = {
        ...withSyncMeta(undefined, { key: 'report.shopName', value: name }),
        // Shared settings use the key as their id so two tills editing the
        // name upsert one cloud row instead of creating a duplicate.
        id: 'report.shopName',
      }
      await target.transaction('rw', target.settings, target.outbox, async () => {
        await target.settings.put(nameRow)
        await target.outbox.add({
          entity: 'settings',
          entityId: nameRow.id,
          op: 'upsert',
          payload: JSON.stringify(nameRow),
          createdAt: Date.now(),
          attempts: 0,
          lastError: null,
        })
      })
    }
  } finally {
    target.close()
  }

  return registerShop(code, name)
}

/** A sensible next code, e.g. `shop-b` when shop A is already present. */
export function suggestShopCode(): string {
  const used = new Set(listShops().map((shop) => shop.id))
  for (let i = 1; i < 26; i++) {
    const code = `shop-${String.fromCharCode(97 + i)}`
    if (!used.has(code)) return code
  }
  return `shop-${Date.now().toString(36).slice(-5)}`
}
