// Stage 3: product catalogue, variants, tax rules and recurring plans.
import { ADMIN, TEAM, requireRole } from './access.js';
import { HttpError, boolean, defined, integer, isoDate, oneOf, routeId, text, transaction, updateRow } from './http.js';

export const INTERVALS = ['daily', 'weekly', 'monthly', 'yearly'];
const MONEY_MAX = 1_000_000_000_00; // ₹1,000,000,000 in paise

function find(db, table, id, label) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, `${label} not found.`);
  return row;
}

const isReferenced = (db, checks, id) => checks.some(sql => db.prepare(sql).get(id));

// ---------- Products ----------
function productFields(body, creating) {
  return defined({
    name: text(body, 'name', { required: creating, max: 120 }),
    type: text(body, 'type', { max: 60 }),
    sales_price: integer(body, 'sales_price', { required: creating, min: 0, max: MONEY_MAX }),
    cost_price: integer(body, 'cost_price', { min: 0, max: MONEY_MAX }),
    notes: text(body, 'notes', { max: 2000, allowEmpty: true }),
    active: boolean(body, 'active'),
  });
}

export function getProduct(db, id) {
  const product = find(db, 'products', id, 'Product');
  product.variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY attribute, value').all(id);
  return product;
}

function listProducts(db, query) {
  const activeOnly = query.get('active') === '1';
  const items = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count
    FROM products p ${activeOnly ? 'WHERE p.active = 1' : ''} ORDER BY p.active DESC, p.name LIMIT 500`).all();
  const variants = db.prepare('SELECT * FROM product_variants ORDER BY attribute, value').all();
  for (const item of items) item.variants = variants.filter(variant => variant.product_id === item.id);
  return { items, limit: 500 };
}

function variantFields(body, creating) {
  return defined({
    attribute: text(body, 'attribute', { required: creating, max: 60 }),
    value: text(body, 'value', { required: creating, max: 60 }),
    price_adjustment: integer(body, 'price_adjustment', { min: -MONEY_MAX, max: MONEY_MAX }),
  });
}

// A variant may lower the price, but never below zero.
function checkVariantPrice(salesPrice, adjustment) {
  if (salesPrice + (adjustment ?? 0) < 0) throw new HttpError(400, 'The price adjustment cannot make the product price negative.');
}

function uniqueVariant(error) {
  if (/UNIQUE/.test(error.message)) throw new HttpError(409, 'This product already has a variant with that attribute and value.');
  throw error;
}

// ---------- Tax rules ----------
function taxFields(body, creating) {
  return defined({
    name: text(body, 'name', { required: creating, max: 80 }),
    rate_basis_points: integer(body, 'rate_basis_points', { required: creating, min: 0, max: 10000 }),
    active: boolean(body, 'active'),
  });
}

// ---------- Plans ----------
function planFields(body, creating) {
  return defined({
    name: text(body, 'name', { required: creating, max: 120 }),
    price: integer(body, 'price', { required: creating, min: 0, max: MONEY_MAX }),
    interval: oneOf(body, 'interval', INTERVALS, { required: creating }),
    minimum_quantity: integer(body, 'minimum_quantity', { min: 1, max: 1_000_000 }),
    available_from: isoDate(body, 'available_from'),
    available_until: isoDate(body, 'available_until'),
    auto_close: boolean(body, 'auto_close'),
    allow_close: boolean(body, 'allow_close'),
    allow_pause: boolean(body, 'allow_pause'),
    allow_renew: boolean(body, 'allow_renew'),
  });
}

function checkPlanDates(plan) {
  if (plan.available_from && plan.available_until && plan.available_until < plan.available_from) {
    throw new HttpError(400, 'available_until must be on or after available_from.');
  }
}

export function planAvailableOn(plan, date) {
  return (!plan.available_from || date >= plan.available_from) && (!plan.available_until || date <= plan.available_until);
}

export const routes = [
  ['GET', '/api/products', ({ db, query }) => listProducts(db, query)],
  ['GET', '/api/products/:id', ({ db, params }) => getProduct(db, routeId(params.id))],
  ['POST', '/api/products', async ({ db, user, body }) => {
    requireRole(user, ...ADMIN);
    const fields = productFields(await body(), true);
    const variants = Array.isArray((await body()).variants) ? (await body()).variants : [];
    return transaction(db, () => {
      const keys = Object.keys(fields);
      const id = Number(db.prepare(`INSERT INTO products(${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => fields[k])).lastInsertRowid);
      for (const variant of variants) {
        const values = variantFields(variant ?? {}, true);
        checkVariantPrice(fields.sales_price, values.price_adjustment);
        try {
          db.prepare('INSERT INTO product_variants(product_id, attribute, value, price_adjustment) VALUES (?, ?, ?, ?)')
            .run(id, values.attribute, values.value, values.price_adjustment ?? 0);
        } catch (error) { uniqueVariant(error); }
      }
      return { status: 201, data: getProduct(db, id) };
    });
  }],
  ['PATCH', '/api/products/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    find(db, 'products', id, 'Product');
    const fields = productFields(await body(), false);
    if (fields.sales_price !== undefined) {
      const lowest = db.prepare('SELECT MIN(price_adjustment) AS lowest FROM product_variants WHERE product_id = ?').get(id).lowest;
      checkVariantPrice(fields.sales_price, lowest);
    }
    updateRow(db, 'products', id, fields);
    return getProduct(db, id);
  }],
  ['DELETE', '/api/products/:id', ({ db, user, params }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    find(db, 'products', id, 'Product');
    const used = isReferenced(db, [
      'SELECT 1 FROM subscription_lines WHERE product_id = ? LIMIT 1',
      'SELECT 1 FROM quotation_template_lines WHERE product_id = ? LIMIT 1',
      'SELECT 1 FROM invoice_lines WHERE product_id = ? LIMIT 1',
      'SELECT 1 FROM discount_products WHERE product_id = ? LIMIT 1',
    ], id);
    // Products used in history are archived instead of deleted, so past subscriptions and invoices stay intact.
    if (used) {
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
      return { archived: true, product: getProduct(db, id) };
    }
    transaction(db, () => {
      db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(id);
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
    });
    return { deleted: true };
  }],

  ['POST', '/api/products/:id/variants', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const productId = routeId(params.id);
    const product = find(db, 'products', productId, 'Product');
    const values = variantFields(await body(), true);
    checkVariantPrice(product.sales_price, values.price_adjustment);
    try {
      db.prepare('INSERT INTO product_variants(product_id, attribute, value, price_adjustment) VALUES (?, ?, ?, ?)')
        .run(productId, values.attribute, values.value, values.price_adjustment ?? 0);
    } catch (error) { uniqueVariant(error); }
    return { status: 201, data: getProduct(db, productId) };
  }],
  ['PATCH', '/api/variants/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    const variant = find(db, 'product_variants', id, 'Variant');
    const values = variantFields(await body(), false);
    if (values.price_adjustment !== undefined) checkVariantPrice(find(db, 'products', variant.product_id, 'Product').sales_price, values.price_adjustment);
    try { updateRow(db, 'product_variants', id, values); } catch (error) { uniqueVariant(error); }
    return getProduct(db, variant.product_id);
  }],
  ['DELETE', '/api/variants/:id', ({ db, user, params }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    const variant = find(db, 'product_variants', id, 'Variant');
    if (isReferenced(db, [
      'SELECT 1 FROM subscription_lines WHERE variant_id = ? LIMIT 1',
      'SELECT 1 FROM quotation_template_lines WHERE variant_id = ? LIMIT 1',
    ], id)) throw new HttpError(409, 'This variant is used by a subscription or quotation template and cannot be deleted.');
    db.prepare('DELETE FROM product_variants WHERE id = ?').run(id);
    return getProduct(db, variant.product_id);
  }],

  ['GET', '/api/tax-rules', ({ db, user }) => {
    requireRole(user, ...TEAM);
    return { items: db.prepare('SELECT * FROM tax_rules ORDER BY active DESC, name').all(), limit: null };
  }],
  ['POST', '/api/tax-rules', async ({ db, user, body }) => {
    requireRole(user, ...ADMIN);
    const fields = taxFields(await body(), true);
    const keys = Object.keys(fields);
    const id = db.prepare(`INSERT INTO tax_rules(${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => fields[k])).lastInsertRowid;
    return { status: 201, data: find(db, 'tax_rules', Number(id), 'Tax rule') };
  }],
  ['PATCH', '/api/tax-rules/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    find(db, 'tax_rules', id, 'Tax rule');
    updateRow(db, 'tax_rules', id, taxFields(await body(), false));
    return find(db, 'tax_rules', id, 'Tax rule');
  }],
  ['DELETE', '/api/tax-rules/:id', ({ db, user, params }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    find(db, 'tax_rules', id, 'Tax rule');
    if (isReferenced(db, [
      'SELECT 1 FROM subscription_lines WHERE tax_rule_id = ? LIMIT 1',
      'SELECT 1 FROM quotation_template_lines WHERE tax_rule_id = ? LIMIT 1',
    ], id)) {
      db.prepare('UPDATE tax_rules SET active = 0 WHERE id = ?').run(id);
      return { archived: true };
    }
    db.prepare('DELETE FROM tax_rules WHERE id = ?').run(id);
    return { deleted: true };
  }],

  ['GET', '/api/plans', ({ db }) => ({
    items: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active','paused')) AS active_subscriptions
      FROM plans p ORDER BY p.name LIMIT 500`).all(),
    limit: 500,
  })],
  ['GET', '/api/plans/:id', ({ db, params }) => find(db, 'plans', routeId(params.id), 'Plan')],
  ['POST', '/api/plans', async ({ db, user, body }) => {
    requireRole(user, ...ADMIN);
    const fields = planFields(await body(), true);
    checkPlanDates(fields);
    const keys = Object.keys(fields);
    const id = db.prepare(`INSERT INTO plans(${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => fields[k])).lastInsertRowid;
    return { status: 201, data: find(db, 'plans', Number(id), 'Plan') };
  }],
  ['PATCH', '/api/plans/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    const plan = find(db, 'plans', id, 'Plan');
    const fields = planFields(await body(), false);
    checkPlanDates({ ...plan, ...fields });
    // Billing frequency and minimum quantity are part of agreed subscriptions, so they are fixed once one is confirmed.
    const changesTerms = ['interval', 'minimum_quantity'].some(key => fields[key] !== undefined && fields[key] !== plan[key]);
    if (changesTerms && db.prepare("SELECT 1 FROM subscriptions WHERE plan_id = ? AND status IN ('confirmed', 'active', 'paused') LIMIT 1").get(id)) {
      throw new HttpError(409, 'This plan has confirmed or running subscriptions, so its billing frequency and minimum quantity cannot change. Create a new plan instead.');
    }
    updateRow(db, 'plans', id, fields);
    return find(db, 'plans', id, 'Plan');
  }],
  ['DELETE', '/api/plans/:id', ({ db, user, params }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    find(db, 'plans', id, 'Plan');
    if (isReferenced(db, [
      'SELECT 1 FROM subscriptions WHERE plan_id = ? LIMIT 1',
      'SELECT 1 FROM quotation_templates WHERE plan_id = ? LIMIT 1',
    ], id)) throw new HttpError(409, 'This plan is used by subscriptions or quotation templates. Set an available-until date to retire it instead.');
    db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    return { deleted: true };
  }],
];
