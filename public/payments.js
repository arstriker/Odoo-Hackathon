// Stage 6 screens: every payment received, newest first.
(() => {
  const views = window.BrightloopViews;

  views.payments = async ctx => {
    const e = ctx.escape;
    const methods = window.BrightloopUI.paymentMethods;
    const search = new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') ?? '';
    const data = await ctx.api(`payments${search ? `?q=${encodeURIComponent(search)}` : ''}`);
    const html = `${ctx.heading('Payments', 'Payments received against confirmed invoices. Record a payment from the invoice it belongs to.', 'Stage 6 · Payments')}
      <section class="stats" aria-label="Payment totals">
        <article class="stat"><div class="stat-label">Payments received<span aria-hidden="true">↗</span></div><div class="stat-value">${data.totals.count}</div><small>All time</small></article>
        <article class="stat"><div class="stat-label">Amount collected<span aria-hidden="true">₹</span></div><div class="stat-value">${ctx.money(data.totals.amount)}</div><small>All time</small></article>
      </section>
      <form class="toolbar" data-action="search"><label class="field search-field"><span class="visually-hidden">Search payments</span>
        <input type="search" name="q" value="${e(search)}" placeholder="Search by invoice, customer or reference" maxlength="80"></label>
        <button type="submit">Search</button></form>
      <section class="panel module-panel"><div class="table-heading"><h2>${search ? `Results for “${e(search)}”` : 'All payments'}</h2><span>${data.items.length} records${data.items.length === data.limit ? ` · first ${data.limit}` : ''}</span></div>
      ${data.items.length ? `<div class="table-scroll"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>
        ${data.items.map(p => `<tr><td>${e(p.payment_date)}</td><td><a class="row-link" href="#invoices/${p.invoice_id}">${e(p.invoice)}</a></td><td>${e(p.customer_name)}</td>
          <td>${methods[p.method] ?? e(p.method)}</td><td>${e(p.reference)}</td><td>${ctx.money(p.amount)}</td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('↗', search ? 'No matching payments' : 'No payments yet', 'Open a confirmed invoice and use “Record payment” when the customer pays.')}</section>`;
    return {
      html,
      mount: root => window.BrightloopUI.bindForms(root, {
        async search(data) {
          const q = data.get('q').trim();
          location.hash = q ? `#payments?q=${encodeURIComponent(q)}` : '#payments';
        },
      }, ctx),
    };
  };
})();
