// Stage 6: payments against confirmed invoices. Partial payments are allowed; an invoice is paid
// once its payments add up to the total, and goes back to confirmed if a payment is removed.
import { TEAM, requireRole } from './access.js';
import { getInvoice } from './billing.js';
import { HttpError, integer, isoDate, oneOf, routeId, text, today, transaction } from './http.js';

export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'card', 'cash', 'cheque', 'other'];

const amountPaid = (db, invoiceId) =>
  db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?').get(invoiceId).paid;

export function recordPayment(db, invoiceId, values, user) {
  const method = oneOf(values, 'method', PAYMENT_METHODS, { required: true });
  const amount = integer(values, 'amount', { required: true, min: 1 });
  const paymentDate = isoDate(values, 'payment_date') ?? today();
  if (paymentDate > today()) throw new HttpError(400, 'The payment date cannot be in the future.');
  const reference = text(values, 'reference', { max: 120 }) || null;
  const note = text(values, 'note', { max: 500, allowEmpty: true }) ?? '';
  return transaction(db, () => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new HttpError(404, 'Invoice not found.');
    if (invoice.status !== 'confirmed') {
      throw new HttpError(409, invoice.status === 'draft' ? 'Confirm the invoice before recording a payment.' : `A ${invoice.status} invoice cannot take payments.`);
    }
    const balance = invoice.total - amountPaid(db, invoiceId);
    if (amount > balance) throw new HttpError(409, `The payment is more than the balance due (${(balance / 100).toFixed(2)}).`);
    if (reference && db.prepare('SELECT 1 FROM payments WHERE reference = ?').get(reference)) {
      throw new HttpError(409, 'A payment with this reference has already been recorded.');
    }
    db.prepare('INSERT INTO payments(invoice_id, method, amount, payment_date, note, reference) VALUES (?, ?, ?, ?, ?, ?)')
      .run(invoiceId, method, amount, paymentDate, note, reference);
    if (amount === balance) db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(invoiceId);
    return getInvoice(db, invoiceId, user);
  });
}

export function deletePayment(db, paymentId) {
  return transaction(db, () => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw new HttpError(404, 'Payment not found.');
    db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
    db.prepare("UPDATE invoices SET status = 'confirmed' WHERE id = ? AND status = 'paid'").run(payment.invoice_id);
    return { deleted: true, invoice_id: payment.invoice_id };
  });
}

function listPayments(db, query, user) {
  const where = [];
  const params = [];
  const invoiceId = Number(query.get('invoice_id'));
  if (Number.isSafeInteger(invoiceId) && invoiceId > 0) { where.push('p.invoice_id = ?'); params.push(invoiceId); }
  if (user?.role === 'customer') { where.push('i.customer_id = ?'); params.push(user.id); }
  const search = query.get('q')?.trim();
  if (search) {
    where.push('(i.number LIKE ? OR i.customer_name LIKE ? OR p.reference LIKE ?)');
    params.push(...Array(3).fill(`%${search.slice(0, 80)}%`));
  }
  const items = db.prepare(`
    SELECT p.id, p.invoice_id, i.number AS invoice, i.customer_name, p.method, p.amount, p.payment_date, p.reference, p.note
    FROM payments p JOIN invoices i ON i.id = p.invoice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.payment_date DESC, p.id DESC LIMIT 200`).all(...params);
  const totals = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount FROM payments p JOIN invoices i ON i.id = p.invoice_id
    ${user?.role === 'customer' ? 'WHERE i.customer_id = ?' : ''}`).get(...(user?.role === 'customer' ? [user.id] : []));
  return { items, limit: 200, totals };
}

export const routes = [
  ['GET', '/api/payments', ({ db, user, query }) => {
    requireRole(user, ...TEAM, 'customer');
    return listPayments(db, query, user);
  }],
  ['POST', '/api/invoices/:id/payments', async ({ db, user, params, body }) => {
    requireRole(user, ...TEAM);
    return { status: 201, data: recordPayment(db, routeId(params.id), await body(), user) };
  }],
  ['DELETE', '/api/payments/:id', ({ db, user, params }) => {
    requireRole(user, 'admin');
    return deletePayment(db, routeId(params.id));
  }],
];
