// Stage 6: discounts. Admins define them, staff attach them to subscriptions, and billing applies the
// ones that qualify to each invoice. A discount with no products applies to every line.
import { ADMIN, TEAM, requireRole } from './access.js';
import { HttpError, integer, isoDate, oneOf, routeId, text, today, transaction, updateRow } from './http.js';

const productIdsOf = (db, discountId) =>
  db.prepare('SELECT product_id FROM discount_products WHERE discount_id = ? ORDER BY product_id').all(discountId).map(row => row.product_id);

// Works out which of a subscription's discounts apply to a billing period and how much each takes off
// each line, in paise. Discounts apply in the order they were created, each on what earlier ones left,
// so a line is never discounted below zero. Minimums are checked against the qualifying lines.
export function discountLines(db, subscriptionId, lines, periodStart) {
  const discounts = db.prepare(`SELECT d.* FROM subscription_discounts sd JOIN discounts d ON d.id = sd.discount_id
    WHERE sd.subscription_id = ? ORDER BY d.id`).all(subscriptionId);
  const lineDiscounts = lines.map(() => 0);
  const applied = [];
  const remaining = index => lines[index].quantity * lines[index].unit_price - lineDiscounts[index];
  for (const discount of discounts) {
    if ((discount.start_date && periodStart < discount.start_date) || (discount.end_date && periodStart > discount.end_date)) continue;
    if (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit) continue;
    const products = new Set(productIdsOf(db, discount.id));
    const eligible = lines.map((_, index) => index).filter(index => !products.size || products.has(lines[index].product_id));
    const quantity = eligible.reduce((sum, index) => sum + lines[index].quantity, 0);
    const purchase = eligible.reduce((sum, index) => sum + lines[index].quantity * lines[index].unit_price, 0);
    if (!eligible.length || quantity < discount.minimum_quantity || purchase < discount.minimum_purchase) continue;

    const amounts = new Map(eligible.map(index => [index, 0]));
    if (discount.type === 'percentage') {
      for (const index of eligible) amounts.set(index, Math.round(remaining(index) * discount.value / 10000));
    } else {
      // A fixed amount is shared across the lines in proportion to their value; leftover paise from
      // rounding go one at a time to lines that still have room.
      const available = eligible.reduce((sum, index) => sum + remaining(index), 0);
      let left = Math.min(discount.value, available);
      for (const index of eligible) {
        const share = available ? Math.floor(Math.min(discount.value, available) * remaining(index) / available) : 0;
        amounts.set(index, share);
        left -= share;
      }
      for (const index of eligible) {
        const extra = Math.min(left, remaining(index) - amounts.get(index));
        amounts.set(index, amounts.get(index) + extra);
        left -= extra;
      }
    }
    const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
    if (!total) continue;
    for (const [index, amount] of amounts) lineDiscounts[index] += amount;
    applied.push({ discount_id: discount.id, amount: total });
  }
  return { lineDiscounts, applied };
}

function discountStatus(discount, date = today()) {
  if (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit) return 'used_up';
  if (discount.end_date && discount.end_date < date) return 'expired';
  if (discount.start_date && discount.start_date > date) return 'scheduled';
  return 'active';
}

export function getDiscount(db, id) {
  const discount = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
  if (!discount) throw new HttpError(404, 'Discount not found.');
  return {
    ...discount,
    status: discountStatus(discount),
    product_ids: productIdsOf(db, id),
    products: db.prepare('SELECT p.id, p.name FROM discount_products dp JOIN products p ON p.id = dp.product_id WHERE dp.discount_id = ? ORDER BY p.name').all(id),
    subscription_count: db.prepare('SELECT COUNT(*) AS count FROM subscription_discounts WHERE discount_id = ?').get(id).count,
    discounted_total: db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM invoice_discounts WHERE discount_id = ?').get(id).total,
  };
}

// Reads a discount from a request body. On update, fields that are not sent keep their current value.
function readDiscount(db, values, existing = null) {
  const required = !existing;
  const fields = {
    name: text(values, 'name', { required, max: 120 }),
    type: oneOf(values, 'type', ['percentage', 'fixed'], { required }),
    value: integer(values, 'value', { required, min: 1 }),
    minimum_purchase: integer(values, 'minimum_purchase', { min: 0 }),
    minimum_quantity: integer(values, 'minimum_quantity', { min: 1 }),
    start_date: isoDate(values, 'start_date'),
    end_date: isoDate(values, 'end_date'),
    usage_limit: integer(values, 'usage_limit', { min: 1, nullable: true }),
  };
  const merged = { ...existing, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
  if (merged.type === 'percentage' && merged.value > 10000) throw new HttpError(400, 'A percentage discount cannot be more than 100%.');
  if (merged.start_date && merged.end_date && merged.end_date < merged.start_date) throw new HttpError(400, 'The end date must be on or after the start date.');
  if (existing && merged.usage_limit != null && merged.usage_limit < existing.usage_count) {
    throw new HttpError(400, `This discount has already been used ${existing.usage_count} times.`);
  }
  let productIds;
  if (Object.hasOwn(values, 'product_ids')) {
    if (!Array.isArray(values.product_ids) || values.product_ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new HttpError(400, 'product_ids must be a list of product ids.');
    }
    productIds = [...new Set(values.product_ids)];
    for (const id of productIds) {
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new HttpError(400, `Product ${id} not found.`);
    }
  }
  return { fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), productIds };
}

function saveProducts(db, discountId, productIds) {
  if (!productIds) return;
  db.prepare('DELETE FROM discount_products WHERE discount_id = ?').run(discountId);
  const insert = db.prepare('INSERT INTO discount_products(discount_id, product_id) VALUES (?, ?)');
  for (const productId of productIds) insert.run(discountId, productId);
}

// Customers may read the discounts on their own subscriptions; only the team can change them.
function findSubscription(db, id, user) {
  const subscription = db.prepare('SELECT id, customer_id, status FROM subscriptions WHERE id = ?').get(id);
  if (!subscription || (user?.role === 'customer' && subscription.customer_id !== user.id)) throw new HttpError(404, 'Subscription not found.');
  return subscription;
}

const subscriptionDiscounts = (db, subscriptionId) => db.prepare(`SELECT d.id FROM subscription_discounts sd JOIN discounts d ON d.id = sd.discount_id
  WHERE sd.subscription_id = ? ORDER BY d.id`).all(subscriptionId).map(row => getDiscount(db, row.id));

export const routes = [
  ['GET', '/api/discounts', ({ db, user }) => {
    requireRole(user, ...TEAM);
    const items = db.prepare('SELECT id FROM discounts ORDER BY id DESC LIMIT 200').all().map(row => getDiscount(db, row.id));
    return { items, limit: 200 };
  }],
  ['GET', '/api/discounts/:id', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    return getDiscount(db, routeId(params.id));
  }],
  ['POST', '/api/discounts', async ({ db, user, body }) => {
    requireRole(user, ...ADMIN);
    const { fields, productIds } = readDiscount(db, await body());
    return transaction(db, () => {
      const keys = Object.keys(fields);
      const id = Number(db.prepare(`INSERT INTO discounts(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .run(...keys.map(key => fields[key])).lastInsertRowid);
      saveProducts(db, id, productIds);
      return { status: 201, data: getDiscount(db, id) };
    });
  }],
  ['PATCH', '/api/discounts/:id', async ({ db, user, params, body }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    const values = await body();
    return transaction(db, () => {
      const existing = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
      if (!existing) throw new HttpError(404, 'Discount not found.');
      const { fields, productIds } = readDiscount(db, values, existing);
      updateRow(db, 'discounts', id, fields);
      saveProducts(db, id, productIds);
      return getDiscount(db, id);
    });
  }],
  ['DELETE', '/api/discounts/:id', ({ db, user, params }) => {
    requireRole(user, ...ADMIN);
    const id = routeId(params.id);
    return transaction(db, () => {
      getDiscount(db, id);
      if (db.prepare('SELECT 1 FROM invoice_discounts WHERE discount_id = ? LIMIT 1').get(id)) {
        throw new HttpError(409, 'This discount has been used on invoices. Set an end date to stop it instead.');
      }
      db.prepare('DELETE FROM subscription_discounts WHERE discount_id = ?').run(id);
      db.prepare('DELETE FROM discounts WHERE id = ?').run(id);
      return { deleted: true };
    });
  }],

  ['GET', '/api/subscriptions/:id/discounts', ({ db, user, params }) => {
    requireRole(user, ...TEAM, 'customer');
    const subscription = findSubscription(db, routeId(params.id), user);
    return { items: subscriptionDiscounts(db, subscription.id) };
  }],
  ['POST', '/api/subscriptions/:id/discounts', async ({ db, user, params, body }) => {
    requireRole(user, ...TEAM);
    const discountId = integer(await body(), 'discount_id', { required: true, min: 1 });
    return transaction(db, () => {
      const subscription = findSubscription(db, routeId(params.id), user);
      if (subscription.status === 'closed') throw new HttpError(409, 'Discounts cannot be added to a closed subscription.');
      const discount = getDiscount(db, discountId);
      if (['expired', 'used_up'].includes(discount.status)) throw new HttpError(409, `This discount is ${discount.status === 'expired' ? 'expired' : 'used up'}.`);
      if (db.prepare('SELECT 1 FROM subscription_discounts WHERE subscription_id = ? AND discount_id = ?').get(subscription.id, discountId)) {
        throw new HttpError(409, 'This discount is already on the subscription.');
      }
      db.prepare('INSERT INTO subscription_discounts(subscription_id, discount_id) VALUES (?, ?)').run(subscription.id, discountId);
      return { status: 201, data: { items: subscriptionDiscounts(db, subscription.id) } };
    });
  }],
  ['DELETE', '/api/subscriptions/:id/discounts/:discountId', ({ db, user, params }) => {
    requireRole(user, ...TEAM);
    const subscription = findSubscription(db, routeId(params.id), user);
    const removed = db.prepare('DELETE FROM subscription_discounts WHERE subscription_id = ? AND discount_id = ?').run(subscription.id, routeId(params.discountId));
    if (!removed.changes) throw new HttpError(404, 'This discount is not on the subscription.');
    return { items: subscriptionDiscounts(db, subscription.id) };
  }],
];
