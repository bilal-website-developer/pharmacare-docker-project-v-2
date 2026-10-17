import { apiRequest } from '../api';
import {
  parseTrashBinEvent,
  type TrashBinEvent,
  type TrashEntityType,
  type TrashAction,
} from '../utils/trashBin';

interface TrashPage {
  items: TrashBinEvent[];
  page: number;
  pageSize: number;
  total: number;
}

const ENTITY_TYPES: readonly TrashEntityType[] = [
  'profile', 'medicine', 'supplier', 'purchase', 'category', 'brand', 'medicine_unit',
];
const ACTIONS: readonly TrashAction[] = ['deleted', 'deactivated', 'voided', 'restored'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return keys.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function parsePage(value: unknown, expectedPage: number): TrashPage {
  if (!isRecord(value)
    || !hasExactKeys(value, ['items', 'page', 'pageSize', 'total'])
    || !Array.isArray(value.items)
    || value.page !== expectedPage
    || !Number.isSafeInteger(value.pageSize)
    || (value.pageSize as number) < 1
    || !Number.isSafeInteger(value.total)
    || (value.total as number) < 0) {
    throw new Error('The Trash Bin service returned an invalid response.');
  }
  return {
    items: value.items.map((item) => {
      if (!isRecord(item)
        || !hasExactKeys(item, [
          'id', 'entityId', 'entityType', 'action', 'displayName', 'actorId',
          'actorName', 'role', 'occurredAt', 'reason', 'canRestore',
        ])
        || typeof item.id !== 'string'
        || typeof item.entityId !== 'string'
        || !/^[a-f\d]{24}$/i.test(item.entityId)
        || !ENTITY_TYPES.includes(item.entityType as TrashEntityType)
        || !ACTIONS.includes(item.action as TrashAction)
        || typeof item.displayName !== 'string'
        || typeof item.actorId !== 'string'
        || !/^[a-f\d]{24}$/i.test(item.actorId)
        || typeof item.actorName !== 'string'
        || (item.role !== null && typeof item.role !== 'string')
        || typeof item.occurredAt !== 'string'
        || (item.reason !== null && typeof item.reason !== 'string')
        || typeof item.canRestore !== 'boolean') {
        throw new Error('The Trash Bin service returned an invalid event.');
      }
      return parseTrashBinEvent({
        id: item.id,
        actor_id: item.actorId,
        actor_name: item.actorName,
        entity_type: item.entityType,
        entity_id: item.entityId,
        entity_role: item.entityType === 'profile' && typeof item.role === 'string' ? item.role : null,
        action: item.action,
        display_name: item.displayName,
        reason: item.reason,
        created_at: item.occurredAt,
        can_restore: item.canRestore,
      });
    }),
    page: value.page as number,
    pageSize: value.pageSize as number,
    total: value.total as number,
  };
}

export async function loadTrashBinEvents(): Promise<TrashBinEvent[]> {
  const pageSize = 200;
  const first = parsePage(await apiRequest<unknown>(`/api/trash?page=1&pageSize=${pageSize}`), 1);
  const events = first.items.slice();
  for (let page = 2; events.length < first.total; page += 1) {
    const next = parsePage(await apiRequest<unknown>(`/api/trash?page=${page}&pageSize=${pageSize}`), page);
    if (next.items.length === 0) throw new Error('The Trash Bin service returned an incomplete page.');
    events.push(...next.items);
  }
  return events;
}

export async function restoreTrashBinEvent(event: TrashBinEvent): Promise<void> {
  if (!event.can_restore) throw new Error('This Trash Bin event cannot be restored.');
  const resourcePath = event.entity_type === 'medicine'
    ? `/api/medicines/${encodeURIComponent(event.entity_id)}`
    : event.entity_type === 'supplier'
      ? `/api/suppliers/${encodeURIComponent(event.entity_id)}`
      : event.entity_type === 'category' || event.entity_type === 'brand'
        ? `/api/${event.entity_type === 'category' ? 'categories' : 'brands'}/${encodeURIComponent(event.entity_id)}`
        : null;
  const path = event.entity_type === 'profile'
    ? `/api/users/${encodeURIComponent(event.entity_id)}/restore`
    : event.action === 'deactivated'
      ? resourcePath
      : resourcePath ? `${resourcePath}/restore` : null;
  if (!path) throw new Error('This Trash Bin item type cannot be restored.');
  const result = await apiRequest<unknown>(path, event.action === 'deactivated'
    ? { method: 'PATCH', body: JSON.stringify({ isActive: true }) }
    : { method: 'POST' });
  if (!isRecord(result)
    || (event.entity_type === 'profile'
      ? typeof result.message !== 'string'
      : result.id !== event.entity_id)) {
    throw new Error('The Trash Bin service returned an invalid restore result.');
  }
}
