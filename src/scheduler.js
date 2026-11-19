// Smog Scheduler: moves flexible outdoor tasks into the cleanest free slots of today's forecast.
// Pure and deterministic; the LLM only extracts the tasks, every decision here is plain code.

import { cigaretteEquivalent } from './impact.js';

const SLOT_STEP_MIN = 30;
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 21 * 60;
const MIN_GAIN_SHARE = 0.1; // move only if exposure drops by at least 10 %
const N95_PM25 = 35.5; // µg/m³: US EPA breakpoint where PM2.5 turns unhealthy for sensitive groups

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round2 = (n) => Math.round(n * 100) / 100;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function pm25ByHour(hourly, date) {
  const byHour = new Map();
  for (const h of hourly) if (h.time.startsWith(date)) byHour.set(Number(h.time.slice(11, 13)), h.pm25);
  return byHour;
}

/** Splits [start, start+duration) into per-hour chunks; null if any hour has no forecast. */
function hourChunks(start, duration, byHour) {
  const chunks = [];
  for (let t = start, end = start + duration; t < end;) {
    const hour = Math.floor(t / 60);
    const next = Math.min((hour + 1) * 60, end);
    if (!byHour.has(hour)) return null;
    chunks.push({ pm25: byHour.get(hour), hours: (next - t) / 60 });
    t = next;
  }
  return chunks;
}

function exposure(start, duration, byHour) {
  const chunks = hourChunks(start, duration, byHour);
  return chunks && chunks.reduce((sum, c) => sum + cigaretteEquivalent(c.pm25, c.hours), 0);
}

function averagePm25(start, duration, byHour) {
  const chunks = hourChunks(start, duration, byHour);
  return chunks && chunks.reduce((sum, c) => sum + c.pm25 * c.hours, 0) / (duration / 60);
}

function bestSlot(task, busy, firstSlot, byHour) {
  let best = null;
  for (let start = firstSlot; start + task.durationMin <= DAY_END_MIN; start += SLOT_STEP_MIN) {
    const slot = { start, end: start + task.durationMin };
    if (busy.some((b) => b.owner !== task.index && overlaps(b, slot))) continue;
    const cost = exposure(start, task.durationMin, byHour);
    if (cost !== null && (!best || cost < best.cost)) best = { start, cost }; // strict < keeps the earliest tie
  }
  return best;
}

function describe(task, newStart, byHour) {
  if (!task.outdoor) return { before: null, after: null, mitigation: null };
  const before = exposure(task.startMin, task.durationMin, byHour);
  const after = exposure(newStart, task.durationMin, byHour);
  const avg = averagePm25(newStart, task.durationMin, byHour);
  return {
    before: before === null ? null : round2(before),
    after: after === null ? null : round2(after),
    mitigation: !task.past && avg !== null && avg > N95_PM25 ? 'n95' : null,
  };
}

const sumKnown = (values) => round2(values.filter((v) => v !== null).reduce((a, b) => a + b, 0));

/**
 * @param {ReadonlyArray<{ name: string, start: string, durationMin: number, outdoor: boolean, flexible: boolean }>} tasks
 * @param {ReadonlyArray<{ time: string, pm25: number }>} hourly local-time forecast
 * @param {{ now: string }} options local ISO time of the current reading
 * @returns {{ tasks: object[], totals: { before: number, after: number } }}
 */
export function reschedule(tasks, hourly, { now }) {
  const byHour = pm25ByHour(hourly, now.slice(0, 10));
  const nowMin = toMinutes(now.slice(11, 16));
  const firstSlot = Math.max(DAY_START_MIN, Math.ceil(nowMin / SLOT_STEP_MIN) * SLOT_STEP_MIN);

  const items = tasks.map((t, index) => ({ ...t, index, startMin: toMinutes(t.start), past: toMinutes(t.start) < nowMin }));
  const movable = items.filter((t) => t.outdoor && t.flexible && !t.past).sort((a, b) => a.startMin - b.startMin || a.index - b.index);

  // Every task starts out occupying its own slot; a moved task releases it and claims the new one.
  const busy = items.map((t) => ({ owner: t.index, start: t.startMin, end: t.startMin + t.durationMin }));
  const newStarts = new Map(items.map((t) => [t.index, t.startMin]));

  for (const task of movable) {
    const original = exposure(task.startMin, task.durationMin, byHour);
    const best = bestSlot(task, busy, firstSlot, byHour);
    if (original === null || !best || best.cost > original * (1 - MIN_GAIN_SHARE)) continue;
    newStarts.set(task.index, best.start);
    busy[task.index] = { owner: task.index, start: best.start, end: best.start + task.durationMin };
  }

  const result = items.map((task) => {
    const newStart = newStarts.get(task.index);
    return Object.freeze({
      name: task.name,
      start: task.start,
      durationMin: task.durationMin,
      outdoor: task.outdoor,
      flexible: task.flexible,
      past: task.past,
      newStart: toClock(newStart),
      moved: newStart !== task.startMin,
      ...describe(task, newStart, byHour),
    });
  });

  return Object.freeze({
    tasks: Object.freeze(result),
    totals: { before: sumKnown(result.map((t) => t.before)), after: sumKnown(result.map((t) => t.after)) },
  });
}
