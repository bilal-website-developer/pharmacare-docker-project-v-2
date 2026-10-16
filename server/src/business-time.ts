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

function timezoneLocalMidnightUtc(timeZone: string, dateText: string): Date {
  const parsedDate = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateText) {
    throw new Error('INVALID_CALENDAR_DATE');
  }

  let candidate = parsedDate;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate).map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const correction = parsedDate.getTime() - localAsUtc;
    if (correction === 0) return candidate;
    candidate = new Date(candidate.getTime() + correction);
  }
  throw new Error('INVALID_SHOP_TIMEZONE');
}

export function timezoneDateBounds(timeZone: string, dateText: string): { start: Date; end: Date } {
  const start = timezoneLocalMidnightUtc(timeZone, dateText);
  const nextDate = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(nextDate.getTime()) || nextDate.toISOString().slice(0, 10) !== dateText) {
    throw new Error('INVALID_CALENDAR_DATE');
  }
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    start,
    end: timezoneLocalMidnightUtc(timeZone, nextDate.toISOString().slice(0, 10)),
  };
}
