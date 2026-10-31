// Stage 5: billing engine. Turns due subscriptions into invoices, one per billing period.
import { TEAM, requireRole } from './access.js';
import { HttpError, addDays, addInterval, routeId, today, transaction } from './http.js';

// Billing creates drafts. Staff confirm them before they are sent; Stage 6 payments mark them paid.
export const INVOICE_ACTIONS = {
  confirm: { from: ['draft'], to: 'confirmed', label: 'Confirm' },
  cancel:  { from: ['draft', 'confirmed'], to: 'cancelled', label: 'Cancel' },
};
const INVOICE_STATUSES = ['draft', 'confirmed', 'paid', 'cancelled'];

// Periods count from the start date, so monthly billing from 31 Jan stays on month ends (28 Feb, 31 Mar)
// instead of drifting to the 28th. Periods are start-inclusive and end-exclusive.
export function periodEnd(startDate, interval, periodStart) {
  let count = 1;
  while (addInterval(startDate, interval, count) <= periodStart) count += 1;
  return addInterval(startDate, interval, count);
}

// Amount, tax and total for one line, in paise. Discounts (Stage 6) come off before tax.
export function priceLine({ quantity, unit_price, tax_rate_basis_points = 0, discount_amount = 0 }) {
  const subtotal = quantity * unit_price;
  const taxable = subtotal - discount_amount;
  const tax_amount = Math.round(taxable * tax_rate_basis_points / 10000);
  return { subtotal, discount_amount, tax_amount, amount: taxable + tax_amount };
}

function subscriptionLines(db, subscriptionId) {
  return db.prepare(`
    SELECT l.product_id, l.quantity, l.unit_price, p.name AS product_name,
           v.attribute AS variant_attribute, v.value AS variant_value,
           COALESCE(l.tax_rate_basis_points, t.rate_basis_points, 0) AS tax_rate_basis_points
    FROM subscription_lines l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN product_variants v ON v.id = l.variant_id
    LEFT JOIN tax_rules t ON t.id = l.tax_rule_id
    WHERE l.subscription_id = ? ORDER BY l.id`).all(subscriptionId);
}

// Creates the invoice for the subscription's next period and moves next_billing_date on.
// Must run inside a transaction. Returns the new invoice id, or null if that period was already invoiced.
function invoiceNextPeriod(db, subscription, plan, issueDate) {
  const periodStart = subscription.next_billing_date;
  const end = periodEnd(subscription.start_date, plan.interval, periodStart);
  db.prepare('UPDATE subscriptions SET next_billing_date = ? WHERE id = ?').run(end, subscription.id);

  // Any invoice overlapping this period, even a cancelled one, means it has been handled already.
  const overlapping = db.prepare('SELECT 1 FROM invoices WHERE subscription_id = ? AND period_start < ? AND period_end > ? LIMIT 1')
    .get(subscription.id, end, periodStart);
  if (overlapping) return null;

  const customer = db.prepare('SELECT name, email FROM users WHERE id = ?').get(subscription.customer_id);
  const lines = subscriptionLines(db, subscription.id).map(line => ({ ...line, ...priceLine(line) }));
  const totals = { subtotal: 0, discount_total: 0, tax_total: 0, total: 0 };
  for (const line of lines) {
    totals.subtotal += line.subtotal;
    totals.discount_total += line.discount_amount;
    totals.tax_total += line.tax_amount;
    totals.total += line.amount;
  }

  const placeholder = `PENDING-${crypto.randomUUID()}`;
  const id = Number(db.prepare(`INSERT INTO invoices(number, subscription_id, customer_id, customer_name, customer_email,
      period_start, period_end, issue_date, due_date, subtotal, discount_total, tax_total, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    placeholder, subscription.id, subscription.customer_id, customer.name, customer.email,
    periodStart, end, issueDate, addDays(issueDate, subscription.payment_terms_days),
    totals.subtotal, totals.discount_total, totals.tax_total, totals.total,
  ).lastInsertRowid);
  // Like subscription numbers, the invoice number derives from the row id, so it is unique.
  db.prepare('UPDATE invoices SET number = ? WHERE id = ?').run(`INV-${String(id).padStart(5, '0')}`, id);

  const insertLine = db.prepare(`INSERT INTO invoice_lines(invoice_id, product_id, description, quantity, unit_price,
    tax_rate_basis_points, discount_amount, tax_amount, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const line of lines) {
    const description = line.variant_value ? `${line.product_name} (${line.variant_attribute}: ${line.variant_value})` : line.product_name;
    insertLine.run(id, line.product_id, description, line.quantity, line.unit_price,
      line.tax_rate_basis_points, line.discount_amount, line.tax_amount, line.amount);
  }
  db.prepare("INSERT INTO subscription_events(subscription_id, action, from_status, to_status, note) VALUES (?, 'invoice', ?, ?, ?)")
    .run(subscription.id, subscription.status, subscription.status, `Invoiced ${periodStart} to ${end}`);
  return id;
}

// The scheduled billing job. Bills every active subscription that is due on `date`, catching up on
// missed periods. Paused periods are skipped, so resuming does not back-bill. Billing stops after the
// expiry date; a renewal extends the expiry date and billing carries on.
// Each subscription is billed in its own transaction and re-read inside it, so running the job twice
// (or two jobs at once) never creates a second invoice for the same period.
export function runBilling(db, date = today()) {
  const due = db.prepare(`
    SELECT id FROM subscriptions
    WHERE status IN ('active', 'paused') AND next_billing_date IS NOT NULL AND next_billing_date <= ?
      AND (expiry_date IS NULL OR next_billing_date <= expiry_date)
    ORDER BY id`).all(date);
  const result = { invoices: [], skipped_paused: 0 };
  for (const { id } of due) {
    transaction(db, () => {
      for (let guard = 0; guard < 5000; guard += 1) {
        const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
        if (!['active', 'paused'].includes(subscription.status) || !subscription.next_billing_date
          || subscription.next_billing_date > date
          || (subscription.expiry_date && subscription.next_billing_date > subscription.expiry_date)) return;
        const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(subscription.plan_id);
        if (subscription.status === 'paused') {
          db.prepare('UPDATE subscriptions SET next_billing_date = ? WHERE id = ?')
            .run(periodEnd(subscription.start_date, plan.interval, subscription.next_billing_date), id);
          result.skipped_paused += 1;
          continue;
        }
        const invoiceId = invoiceNextPeriod(db, subscription, plan, date);
        if (invoiceId) result.invoices.push(invoiceId);
      }
    });
  }
  return result;
}

// Customers only see their own invoices, and not drafts, which are still internal.
export function getInvoice(db, id, user) {
  const invoice = db.prepare(`
    SELECT i.*, s.number AS subscription_number,
           COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS amount_paid
    FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
    WHERE i.id = ?`).get(id);
  if (!invoice || (user?.role === 'customer' && (invoice.customer_id !== user.id || invoice.status === 'draft'))) {
    throw new HttpError(404, 'Invoice not found.');
  }
  const payments = db.prepare('SELECT id, method, amount, payment_date, note, reference FROM payments WHERE invoice_id = ? ORDER BY payment_date, id').all(id);
  return {
    ...invoice,
    balance: invoice.status === 'cancelled' ? 0 : invoice.total - invoice.amount_paid,
    lines: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(id),
    payments,
    actions: user?.role === 'customer' ? [] : Object.keys(INVOICE_ACTIONS)
      .filter(name => INVOICE_ACTIONS[name].from.includes(invoice.status) && !(name === 'cancel' && payments.length)),
  };
}

function runInvoiceAction(db, id, name, user) {
  const action = Object.hasOwn(INVOICE_ACTIONS, name) ? INVOICE_ACTIONS[name] : null;
  if (!action) throw new HttpError(404, 'Unknown action.');
  return transaction(db, () => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found.');
    if (!action.from.includes(invoice.status)) {
      throw new HttpError(409, `A ${invoice.status} invoice cannot be moved with "${action.label}".`);
    }
    if (name === 'cancel' && db.prepare('SELECT 1 FROM payments WHERE invoice_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, 'This invoice has payments and cannot be cancelled.');
    }
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(action.to, id);
    return getInvoice(db, id, user);
  });
}

function listInvoices(db, query, user) {
  const where = [];
  const params = [];
  const status = query.get('status');
  if (status && INVOICE_STATUSES.includes(status)) { where.push('i.status = ?'); params.push(status); }
  const subscriptionId = Number(query.get('subscription_id'));
  if (Number.isSafeInteger(subscriptionId) && subscriptionId > 0) { where.push('i.subscription_id = ?'); params.push(subscriptionId); }
  const own = user?.role === 'customer' ? "i.customer_id = ? AND i.status <> 'draft'" : '';
  if (own) { where.push(own); params.push(user.id); }
  const search = query.get('q')?.trim();
  if (search) {
    where.push('(i.number LIKE ? OR i.customer_name LIKE ? OR i.customer_email LIKE ? OR s.number LIKE ?)');
    params.push(...Array(4).fill(`%${search.slice(0, 80)}%`));
  }
  const items = db.prepare(`
    SELECT i.id, i.number, i.status, i.customer_name, i.period_start, i.period_end, i.issue_date, i.due_date, i.total,
           s.number AS subscription_number,
           i.total - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS balance
    FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.id DESC LIMIT 200`).all(...params);
  const counts = Object.fromEntries(INVOICE_STATUSES.map(name => [name, 0]));
  for (const row of db.prepare(`SELECT status, COUNT(*) AS count FROM invoices i ${own ? `WHERE ${own}` : ''} GROUP BY status`).all(...(own ? [user.id] : []))) {
    counts[row.status] = row.count;
  }
  return { items, limit: 200, counts };
}

export const routes = [
  ['POST', '/api/billing/run', ({ db, user }) => {
    requireRole(user, 'admin');
    return runBilling(db);
  }],
  ['GET', '/api/invoices', ({ db, user, query }) => {
    requireRole(user, ...TEAM, 'customer');
    return listInvoices(db, query, user);
  }],
  ['GET', '/api/invoices/:id', ({ db, user, params }) => {
    requireRole(user, ...TEAM, 'customer');
    return getInvoice(db, routeId(params.id), user);
  }],
  ['POST', '/api/invoices/:id/actions/:action', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    return runInvoiceAction(db, routeId(params.id), params.action, user);
  }],
];
