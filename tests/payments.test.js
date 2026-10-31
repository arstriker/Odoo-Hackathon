import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { runBilling } from '../server/billing.js';

// Alice (id 1) has one monthly subscription billed ₹5,522.40 per period (3 × ₹1,560 + 18% GST).
const USERS = { admin: { id: 2, role: 'admin' }, staff: { id: 3, role: 'staff' }, alice: { id: 1, role: 'customer' }, bob: { id: 4, role: 'customer' } };
const TOTAL = 552240;

async function startApp() {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO users(id, name, email, role) VALUES (1, 'Alice', 'alice@example.com', 'customer');
    INSERT INTO products(id, name, sales_price) VALUES (1, 'CRM', 156000);
    INSERT INTO plans(id, name, price, interval) VALUES (1, 'Plan', 0, 'monthly');
    INSERT INTO subscriptions(id, number, customer_id, plan_id, status, start_date, next_billing_date, payment_terms_days)
      VALUES (1, 'SUB-00001', 1, 1, 'active', '2026-01-31', '2026-01-31', 14);
    INSERT INTO subscription_lines(subscription_id, product_id, quantity, unit_price, tax_rate_basis_points) VALUES (1, 1, 3, 156000, 1800);`);
  runBilling(db, '2026-02-28'); // INV-00001 (January) and INV-00002 (February), both drafts
  const server = createApp(db, { authenticate: req => USERS[req.headers['x-test-user']] ?? null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const as = user => async (method, path, body) => {
    const headers = { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const stop = () => new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  return { db, admin: as('admin'), staff: as('staff'), alice: as('alice'), bob: as('bob'), stop };
}

test('partial payments reduce the balance and the last one marks the invoice paid', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.staff('POST', '/invoices/1/payments', { method: 'upi', amount: 100000 })).status, 409, 'drafts cannot take payments');
    await app.staff('POST', '/invoices/1/actions/confirm');
    assert.equal((await app.staff('GET', '/invoices/1')).body.can_record_payment, true);

    const first = await app.staff('POST', '/invoices/1/payments', { method: 'upi', amount: 200000, payment_date: '2026-02-05', reference: 'UPI-1' });
    assert.equal(first.status, 201);
    assert.deepEqual([first.body.status, first.body.amount_paid, first.body.balance, first.body.actions], ['confirmed', 200000, TOTAL - 200000, []]);

    const tooMuch = await app.staff('POST', '/invoices/1/payments', { method: 'cash', amount: TOTAL });
    assert.equal(tooMuch.status, 409, 'overpayment is rejected');
    assert.match(tooMuch.body.error, /3522\.40/);
    assert.equal((await app.staff('POST', '/invoices/1/payments', { method: 'upi', amount: 1, reference: 'UPI-1' })).status, 409, 'duplicate reference');

    const last = await app.staff('POST', '/invoices/1/payments', { method: 'bank_transfer', amount: TOTAL - 200000 });
    assert.deepEqual([last.body.status, last.body.balance, last.body.can_record_payment, last.body.payments.length], ['paid', 0, false, 2]);
    assert.equal((await app.staff('POST', '/invoices/1/payments', { method: 'cash', amount: 1 })).status, 409, 'paid invoices take no more payments');
  } finally { await app.stop(); }
});

test('payment input is validated', async () => {
  const app = await startApp();
  try {
    await app.staff('POST', '/invoices/1/actions/confirm');
    for (const body of [{ amount: 100 }, { method: 'bitcoin', amount: 100 }, { method: 'upi' }, { method: 'upi', amount: 0 }, { method: 'upi', amount: 1.5 },
      { method: 'upi', amount: 100, payment_date: '2026-02-30' }, { method: 'upi', amount: 100, payment_date: '2999-01-01' }]) {
      assert.equal((await app.staff('POST', '/invoices/1/payments', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.staff('POST', '/invoices/99/payments', { method: 'upi', amount: 100 })).status, 404);
    await app.staff('POST', '/invoices/2/actions/cancel');
    assert.equal((await app.staff('POST', '/invoices/2/payments', { method: 'upi', amount: 100 })).status, 409, 'cancelled invoices take no payments');
  } finally { await app.stop(); }
});

test('removing a payment reopens a paid invoice; only admins can remove payments', async () => {
  const app = await startApp();
  try {
    await app.staff('POST', '/invoices/1/actions/confirm');
    await app.staff('POST', '/invoices/1/payments', { method: 'card', amount: TOTAL });
    const [payment] = (await app.staff('GET', '/payments')).body.items;
    assert.equal((await app.staff('DELETE', `/payments/${payment.id}`)).status, 403);
    assert.equal((await app.admin('DELETE', `/payments/${payment.id}`)).status, 200);
    const invoice = (await app.staff('GET', '/invoices/1')).body;
    assert.deepEqual([invoice.status, invoice.balance], ['confirmed', TOTAL]);
    assert.equal((await app.admin('DELETE', `/payments/${payment.id}`)).status, 404);
  } finally { await app.stop(); }
});

test('payments list totals, and customers see only their own payments and cannot record any', async () => {
  const app = await startApp();
  try {
    await app.staff('POST', '/invoices/1/actions/confirm');
    await app.staff('POST', '/invoices/1/payments', { method: 'upi', amount: 100000, reference: 'UPI-9' });
    const list = (await app.staff('GET', '/payments')).body;
    assert.deepEqual(list.items.map(p => [p.invoice, p.customer_name, p.method, p.amount]), [['INV-00001', 'Alice', 'upi', 100000]]);
    assert.deepEqual(list.totals, { count: 1, amount: 100000 });
    assert.equal((await app.staff('GET', '/payments?q=UPI-9')).body.items.length, 1);
    assert.equal((await app.staff('GET', '/payments?invoice_id=2')).body.items.length, 0);

    assert.equal((await app.alice('GET', '/payments')).body.items.length, 1);
    assert.equal((await app.bob('GET', '/payments')).body.items.length, 0);
    assert.equal((await app.alice('POST', '/invoices/1/payments', { method: 'upi', amount: 100 })).status, 403);
    assert.equal((await app.alice('GET', '/invoices/1')).body.can_record_payment, false);
  } finally { await app.stop(); }
});

test('confirming a ₹0 invoice settles it straight away', async () => {
  const app = await startApp();
  try {
    app.db.exec('UPDATE invoices SET subtotal = 0, tax_total = 0, total = 0 WHERE id = 2');
    assert.equal((await app.staff('POST', '/invoices/2/actions/confirm')).body.status, 'paid');
  } finally { await app.stop(); }
});
