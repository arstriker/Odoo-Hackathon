// Stage 7 screens: finance lead summary, revenue analytics and overdue collections.
(() => {
  const views = window.BrightloopViews;
  const { status, capitalize } = window.BrightloopUI;

  const PRESETS = [
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
    ['this_quarter', 'This quarter'],
    ['this_year', 'This year'],
    ['all', 'All time'],
  ];

  views.finance = async ctx => {
    const e = ctx.escape;
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const preset = params.get('preset') ?? 'this_month';

    const data = await ctx.api(`finance/summary?preset=${encodeURIComponent(preset)}`);

    const { subscriptions: subs, revenue: rev, receivables: rec, overdue_invoices: overdue } = data;

    const cards = [
      {
        title: 'Active Subscriptions',
        value: subs.active,
        note: `${subs.paused ? `${subs.paused} paused · ` : ''}MRR run rate ${ctx.money(subs.estimated_mrr)}`,
        icon: '📈',
        tone: 'good',
      },
      {
        title: 'Revenue Collected',
        value: ctx.money(rev.collected_amount),
        note: `${rev.payments_count} payment${rev.payments_count === 1 ? '' : 's'} recorded`,
        icon: '💰',
        tone: 'good',
      },
      {
        title: 'Total Outstanding',
        value: ctx.money(rec.total_outstanding),
        note: `Current due: ${ctx.money(rec.current_due)}`,
        icon: '⏳',
        tone: '',
      },
      {
        title: 'Overdue Receivables',
        value: ctx.money(rec.total_overdue),
        note: `${rec.overdue_count} overdue invoice${rec.overdue_count === 1 ? '' : 's'}`,
        icon: '⚠️',
        tone: rec.overdue_count > 0 ? 'bad' : 'good',
      },
    ];

    const html = `${ctx.heading('Finance & Performance', 'Executive view of subscriptions, collections and receivables.', 'Stage 7 · Reporting')}
      <div class="toolbar">
        <nav class="tabs" aria-label="Period preset">
          ${PRESETS.map(([val, label]) => `<a class="tab ${val === preset ? 'active' : ''}" href="#finance?preset=${val}">${label}</a>`).join('')}
        </nav>
      </div>

      <section class="stats" aria-label="Financial KPIs">
        ${cards.map(card => `
          <article class="stat">
            <div class="stat-label">${card.title} <span aria-hidden="true">${card.icon}</span></div>
            <div class="stat-value ${card.tone}">${card.value}</div>
            <small>${card.note}</small>
          </article>`).join('')}
      </section>

      <div class="two-column">
        <section class="panel">
          <div class="table-heading">
            <h2>⚠️ Chase overdue invoices</h2>
            <span>${overdue.length} invoice${overdue.length === 1 ? '' : 's'}</span>
          </div>
          <p class="panel-intro">Prioritize reaching out to these accounts to collect outstanding revenue.</p>
          ${overdue.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Invoice</th><th>Customer</th><th>Due date</th><th>Aging</th><th>Balance</th></tr></thead>
            <tbody>
              ${overdue.map(i => `<tr>
                <td><a class="row-link" href="#invoices/${i.id}">${e(i.number)}</a></td>
                <td>${e(i.customer_name)}<small>${e(i.customer_email)}</small></td>
                <td>${e(i.due_date)}</td>
                <td><span class="pill bad">${i.days_overdue} day${i.days_overdue === 1 ? '' : 's'}</span></td>
                <td><strong>${ctx.money(i.balance)}</strong></td>
              </tr>`).join('')}
            </tbody>
          </table></div>` : ctx.empty('✓', 'No overdue invoices', 'All confirmed invoices are paid up to date!')}
        </section>

        <section class="panel">
          <div class="table-heading">
            <h2>Collections by payment method</h2>
            <span>${rev.by_method.length} method${rev.by_method.length === 1 ? '' : 's'}</span>
          </div>
          <p class="panel-intro">Breakdown of cash collected in the selected period.</p>
          ${rev.by_method.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Method</th><th>Count</th><th>Total Collected</th></tr></thead>
            <tbody>
              ${rev.by_method.map(m => `<tr>
                <td><span class="chip">${capitalize(m.method)}</span></td>
                <td>${m.count}</td>
                <td><strong>${ctx.money(m.total_amount)}</strong></td>
              </tr>`).join('')}
            </tbody>
          </table></div>` : '<p class="muted">No payments recorded in this period.</p>'}

          <h2 class="history-title" style="margin-top:1.5rem;">Monthly cashflow trend</h2>
          ${rev.monthly_trend.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Month</th><th>Transactions</th><th>Amount</th></tr></thead>
            <tbody>
              ${rev.monthly_trend.map(row => `<tr>
                <td><strong>${e(row.month)}</strong></td>
                <td>${row.count}</td>
                <td>${ctx.money(row.total_amount)}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>` : '<p class="muted">No trend data available for this range.</p>'}
        </section>
      </div>`;

    return { html };
  };
})();
