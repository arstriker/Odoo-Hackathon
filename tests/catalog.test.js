import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { addInterval } from '../server/http.js';

async function startApp(options) {
  const db = openDatabase(':memory:');
  const server = createApp(db, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const stop = () => new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  return { db, call, stop };
}

test('admin configures a product with a variant and a usable monthly plan', async () => {
  const { call, stop } = await startApp();
  try {
    const product = await call('POST', '/products', {
      name: 'Brightloop CRM', type: 'software', sales_price: 120000, cost_price: 40000, notes: 'Core CRM',
      variants: [{ attribute: 'Brand', value: 'Odoo', price_adjustment: 56000 }],
    });
    assert.equal(product.status, 201);
    assert.equal(product.body.variants[0].price_adjustment, 56000);

    assert.equal((await call('POST', `/products/${product.body.id}/variants`, { attribute: 'Brand', value: 'Odoo' })).status, 409);
    const withVariant = await call('POST', `/products/${product.body.id}/variants`, { attribute: 'Brand', value: 'Generic', price_adjustment: -1000 });
    assert.equal(withVariant.body.variants.length, 2);

    const edited = await call('PATCH', `/products/${product.body.id}`, { sales_price: 150000, notes: '' });
    assert.equal(edited.body.sales_price, 150000);
    assert.equal(edited.body.notes, '');

    const tax = await call('POST', '/tax-rules', { name: 'GST 18%', rate_basis_points: 1800 });
    assert.equal(tax.status, 201);
    assert.equal((await call('POST', '/tax-rules', { name: 'Too much', rate_basis_points: 10001 })).status, 400);

    const plan = await call('POST', '/plans', {
      name: 'Business monthly', price: 99900, interval: 'monthly', minimum_quantity: 2,
      available_from: '2026-01-01', available_until: '2026-12-31', auto_close: true, allow_pause: false,
    });
    assert.equal(plan.status, 201);
    assert.deepEqual(
      [plan.body.interval, plan.body.minimum_quantity, plan.body.auto_close, plan.body.allow_close, plan.body.allow_pause, plan.body.allow_renew],
      ['monthly', 2, 1, 1, 0, 1],
    );
    const plans = await call('GET', '/plans');
    assert.equal(plans.body.items[0].active_subscriptions, 0);
  } finally { await stop(); }
});

test('catalogue validation rejects bad input', async () => {
  const { call, stop } = await startApp();
  try {
    assert.equal((await call('POST', '/products', { sales_price: 100 })).status, 400);
    assert.equal((await call('POST', '/products', { name: 'X', sales_price: -1 })).status, 400);
    assert.equal((await call('POST', '/products', { name: 'X', sales_price: 1.5 })).status, 400);
    assert.equal((await call('POST', '/plans', { name: 'P', price: 100, interval: 'hourly' })).status, 400);
    assert.equal((await call('POST', '/plans', { name: 'P', price: 100, interval: 'daily', minimum_quantity: 0 })).status, 400);
    assert.equal((await call('POST', '/plans', { name: 'P', price: 100, interval: 'daily', available_from: '2026-02-30' })).status, 400);
    assert.equal((await call('POST', '/plans', { name: 'P', price: 100, interval: 'daily', available_from: '2026-05-01', available_until: '2026-04-01' })).status, 400);
    const plan = await call('POST', '/plans', { name: 'P', price: 100, interval: 'weekly', available_from: '2026-05-01' });
    assert.equal((await call('PATCH', `/plans/${plan.body.id}`, { available_until: '2026-04-01' })).status, 400);
    assert.equal((await call('GET', '/products/999')).status, 404);
    assert.equal((await call('PUT', '/products/1', {})).status, 405);
  } finally { await stop(); }
});

test('products in use are archived instead of deleted; unused ones are removed', async () => {
  const { db, call, stop } = await startApp();
  try {
    const unused = await call('POST', '/products', { name: 'Unused', sales_price: 100 });
    assert.deepEqual((await call('DELETE', `/products/${unused.body.id}`)).body, { deleted: true });

    const used = await call('POST', '/products', { name: 'Used', sales_price: 100 });
    const plan = await call('POST', '/plans', { name: 'Monthly', price: 100, interval: 'monthly' });
    db.exec(`INSERT INTO quotation_templates(id, name, plan_id) VALUES (1, 'T', ${plan.body.id})`);
    db.exec(`INSERT INTO quotation_template_lines(template_id, product_id, quantity, unit_price) VALUES (1, ${used.body.id}, 1, 100)`);
    const archived = await call('DELETE', `/products/${used.body.id}`);
    assert.equal(archived.body.archived, true);
    assert.equal(archived.body.product.active, 0);
    assert.equal((await call('DELETE', `/plans/${plan.body.id}`)).status, 409);
  } finally { await stop(); }
});

test('only admins can change the catalogue', async () => {
  const { call, stop } = await startApp({ authenticate: () => ({ id: 2, role: 'staff' }) });
  try {
    assert.equal((await call('POST', '/products', { name: 'X', sales_price: 1 })).status, 403);
    assert.equal((await call('POST', '/plans', { name: 'P', price: 1, interval: 'monthly' })).status, 403);
    assert.equal((await call('POST', '/tax-rules', { name: 'T', rate_basis_points: 1 })).status, 403);
    assert.equal((await call('GET', '/products')).status, 200);
    assert.equal((await call('GET', '/tax-rules')).status, 200);
  } finally { await stop(); }
  const anonymous = await startApp({ authenticate: () => null });
  try {
    assert.equal((await anonymous.call('POST', '/products', { name: 'X', sales_price: 1 })).status, 401);
  } finally { await anonymous.stop(); }
});

test('billing intervals clamp to month ends', () => {
  assert.equal(addInterval('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addInterval('2028-01-31', 'monthly'), '2028-02-29');
  assert.equal(addInterval('2028-02-29', 'yearly'), '2029-02-28');
  assert.equal(addInterval('2026-12-30', 'weekly'), '2027-01-06');
  assert.equal(addInterval('2026-12-31', 'daily'), '2027-01-01');
});

test('a variant cannot make the product price negative', async () => {
  const { call, stop } = await startApp();
  try {
    assert.equal((await call('POST', '/products', { name: 'Cheap', sales_price: 10000, variants: [{ attribute: 'A', value: 'B', price_adjustment: -20000 }] })).status, 400);
    assert.equal((await call('GET', '/products')).body.items.length, 0, 'the rejected product is rolled back');
    const product = (await call('POST', '/products', { name: 'Cheap', sales_price: 10000 })).body;
    assert.equal((await call('POST', `/products/${product.id}/variants`, { attribute: 'A', value: 'B', price_adjustment: -20000 })).status, 400);
    const ok = (await call('POST', `/products/${product.id}/variants`, { attribute: 'A', value: 'B', price_adjustment: -10000 })).body;
    assert.equal(ok.variants.length, 1);
    assert.equal((await call('PATCH', `/variants/${ok.variants[0].id}`, { price_adjustment: -10001 })).status, 400);
    assert.equal((await call('PATCH', `/products/${product.id}`, { sales_price: 5000 })).status, 400);
    assert.equal((await call('PATCH', `/products/${product.id}`, { sales_price: 10000 })).status, 200);
  } finally { await stop(); }
});
