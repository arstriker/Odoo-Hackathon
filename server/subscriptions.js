// Stage 4: customers, quotation templates and the subscription lifecycle.
import { TEAM, requireRole } from './access.js';
import { planAvailableOn } from './catalog.js';
import {
  HttpError, addDays, addInterval, defined, integer, isoDate, routeId, text, today, transaction, updateRow,
} from './http.js';

// Draft → Quotation → Confirmed → Active → Closed, with pause/resume and renewal while active.
export const ACTIONS = {
  send:     { from: ['draft'], to: 'quotation', label: 'Send quotation' },
  confirm:  { from: ['draft', 'quotation'], to: 'confirmed', label: 'Confirm' },
  activate: { from: ['confirmed'], to: 'active', label: 'Activate' },
  pause:    { from: ['active'], to: 'paused', label: 'Pause', planFlag: 'allow_pause' },
  resume:   { from: ['paused'], to: 'active', label: 'Resume' },
  renew:    { from: ['active', 'paused'], to: 'active', label: 'Renew', planFlag: 'allow_renew' },
  close:    { from: ['draft', 'quotation', 'confirmed', 'active', 'paused'], to: 'closed', label: 'Close' },
};
const EDITABLE = ['draft', 'quotation'];
const STATUSES = ['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'];

function allowedActions(subscription, plan) {
  return Object.entries(ACTIONS)
    .filter(([name, action]) => {
      if (!action.from.includes(subscription.status)) return false;
      if (action.planFlag && !plan[action.planFlag]) return false;
      // Closing a running subscription early is a plan policy; cancelling an unconfirmed quote is always allowed.
      if (name === 'close' && ['active', 'paused'].includes(subscription.status) && !plan.allow_close) return false;
      if (name === 'renew' && !subscription.expiry_date) return false;
      return true;
    })
    .map(([name]) => name);
}

// ---------- Lines (shared by templates and subscriptions) ----------
function readLines(db, rawLines, plan) {
  if (!Array.isArray(rawLines)) throw new HttpError(400, 'lines must be a list.');
  if (rawLines.length > 100) throw new HttpError(400, 'A maximum of 100 lines is allowed.');
  return rawLines.map((raw, index) => {
    const line = raw && typeof raw === 'object' ? raw : {};
    const where = `Line ${index + 1}`;
    const productId = integer(line, 'product_id', { required: true, min: 1 });
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new HttpError(400, `${where}: product not found.`);
    if (!product.active) throw new HttpError(400, `${where}: ${product.name} is archived.`);
    const variantId = integer(line, 'variant_id', { min: 1, nullable: true }) ?? null;
    let variant = null;
    if (variantId) {
      variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?').get(variantId, productId);
      if (!variant) throw new HttpError(400, `${where}: the variant does not belong to ${product.name}.`);
    }
    const taxRuleId = integer(line, 'tax_rule_id', { min: 1, nullable: true }) ?? null;
    if (taxRuleId && !db.prepare('SELECT 1 FROM tax_rules WHERE id = ? AND active = 1').get(taxRuleId)) {
      throw new HttpError(400, `${where}: tax rule not found or inactive.`);
    }
    const quantity = integer(line, 'quantity', { required: true, min: 1, max: 1_000_000 });
    if (quantity < plan.minimum_quantity) {
      throw new HttpError(400, `${where}: ${plan.name} requires a minimum quantity of ${plan.minimum_quantity}.`);
    }
    const defaultPrice = Math.max(0, product.sales_price + (variant?.price_adjustment ?? 0));
    const unitPrice = integer(line, 'unit_price', { min: 0, max: 1_000_000_000_00 }) ?? defaultPrice;
    return { product_id: productId, variant_id: variantId, quantity, unit_price: unitPrice, tax_rule_id: taxRuleId };
  });
}

function describeLines(db, table, foreignKey, id) {
  const lines = db.prepare(`
    SELECT l.*, p.name AS product_name, v.attribute AS variant_attribute, v.value AS variant_value,
           t.name AS tax_name, COALESCE(t.rate_basis_points, 0) AS tax_rate_basis_points
    FROM ${table} l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN product_variants v ON v.id = l.variant_id
    LEFT JOIN tax_rules t ON t.id = l.tax_rule_id
    WHERE l.${foreignKey} = ? ORDER BY l.id`).all(id);
  const totals = { subtotal: 0, tax_total: 0, total: 0 };
  for (const line of lines) {
    line.amount = line.quantity * line.unit_price;
    line.tax_amount = Math.round(line.amount * line.tax_rate_basis_points / 10000);
    line.total = line.amount + line.tax_amount;
    totals.subtotal += line.amount;
    totals.tax_total += line.tax_amount;
    totals.total += line.total;
  }
  return { lines, totals };
}

function insertLines(db, table, foreignKey, id, lines) {
  const insert = db.prepare(`INSERT INTO ${table}(${foreignKey}, product_id, variant_id, quantity, unit_price, tax_rule_id) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const line of lines) insert.run(id, line.product_id, line.variant_id, line.quantity, line.unit_price, line.tax_rule_id);
}

function findPlan(db, id) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!plan) throw new HttpError(400, 'Plan not found.');
  return plan;
}

// ---------- Quotation templates ----------
function getTemplate(db, id) {
  const template = db.prepare('SELECT t.*, p.name AS plan_name, p.interval AS plan_interval FROM quotation_templates t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?').get(id);
  if (!template) throw new HttpError(404, 'Quotation template not found.');
  return { ...template, ...describeLines(db, 'quotation_template_lines', 'template_id', id) };
}

function templateFields(body, creating) {
  return defined({
    name: text(body, 'name', { required: creating, max: 120 }),
    plan_id: integer(body, 'plan_id', { required: creating, min: 1 }),
    validity_days: integer(body, 'validity_days', { min: 1, max: 3650 }),
    payment_terms_days: integer(body, 'payment_terms_days', { min: 0, max: 365 }),
  });
}

// ---------- Subscriptions ----------
export function getSubscription(db, id, user) {
  const subscription = db.prepare(`
    SELECT s.*, u.name AS customer_name, u.email AS customer_email, p.name AS plan_name, t.name AS template_name
    FROM subscriptions s
    JOIN users u ON u.id = s.customer_id
    JOIN plans p ON p.id = s.plan_id
    LEFT JOIN quotation_templates t ON t.id = s.quotation_template_id
    WHERE s.id = ?`).get(id);
  if (!subscription || (user?.role === 'customer' && subscription.customer_id !== user.id)) {
    throw new HttpError(404, 'Subscription not found.');
  }
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(subscription.plan_id);
  return {
    ...subscription,
    plan,
    ...describeLines(db, 'subscription_lines', 'subscription_id', id),
    events: db.prepare(`SELECT e.*, u.name AS user_name FROM subscription_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.subscription_id = ? ORDER BY e.id`).all(id),
    allowed_actions: user?.role === 'customer' ? [] : allowedActions(subscription, plan),
  };
}

function logEvent(db, subscriptionId, action, fromStatus, toStatus, user, note = '') {
  db.prepare('INSERT INTO subscription_events(subscription_id, action, from_status, to_status, user_id, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(subscriptionId, action, fromStatus, toStatus, user?.id ?? null, note);
}

function checkDates(start, expiry) {
  if (expiry && expiry < start) throw new HttpError(400, 'The expiry date must be on or after the start date.');
}

function findCustomer(db, id) {
  const customer = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'customer'").get(id);
  if (!customer) throw new HttpError(400, 'Customer not found.');
  return customer;
}

// Number of whole billing intervals in the original term, so a renewal extends by the same length.
function termIntervals(start, expiry, interval) {
  let count = 1;
  while (count < 1000 && addInterval(start, interval, count) < expiry) count += 1;
  return count;
}

function runAction(db, id, name, user, date = today()) {
  const action = ACTIONS[name];
  if (!action) throw new HttpError(404, 'Unknown action.');
  return transaction(db, () => {
    const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    if (!subscription) throw new HttpError(404, 'Subscription not found.');
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(subscription.plan_id);
    if (!allowedActions(subscription, plan).includes(name)) {
      const reason = action.from.includes(subscription.status)
        ? `The ${plan.name} plan does not allow this action.`
        : `A ${subscription.status} subscription cannot be moved with "${action.label}".`;
      throw new HttpError(409, reason);
    }
    const changes = { status: action.to };
    let note = '';
    if (name === 'send' || name === 'confirm') {
      const lineCount = db.prepare('SELECT COUNT(*) AS count FROM subscription_lines WHERE subscription_id = ?').get(id).count;
      if (!lineCount) throw new HttpError(409, 'Add at least one product line first.');
    }
    if (name === 'confirm') {
      if (subscription.valid_until && subscription.valid_until < date) {
        throw new HttpError(409, `This quotation expired on ${subscription.valid_until}. Create a new quotation.`);
      }
      if (!planAvailableOn(plan, subscription.start_date)) {
        throw new HttpError(409, `The ${plan.name} plan is not available on the start date ${subscription.start_date}.`);
      }
    }
    if (name === 'activate') {
      if (subscription.expiry_date && subscription.expiry_date < date) throw new HttpError(409, 'This subscription has already expired.');
      changes.next_billing_date = subscription.next_billing_date ?? subscription.start_date;
    }
    if (name === 'renew') {
      const intervals = termIntervals(subscription.start_date, subscription.expiry_date, plan.interval);
      changes.expiry_date = addInterval(subscription.expiry_date, plan.interval, intervals);
      changes.next_billing_date = subscription.next_billing_date ?? subscription.start_date;
      note = `Extended to ${changes.expiry_date}`;
    }
    if (name === 'close') changes.next_billing_date = null;
    updateRow(db, 'subscriptions', id, changes);
    logEvent(db, id, name, subscription.status, action.to, user, note);
    return getSubscription(db, id, user);
  });
}

// Closes running subscriptions whose plan closes automatically once the expiry date has passed.
export function closeExpiredSubscriptions(db, date = today()) {
  return transaction(db, () => {
    const expired = db.prepare(`
      SELECT s.id, s.status FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'paused') AND p.auto_close = 1 AND s.expiry_date IS NOT NULL AND s.expiry_date < ?`).all(date);
    for (const subscription of expired) {
      db.prepare("UPDATE subscriptions SET status = 'closed', next_billing_date = NULL WHERE id = ?").run(subscription.id);
      logEvent(db, subscription.id, 'auto_close', subscription.status, 'closed', null, `Plan ended on expiry date (checked ${date})`);
    }
    return expired.length;
  });
}

function listSubscriptions(db, query, user) {
  const where = [];
  const params = [];
  const status = query.get('status');
  if (status && STATUSES.includes(status)) { where.push('s.status = ?'); params.push(status); }
  if (user?.role === 'customer') { where.push('s.customer_id = ?'); params.push(user.id); }
  const search = query.get('q')?.trim();
  if (search) {
    where.push('(s.number LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
    params.push(...Array(3).fill(`%${search.slice(0, 80)}%`));
  }
  const items = db.prepare(`
    SELECT s.id, s.number, s.status, s.start_date, s.expiry_date, s.next_billing_date, s.valid_until,
           u.name AS customer, p.name AS plan, p.interval,
           COALESCE((SELECT SUM(l.quantity * l.unit_price) FROM subscription_lines l WHERE l.subscription_id = s.id), 0) AS subtotal
    FROM subscriptions s JOIN users u ON u.id = s.customer_id JOIN plans p ON p.id = s.plan_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.id DESC LIMIT 200`).all(...params);
  const counts = Object.fromEntries(STATUSES.map(name => [name, 0]));
  const countWhere = user?.role === 'customer' ? 'WHERE customer_id = ?' : '';
  for (const row of db.prepare(`SELECT status, COUNT(*) AS count FROM subscriptions ${countWhere} GROUP BY status`).all(...(countWhere ? [user.id] : []))) {
    counts[row.status] = row.count;
  }
  return { items, limit: 200, counts };
}

export const routes = [
  ['POST', '/api/customers', async ({ db, user, body }) => {
    requireRole(user, ...TEAM);
    const values = await body();
    const name = text(values, 'name', { required: true, max: 120 });
    const email = text(values, 'email', { required: true, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    try {
      const id = db.prepare("INSERT INTO users(name, email, role) VALUES (?, ?, 'customer')").run(name, email).lastInsertRowid;
      return { status: 201, data: db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(id) };
    } catch (error) {
      if (/UNIQUE/.test(error.message)) throw new HttpError(409, 'An account with this email already exists.');
      throw error;
    }
  }],

  ['GET', '/api/quotation-templates', ({ db, user }) => {
    requireRole(user, ...TEAM);
    const ids = db.prepare('SELECT id FROM quotation_templates ORDER BY name LIMIT 200').all();
    return { items: ids.map(row => getTemplate(db, row.id)), limit: 200 };
  }],
  ['GET', '/api/quotation-templates/:id', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    return getTemplate(db, routeId(params.id));
  }],
  ['POST', '/api/quotation-templates', async ({ db, user, body }) => {
    requireRole(user, ...TEAM);
    const values = await body();
    const fields = templateFields(values, true);
    const plan = findPlan(db, fields.plan_id);
    const lines = readLines(db, values.lines ?? [], plan);
    return transaction(db, () => {
      const keys = Object.keys(fields);
      const id = Number(db.prepare(`INSERT INTO quotation_templates(${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => fields[k])).lastInsertRowid);
      insertLines(db, 'quotation_template_lines', 'template_id', id, lines);
      return { status: 201, data: getTemplate(db, id) };
    });
  }],
  ['PATCH', '/api/quotation-templates/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...TEAM);
    const id = routeId(params.id);
    const existing = getTemplate(db, id);
    const values = await body();
    const fields = templateFields(values, false);
    const plan = findPlan(db, fields.plan_id ?? existing.plan_id);
    const lines = values.lines === undefined ? null : readLines(db, values.lines, plan);
    return transaction(db, () => {
      updateRow(db, 'quotation_templates', id, fields);
      if (lines) {
        db.prepare('DELETE FROM quotation_template_lines WHERE template_id = ?').run(id);
        insertLines(db, 'quotation_template_lines', 'template_id', id, lines);
      }
      return getTemplate(db, id);
    });
  }],
  ['DELETE', '/api/quotation-templates/:id', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    const id = routeId(params.id);
    getTemplate(db, id);
    if (db.prepare('SELECT 1 FROM subscriptions WHERE quotation_template_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, 'Subscriptions were created from this template, so it cannot be deleted.');
    }
    db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(id);
    return { deleted: true };
  }],

  ['GET', '/api/subscriptions', ({ db, user, query }) => {
    requireRole(user, 'admin', 'staff', 'customer');
    return listSubscriptions(db, query, user);
  }],
  ['GET', '/api/subscriptions/:id', ({ db, user, params }) => {
    requireRole(user, 'admin', 'staff', 'customer');
    return getSubscription(db, routeId(params.id), user);
  }],
  ['POST', '/api/subscriptions', async ({ db, user, body }) => {
    requireRole(user, ...TEAM);
    const values = await body();
    const customer = findCustomer(db, integer(values, 'customer_id', { required: true, min: 1 }));
    const templateId = integer(values, 'template_id', { min: 1, nullable: true }) ?? null;
    const template = templateId ? getTemplate(db, templateId) : null;
    if (templateId && !template) throw new HttpError(400, 'Quotation template not found.');
    const planId = integer(values, 'plan_id', { min: 1 }) ?? template?.plan_id;
    if (!planId) throw new HttpError(400, 'plan_id is required.');
    const plan = findPlan(db, planId);
    const startDate = isoDate(values, 'start_date') ?? today();
    const expiryDate = isoDate(values, 'expiry_date') ?? null;
    checkDates(startDate, expiryDate);
    if (!planAvailableOn(plan, startDate)) throw new HttpError(400, `The ${plan.name} plan is not available on ${startDate}.`);
    const validUntil = isoDate(values, 'valid_until') ?? (template ? addDays(today(), template.validity_days) : null);
    const paymentTerms = integer(values, 'payment_terms_days', { min: 0, max: 365 }) ?? template?.payment_terms_days ?? 14;
    const notes = text(values, 'notes', { max: 2000, allowEmpty: true }) ?? '';
    // A template supplies its lines unless the request sends its own.
    const rawLines = values.lines ?? (template ? template.lines.map(line => ({
      product_id: line.product_id, variant_id: line.variant_id, quantity: line.quantity, unit_price: line.unit_price, tax_rule_id: line.tax_rule_id,
    })) : []);
    const lines = readLines(db, rawLines, plan);
    return transaction(db, () => {
      const placeholder = `PENDING-${crypto.randomUUID()}`;
      const id = Number(db.prepare(`INSERT INTO subscriptions(number, customer_id, plan_id, quotation_template_id, start_date, expiry_date, valid_until, payment_terms_days, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(placeholder, customer.id, plan.id, templateId, startDate, expiryDate, validUntil, paymentTerms, notes).lastInsertRowid);
      // The number derives from the row id, so it is unique and never reused while the row exists.
      db.prepare('UPDATE subscriptions SET number = ? WHERE id = ?').run(`SUB-${String(id).padStart(5, '0')}`, id);
      insertLines(db, 'subscription_lines', 'subscription_id', id, lines);
      logEvent(db, id, 'create', null, 'draft', user, template ? `From template ${template.name}` : '');
      return { status: 201, data: getSubscription(db, id, user) };
    });
  }],
  ['PATCH', '/api/subscriptions/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...TEAM);
    const id = routeId(params.id);
    const existing = getSubscription(db, id, user);
    if (!EDITABLE.includes(existing.status)) throw new HttpError(409, 'Only draft and quotation subscriptions can be edited.');
    const values = await body();
    const fields = defined({
      customer_id: values.customer_id === undefined ? undefined : findCustomer(db, integer(values, 'customer_id', { min: 1 })).id,
      plan_id: integer(values, 'plan_id', { min: 1 }),
      start_date: isoDate(values, 'start_date'),
      expiry_date: isoDate(values, 'expiry_date'),
      valid_until: isoDate(values, 'valid_until'),
      payment_terms_days: integer(values, 'payment_terms_days', { min: 0, max: 365 }),
      notes: text(values, 'notes', { max: 2000, allowEmpty: true }),
    });
    if (fields.start_date === null) throw new HttpError(400, 'start_date cannot be empty.');
    const plan = findPlan(db, fields.plan_id ?? existing.plan_id);
    const startDate = fields.start_date ?? existing.start_date;
    checkDates(startDate, fields.expiry_date === undefined ? existing.expiry_date : fields.expiry_date);
    if (!planAvailableOn(plan, startDate)) throw new HttpError(400, `The ${plan.name} plan is not available on ${startDate}.`);
    // Changing the plan re-checks the minimum quantity on the current lines.
    const rawLines = values.lines ?? (fields.plan_id ? existing.lines : null);
    const lines = rawLines ? readLines(db, rawLines, plan) : null;
    return transaction(db, () => {
      updateRow(db, 'subscriptions', id, fields);
      if (lines) {
        db.prepare('DELETE FROM subscription_lines WHERE subscription_id = ?').run(id);
        insertLines(db, 'subscription_lines', 'subscription_id', id, lines);
      }
      return getSubscription(db, id, user);
    });
  }],
  ['DELETE', '/api/subscriptions/:id', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    const id = routeId(params.id);
    const existing = getSubscription(db, id, user);
    if (existing.status !== 'draft') throw new HttpError(409, 'Only draft subscriptions can be deleted. Close it instead.');
    if (db.prepare('SELECT 1 FROM invoices WHERE subscription_id = ? LIMIT 1').get(id)) throw new HttpError(409, 'This subscription has invoices.');
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
    return { deleted: true };
  }],
  ['POST', '/api/subscriptions/:id/actions/:action', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    return runAction(db, routeId(params.id), params.action, user);
  }],
  ['POST', '/api/subscriptions/close-expired', ({ db, user }) => {
    requireRole(user, 'admin');
    return { closed: closeExpiredSubscriptions(db) };
  }],
];
