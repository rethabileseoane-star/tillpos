import { db, withSyncMeta } from '@/db'
import type { AppSettings } from '@/db/types'
import { queueEntity } from './outbox'

/**
 * Settings that belong to the shop rather than to one device, and so sync.
 *
 * Everything else in `settings` stays on this device on purpose. `security.*`
 * holds the app-lock digest — pushing it would impose one till's PIN on every
 * other till — and `sync.*` holds this device's session and cursor. A pulled
 * row whose key is not on this list is ignored rather than written, so a stray
 * or hostile row in the cloud can never change a device's lock.
 */
export const SHARED_SETTING_KEYS = ['report.shopName'] as const

export function isSharedSettingKey(key: string): boolean {
  return (SHARED_SETTING_KEYS as readonly string[]).includes(key)
}

/**
 * Write a shop-wide setting and queue it for sync.
 *
 * The row id is the setting key rather than a fresh UUID. Two devices editing
 * the same setting therefore write to the same remote row instead of creating a
 * duplicate that the `key` unique index would reject; a row left behind by an
 * older build is dropped rather than allowed to shadow the new one.
 */
export async function saveSharedSetting(key: string, value: string): Promise<void> {
  if (!isSharedSettingKey(key)) throw new Error(`"${key}" is not a shared setting`)
  const existing = await db.settings.where('key').equals(key).first()
  if (existing && existing.id !== key) await db.settings.delete(existing.id)
  const previous = existing && existing.id === key ? existing : undefined
  const row: AppSettings = { ...withSyncMeta(previous, { key, value }), id: key }
  await db.settings.put(row)
  await queueEntity('settings', row.id, 'upsert', row)
}
