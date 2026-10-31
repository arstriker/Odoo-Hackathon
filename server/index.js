import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, projectRoot } from './database.js';
import { developmentUser } from './access.js';
import { HttpError, readJson } from './http.js';
import { routes as catalogRoutes } from './catalog.js';
import { closeExpiredSubscriptions, routes as subscriptionRoutes } from './subscriptions.js';
import { runBilling, routes as billingRoutes } from './billing.js';
import { routes as paymentRoutes } from './payments.js';
import { routes as discountRoutes } from './discounts.js';
import { routes as financeRoutes } from './finance.js';

const collections = {
  customers: "SELECT id,name,email,created_at FROM users WHERE role = 'customer' ORDER BY id DESC LIMIT 100",
  products: 'SELECT id,name,type,sales_price,cost_price,active FROM products ORDER BY id DESC LIMIT 100',
  plans: 'SELECT id,name,price,interval,minimum_quantity FROM plans ORDER BY id DESC LIMIT 100',
  subscriptions: 'SELECT s.id,s.number,u.name AS customer,p.name AS plan,s.status,s.next_billing_date FROM subscriptions s JOIN users u ON u.id=s.customer_id JOIN plans p ON p.id=s.plan_id ORDER BY s.id DESC LIMIT 100',
  invoices: 'SELECT id,number,customer_name,status,due_date,total FROM invoices ORDER BY id DESC LIMIT 100',
  payments: 'SELECT p.id,i.number AS invoice,p.method,p.amount,p.payment_date FROM payments p JOIN invoices i ON i.id=p.invoice_id ORDER BY p.id DESC LIMIT 100',
  discounts: 'SELECT id,name,type,value,start_date,end_date,usage_count,usage_limit FROM discounts ORDER BY id DESC LIMIT 100',
  settings: 'SELECT id,name,rate_basis_points,active FROM tax_rules ORDER BY id DESC LIMIT 100',
};
const assets = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/manage.js': 'manage.js',
  '/subscriptions.js': 'subscriptions.js',
  '/invoices.js': 'invoices.js',
  '/payments.js': 'payments.js',
  '/discounts.js': 'discounts.js',
  '/finance.js': 'finance.js',
  '/styles.css': 'styles.css',
};
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Route patterns such as '/api/products/:id' compiled to regular expressions with named groups.
const compile = list => list.map(([method, pattern, handler]) => ({
  method,
  handler,
  regex: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
}));
const apiRoutes = compile([...catalogRoutes, ...subscriptionRoutes, ...billingRoutes, ...paymentRoutes, ...discountRoutes, ...financeRoutes]);

export function createApp(db, { authenticate = () => developmentUser } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const matches = apiRoutes.map(route => ({ route, match: route.regex.exec(path) })).filter(entry => entry.match);
      const found = matches.find(entry => entry.route.method === req.method);
      if (found) {
        let parsed;
        const body = async () => (parsed ??= await readJson(req));
        const user = await authenticate(req, db);
        const result = await found.route.handler({ db, req, user, body, params: found.match.groups ?? {}, query: url.searchParams });
        return result && Number.isInteger(result.status) && Object.hasOwn(result, 'data') ? json(result.status, result.data) : json(200, result);
      }
      // Paths with write routes but no GET route (such as /api/customers) still fall back to the read-only collections below.
      if (req.method !== 'GET') return json(405, { error: 'This method is not supported for this endpoint.' });
      if (path === '/api/health') return json(200, { status: 'ok', database: db.prepare('SELECT 1 AS connected').get().connected === 1 ? 'connected' : 'unavailable', schemaVersion: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version });
      if (path === '/api/overview') {
        const counts = {};
        for (const table of ['products','plans','subscriptions','invoices','payments','discounts']) counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
        counts.customers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='customer'").get().count;
        return json(200, { counts, stage: 7, currency: 'INR' });
      }
      if (path.startsWith('/api/')) {
        const query = collections[path.slice(5)];
        return query ? json(200, { items: db.prepare(query).all(), limit: 100 }) : json(404, { error: 'Endpoint not found' });
      }
      if (!Object.hasOwn(assets, path)) return json(404, { error: 'Not found' });
      const file = assets[path];
      const body = await readFile(resolve(projectRoot, 'public', file));
      res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (/constraint failed/.test(error?.message ?? '')) return json(409, { error: 'The change conflicts with existing data.' });
      console.error(error);
      if (!res.headersSent) json(500, { error: 'Unable to complete request' });
      else res.end();
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDatabase();
  const server = createApp(db);
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  // At start-up and every hour: close expired subscriptions on auto-close plans, then invoice due ones.
  const closeExpired = () => { try { const closed = closeExpiredSubscriptions(db); if (closed) console.log(`Closed ${closed} expired subscription(s).`); } catch (error) { console.error(error); } };
  const bill = () => { try { const { invoices } = runBilling(db); if (invoices.length) console.log(`Created ${invoices.length} invoice(s).`); } catch (error) { console.error(error); } };
  const scheduled = () => { closeExpired(); bill(); };
  scheduled();
  const timer = setInterval(scheduled, 60 * 60 * 1000);
  timer.unref();
  server.listen(port, host, () => console.log(`Brightloop running at http://${host}:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); });
}
