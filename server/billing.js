// Stage 5: billing engine. Turns due subscriptions into invoices, one per billing period.
import { addDays, addInterval, today, transaction } from './http.js';

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
           COALESCE(t.rate_basis_points, 0) AS tax_rate_basis_points
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
