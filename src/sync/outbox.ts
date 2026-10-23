import { db } from '@/db'
import type { SyncEntity, SyncOp } from '@/db/types'
import { notifyLocalWrite } from './signal'

/**
 * Durable outbox.
 *
 * Every local mutation is queued here at write time, even though no backend is
 * connected yet. That keeps the write path identical whether sync is disabled
 * or enabled, so switching it on later needs no changes to the sale or catalog
 * code. Rows are coalesced per entity id: 20 edits to one product collapse into
 * a single push rather than 20.
 */
export async function queueEntity(
  entity: SyncEntity,
  entityId: string,
  op: SyncOp,
  payload: unknown,
): Promise<void> {
  const existing = await db.outbox
    .where('entityId')
    .equals(entityId)
    .filter((i) => i.entity === entity)
    .first()

  if (existing) {
    await db.outbox.update(existing.id!, {
      payload: JSON.stringify(payload),
      op,
      createdAt: Date.now(),
    })
    notifyLocalWrite()
    return
  }

  await db.outbox.add({
    entity,
    entityId,
    op,
    payload: JSON.stringify(payload),
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  })
  notifyLocalWrite()
}

export async function outboxCount(): Promise<number> {
  return db.outbox.count()
}

/** Only for a factory reset. Sales and stock history are never dropped. */
export async function clearOutbox(): Promise<void> {
  await db.outbox.clear()
}