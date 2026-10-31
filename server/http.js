// Shared request helpers: JSON body parsing, validation and errors for write endpoints.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) throw new HttpError(415, 'Send the request body as application/json.');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

const has = (body, key) => Object.hasOwn(body, key) && body[key] !== undefined;

// Each reader returns undefined when the field is absent and optional, so PATCH can pick provided fields only.
export function text(body, key, { required = false, max = 200, allowEmpty = false } = {}) {
  if (!has(body, key) || body[key] === null) {
    if (required) throw new HttpError(400, `${key} is required.`);
    return undefined;
  }
  if (typeof body[key] !== 'string') throw new HttpError(400, `${key} must be text.`);
  const value = body[key].trim();
  if (!value && (required || !allowEmpty)) throw new HttpError(400, `${key} cannot be empty.`);
  if (value.length > max) throw new HttpError(400, `${key} must be at most ${max} characters.`);
  return value;
}

export function integer(body, key, { required = false, min = -Infinity, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (!has(body, key) || (body[key] === null && !nullable)) {
    if (required) throw new HttpError(400, `${key} is required.`);
    return undefined;
  }
  if (body[key] === null) return null;
  const value = typeof body[key] === 'string' && body[key].trim() !== '' ? Number(body[key]) : body[key];
  if (!Number.isSafeInteger(value)) throw new HttpError(400, `${key} must be a whole number.`);
  if (value < min || value > max) throw new HttpError(400, `${key} must be between ${min} and ${max}.`);
  return value;
}

export function boolean(body, key) {
  if (!has(body, key)) return undefined;
  if (typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be true or false.`);
  return body[key] ? 1 : 0;
}

export function oneOf(body, key, values, { required = false } = {}) {
  if (!has(body, key)) {
    if (required) throw new HttpError(400, `${key} is required.`);
    return undefined;
  }
  if (!values.includes(body[key])) throw new HttpError(400, `${key} must be one of: ${values.join(', ')}.`);
  return body[key];
}

export function isoDate(body, key, { required = false } = {}) {
  if (!has(body, key) || body[key] === null || body[key] === '') {
    if (required) throw new HttpError(400, `${key} is required.`);
    return has(body, key) ? null : undefined;
  }
  if (!isValidDate(body[key])) throw new HttpError(400, `${key} must be a date in YYYY-MM-DD format.`);
  return body[key];
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Adds billing intervals; month/year steps clamp to the last day of shorter months (31 Jan + 1 month = 28/29 Feb).
export function addInterval(date, interval, count = 1) {
  if (interval === 'daily') return addDays(date, count);
  if (interval === 'weekly') return addDays(date, 7 * count);
  const [year, month, day] = date.split('-').map(Number);
  const months = interval === 'yearly' ? 12 * count : count;
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// Picks the defined keys of an object, for building UPDATE statements from PATCH bodies.
export function defined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function updateRow(db, table, id, values) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(key => values[key]), id);
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function routeId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'Record not found.');
  return id;
}
