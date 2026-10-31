import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { closeExpiredSubscriptions } from '../server/subscriptions.js';
import { addDays, today } from '../server/http.js';

// Test identities: the x-test-user header picks who is signed in.
const USERS = { admin: { id: 1, role: 'admin' }, staff: { id: 2, role: 'staff' }, alice: { id: 3, role: 'customer' }, bob: { id: 4, role: 'customer' } };

async function startApp() {
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO users(id, name, email, role) VALUES
    (1, 'Admin', 'admin@example.com', 'admin'), (2, 'Sam Staff', 'staff@example.com', 'staff'),
    (3, 'Alice', 'alice@example.com', 'customer'), (4, 'Bob', 'bob@example.com', 'customer')`);
  const server = createApp(db, { authenticate: req => USERS[req.headers['x-test-user']] ?? null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = user => async (method, path, body) => {
    const headers = { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const stop = () => new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  return { db, admin: as('admin'), staff: as('staff'), alice: as('alice'), bob: as('bob'), anonymous: as('nobody'), stop };
}

async function catalogue(admin, planOverrides = {}) {
  const product = (await admin('POST', '/products', { name: 'CRM', sales_price: 100000, variants: [{ attribute: 'Brand', value: 'Odoo', price_adjustment: 56000 }] })).body;
  const tax = (await admin('POST', '/tax-rules', { name: 'GST 18%', rate_basis_points: 1800 })).body;
  const plan = (await admin('POST', '/plans', { name: 'Monthly', price: 99900, interval: 'monthly', minimum_quantity: 2, ...planOverrides })).body;
  return { product, variant: product.variants[0], tax, plan };
}

test('staff turns a quotation from a template into an active subscription', async () => {
  const app = await startApp();
  try {
    const { product, variant, tax, plan } = await catalogue(app.admin);
    const template = await app.staff('POST', '/quotation-templates', {
      name: 'Standard offer', plan_id: plan.id, validity_days: 15, payment_terms_days: 30,
      lines: [{ product_id: product.id, variant_id: variant.id, quantity: 3, tax_rule_id: tax.id }],
    });
    assert.equal(template.status, 201);
    assert.equal(template.body.lines[0].unit_price, 156000); // 1000 + 560 brand adjustment
    assert.equal(template.body.totals.total, 3 * 156000 + Math.round(3 * 156000 * 0.18));

    const created = await app.staff('POST', '/subscriptions', { customer_id: 3, template_id: template.body.id, start_date: today(), expiry_date: addDays(today(), 365) });
    assert.equal(created.status, 201);
    const sub = created.body;
    assert.match(sub.number, /^SUB-\d{5}$/);
    assert.deepEqual([sub.status, sub.plan_id, sub.payment_terms_days, sub.valid_until], ['draft', plan.id, 30, addDays(today(), 15)]);
    assert.equal(sub.lines.length, 1);
    assert.deepEqual(sub.allowed_actions, ['send', 'confirm', 'close']);

    assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/activate`)).status, 409);
    for (const [action, expected] of [['send', 'quotation'], ['confirm', 'confirmed'], ['activate', 'active']]) {
      const result = await app.staff('POST', `/subscriptions/${sub.id}/actions/${action}`);
      assert.equal(result.status, 200, `${action}: ${result.body.error}`);
      assert.equal(result.body.status, expected);
    }
    const active = (await app.staff('GET', `/subscriptions/${sub.id}`)).body;
    assert.equal(active.next_billing_date, today());
    assert.deepEqual(active.events.map(event => event.to_status), ['draft', 'quotation', 'confirmed', 'active']);
    assert.equal(active.events[1].user_name, 'Sam Staff');

    // Lines are locked once confirmed.
    assert.equal((await app.staff('PATCH', `/subscriptions/${sub.id}`, { notes: 'late change' })).status, 409);
    assert.equal((await app.staff('DELETE', `/subscriptions/${sub.id}`)).status, 409);

    const second = await app.staff('POST', '/subscriptions', { customer_id: 4, plan_id: plan.id, lines: [{ product_id: product.id, quantity: 2 }] });
    assert.notEqual(second.body.number, sub.number);
    assert.equal(second.body.lines[0].unit_price, 100000);

    const list = await app.staff('GET', '/subscriptions?status=active');
    assert.deepEqual(list.body.items.map(item => item.number), [sub.number]);
    assert.equal(list.body.counts.active, 1);
    assert.equal(list.body.counts.draft, 1);
  } finally { await app.stop(); }
});

test('pause, resume, renewal and closing follow the plan settings', async () => {
  const app = await startApp();
  try {
    const { product, plan } = await catalogue(app.admin, { allow_pause: true, allow_renew: true, allow_close: false });
    const start = '2027-01-31';
    const sub = (await app.staff('POST', '/subscriptions', { customer_id: 3, plan_id: plan.id, start_date: start, expiry_date: '2027-04-30', lines: [{ product_id: product.id, quantity: 2 }] })).body;
    for (const action of ['confirm', 'activate']) assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/${action}`)).status, 200);

    assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/pause`)).body.status, 'paused');
    assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/resume`)).body.status, 'active');

    // Term was three months (31 Jan → 30 Apr), so renewal extends by three more months.
    const renewed = await app.staff('POST', `/subscriptions/${sub.id}/actions/renew`);
    assert.equal(renewed.body.expiry_date, '2027-07-30');
    assert.equal(renewed.body.status, 'active');

    const close = await app.staff('POST', `/subscriptions/${sub.id}/actions/close`);
    assert.equal(close.status, 409);
    assert.match(close.body.error, /does not allow/);

    await app.admin('PATCH', `/plans/${plan.id}`, { allow_pause: false, allow_close: true });
    assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/pause`)).status, 409);
    const closed = await app.staff('POST', `/subscriptions/${sub.id}/actions/close`);
    assert.equal(closed.body.status, 'closed');
    assert.equal(closed.body.next_billing_date, null);
    assert.deepEqual(closed.body.allowed_actions, []);
    assert.equal((await app.staff('POST', `/subscriptions/${sub.id}/actions/activate`)).status, 409);
  } finally { await app.stop(); }
});

test('plans that close automatically end expired subscriptions', async () => {
  const app = await startApp();
  try {
    const { product, plan } = await catalogue(app.admin, { auto_close: true });
    const manual = (await app.admin('POST', '/plans', { name: 'Manual', price: 1000, interval: 'monthly' })).body;
    const make = async planId => {
      const sub = (await app.staff('POST', '/subscriptions', { customer_id: 3, plan_id: planId, start_date: '2026-01-01', expiry_date: '2026-03-31', lines: [{ product_id: product.id, quantity: 2 }] })).body;
      app.db.prepare("UPDATE subscriptions SET status = 'active' WHERE id = ?").run(sub.id);
      return sub.id;
    };
    const autoId = await make(plan.id);
    const manualId = await make(manual.id);
    assert.equal(closeExpiredSubscriptions(app.db, '2026-03-31'), 0);
    assert.equal(closeExpiredSubscriptions(app.db, '2026-04-01'), 1);
    const auto = (await app.staff('GET', `/subscriptions/${autoId}`)).body;
    assert.equal(auto.status, 'closed');
    assert.equal(auto.events.at(-1).action, 'auto_close');
    assert.equal((await app.staff('GET', `/subscriptions/${manualId}`)).body.status, 'active');
  } finally { await app.stop(); }
});

test('quotation rules: minimum quantity, availability, validity and variants', async () => {
  const app = await startApp();
  try {
    const { product, plan } = await catalogue(app.admin, { available_from: '2026-01-01', available_until: '2026-12-31' });
    const other = (await app.admin('POST', '/products', { name: 'Other', sales_price: 1, variants: [{ attribute: 'Size', value: 'L' }] })).body;
    const base = { customer_id: 3, plan_id: plan.id, start_date: '2026-06-01' };
    assert.match((await app.staff('POST', '/subscriptions', { ...base, lines: [{ product_id: product.id, quantity: 1 }] })).body.error, /minimum quantity of 2/);
    assert.match((await app.staff('POST', '/subscriptions', { ...base, start_date: '2027-01-01', lines: [] })).body.error, /not available/);
    assert.match((await app.staff('POST', '/subscriptions', { ...base, lines: [{ product_id: product.id, variant_id: other.variants[0].id, quantity: 2 }] })).body.error, /does not belong/);
    assert.match((await app.staff('POST', '/subscriptions', { ...base, customer_id: 2, lines: [] })).body.error, /Customer not found/);
    assert.equal((await app.staff('POST', '/subscriptions', { ...base, expiry_date: '2026-05-01', lines: [] })).status, 400);

    const empty = (await app.staff('POST', '/subscriptions', { ...base, lines: [] })).body;
    assert.match((await app.staff('POST', `/subscriptions/${empty.id}/actions/confirm`)).body.error, /at least one product line/);

    const expired = (await app.staff('POST', '/subscriptions', { ...base, valid_until: '2026-01-01', lines: [{ product_id: product.id, quantity: 2 }] })).body;
    assert.match((await app.staff('POST', `/subscriptions/${expired.id}/actions/confirm`)).body.error, /expired/);

    const edited = await app.staff('PATCH', `/subscriptions/${expired.id}`, { valid_until: null, lines: [{ product_id: product.id, quantity: 5, unit_price: 9000 }] });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.totals.subtotal, 45000);
    assert.equal((await app.staff('POST', `/subscriptions/${expired.id}/actions/confirm`)).body.status, 'confirmed');

    assert.deepEqual((await app.staff('DELETE', `/subscriptions/${empty.id}`)).body, { deleted: true });
  } finally { await app.stop(); }
});

test('customers see only their own subscriptions and cannot manage them', async () => {
  const app = await startApp();
  try {
    const { product, plan } = await catalogue(app.admin);
    const alices = (await app.staff('POST', '/subscriptions', { customer_id: 3, plan_id: plan.id, lines: [{ product_id: product.id, quantity: 2 }] })).body;
    await app.staff('POST', '/subscriptions', { customer_id: 4, plan_id: plan.id, lines: [{ product_id: product.id, quantity: 2 }] });

    const list = await app.alice('GET', '/subscriptions');
    assert.deepEqual(list.body.items.map(item => item.id), [alices.id]);
    assert.equal(list.body.counts.draft, 1);
    assert.equal((await app.alice('GET', `/subscriptions/${alices.id}`)).body.allowed_actions.length, 0);
    assert.equal((await app.bob('GET', `/subscriptions/${alices.id}`)).status, 404);
    assert.equal((await app.alice('POST', `/subscriptions/${alices.id}/actions/confirm`)).status, 403);
    assert.equal((await app.alice('POST', '/subscriptions', { customer_id: 3, plan_id: plan.id })).status, 403);
    assert.equal((await app.alice('GET', '/quotation-templates')).status, 403);
    assert.equal((await app.anonymous('GET', '/subscriptions')).status, 401);

    const customer = await app.staff('POST', '/customers', { name: 'New Co', email: 'New@Example.com' });
    assert.equal(customer.body.email, 'new@example.com');
    assert.equal((await app.staff('POST', '/customers', { name: 'Dup', email: 'NEW@example.com' })).status, 409);
    assert.equal((await app.alice('POST', '/customers', { name: 'X', email: 'x@example.com' })).status, 403);
  } finally { await app.stop(); }
});

test('templates in use cannot be deleted', async () => {
  const app = await startApp();
  try {
    const { product, plan } = await catalogue(app.admin);
    const template = (await app.staff('POST', '/quotation-templates', { name: 'T', plan_id: plan.id, lines: [{ product_id: product.id, quantity: 2 }] })).body;
    await app.staff('POST', '/subscriptions', { customer_id: 3, template_id: template.id });
    assert.equal((await app.staff('DELETE', `/quotation-templates/${template.id}`)).status, 409);
    const unused = (await app.staff('POST', '/quotation-templates', { name: 'U', plan_id: plan.id, lines: [] })).body;
    assert.equal((await app.staff('DELETE', `/quotation-templates/${unused.id}`)).status, 200);
  } finally { await app.stop(); }
});
