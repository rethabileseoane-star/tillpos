import { getSetting, loadedShop } from '@/db'
import { saveSharedSetting } from '@/sync/shared'
import { updateShopName } from '@/shops/registry'

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
  const clean = name.trim()
  await saveSharedSetting(KEY, clean)
  // Keep the shop picker in step with the name printed on reports.
  updateShopName(loadedShop.id, clean)
}
