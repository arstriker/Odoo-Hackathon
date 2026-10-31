import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { runBilling } from '../server/billing.js';

// Alice's monthly subscription from 31 Jan: 3 × CRM at ₹1,560 with 18% GST, plus 1 × Support at ₹500 untaxed.
function setup() {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO users(id, name, email, role) VALUES (1, 'Alice', 'alice@example.com', 'customer'), (5, 'Bob', 'bob@example.com', 'customer');
    INSERT INTO products(id, name, sales_price) VALUES (1, 'CRM', 156000), (2, 'Support', 50000);
    INSERT INTO plans(id, name, price, interval) VALUES (1, 'Plan', 0, 'monthly');
    INSERT INTO subscriptions(id, number, customer_id, plan_id, status, start_date, next_billing_date, payment_terms_days)
      VALUES (1, 'SUB-00001', 1, 1, 'active', '2026-01-31', '2026-01-31', 14);
    INSERT INTO subscription_lines(subscription_id, product_id, quantity, unit_price, tax_rate_basis_points)
      VALUES (1, 1, 3, 156000, 1800), (1, 2, 1, 50000, 0);`);
  return db;
}
// Adds a discount to the subscription; products limits it to those product ids.
function discount(db, fields, products = []) {
  const keys = Object.keys(fields);
  const id = Number(db.prepare(`INSERT INTO discounts(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(fields)).lastInsertRowid);
  for (const product of products) db.prepare('INSERT INTO discount_products(discount_id, product_id) VALUES (?, ?)').run(id, product);
  db.prepare('INSERT INTO subscription_discounts(subscription_id, discount_id) VALUES (1, ?)').run(id);
  return id;
}
const invoices = db => db.prepare('SELECT * FROM invoices ORDER BY period_start').all();
const lines = (db, invoiceId) => db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(invoiceId);
const usage = (db, id) => db.prepare('SELECT usage_count FROM discounts WHERE id = ?').get(id).usage_count;

test('a percentage discount comes off before tax and is recorded on the invoice', () => {
  const db = setup();
  try {
    const id = discount(db, { name: '10% off', type: 'percentage', value: 1000 });
    runBilling(db, '2026-01-31');
    const [invoice] = invoices(db);
    // Subtotal ₹5,180; discount ₹518; GST 18% on (₹4,680 − ₹468) = ₹758.16.
    assert.deepEqual([invoice.subtotal, invoice.discount_total, invoice.tax_total, invoice.total], [518000, 51800, 75816, 542016]);
    assert.deepEqual(lines(db, invoice.id).map(l => [l.discount_amount, l.amount]), [[46800, 497016], [5000, 45000]]);
    assert.deepEqual(db.prepare('SELECT discount_id, amount FROM invoice_discounts').all().map(r => ({ ...r })), [{ discount_id: id, amount: 51800 }]);
    assert.equal(usage(db, id), 1);
  } finally { db.close(); }
});

test('a fixed discount is shared across lines without rounding loss, and is capped at the line value', () => {
  const db = setup();
  try {
    discount(db, { name: '₹1,000 off', type: 'fixed', value: 100000 });
    discount(db, { name: 'Free support', type: 'fixed', value: 999900 }, [2]);
    runBilling(db, '2026-01-31');
    const [invoice] = invoices(db);
    // ₹1,000 split by value: CRM ₹903.47 + 1 paisa of rounding, Support ₹96.52. Free support then takes the ₹403.48 left on Support.
    const [crm, support] = lines(db, invoice.id);
    assert.deepEqual([crm.discount_amount, support.discount_amount], [90348, 50000]);
    assert.equal(support.amount, 0, 'the support line is fully discounted but never negative');
    assert.deepEqual(db.prepare('SELECT amount FROM invoice_discounts ORDER BY discount_id').all().map(r => r.amount), [100000, 40348]);
    assert.deepEqual([invoice.discount_total, invoice.tax_total, invoice.total], [140348, 67977, 445629]);
  } finally { db.close(); }
});

test('product, quantity, purchase and date conditions decide whether a discount applies', () => {
  const db = setup();
  try {
    const crmOnly = discount(db, { name: 'CRM 50%', type: 'percentage', value: 5000 }, [1]);
    const bigOrder = discount(db, { name: 'Bulk', type: 'percentage', value: 1000, minimum_quantity: 5 });
    const bigSpend = discount(db, { name: 'Big spend', type: 'fixed', value: 10000, minimum_purchase: 600000 });
    const february = discount(db, { name: 'From Feb', type: 'fixed', value: 1000, start_date: '2026-02-15', end_date: '2026-03-15' });
    runBilling(db, '2026-04-30');
    const applied = db.prepare('SELECT i.period_start, x.discount_id FROM invoice_discounts x JOIN invoices i ON i.id = x.invoice_id ORDER BY i.period_start, x.discount_id').all()
      .map(r => [r.period_start, r.discount_id]);
    assert.deepEqual(applied, [
      ['2026-01-31', crmOnly], ['2026-02-28', crmOnly], ['2026-02-28', february], ['2026-03-31', crmOnly], ['2026-04-30', crmOnly]]);
    assert.equal(lines(db, invoices(db)[0].id)[1].discount_amount, 0, 'the CRM-only discount leaves support alone');
    assert.deepEqual([usage(db, bigOrder), usage(db, bigSpend)], [0, 0]);
  } finally { db.close(); }
});

test('usage limits are never exceeded, and cancelling an invoice gives the use back', () => {
  const db = setup();
  try {
    const id = discount(db, { name: 'First two months', type: 'percentage', value: 2000, usage_limit: 2 });
    runBilling(db, '2026-03-31');
    assert.deepEqual(invoices(db).map(i => i.discount_total > 0), [true, true, false]);
    assert.equal(usage(db, id), 2);

    // The same release the cancel action performs (checked over HTTP below).
    db.exec("UPDATE invoices SET status = 'cancelled' WHERE id = 1");
    db.prepare('UPDATE discounts SET usage_count = usage_count - 1 WHERE id IN (SELECT discount_id FROM invoice_discounts WHERE invoice_id = 1)').run();
    runBilling(db, '2026-04-30');
    assert.equal(invoices(db).at(-1).discount_total > 0, true, 'the freed use goes to the next invoice');
    assert.equal(usage(db, id), 2);
  } finally { db.close(); }
});

test('a fully used line takes no more discount, so a second discount that adds nothing is not counted', () => {
  const db = setup();
  try {
    discount(db, { name: 'Free', type: 'percentage', value: 10000 });
    const extra = discount(db, { name: 'Extra', type: 'fixed', value: 5000 });
    runBilling(db, '2026-01-31');
    const [invoice] = invoices(db);
    assert.deepEqual([invoice.discount_total, invoice.tax_total, invoice.total], [518000, 0, 0]);
    assert.equal(usage(db, extra), 0);
  } finally { db.close(); }
});

// ---------- HTTP ----------
const USERS = { admin: { id: 2, role: 'admin' }, staff: { id: 3, role: 'staff' }, alice: { id: 1, role: 'customer' }, bob: { id: 5, role: 'customer' } };
async function serve(db) {
  const server = createApp(db, { authenticate: req => USERS[req.headers['x-test-user']] ?? null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const as = user => async (method, path, body) => {
    const headers = { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { admin: as('admin'), staff: as('staff'), alice: as('alice'), bob: as('bob'), stop: () => new Promise(resolve => server.close(resolve)) };
}

test('admins manage discounts; input is validated', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    const created = await app.admin('POST', '/discounts', { name: 'Launch', type: 'percentage', value: 1500, product_ids: [1], start_date: '2026-01-01', usage_limit: 10 });
    assert.equal(created.status, 201);
    assert.deepEqual([created.body.status, created.body.product_ids, created.body.usage_count, created.body.minimum_quantity], ['active', [1], 0, 1]);
    assert.equal((await app.staff('POST', '/discounts', { name: 'X', type: 'fixed', value: 100 })).status, 403);
    for (const body of [{ type: 'fixed', value: 100 }, { name: 'X', type: 'half', value: 100 }, { name: 'X', type: 'percentage', value: 10001 },
      { name: 'X', type: 'fixed', value: 0 }, { name: 'X', type: 'fixed', value: 100, start_date: '2026-05-01', end_date: '2026-04-01' },
      { name: 'X', type: 'fixed', value: 100, product_ids: [99] }]) {
      assert.equal((await app.admin('POST', '/discounts', body)).status, 400, JSON.stringify(body));
    }
    const edited = await app.admin('PATCH', `/discounts/${created.body.id}`, { value: 2000, product_ids: [], end_date: '2020-01-01', start_date: null });
    assert.deepEqual([edited.body.value, edited.body.product_ids, edited.body.status], [2000, [], 'expired']);
    assert.equal((await app.staff('GET', '/discounts')).body.items.length, 1);
    assert.equal((await app.admin('DELETE', `/discounts/${created.body.id}`)).status, 200);
    assert.equal((await app.staff('GET', `/discounts/${created.body.id}`)).status, 404);
  } finally { await app.stop(); db.close(); }
});

test('staff attach discounts to subscriptions; used discounts cannot be deleted', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    const id = (await app.admin('POST', '/discounts', { name: '10% off', type: 'percentage', value: 1000 })).body.id;
    const expired = (await app.admin('POST', '/discounts', { name: 'Old', type: 'fixed', value: 100, end_date: '2020-01-01' })).body.id;
    const added = await app.staff('POST', '/subscriptions/1/discounts', { discount_id: id });
    assert.deepEqual([added.status, added.body.items.map(d => d.name)], [201, ['10% off']]);
    assert.equal((await app.staff('POST', '/subscriptions/1/discounts', { discount_id: id })).status, 409, 'already attached');
    assert.equal((await app.staff('POST', '/subscriptions/1/discounts', { discount_id: expired })).status, 409, 'expired');
    assert.equal((await app.alice('POST', '/subscriptions/1/discounts', { discount_id: id })).status, 403);
    assert.equal((await app.alice('GET', '/subscriptions/1/discounts')).body.items.length, 1);
    assert.equal((await app.bob('GET', '/subscriptions/1/discounts')).status, 404);

    runBilling(db, '2026-01-31');
    const invoice = (await app.staff('GET', '/invoices/1')).body;
    assert.deepEqual(invoice.discounts.map(d => [d.name, d.amount]), [['10% off', 51800]]);
    assert.equal((await app.admin('DELETE', `/discounts/${id}`)).status, 409, 'used on an invoice');
    await app.staff('POST', '/invoices/1/actions/cancel');
    assert.equal((await app.staff('GET', `/discounts/${id}`)).body.usage_count, 0, 'cancelling gives the use back');

    assert.deepEqual((await app.staff('DELETE', `/subscriptions/1/discounts/${id}`)).body.items, []);
    assert.equal((await app.staff('DELETE', `/subscriptions/1/discounts/${id}`)).status, 404);
  } finally { await app.stop(); db.close(); }
});
