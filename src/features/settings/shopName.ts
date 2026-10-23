import { getSetting } from '@/db'
import { saveSharedSetting } from '@/sync/shared'

/**
 * The shop's name, printed on report headers. Optional — reports fall back to
 * a neutral title when it is not set.
 *
 * It is a shop-wide value, not a device one, so it is written through the
 * shared-setting path: saved locally and queued so the other tills pick it up.
 */

const KEY = 'report.shopName'

export async function loadShopName(): Promise<string> {
  const raw = await getSetting(KEY)
  return raw?.trim() ? raw.trim() : ''
}

export async function saveShopName(name: string): Promise<void> {
  await saveSharedSetting(KEY, name.trim())
}
