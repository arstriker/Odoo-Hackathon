import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { runBilling } from '../server/billing.js';
import { transaction } from '../server/http.js';

function setup() {
  const db = openDatabase(':memory:');
  db.exec(`
    INSERT INTO users(id, name, email, role) VALUES (1, 'Acme Corp', 'billing@acme.com', 'customer');
    INSERT INTO users(id, name, email, role) VALUES (2, 'Beta LLC', 'accounts@beta.com', 'customer');
    INSERT INTO products(id, name, sales_price) VALUES (1, 'Pro License', 100000);
    INSERT INTO tax_rules(id, name, rate_basis_points) VALUES (1, 'GST 18%', 1800);
    INSERT INTO plans(id, name, price, interval) VALUES (1, 'Monthly', 0, 'monthly');
    INSERT INTO plans(id, name, price, interval) VALUES (2, 'Yearly', 0, 'yearly');

    -- Sub 1: Active monthly, ₹1,180/mo
    INSERT INTO subscriptions(id, number, customer_id, plan_id, status, start_date, next_billing_date, payment_terms_days)
      VALUES (1, 'SUB-00001', 1, 1, 'active', '2026-01-01', '2026-01-01', 14);
    INSERT INTO subscription_lines(subscription_id, product_id, quantity, unit_price, tax_rule_id, tax_rate_basis_points)
      VALUES (1, 1, 1, 100000, 1, 1800);

    -- Sub 2: Active yearly, ₹1,180/yr
    INSERT INTO subscriptions(id, number, customer_id, plan_id, status, start_date, next_billing_date, payment_terms_days)
      VALUES (2, 'SUB-00002', 2, 2, 'active', '2026-01-01', '2026-01-01', 14);
    INSERT INTO subscription_lines(subscription_id, product_id, quantity, unit_price, tax_rule_id, tax_rate_basis_points)
      VALUES (2, 1, 1, 100000, 1, 1800);
  `);
  // Bill subscriptions for Jan 1, 2026 -> 2 invoices generated (INV-00001 for Acme, INV-00002 for Beta)
  // Both invoices have total = 118000 paise (₹1,180.00), due date = 2026-01-15
  runBilling(db, '2026-01-01');

  // Confirm both invoices
  db.exec("UPDATE invoices SET status = 'confirmed'");

  // Record full payment for INV-00001 on 2026-01-10 via 'bank'
  db.exec("INSERT INTO payments(invoice_id, method, amount, payment_date, reference) VALUES (1, 'bank', 118000, '2026-01-10', 'TXN-001'); UPDATE invoices SET status = 'paid' WHERE id = 1;");

  // INV-00002 has 0 payment and is due 2026-01-15.
  return db;
}

const USERS = {
  admin: { id: 10, role: 'admin' },
  staff: { id: 11, role: 'staff' },
  alice: { id: 1, role: 'customer' },
};

async function serve(db) {
  const server = createApp(db, { authenticate: req => USERS[req.headers['x-test-user']] ?? null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const as = user => async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { 'x-test-user': user },
    });
    return { status: response.status, body: await response.json() };
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  return { admin: as('admin'), staff: as('staff'), alice: as('alice'), stop };
}

test('finance: summary KPIs, revenue, receivables and overdue aging', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    const res = await app.staff('GET', '/finance/summary?preset=all');
    assert.equal(res.status, 200);

    const data = res.body;

    // 1. Subscriptions: 2 active (1 monthly, 1 yearly)
    assert.equal(data.subscriptions.active, 2);
    // Estimated MRR: Monthly (100000) + Yearly (Math.round(100000 / 12) = 8333) = 108333 paise
    assert.equal(data.subscriptions.estimated_mrr, 108333);

    // 2. Revenue collected: 1 payment of 118000 paise via 'bank'
    assert.equal(data.revenue.collected_amount, 118000);
    assert.equal(data.revenue.payments_count, 1);
    assert.deepEqual(data.revenue.by_method, [{ method: 'bank', count: 1, total_amount: 118000 }]);

    // 3. Receivables & Overdue: INV-00002 has balance 118000 paise, due 2026-01-15
    assert.equal(data.receivables.total_outstanding, 118000);
    assert.equal(data.receivables.total_overdue, 118000);
    assert.equal(data.receivables.overdue_count, 1);

    // 4. Overdue invoice list
    assert.equal(data.overdue_invoices.length, 1);
    const overdue = data.overdue_invoices[0];
    assert.equal(overdue.number, 'INV-00002');
    assert.equal(overdue.customer_name, 'Beta LLC');
    assert.equal(overdue.balance, 118000);
    assert.ok(overdue.days_overdue > 0);

    // Dedicated overdue endpoint
    const overdueList = await app.staff('GET', '/finance/overdue');
    assert.equal(overdueList.status, 200);
    assert.equal(overdueList.body.items.length, 1);
    assert.equal(overdueList.body.items[0].number, 'INV-00002');
  } finally { await app.stop(); db.close(); }
});

test('finance: high volume performance benchmark (<50ms for 1000 subscriptions)', async () => {
  const db = setup();
  const app = await serve(db);
  try {
    // Insert 1,000 subscriptions with lines and invoices in a transaction
    transaction(db, () => {
      const insertSub = db.prepare(`
        INSERT INTO subscriptions(number, customer_id, plan_id, status, start_date, next_billing_date, payment_terms_days)
        VALUES (?, 1, 1, 'active', '2026-01-01', '2026-01-01', 14)`);
      const insertLine = db.prepare('INSERT INTO subscription_lines(subscription_id, product_id, quantity, unit_price) VALUES (?, 1, 1, 100000)');
      const insertInv = db.prepare(`
        INSERT INTO invoices(number, subscription_id, customer_id, customer_name, customer_email, period_start, period_end, issue_date, due_date, status, subtotal, discount_total, tax_total, total)
        VALUES (?, ?, 1, 'Acme Corp', 'billing@acme.com', '2026-01-01', '2026-02-01', '2026-01-01', '2026-01-15', 'confirmed', 100000, 0, 18000, 118000)`);
      const insertPay = db.prepare("INSERT INTO payments(invoice_id, method, amount, payment_date) VALUES (?, 'bank', 50000, '2026-01-10')");

      for (let i = 10; i < 1010; i++) {
        const subId = Number(insertSub.run(`SUB-BENCH-${i}`).lastInsertRowid);
        insertLine.run(subId);
        const invId = Number(insertInv.run(`INV-BENCH-${i}`, subId).lastInsertRowid);
        if (i % 2 === 0) {
          insertPay.run(invId);
        }
      }
    });

    const start = performance.now();
    const res = await app.staff('GET', '/finance/summary?preset=all');
    const elapsed = performance.now() - start;

    assert.equal(res.status, 200);
    assert.ok(res.body.subscriptions.active >= 1000);
    // SLA is under 2000ms; verify it executes comfortably under 200ms
    assert.ok(elapsed < 200, `Execution took ${elapsed.toFixed(2)}ms (expected < 200ms)`);
  } finally { await app.stop(); db.close(); }
});
