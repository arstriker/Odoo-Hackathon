import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { periodEnd, priceLine, runBilling } from '../server/billing.js';
import { createApp } from '../server/index.js';
import { today } from '../server/http.js';

// An active monthly subscription: 3 × ₹1,560 (Odoo brand variant) with 18% GST, 14-day payment terms.
function setup({ status = 'active', start = '2026-01-31', expiry = null, interval = 'monthly' } = {}) {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO users(id, name, email, role) VALUES (1, 'Alice', 'alice@example.com', 'customer');
    INSERT INTO products(id, name, sales_price) VALUES (1, 'CRM', 100000);
    INSERT INTO product_variants(id, product_id, attribute, value, price_adjustment) VALUES (1, 1, 'Brand', 'Odoo', 56000);
    INSERT INTO tax_rules(id, name, rate_basis_points) VALUES (1, 'GST 18%', 1800);
    INSERT INTO plans(id, name, price, interval) VALUES (1, 'Plan', 0, '${interval}');`);
  db.prepare(`INSERT INTO subscriptions(id, number, customer_id, plan_id, status, start_date, expiry_date, next_billing_date, payment_terms_days)
    VALUES (1, 'SUB-00001', 1, 1, ?, ?, ?, ?, 14)`).run(status, start, expiry, start);
  db.exec('INSERT INTO subscription_lines(subscription_id, product_id, variant_id, quantity, unit_price, tax_rule_id) VALUES (1, 1, 1, 3, 156000, 1)');
  return db;
}
const invoices = db => db.prepare('SELECT * FROM invoices ORDER BY period_start').all();

test('periods count from the start date and keep month ends', () => {
  assert.equal(periodEnd('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(periodEnd('2026-01-31', 'monthly', '2026-02-28'), '2026-03-31');
  assert.equal(periodEnd('2026-01-01', 'weekly', '2026-01-08'), '2026-01-15');
  assert.equal(periodEnd('2024-02-29', 'yearly', '2024-02-29'), '2025-02-28');
});

test('line pricing rounds tax on the discounted amount, in paise', () => {
  assert.deepEqual(priceLine({ quantity: 3, unit_price: 156000, tax_rate_basis_points: 1800 }),
    { subtotal: 468000, discount_amount: 0, tax_amount: 84240, amount: 552240 });
  assert.equal(priceLine({ quantity: 1, unit_price: 999, tax_rate_basis_points: 1800, discount_amount: 99 }).tax_amount, 162);
});

test('a due subscription generates exactly one invoice per billing period', () => {
  const db = setup();
  try {
    assert.equal(runBilling(db, '2026-01-31').invoices.length, 1);
    assert.equal(runBilling(db, '2026-01-31').invoices.length, 0, 'running the job again bills nothing');
    const [invoice] = invoices(db);
    assert.match(invoice.number, /^INV-\d{5}$/);
    assert.deepEqual([invoice.status, invoice.period_start, invoice.period_end, invoice.issue_date, invoice.due_date],
      ['draft', '2026-01-31', '2026-02-28', '2026-01-31', '2026-02-14']);
    assert.deepEqual([invoice.customer_name, invoice.subtotal, invoice.tax_total, invoice.total], ['Alice', 468000, 84240, 552240]);
    const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(invoice.id);
    assert.deepEqual(lines.map(l => [l.description, l.quantity, l.amount]), [['CRM (Brand: Odoo)', 3, 552240]]);
    assert.equal(db.prepare('SELECT next_billing_date FROM subscriptions').get().next_billing_date, '2026-02-28');
  } finally { db.close(); }
});

test('invoices use the tax rate agreed on the subscription, not a later tax rule change', () => {
  const db = setup();
  try {
    db.exec('UPDATE subscription_lines SET tax_rate_basis_points = 1800; UPDATE tax_rules SET rate_basis_points = 2800');
    runBilling(db, '2026-01-31');
    const [invoice] = invoices(db);
    assert.deepEqual([invoice.tax_total, invoice.total], [84240, 552240]);
    assert.equal(db.prepare('SELECT tax_rate_basis_points FROM invoice_lines').get().tax_rate_basis_points, 1800);
  } finally { db.close(); }
});

test('missed periods are caught up without gaps or duplicates', () => {
  const db = setup();
  try {
    assert.equal(runBilling(db, '2026-04-15').invoices.length, 3);
    assert.deepEqual(invoices(db).map(i => [i.period_start, i.period_end]),
      [['2026-01-31', '2026-02-28'], ['2026-02-28', '2026-03-31'], ['2026-03-31', '2026-04-30']]);
    assert.equal(runBilling(db, '2026-04-29').invoices.length, 0);
    assert.equal(runBilling(db, '2026-04-30').invoices.length, 1);
  } finally { db.close(); }
});

test('an invoiced or cancelled period is never billed again', () => {
  const db = setup();
  try {
    runBilling(db, '2026-01-31');
    db.exec("UPDATE invoices SET status = 'cancelled'");
    db.exec("UPDATE subscriptions SET next_billing_date = '2026-01-31'"); // e.g. a renewal resetting the date
    assert.equal(runBilling(db, '2026-01-31').invoices.length, 0);
    assert.equal(invoices(db).length, 1);
  } finally { db.close(); }
});

test('draft, closed and paused subscriptions are not billed; billing stops at expiry', () => {
  for (const status of ['draft', 'quotation', 'confirmed', 'closed']) {
    const db = setup({ status });
    try { assert.equal(runBilling(db, '2026-06-01').invoices.length, 0, status); } finally { db.close(); }
  }
  const paused = setup({ status: 'paused' });
  try {
    assert.equal(runBilling(paused, '2026-03-15').skipped_paused, 2);
    paused.exec("UPDATE subscriptions SET status = 'active'");
    assert.equal(runBilling(paused, '2026-03-15').invoices.length, 0, 'resuming does not back-bill paused months');
    assert.equal(runBilling(paused, '2026-03-31').invoices.length, 1);
  } finally { paused.close(); }
  const expiring = setup({ expiry: '2026-03-15' });
  try {
    assert.equal(runBilling(expiring, '2026-12-31').invoices.length, 2);
    assert.equal(invoices(expiring).at(-1).period_start, '2026-02-28');
  } finally { expiring.close(); }
});

// Serves `db` over HTTP; the x-test-user header picks who is signed in. Alice (id 1) owns the subscription.
const USERS = { admin: { id: 2, role: 'admin' }, staff: { id: 3, role: 'staff' }, alice: { id: 1, role: 'customer' }, bob: { id: 4, role: 'customer' } };
async function serve(db) {
  const server = createApp(db, { authenticate: req => USERS[req.headers['x-test-user']] ?? null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const as = user => async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'x-test-user': user } });
    return { status: response.status, body: await response.json() };
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  return { admin: as('admin'), staff: as('staff'), alice: as('alice'), bob: as('bob'), anonymous: as('nobody'), stop };
}

test('admins can run billing over HTTP; others cannot', async () => {
  const db = setup({ start: today() });
  const app = await serve(db);
  try {
    assert.equal((await app.anonymous('POST', '/billing/run')).status, 401);
    assert.equal((await app.staff('POST', '/billing/run')).status, 403);
    assert.equal(invoices(db).length, 0);
    const first = await app.admin('POST', '/billing/run');
    assert.equal(first.status, 200);
    assert.equal(first.body.invoices.length, 1);
    assert.equal((await app.admin('POST', '/billing/run')).body.invoices.length, 0, 'running it again bills nothing');
  } finally { await app.stop(); db.close(); }
});

test('staff list, open, confirm and cancel invoices', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    runBilling(db, '2026-02-28');
    const list = await app.staff('GET', '/invoices?status=draft');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map(i => [i.number, i.subscription_number, i.balance]),
      [['INV-00002', 'SUB-00001', 552240], ['INV-00001', 'SUB-00001', 552240]]);
    assert.deepEqual(list.body.counts, { draft: 2, confirmed: 0, paid: 0, cancelled: 0 });
    assert.equal((await app.staff('GET', '/invoices?q=INV-00001')).body.items.length, 1);

    const invoice = (await app.staff('GET', '/invoices/1')).body;
    assert.deepEqual([invoice.total, invoice.amount_paid, invoice.balance, invoice.lines.length], [552240, 0, 552240, 1]);
    assert.deepEqual(invoice.actions, ['confirm', 'cancel']);

    const confirmed = await app.staff('POST', '/invoices/1/actions/confirm');
    assert.deepEqual([confirmed.status, confirmed.body.status, confirmed.body.actions], [200, 'confirmed', ['cancel']]);
    assert.equal((await app.staff('POST', '/invoices/1/actions/confirm')).status, 409, 'cannot confirm twice');
    assert.equal((await app.staff('POST', '/invoices/1/actions/pay')).status, 404);

    db.exec("INSERT INTO payments(invoice_id, method, amount, payment_date) VALUES (1, 'bank', 100000, '2026-02-10')");
    const partlyPaid = (await app.staff('GET', '/invoices/1')).body;
    assert.deepEqual([partlyPaid.amount_paid, partlyPaid.balance, partlyPaid.actions], [100000, 452240, []]);
    assert.equal((await app.staff('POST', '/invoices/1/actions/cancel')).status, 409, 'paid invoices cannot be cancelled');

    const cancelled = await app.staff('POST', '/invoices/2/actions/cancel');
    assert.deepEqual([cancelled.body.status, cancelled.body.balance, cancelled.body.actions], ['cancelled', 0, []]);
    assert.equal(runBilling(db, '2026-02-28').invoices.length, 0, 'a cancelled period is not billed again');
  } finally { await app.stop(); db.close(); }
});

test('customers see only their own invoices, never drafts, and cannot change them', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    runBilling(db, '2026-02-28');
    assert.equal((await app.alice('GET', '/invoices')).body.items.length, 0, 'drafts are internal');
    assert.equal((await app.alice('GET', '/invoices/1')).status, 404);
    await app.staff('POST', '/invoices/1/actions/confirm');

    const own = await app.alice('GET', '/invoices');
    assert.deepEqual(own.body.items.map(i => i.number), ['INV-00001']);
    assert.deepEqual(own.body.counts, { draft: 0, confirmed: 1, paid: 0, cancelled: 0 });
    assert.deepEqual((await app.alice('GET', '/invoices/1')).body.actions, []);
    assert.equal((await app.alice('POST', '/invoices/1/actions/cancel')).status, 403);
    assert.equal((await app.bob('GET', '/invoices')).body.items.length, 0);
    assert.equal((await app.bob('GET', '/invoices/1')).status, 404);
    assert.equal((await app.anonymous('GET', '/invoices')).status, 401);
  } finally { await app.stop(); db.close(); }
});
