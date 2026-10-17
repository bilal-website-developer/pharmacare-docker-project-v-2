export type TrashEntityType = 'profile' | 'medicine' | 'supplier' | 'purchase' | 'category' | 'brand' | 'medicine_unit';
export type TrashAction = 'deleted' | 'deactivated' | 'voided' | 'restored';
export type TrashFilter = 'all' | TrashEntityType;

export interface TrashBinEvent {
  id: string;
  actor_id: string | null;
  actor_name: string;
  entity_type: TrashEntityType;
  entity_id: string;
  entity_role: string | null;
  action: TrashAction;
  display_name: string;
  reason: string | null;
  created_at: string;
  can_restore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTrashBinEvent(value: unknown): TrashBinEvent {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || (value.actor_id !== null && typeof value.actor_id !== 'string')
    || typeof value.actor_name !== 'string'
    || !['profile', 'medicine', 'supplier', 'purchase', 'category', 'brand', 'medicine_unit'].includes(String(value.entity_type))
    || typeof value.entity_id !== 'string'
    || (value.entity_role !== null && typeof value.entity_role !== 'string')
    || !['deleted', 'deactivated', 'voided', 'restored'].includes(String(value.action))
    || typeof value.display_name !== 'string'
    || (value.reason !== null && typeof value.reason !== 'string')
    || typeof value.created_at !== 'string'
    || typeof value.can_restore !== 'boolean') {
    throw new Error('Received a Trash Bin event with invalid fields.');
  }

  return {
    id: value.id,
    actor_id: value.actor_id,
    actor_name: value.actor_name.trim() || 'Unknown user',
    entity_type: value.entity_type as TrashEntityType,
    entity_id: value.entity_id,
    entity_role: value.entity_role,
    action: value.action as TrashAction,
    display_name: value.display_name.trim() || 'Unknown item',
    reason: value.reason,
    created_at: value.created_at,
    can_restore: value.can_restore,
  };
}

export function filterTrashBinEvents(
  events: readonly TrashBinEvent[],
  filter: TrashFilter,
): TrashBinEvent[] {
  return filter === 'all'
    ? [...events]
    : events.filter((event) => filter === 'medicine'
      ? ['medicine', 'category', 'brand', 'medicine_unit'].includes(event.entity_type)
      : event.entity_type === filter);
}
