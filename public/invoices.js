// Stage 5 screens: invoices created by the billing engine.
(() => {
  const views = window.BrightloopViews;
  const { field, moneyField, select, status, bindForms, toPaise, capitalize } = window.BrightloopUI;
  const METHOD_LABELS = { bank_transfer: 'Bank transfer', upi: 'UPI', card: 'Card', cash: 'Cash', cheque: 'Cheque', other: 'Other' };
  window.BrightloopUI.paymentMethods = METHOD_LABELS;

  const FLOW = ['draft', 'confirmed', 'paid'];
  const STATUSES = ['draft', 'confirmed', 'paid', 'cancelled'];
  const STATUS_TONE = { draft: '', confirmed: 'info', paid: 'good', cancelled: 'bad' };
  const ACTION_LABELS = { confirm: 'Confirm invoice', cancel: 'Cancel invoice' };
  const ACTION_CONFIRM = { confirm: 'Confirm this invoice? The customer will be able to see it.', cancel: 'Cancel this invoice? Its period will not be billed again.' };
  const localToday = () => { const now = new Date(); return new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const overdue = invoice => invoice.status === 'confirmed' && invoice.balance > 0 && invoice.due_date < localToday();
  const statusPill = invoice => `${status(capitalize(invoice.status), STATUS_TONE[invoice.status])}${overdue(invoice) ? ` ${status('Overdue', 'bad')}` : ''}`;

  // Shared with the subscription page, which lists the invoices of one subscription.
  window.BrightloopUI.invoiceRows = (ctx, items) => items.map(i => `<tr>
    <td><a class="row-link" href="#invoices/${i.id}">${ctx.escape(i.number)}</a></td><td>${ctx.escape(i.period_start)} → ${ctx.escape(i.period_end)}</td>
    <td>${statusPill(i)}</td><td>${ctx.escape(i.due_date)}</td><td>${ctx.money(i.total)}</td><td>${ctx.money(i.status === 'cancelled' ? 0 : i.balance)}</td></tr>`).join('');

  views.invoices = async ctx => (ctx.id ? invoiceDetail(ctx, Number(ctx.id.split('?')[0])) : invoiceList(ctx));

  async function invoiceList(ctx) {
    const e = ctx.escape;
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const filter = params.get('status') ?? '';
    const data = await ctx.api(`invoices${filter ? `?status=${encodeURIComponent(filter)}` : ''}`);
    const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
    const tabs = [['', 'All', total], ...STATUSES.map(s => [s, capitalize(s), data.counts[s]])];
    const html = `${ctx.heading('Invoices', 'Invoices are created automatically for each billing period of an active subscription.', 'Stage 5 · Billing')}
      <div class="toolbar"><nav class="tabs" aria-label="Filter by status">${tabs.map(([value, label, count]) =>
        `<a class="tab ${value === filter ? 'active' : ''}" href="#invoices${value ? `?status=${value}` : ''}">${label}<span>${count}</span></a>`).join('')}</nav>
        <button type="button" data-click="runBilling">Run billing now</button></div>
      <section class="panel module-panel"><div class="table-heading"><h2>${filter ? capitalize(filter) : 'All'} invoices</h2><span>${data.items.length} records${data.items.length === data.limit ? ` · first ${data.limit}` : ''}</span></div>
      ${data.items.length ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Subscription</th><th>Period</th><th>Status</th><th>Due date</th><th>Total</th><th>Balance</th></tr></thead><tbody>
        ${data.items.map(i => `<tr><td><a class="row-link" href="#invoices/${i.id}">${e(i.number)}</a></td><td>${e(i.customer_name)}</td><td>${e(i.subscription_number)}</td>
          <td>${e(i.period_start)} → ${e(i.period_end)}</td><td>${statusPill(i)}</td><td>${e(i.due_date)}</td><td>${ctx.money(i.total)}</td>
          <td>${ctx.money(i.status === 'cancelled' ? 0 : i.balance)}</td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('▧', filter ? `No ${filter} invoices` : 'No invoices yet', 'Activate a subscription, then billing creates its first invoice on the start date. Billing runs every hour, or use “Run billing now”.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async runBilling() {
          const result = await ctx.api('billing/run', { method: 'POST' });
          const count = result.invoices.length;
          ctx.notify(count ? `${count} invoice${count === 1 ? '' : 's'} created.` : 'Nothing is due for billing right now.');
          ctx.rerender();
        },
      }, ctx),
    };
  }

  async function invoiceDetail(ctx, id) {
    const e = ctx.escape;
    const i = await ctx.api(`invoices/${id}`);
    const stepIndex = FLOW.indexOf(i.status);
    const html = `${ctx.heading(`${e(i.number)} ${statusPill(i)}`, `${e(i.customer_name)} · ${e(i.subscription_number)}`, 'Stage 5 · Billing', '#invoices')}
      ${i.status === 'cancelled' ? '<div class="stage-note">This invoice was cancelled. Its billing period will not be invoiced again.</div>'
        : `<ol class="stepper" aria-label="Invoice status">${FLOW.map((step, index) =>
          `<li class="${index < stepIndex ? 'done' : index === stepIndex ? 'current' : ''}">${capitalize(step)}</li>`).join('')}</ol>`}
      ${i.actions.length ? `<div class="action-bar">${i.actions.map(action =>
        `<button type="button" class="${action === 'cancel' ? 'secondary danger' : ''}" data-click="runAction" data-action-name="${action}" data-confirm="${ACTION_CONFIRM[action]}">${ACTION_LABELS[action]}</button>`).join('')}</div>` : ''}
      <div class="two-column">
        <section class="panel"><h2>Invoice lines</h2><p class="panel-intro">Billing period ${e(i.period_start)} → ${e(i.period_end)} · prices in INR</p>
          <div class="table-scroll"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Tax</th><th>Amount</th></tr></thead><tbody>
            ${i.lines.map(line => `<tr><td>${e(line.description)}</td><td>${line.quantity}</td><td>${ctx.money(line.unit_price)}</td>
              <td>${line.tax_rate_basis_points ? `${line.tax_rate_basis_points / 100}%<small>${ctx.money(line.tax_amount)}</small>` : '—'}</td><td>${ctx.money(line.amount)}</td></tr>`).join('')}
          </tbody><tfoot>
            <tr><td colspan="4">Untaxed amount</td><td>${ctx.money(i.subtotal)}</td></tr>
            ${i.discount_total ? `<tr><td colspan="4">Discounts</td><td>− ${ctx.money(i.discount_total)}</td></tr>` : ''}
            <tr><td colspan="4">Taxes</td><td>${ctx.money(i.tax_total)}</td></tr>
            <tr class="grand"><td colspan="4">Total</td><td>${ctx.money(i.total)}</td></tr>
            <tr><td colspan="4">Paid</td><td>${ctx.money(i.amount_paid)}</td></tr>
            <tr class="grand"><td colspan="4">Balance due</td><td>${ctx.money(i.balance)}</td></tr>
          </tfoot></table></div></section>
        <section class="panel"><h2>Details</h2><p class="panel-intro">Customer details are kept as they were when the invoice was issued.</p>
          ${[['Customer', `${e(i.customer_name)}<small>${e(i.customer_email)}</small>`],
            ['Subscription', `<a class="row-link" href="#subscriptions/${i.subscription_id}">${e(i.subscription_number)}</a>`],
            ['Issue date', e(i.issue_date)], ['Due date', e(i.due_date)]]
            .map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`).join('')}
          <h2 class="history-title">Payments</h2>
          ${i.payments.length ? `<ol class="timeline">${i.payments.map(p => `<li><strong>${ctx.money(p.amount)}</strong> · ${METHOD_LABELS[p.method] ?? e(p.method)}${p.reference ? ` · ${e(p.reference)}` : ''}<small>${e(p.payment_date)}${p.note ? ` · ${e(p.note)}` : ''}</small>
            <button type="button" class="link-button danger-text" data-click="removePayment" data-payment-id="${p.id}" data-confirm="Remove this ${ctx.money(p.amount)} payment? Only do this for a payment recorded by mistake.">Remove</button></li>`).join('')}</ol>`
            : `<p class="muted">${i.status === 'draft' ? 'Confirm the invoice to start recording payments.' : 'No payments yet.'}</p>`}
        </section>
      </div>
      ${i.can_record_payment ? `<section class="panel form-panel-static"><h2>Record payment</h2><p class="panel-intro">Balance due ${ctx.money(i.balance)}. Part payments are fine; the invoice is marked paid when the balance reaches ₹0.</p>
        <form data-action="recordPayment" class="stack"><div class="form-grid three">
          ${select(e, 'Method', 'method', [['', 'Select a method'], ...Object.entries(METHOD_LABELS)], '', { required: true })}
          ${moneyField(e, 'Amount (₹)', 'amount', i.balance, { required: true })}
          ${field(e, 'Payment date', 'payment_date', { type: 'date', value: localToday(), required: true, attrs: `max="${localToday()}"` })}
          ${field(e, 'Reference', 'reference', { attrs: 'maxlength="120" placeholder="UTR, cheque or transaction number"' })}
          ${field(e, 'Note', 'note', { attrs: 'maxlength="500"' })}
          <div class="form-actions align-end"><button type="submit">Record payment</button></div>
        </div><span class="form-message" role="status"></span></form></section>` : ''}`;
    return {
      html,
      mount: root => bindForms(root, {
        async runAction(dataset) {
          const updated = await ctx.api(`invoices/${id}/actions/${dataset.actionName}`, { method: 'POST' });
          ctx.notify(`${updated.number} is now ${updated.status}.`);
          ctx.rerender();
        },
        async recordPayment(data) {
          const body = { method: data.get('method'), amount: toPaise(data.get('amount')), payment_date: data.get('payment_date') };
          if (data.get('reference').trim()) body.reference = data.get('reference');
          if (data.get('note').trim()) body.note = data.get('note');
          const updated = await ctx.api(`invoices/${id}/payments`, { method: 'POST', body });
          ctx.notify(updated.status === 'paid' ? `${updated.number} is fully paid.` : `Payment recorded. ${ctx.money(updated.balance)} still due.`);
          ctx.rerender();
        },
        async removePayment(dataset) {
          await ctx.api(`payments/${dataset.paymentId}`, { method: 'DELETE' });
          ctx.notify('Payment removed.');
          ctx.rerender();
        },
      }, ctx),
    };
  }
})();
