// Stage 6 screens: discounts, and the discounts attached to a subscription.
(() => {
  const views = window.BrightloopViews;
  const { field, moneyField, select, checkbox, status, bindForms, toPaise, toRupees } = window.BrightloopUI;

  const STATUS = { active: ['Active', 'good'], scheduled: ['Scheduled', 'info'], expired: ['Expired', 'bad'], used_up: ['Used up', 'warn'] };
  const statusPill = discount => status(...STATUS[discount.status]);
  // Percentages are stored in basis points and fixed amounts in paise.
  const valueLabel = (ctx, d) => (d.type === 'percentage' ? `${d.value / 100}% off` : `${ctx.money(d.value)} off`);
  const conditions = (ctx, d) => [
    d.minimum_quantity > 1 && `min. ${d.minimum_quantity} items`,
    d.minimum_purchase > 0 && `min. ${ctx.money(d.minimum_purchase)}`,
    d.start_date && `from ${d.start_date}`,
    d.end_date && `until ${d.end_date}`,
  ].filter(Boolean);
  const usesLabel = d => `${d.usage_count}${d.usage_limit ? ` / ${d.usage_limit}` : ''}`;
  window.BrightloopUI.discountSummary = (ctx, d) => `${valueLabel(ctx, d)}${d.products.length ? ` · ${d.products.map(p => ctx.escape(p.name)).join(', ')}` : ' · all products'}`;

  const discountForm = (e, products, d = {}) => `
    <div class="form-grid three">
      ${field(e, 'Name', 'name', { value: d.name, required: true, attrs: 'maxlength="120" placeholder="Festive 10% off"' })}
      ${select(e, 'Type', 'type', [['percentage', 'Percentage (%)'], ['fixed', 'Fixed amount (₹)']], d.type ?? 'percentage', { required: true })}
      ${field(e, 'Value', 'value', { type: 'number', value: d.value == null ? '' : toRupees(d.value), required: true, attrs: 'min="0.01" step="0.01" inputmode="decimal"', hint: 'Percent for a percentage discount, rupees for a fixed one.' })}
      ${moneyField(e, 'Minimum purchase (₹)', 'minimum_purchase', d.minimum_purchase ?? 0, { hint: 'Of the qualifying lines, per invoice.' })}
      ${field(e, 'Minimum quantity', 'minimum_quantity', { type: 'number', value: d.minimum_quantity ?? 1, required: true, attrs: 'min="1" step="1"' })}
      ${field(e, 'Usage limit', 'usage_limit', { type: 'number', value: d.usage_limit ?? '', attrs: 'min="1" step="1" placeholder="Unlimited"', hint: 'Each invoice it is applied to counts as one use.' })}
      ${field(e, 'Start date', 'start_date', { type: 'date', value: d.start_date })}
      ${field(e, 'End date', 'end_date', { type: 'date', value: d.end_date })}
    </div>
    <fieldset><legend>Applies to <small>Leave all unticked to apply it to every product.</small></legend>
      <div class="check-grid">${products.map(p => checkbox(e, p.name, `product_${p.id}`, d.product_ids?.includes(p.id))).join('') || '<p class="muted">No products yet.</p>'}</div>
    </fieldset>`;

  const discountBody = (data, products) => {
    const value = Number(data.get('value'));
    return {
      name: data.get('name'), type: data.get('type'),
      value: data.get('type') === 'percentage' ? Math.round(value * 100) : toPaise(value),
      minimum_purchase: toPaise(data.get('minimum_purchase')), minimum_quantity: Number(data.get('minimum_quantity')),
      usage_limit: data.get('usage_limit') ? Number(data.get('usage_limit')) : null,
      start_date: data.get('start_date') || null, end_date: data.get('end_date') || null,
      product_ids: products.filter(p => data.get(`product_${p.id}`)).map(p => p.id),
    };
  };

  views.discounts = async ctx => {
    const e = ctx.escape;
    const [discounts, products] = await Promise.all([ctx.api('discounts'), ctx.api('products')]);
    if (ctx.id) return discountDetail(ctx, Number(ctx.id), products.items);
    const html = `${ctx.heading('Discounts', 'Create offers, then add them to subscriptions. Billing applies them to each invoice that qualifies.', 'Stage 6 · Discounts')}
      <details class="panel form-panel" ${discounts.items.length ? '' : 'open'}><summary>+ New discount</summary>
        <form data-action="createDiscount" class="stack">${discountForm(e, products.items)}
          <div class="form-actions"><button type="submit">Create discount</button><span class="form-message" role="status"></span></div></form></details>
      <section class="panel module-panel"><div class="table-heading"><h2>All discounts</h2><span>${discounts.items.length} records</span></div>
      ${discounts.items.length ? `<div class="table-scroll"><table><thead><tr><th>Discount</th><th>Value</th><th>Applies to</th><th>Conditions</th><th>Status</th><th>Subscriptions</th><th>Uses</th><th>Given so far</th></tr></thead><tbody>
        ${discounts.items.map(d => `<tr><td><a class="row-link" href="#discounts/${d.id}">${e(d.name)}</a></td><td>${valueLabel(ctx, d)}</td>
          <td class="wrap">${d.products.map(p => `<span class="chip">${e(p.name)}</span>`).join('') || 'All products'}</td>
          <td class="wrap">${conditions(ctx, d).map(c => `<span class="chip">${e(c)}</span>`).join('') || '—'}</td>
          <td>${statusPill(d)}</td><td>${d.subscription_count}</td><td>${usesLabel(d)}</td><td>${ctx.money(d.discounted_total)}</td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('%', 'No discounts yet', 'Create a discount above, then add it to a subscription from the subscription page.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async createDiscount(data) {
          const discount = await ctx.api('discounts', { method: 'POST', body: discountBody(data, products.items) });
          ctx.notify(`${discount.name} created.`);
          ctx.rerender();
        },
      }, ctx),
    };
  };

  async function discountDetail(ctx, id, products) {
    const e = ctx.escape;
    const d = await ctx.api(`discounts/${id}`);
    const html = `${ctx.heading(`${e(d.name)} ${statusPill(d)}`, `${valueLabel(ctx, d)} · used ${usesLabel(d)} times · ${ctx.money(d.discounted_total)} given so far`, 'Stage 6 · Discounts', '#discounts')}
      <section class="panel"><form data-action="saveDiscount" class="stack">${discountForm(e, products, d)}
        <div class="form-actions"><button type="submit">Save changes</button><span class="form-message" role="status"></span></div></form>
        <p class="note">Changes apply to future invoices only. Invoices already issued keep the discount they were given.</p>
        <div class="danger-zone"><button type="button" class="secondary danger" data-click="deleteDiscount" data-confirm="Delete ${e(d.name)}? It will be removed from ${d.subscription_count} subscription(s).">Delete discount</button>
        <small>Discounts already used on invoices can't be deleted. Set an end date to stop them.</small></div>
      </section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async saveDiscount(data) {
          await ctx.api(`discounts/${id}`, { method: 'PATCH', body: discountBody(data, products) });
          ctx.notify('Discount saved.');
          ctx.rerender();
        },
        async deleteDiscount() {
          await ctx.api(`discounts/${id}`, { method: 'DELETE' });
          ctx.notify('Discount deleted.');
          location.hash = '#discounts';
        },
      }, ctx),
    };
  }

  // The Discounts section of a subscription page. Customers see the list; the team can add and remove.
  window.BrightloopUI.subscriptionDiscounts = async (ctx, subscription) => {
    const e = ctx.escape;
    const [attached, all] = await Promise.all([
      ctx.api(`subscriptions/${subscription.id}/discounts`),
      ctx.api('discounts').catch(() => null),
    ]);
    const attachedIds = new Set(attached.items.map(d => d.id));
    const available = (all?.items ?? []).filter(d => !attachedIds.has(d.id) && ['active', 'scheduled'].includes(d.status));
    const canEdit = all && subscription.status !== 'closed';
    const html = `<section class="panel module-panel"><div class="table-heading"><h2>Discounts</h2><span>Applied automatically to each invoice that qualifies</span></div>
      ${attached.items.length ? `<div class="table-scroll"><table><thead><tr><th>Discount</th><th>Value</th><th>Applies to</th><th>Conditions</th><th>Status</th><th>Uses</th>${canEdit ? '<th></th>' : ''}</tr></thead><tbody>
        ${attached.items.map(d => `<tr><td>${all ? `<a class="row-link" href="#discounts/${d.id}">${e(d.name)}</a>` : e(d.name)}</td><td>${valueLabel(ctx, d)}</td>
          <td>${d.products.map(p => e(p.name)).join(', ') || 'All products'}</td><td>${conditions(ctx, d).map(e).join(' · ') || '—'}</td><td>${statusPill(d)}</td><td>${usesLabel(d)}</td>
          ${canEdit ? `<td><button type="button" class="link-button danger-text" data-click="removeDiscount" data-discount-id="${d.id}" data-confirm="Remove ${e(d.name)} from this subscription? Invoices already issued keep it.">Remove</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : '<p class="muted panel-pad">No discounts on this subscription.</p>'}
      ${canEdit ? (available.length ? `<form data-action="addDiscount" class="toolbar panel-pad">
          <label class="field search-field"><span class="visually-hidden">Discount to add</span><select name="discount_id" required><option value="">Choose a discount to add</option>
            ${available.map(d => `<option value="${d.id}">${e(d.name)} · ${window.BrightloopUI.discountSummary(ctx, d)}</option>`).join('')}</select></label>
          <button type="submit">Add discount</button><span class="form-message" role="status"></span></form>`
        : '<p class="muted panel-pad">No other active discounts to add. <a class="row-link" href="#discounts">Create one</a>.</p>') : ''}
    </section>`;
    const handlers = {
      async addDiscount(data) {
        await ctx.api(`subscriptions/${subscription.id}/discounts`, { method: 'POST', body: { discount_id: Number(data.get('discount_id')) } });
        ctx.notify('Discount added. It applies from the next invoice.');
        ctx.rerender();
      },
      async removeDiscount(dataset) {
        await ctx.api(`subscriptions/${subscription.id}/discounts/${dataset.discountId}`, { method: 'DELETE' });
        ctx.notify('Discount removed.');
        ctx.rerender();
      },
    };
    return { html, handlers };
  };
})();
