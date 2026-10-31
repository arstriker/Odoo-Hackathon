// Stage 7: finance & performance reporting engine.
import { TEAM, requireRole } from './access.js';
import { addDays, today } from './http.js';

function resolveDateRange(query) {
  const t = today();
  const [year, month, day] = t.split('-').map(Number);
  const preset = query.get('preset');
  let from = query.get('from');
  let to = query.get('to');

  if (preset === 'this_month') {
    from = `${year}-${String(month).padStart(2, '0')}-01`;
    to = t;
  } else if (preset === 'last_month') {
    const lastMonthYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;
    const lastDay = new Date(Date.UTC(lastMonthYear, lastMonth, 0)).getUTCDate();
    from = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`;
    to = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  } else if (preset === 'this_quarter') {
    const qStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    from = `${year}-${String(qStartMonth).padStart(2, '0')}-01`;
    to = t;
  } else if (preset === 'this_year') {
    from = `${year}-01-01`;
    to = t;
  } else if (preset === 'all') {
    from = null;
    to = null;
  } else if (!from && !to) {
    // Default to this month
    from = `${year}-${String(month).padStart(2, '0')}-01`;
    to = t;
  }

  return { from: from || null, to: to || null, preset: preset || (from && to ? 'custom' : 'all') };
}

export function getFinanceSummary(db, query, user) {
  requireRole(user, ...TEAM);
  const range = resolveDateRange(query);
  const curDate = today();

  // 1. Active & Paused Subscriptions Breakdown
  const subCounts = { active: 0, paused: 0, confirmed: 0, closed: 0, draft: 0, total: 0 };
  const countRows = db.prepare('SELECT status, COUNT(*) AS count FROM subscriptions GROUP BY status').all();
  for (const row of countRows) {
    if (subCounts[row.status] !== undefined) subCounts[row.status] = row.count;
    subCounts.total += row.count;
  }

  // Breakdown by plan & interval, plus MRR calculation
  const intervalRows = db.prepare(`
    SELECT p.interval, COUNT(s.id) AS count,
           COALESCE(SUM(l.quantity * l.unit_price), 0) AS raw_subtotal
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    LEFT JOIN subscription_lines l ON l.subscription_id = s.id
    WHERE s.status = 'active'
    GROUP BY p.interval`).all();

  let estimatedMRR = 0;
  for (const row of intervalRows) {
    if (row.interval === 'daily') estimatedMRR += row.raw_subtotal * 30;
    else if (row.interval === 'weekly') estimatedMRR += Math.round(row.raw_subtotal * 52 / 12);
    else if (row.interval === 'monthly') estimatedMRR += row.raw_subtotal;
    else if (row.interval === 'yearly') estimatedMRR += Math.round(row.raw_subtotal / 12);
  }

  // 2. Revenue Collected (Payments in range)
  const payWhere = [];
  const payParams = [];
  if (range.from) {
    payWhere.push('p.payment_date >= ?');
    payParams.push(range.from);
  }
  if (range.to) {
    payWhere.push('p.payment_date <= ?');
    payParams.push(range.to);
  }
  const payWhereSql = payWhere.length ? `WHERE ${payWhere.join(' AND ')}` : '';

  const paymentsAggregate = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS total_amount
    FROM payments p
    ${payWhereSql}`).get(...payParams);

  const paymentsByMethod = db.prepare(`
    SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS total_amount
    FROM payments p
    ${payWhereSql}
    GROUP BY p.method
    ORDER BY total_amount DESC`).all(...payParams);

  const monthlyTrend = db.prepare(`
    SELECT strftime('%Y-%m', p.payment_date) AS month, COUNT(*) AS count, SUM(p.amount) AS total_amount
    FROM payments p
    ${payWhereSql}
    GROUP BY month
    ORDER BY month ASC LIMIT 24`).all(...payParams);

  // 3. Outstanding Receivables & Overdue Invoices
  // Confirmed invoices that have not been cancelled
  const receivables = db.prepare(`
    SELECT
      COUNT(CASE WHEN (i.total - COALESCE(p.paid, 0)) > 0 THEN 1 END) AS unpaid_invoices_count,
      COALESCE(SUM(CASE WHEN (i.total - COALESCE(p.paid, 0)) > 0 THEN i.total - COALESCE(p.paid, 0) ELSE 0 END), 0) AS total_outstanding,
      COALESCE(SUM(CASE WHEN (i.total - COALESCE(p.paid, 0)) > 0 AND i.due_date >= ? THEN i.total - COALESCE(p.paid, 0) ELSE 0 END), 0) AS current_due,
      COALESCE(SUM(CASE WHEN (i.total - COALESCE(p.paid, 0)) > 0 AND i.due_date < ? THEN i.total - COALESCE(p.paid, 0) ELSE 0 END), 0) AS total_overdue,
      COUNT(CASE WHEN (i.total - COALESCE(p.paid, 0)) > 0 AND i.due_date < ? THEN 1 END) AS overdue_count
    FROM invoices i
    LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
    WHERE i.status = 'confirmed'`).get(curDate, curDate, curDate);

  // Top overdue invoices to chase
  const overdueInvoices = db.prepare(`
    SELECT i.id, i.number, i.customer_name, i.customer_email, s.number AS subscription_number,
           i.due_date, i.total, (i.total - COALESCE(p.paid, 0)) AS balance,
           CAST(ROUND(JULIANDAY(?) - JULIANDAY(i.due_date)) AS INTEGER) AS days_overdue
    FROM invoices i
    JOIN subscriptions s ON s.id = i.subscription_id
    LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
    WHERE i.status = 'confirmed' AND i.due_date < ? AND (i.total - COALESCE(p.paid, 0)) > 0
    ORDER BY days_overdue DESC, balance DESC LIMIT 50`).all(curDate, curDate);

  return {
    date_range: range,
    subscriptions: {
      ...subCounts,
      intervals: intervalRows,
      estimated_mrr: estimatedMRR,
    },
    revenue: {
      collected_amount: paymentsAggregate.total_amount,
      payments_count: paymentsAggregate.count,
      by_method: paymentsByMethod,
      monthly_trend: monthlyTrend,
    },
    receivables: {
      total_outstanding: receivables.total_outstanding,
      current_due: receivables.current_due,
      total_overdue: receivables.total_overdue,
      overdue_count: receivables.overdue_count,
    },
    overdue_invoices: overdueInvoices,
  };
}

export const routes = [
  ['GET', '/api/finance/summary', ({ db, user, query }) => {
    return getFinanceSummary(db, query, user);
  }],
  ['GET', '/api/finance/overdue', ({ db, user }) => {
    requireRole(user, ...TEAM);
    const curDate = today();
    const items = db.prepare(`
      SELECT i.id, i.number, i.customer_name, i.customer_email, s.number AS subscription_number,
             i.due_date, i.total, (i.total - COALESCE(p.paid, 0)) AS balance,
             CAST(ROUND(JULIANDAY(?) - JULIANDAY(i.due_date)) AS INTEGER) AS days_overdue
      FROM invoices i
      JOIN subscriptions s ON s.id = i.subscription_id
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
      WHERE i.status = 'confirmed' AND i.due_date < ? AND (i.total - COALESCE(p.paid, 0)) > 0
      ORDER BY days_overdue DESC LIMIT 100`).all(curDate, curDate);
    return { items };
  }],
];
