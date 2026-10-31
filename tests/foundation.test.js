import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { latestSchemaVersion } from '../server/migrations.js';

test('schema persists, reopens safely and enforces financial constraints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brightloop-'));
  const path = join(directory, 'test.sqlite');
  let db;
  try {
    db = openDatabase(path);
    db.exec("INSERT INTO users(id,name,email,role) VALUES(1,'Customer','person@example.com','customer')");
    assert.throws(() => db.exec("INSERT INTO users(name,email,role) VALUES('Duplicate','PERSON@example.com','customer')"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO users(name,email,role) VALUES('Invalid','other@example.com','owner')"), /CHECK/);
    db.exec("INSERT INTO plans(id,name,price,interval) VALUES(1,'Monthly',10000,'monthly')");
    assert.throws(() => db.exec("INSERT INTO subscriptions(number,customer_id,plan_id,start_date) VALUES('BAD',999,1,'2026-10-01')"), /FOREIGN KEY/);
    db.exec("INSERT INTO subscriptions(id,number,customer_id,plan_id,start_date) VALUES(1,'SUB-001',1,1,'2026-10-01')");
    const invoice = db.prepare("INSERT INTO invoices(number,subscription_id,customer_id,customer_name,customer_email,period_start,period_end,issue_date,due_date,subtotal,total) VALUES(?,1,1,'Customer','person@example.com','2026-10-01','2026-11-01','2026-10-01','2026-10-15',10000,10000)");
    invoice.run('INV-001');
    assert.throws(() => invoice.run('INV-002'), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE invoices SET total=1 WHERE id=1'), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO payments(invoice_id,method,amount,payment_date) VALUES(1,'bank',-10,'2026-10-02')"), /CHECK/);
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count, 1);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, latestSchemaVersion);
  } finally { db?.close(); rmSync(directory, {recursive:true,force:true}); }
});

test('HTTP serves UI and database-backed read-only collections', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users(name,email,role) VALUES(?,?,?)").run('Real Customer','customer@example.com','customer');
  const server = createApp(db);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then(r=>r.json());
    assert.equal(health.database,'connected');
    const overview = await fetch(`${base}/api/overview`).then(r=>r.json());
    assert.equal(overview.counts.customers,1);
    assert.equal(overview.counts.subscriptions,0);
    const customers = await fetch(`${base}/api/customers`).then(r=>r.json());
    assert.equal(customers.items[0].name,'Real Customer');
    assert.equal(Object.hasOwn(customers.items[0],'password_hash'),false);
    for (const endpoint of ['products','plans','subscriptions','invoices','payments','discounts','settings']) {
      const response = await fetch(`${base}/api/${endpoint}`);
      assert.equal(response.status,200);
      assert.deepEqual((await response.json()).items,[]);
    }
    for (const path of ['/','/app.js','/styles.css']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status,200);
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await fetch(`${base}/api/missing`)).status,404);
    assert.equal((await fetch(`${base}/package.json`)).status,404);
    assert.equal((await fetch(`${base}/api/customers`,{method:'DELETE'})).status,405);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
