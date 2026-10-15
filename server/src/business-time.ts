export function timezoneToday(timeZone: string, now = new Date()): Date {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now).map((part) => [part.type, part.value]));
  } catch {
    throw new Error('INVALID_SHOP_TIMEZONE');
  }
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error('INVALID_SHOP_TIMEZONE');
  return new Date(`${dateText}T00:00:00.000Z`);
}
