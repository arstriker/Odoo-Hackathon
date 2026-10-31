// Stage 4 screens: customers, quotation templates and subscriptions.
(() => {
  const views = window.BrightloopViews;
  const { field, moneyField, select, status, bindForms, toPaise, toRupees, capitalize } = window.BrightloopUI;

  const FLOW = ['draft', 'quotation', 'confirmed', 'active', 'closed'];
  const STATUS_TONE = { draft: '', quotation: 'info', confirmed: 'info', active: 'good', paused: 'warn', closed: 'bad' };
  const ACTION_LABELS = { send: 'Send quotation', confirm: 'Confirm', activate: 'Activate', pause: 'Pause', resume: 'Resume', renew: 'Renew', close: 'Close', invoice: 'Invoiced' };
  const ACTION_CONFIRM = { close: 'Close this subscription? This cannot be undone.', renew: 'Renew for another term?' };
  const statusPill = value => status(capitalize(value), STATUS_TONE[value]);
  const localToday = () => { const now = new Date(); return new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const addDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  // ---------- Line editor shared by templates and subscriptions ----------
  async function loadCatalogue(ctx) {
    const [products, taxes] = await Promise.all([ctx.api('products?active=1'), ctx.api('tax-rules')]);
    return { products: products.items, taxes: taxes.items.filter(rule => rule.active) };
  }

  function lineRow(ctx, catalogue, line = {}) {
    const e = ctx.escape;
    const product = catalogue.products.find(item => item.id === line.product_id);
    const variants = product?.variants ?? [];
    return `<div class="line-row">
      <label class="field"><span>Product</span><select name="product_id" required>
        <option value="">Select a product</option>
        ${catalogue.products.map(item => `<option value="${item.id}" ${item.id === line.product_id ? 'selected' : ''}>${e(item.name)} · ${ctx.money(item.sales_price)}</option>`).join('')}
      </select></label>
      <label class="field"><span>Variant</span><select name="variant_id">
        <option value="">None</option>
        ${variants.map(v => `<option value="${v.id}" ${v.id === line.variant_id ? 'selected' : ''}>${e(v.attribute)}: ${e(v.value)}</option>`).join('')}
      </select></label>
      <label class="field"><span>Quantity</span><input type="number" name="quantity" min="1" step="1" required value="${line.quantity ?? 1}"></label>
      <label class="field"><span>Unit price (₹)</span><input type="number" name="unit_price" min="0" step="0.01" inputmode="decimal" value="${line.unit_price == null ? '' : toRupees(line.unit_price)}" placeholder="${product ? toRupees(defaultPrice(catalogue, line.product_id, line.variant_id)) : 'Auto'}"></label>
      <label class="field"><span>Tax</span><select name="tax_rule_id">
        <option value="">No tax</option>
        ${catalogue.taxes.map(t => `<option value="${t.id}" ${t.id === line.tax_rule_id ? 'selected' : ''}>${e(t.name)} (${t.rate_basis_points / 100}%)</option>`).join('')}
      </select></label>
      <button type="button" class="secondary remove-line" aria-label="Remove line">✕</button>
    </div>`;
  }

  function defaultPrice(catalogue, productId, variantId) {
    const product = catalogue.products.find(item => item.id === productId);
    if (!product) return 0;
    const variant = product.variants.find(v => v.id === variantId);
    return Math.max(0, product.sales_price + (variant?.price_adjustment ?? 0));
  }

  const lineEditor = (ctx, catalogue, lines) => `
    <fieldset class="line-editor"><legend>Product lines <small>Leave the unit price empty to use the catalogue price.</small></legend>
      <div class="lines">${(lines.length ? lines : [{}]).map(line => lineRow(ctx, catalogue, line)).join('')}</div>
      <button type="button" class="secondary add-line">+ Add line</button>
    </fieldset>`;

  // Keeps variant options and the price hint in sync with the selected product.
  function mountLineEditor(root, ctx, catalogue) {
    root.addEventListener('click', event => {
      if (event.target.closest('.add-line')) {
        const lines = event.target.closest('.line-editor').querySelector('.lines');
        lines.insertAdjacentHTML('beforeend', lineRow(ctx, catalogue));
      }
      const remove = event.target.closest('.remove-line');
      if (remove) {
        const lines = remove.closest('.lines');
        if (lines.children.length > 1) remove.closest('.line-row').remove();
        else ctx.notify('At least one product line is required.', 'error');
      }
    });
    root.addEventListener('change', event => {
      const row = event.target.closest('.line-row');
      if (!row || !['product_id', 'variant_id'].includes(event.target.name)) return;
      const productId = Number(row.querySelector('[name="product_id"]').value) || null;
      let variantId = Number(row.querySelector('[name="variant_id"]').value) || null;
      if (event.target.name === 'product_id') {
        const product = catalogue.products.find(item => item.id === productId);
        row.querySelector('[name="variant_id"]').innerHTML = `<option value="">None</option>${(product?.variants ?? []).map(v =>
          `<option value="${v.id}">${ctx.escape(v.attribute)}: ${ctx.escape(v.value)}</option>`).join('')}`;
        variantId = null;
      }
      row.querySelector('[name="unit_price"]').placeholder = productId ? toRupees(defaultPrice(catalogue, productId, variantId)) : 'Auto';
    });
  }

  const readLines = form => [...form.querySelectorAll('.line-row')].map(row => {
    const value = name => row.querySelector(`[name="${name}"]`).value;
    const line = { product_id: Number(value('product_id')), quantity: Number(value('quantity')) };
    if (value('variant_id')) line.variant_id = Number(value('variant_id'));
    if (value('tax_rule_id')) line.tax_rule_id = Number(value('tax_rule_id'));
    if (value('unit_price') !== '') line.unit_price = toPaise(value('unit_price'));
    return line;
  });

  const linesTable = (ctx, record) => {
    const e = ctx.escape;
    if (!record.lines.length) return '<p class="muted">No product lines.</p>';
    return `<div class="table-scroll"><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th>Taxes</th><th>Amount</th></tr></thead><tbody>
      ${record.lines.map(line => `<tr><td>${e(line.product_name)}${line.variant_value ? `<small>${e(line.variant_attribute)}: ${e(line.variant_value)}</small>` : ''}</td>
        <td>${line.quantity}</td><td>${ctx.money(line.unit_price)}</td>
        <td>${line.tax_name ? `${e(line.tax_name)}<small>${ctx.money(line.tax_amount)}</small>` : '—'}</td><td>${ctx.money(line.amount)}</td></tr>`).join('')}
      </tbody><tfoot>
        <tr><td colspan="4">Untaxed amount</td><td>${ctx.money(record.totals.subtotal)}</td></tr>
        <tr><td colspan="4">Taxes</td><td>${ctx.money(record.totals.tax_total)}</td></tr>
        <tr class="grand"><td colspan="4">Total per period</td><td>${ctx.money(record.totals.total)}</td></tr>
      </tfoot></table></div>`;
  };

  // ---------- Customers ----------
  views.customers = async ctx => {
    const e = ctx.escape;
    const { items } = await ctx.api('customers');
    const html = `${ctx.heading('Customers', 'Customer accounts used on quotations and subscriptions.', 'Stage 4 · Subscriptions')}
      <section class="panel form-panel-static"><h2>Add customer</h2><p class="panel-intro">The customer can set a password when they sign in for the first time.</p>
        <form data-action="createCustomer" class="stack"><div class="form-grid three">
          ${field(e, 'Name', 'name', { required: true, attrs: 'maxlength="120" placeholder="Acme Retail"' })}
          ${field(e, 'Email', 'email', { type: 'email', required: true, attrs: 'maxlength="254" placeholder="billing@acme.example"' })}
          <div class="form-actions align-end"><button type="submit">Add customer</button></div>
        </div><span class="form-message" role="status"></span></form></section>
      <section class="panel module-panel"><div class="table-heading"><h2>All customers</h2><span>${items.length} records</span></div>
      ${items.length ? `<div class="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Created</th><th></th></tr></thead><tbody>
        ${items.map(c => `<tr><td>${e(c.name)}</td><td>${e(c.email)}</td><td>${e(c.created_at)}</td>
          <td><a class="link-button" href="#subscriptions/new?customer=${c.id}">New quotation</a></td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('♧', 'No customers yet', 'Add a customer above to prepare their first quotation.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async createCustomer(data) {
          const customer = await ctx.api('customers', { method: 'POST', body: { name: data.get('name'), email: data.get('email') } });
          ctx.notify(`${customer.name} added.`);
          ctx.rerender();
        },
      }, ctx),
    };
  };

  // ---------- Quotation templates ----------
  views.templates = async ctx => {
    const e = ctx.escape;
    const [templates, plans, catalogue] = await Promise.all([ctx.api('quotation-templates'), ctx.api('plans'), loadCatalogue(ctx)]);
    const editing = ctx.id ? templates.items.find(t => t.id === Number(ctx.id)) : null;
    if (ctx.id && !editing) throw new Error('Quotation template not found.');
    const planOptions = [['', 'Select a plan'], ...plans.items.map(p => [p.id, `${p.name} · ${ctx.money(p.price)} ${p.interval} · min ${p.minimum_quantity}`])];
    const form = (template = {}) => `
      <form data-action="${template.id ? 'saveTemplate' : 'createTemplate'}" class="stack">
        <div class="form-grid">
          ${field(e, 'Template name', 'name', { value: template.name, required: true, attrs: 'maxlength="120" placeholder="Enterprise yearly offer"' })}
          ${select(e, 'Plan', 'plan_id', planOptions, template.plan_id, { required: true })}
          ${field(e, 'Valid for (days)', 'validity_days', { type: 'number', value: template.validity_days ?? 30, required: true, attrs: 'min="1" max="3650"' })}
          ${field(e, 'Payment terms (days)', 'payment_terms_days', { type: 'number', value: template.payment_terms_days ?? 14, required: true, attrs: 'min="0" max="365"' })}
        </div>
        ${lineEditor(ctx, catalogue, template.lines ?? [])}
        <div class="form-actions"><button type="submit">${template.id ? 'Save template' : 'Create template'}</button><span class="form-message" role="status"></span></div>
      </form>`;
    const body = (data, formElement) => ({
      name: data.get('name'), plan_id: Number(data.get('plan_id')),
      validity_days: Number(data.get('validity_days')), payment_terms_days: Number(data.get('payment_terms_days')),
      lines: readLines(formElement),
    });
    const setupHint = !plans.items.length || !catalogue.products.length
      ? `<div class="stage-note">Create at least one <a class="row-link" href="#products">product</a> and one <a class="row-link" href="#plans">plan</a> before building templates.</div>` : '';

    const html = editing
      ? `${ctx.heading(e(editing.name), `Based on ${e(editing.plan_name)} · valid for ${editing.validity_days} days`, 'Stage 4 · Subscriptions', '#templates')}
         <section class="panel">${form(editing)}
           <div class="danger-zone"><button type="button" class="secondary danger" data-click="deleteTemplate" data-confirm="Delete this template?">Delete template</button></div></section>`
      : `${ctx.heading('Quotation templates', 'Start quotations from a ready-made plan and product lines.', 'Stage 4 · Subscriptions')}${setupHint}
         <details class="panel form-panel" ${templates.items.length ? '' : 'open'}><summary>+ New template</summary>${form()}</details>
         <section class="panel module-panel"><div class="table-heading"><h2>All templates</h2><span>${templates.items.length} records</span></div>
         ${templates.items.length ? `<div class="table-scroll"><table><thead><tr><th>Template</th><th>Plan</th><th>Lines</th><th>Valid for</th><th>Payment terms</th><th>Total per period</th><th></th></tr></thead><tbody>
           ${templates.items.map(t => `<tr><td><a class="row-link" href="#templates/${t.id}">${e(t.name)}</a></td><td>${e(t.plan_name)}</td>
             <td class="wrap">${t.lines.map(l => `<span class="chip">${l.quantity} × ${e(l.product_name)}${l.variant_value ? ` (${e(l.variant_value)})` : ''}</span>`).join('') || '—'}</td>
             <td>${t.validity_days} days</td><td>${t.payment_terms_days} days</td><td>${ctx.money(t.totals.total)}</td>
             <td><a class="link-button" href="#subscriptions/new?template=${t.id}">Use</a></td></tr>`).join('')}
         </tbody></table></div>` : ctx.empty('❏', 'No templates yet', 'Templates let the team prepare a quotation in a few clicks.')}</section>`;
    return {
      html,
      mount: root => {
        mountLineEditor(root, ctx, catalogue);
        bindForms(root, {
          async createTemplate(data, formElement) {
            await ctx.api('quotation-templates', { method: 'POST', body: body(data, formElement) });
            ctx.notify('Template created.');
            ctx.rerender();
          },
          async saveTemplate(data, formElement) {
            await ctx.api(`quotation-templates/${editing.id}`, { method: 'PATCH', body: body(data, formElement) });
            ctx.notify('Template saved.');
            ctx.rerender();
          },
          async deleteTemplate() {
            await ctx.api(`quotation-templates/${editing.id}`, { method: 'DELETE' });
            ctx.notify('Template deleted.');
            location.hash = '#templates';
          },
        }, ctx);
      },
    };
  };

  // ---------- Subscriptions ----------
  views.subscriptions = async ctx => {
    const [id, search] = (ctx.id ?? '').split('?');
    if (id === 'new') return subscriptionForm(ctx, null, new URLSearchParams(search));
    if (id) return subscriptionDetail(ctx, Number(id));
    return subscriptionList(ctx);
  };

  async function subscriptionList(ctx) {
    const e = ctx.escape;
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const filter = params.get('status') ?? '';
    const data = await ctx.api(`subscriptions${filter ? `?status=${encodeURIComponent(filter)}` : ''}`);
    const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
    const tabs = [['', 'All', total], ...['draft', 'quotation', 'confirmed', 'active', 'paused', 'closed'].map(s => [s, capitalize(s), data.counts[s]])];
    const html = `${ctx.heading('Subscriptions', 'Track every subscription from quotation to renewal.', 'Stage 4 · Subscriptions')}
      <div class="toolbar"><nav class="tabs" aria-label="Filter by status">${tabs.map(([value, label, count]) =>
        `<a class="tab ${value === filter ? 'active' : ''}" href="#subscriptions${value ? `?status=${value}` : ''}">${label}<span>${count}</span></a>`).join('')}</nav>
        <a class="button" href="#subscriptions/new">+ New quotation</a></div>
      <section class="panel module-panel"><div class="table-heading"><h2>${filter ? capitalize(filter) : 'All'} subscriptions</h2><span>${data.items.length} records${data.items.length === data.limit ? ` · first ${data.limit}` : ''}</span></div>
      ${data.items.length ? `<div class="table-scroll"><table><thead><tr><th>Number</th><th>Customer</th><th>Plan</th><th>Status</th><th>Start</th><th>Expiry</th><th>Next billing</th><th>Untaxed / period</th></tr></thead><tbody>
        ${data.items.map(s => `<tr><td><a class="row-link" href="#subscriptions/${s.id}">${e(s.number)}</a></td><td>${e(s.customer)}</td><td>${e(s.plan)}</td>
          <td>${statusPill(s.status)}</td><td>${e(s.start_date)}</td><td>${e(s.expiry_date)}</td><td>${e(s.next_billing_date)}</td><td>${ctx.money(s.subtotal)}</td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('↻', filter ? `No ${filter} subscriptions` : 'No subscriptions yet', 'Create a quotation for a customer, then confirm and activate it.')}</section>`;
    return { html };
  }

  async function subscriptionForm(ctx, existing, params = new URLSearchParams()) {
    const e = ctx.escape;
    const [customers, plans, templates, catalogue] = await Promise.all([
      ctx.api('customers'), ctx.api('plans'), ctx.api('quotation-templates'), loadCatalogue(ctx),
    ]);
    const chosenTemplate = templates.items.find(t => t.id === Number(params.get('template')));
    const values = existing ?? {
      customer_id: Number(params.get('customer')) || null,
      plan_id: chosenTemplate?.plan_id,
      quotation_template_id: chosenTemplate?.id,
      start_date: localToday(),
      payment_terms_days: chosenTemplate?.payment_terms_days ?? 14,
      valid_until: chosenTemplate ? addDays(localToday(), chosenTemplate.validity_days) : '',
      lines: chosenTemplate?.lines ?? [],
    };
    const missing = [
      !customers.items.length && '<a class="row-link" href="#customers">a customer</a>',
      !plans.items.length && '<a class="row-link" href="#plans">a plan</a>',
      !catalogue.products.length && '<a class="row-link" href="#products">a product</a>',
    ].filter(Boolean);
    const html = `${ctx.heading(existing ? `Edit ${e(existing.number)}` : 'New quotation', existing ? 'Draft and quotation subscriptions can still be changed.' : 'Choose a customer and plan, or start from a template.', 'Stage 4 · Subscriptions', existing ? `#subscriptions/${existing.id}` : '#subscriptions')}
      ${missing.length ? `<div class="stage-note">Create ${missing.join(', ')} first.</div>` : ''}
      <section class="panel"><form data-action="saveSubscription" class="stack">
        <div class="form-grid">
          ${existing ? '' : select(e, 'Start from template', 'template_id', [['', 'No template'], ...templates.items.map(t => [t.id, `${t.name} · ${t.plan_name}`])], values.quotation_template_id)}
          ${select(e, 'Customer', 'customer_id', [['', 'Select a customer'], ...customers.items.map(c => [c.id, `${c.name} · ${c.email}`])], values.customer_id, { required: true })}
          ${select(e, 'Plan', 'plan_id', [['', 'Select a plan'], ...plans.items.map(p => [p.id, `${p.name} · ${ctx.money(p.price)} ${p.interval} · min ${p.minimum_quantity}`])], values.plan_id, { required: true })}
          ${field(e, 'Start date', 'start_date', { type: 'date', value: values.start_date, required: true })}
          ${field(e, 'Expiry date', 'expiry_date', { type: 'date', value: values.expiry_date, hint: 'Needed for renewal and automatic closing.' })}
          ${field(e, 'Quotation valid until', 'valid_until', { type: 'date', value: values.valid_until })}
          ${field(e, 'Payment terms (days)', 'payment_terms_days', { type: 'number', value: values.payment_terms_days, required: true, attrs: 'min="0" max="365"' })}
        </div>
        ${lineEditor(ctx, catalogue, values.lines)}
        <label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="2000">${e(values.notes ?? '')}</textarea></label>
        <div class="form-actions"><button type="submit">${existing ? 'Save changes' : 'Create quotation'}</button><span class="form-message" role="status"></span></div>
      </form></section>`;
    return {
      html,
      mount: root => {
        mountLineEditor(root, ctx, catalogue);
        // Choosing a template fills in its plan, terms, validity and lines.
        root.querySelector('[name="template_id"]')?.addEventListener('change', event => {
          const id = event.target.value;
          location.hash = `#subscriptions/new?${new URLSearchParams({ ...(id && { template: id }), ...(root.querySelector('[name="customer_id"]').value && { customer: root.querySelector('[name="customer_id"]').value }) })}`;
        });
        bindForms(root, {
          async saveSubscription(data, form) {
            const body = {
              customer_id: Number(data.get('customer_id')), plan_id: Number(data.get('plan_id')),
              start_date: data.get('start_date'), expiry_date: data.get('expiry_date') || null,
              valid_until: data.get('valid_until') || null, payment_terms_days: Number(data.get('payment_terms_days')),
              notes: data.get('notes') ?? '', lines: readLines(form),
            };
            if (!existing && data.get('template_id')) body.template_id = Number(data.get('template_id'));
            const saved = await ctx.api(existing ? `subscriptions/${existing.id}` : 'subscriptions', { method: existing ? 'PATCH' : 'POST', body });
            ctx.notify(existing ? 'Changes saved.' : `${saved.number} created as a draft.`);
            location.hash = `#subscriptions/${saved.id}`;
          },
        }, ctx);
      },
    };
  }

  async function subscriptionDetail(ctx, id) {
    const e = ctx.escape;
    if (location.hash.endsWith('/edit')) {
      const existing = await ctx.api(`subscriptions/${id}`);
      return subscriptionForm(ctx, existing);
    }
    const [s, invoices] = await Promise.all([ctx.api(`subscriptions/${id}`), ctx.api(`invoices?subscription_id=${id}`)]);
    const stepIndex = s.status === 'paused' ? FLOW.indexOf('active') : FLOW.indexOf(s.status);
    const editable = ['draft', 'quotation'].includes(s.status);
    const policies = [s.plan.auto_close && 'closes automatically at expiry', s.plan.allow_pause && 'can pause', s.plan.allow_renew && 'can renew', s.plan.allow_close && 'can close early'].filter(Boolean);
    const html = `${ctx.heading(`${e(s.number)} ${statusPill(s.status)}`, `${e(s.customer_name)} · ${e(s.plan_name)}`, 'Stage 4 · Subscriptions', '#subscriptions')}
      <ol class="stepper" aria-label="Subscription status">${FLOW.map((step, index) =>
        `<li class="${index < stepIndex ? 'done' : index === stepIndex ? 'current' : ''}">${capitalize(step)}${step === 'active' && s.status === 'paused' ? ' (paused)' : ''}</li>`).join('')}</ol>
      <div class="action-bar">
        ${s.allowed_actions.map(action => `<button type="button" class="${['close'].includes(action) ? 'secondary danger' : action === 'pause' ? 'secondary' : ''}" data-click="runAction" data-action-name="${action}" ${ACTION_CONFIRM[action] ? `data-confirm="${ACTION_CONFIRM[action]}"` : ''}>${ACTION_LABELS[action]}</button>`).join('')}
        ${editable ? `<a class="button secondary-link" href="#subscriptions/${s.id}/edit">Edit</a>` : ''}
        ${s.status === 'draft' ? '<button type="button" class="secondary danger" data-click="deleteSubscription" data-confirm="Delete this draft?">Delete draft</button>' : ''}
      </div>
      <div class="two-column">
        <section class="panel"><h2>Product lines</h2><p class="panel-intro">Billed ${e(s.plan.interval)} · prices in INR</p>${linesTable(ctx, s)}
          ${s.notes ? `<p class="note"><strong>Notes:</strong> ${e(s.notes)}</p>` : ''}</section>
        <section class="panel"><h2>Details</h2><p class="panel-intro">Plan policy: ${policies.join(', ') || 'no lifecycle actions'}</p>
          ${[['Customer', `${e(s.customer_name)}<small>${e(s.customer_email)}</small>`], ['Plan', e(s.plan_name)], ['Template', e(s.template_name)],
            ['Start date', e(s.start_date)], ['Expiry date', e(s.expiry_date)], ['Quotation valid until', e(s.valid_until)],
            ['Next billing date', e(s.next_billing_date)], ['Payment terms', `${s.payment_terms_days} days`]]
            .map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`).join('')}
          <h2 class="history-title">History</h2>
          <ol class="timeline">${s.events.map(ev => `<li><strong>${ev.action === 'create' ? 'Created' : ev.action === 'auto_close' ? 'Closed automatically' : ACTION_LABELS[ev.action] ?? ev.action}</strong>
            ${ev.from_status === ev.to_status ? '' : `${ev.from_status ? `${capitalize(ev.from_status)} → ` : ''}${capitalize(ev.to_status)}`}${ev.note ? `${ev.from_status === ev.to_status ? '' : ' · '}${e(ev.note)}` : ''}<small>${e(ev.created_at)} UTC${ev.user_name ? ` · ${e(ev.user_name)}` : ''}</small></li>`).join('')}</ol>
        </section>
      </div>
      <section class="panel module-panel"><div class="table-heading"><h2>Invoices</h2><span>${invoices.items.length} records</span></div>
      ${invoices.items.length ? `<div class="table-scroll"><table><thead><tr><th>Invoice</th><th>Period</th><th>Status</th><th>Due date</th><th>Total</th><th>Balance</th></tr></thead><tbody>
        ${window.BrightloopUI.invoiceRows(ctx, invoices.items)}</tbody></table></div>`
        : ctx.empty('▧', 'No invoices yet', s.next_billing_date ? `The first invoice is created on ${e(s.next_billing_date)}.` : 'Invoices are created once the subscription is active.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async runAction(dataset) {
          const updated = await ctx.api(`subscriptions/${id}/actions/${dataset.actionName}`, { method: 'POST' });
          ctx.notify(`${updated.number} is now ${updated.status}.`);
          ctx.rerender();
        },
        async deleteSubscription() {
          await ctx.api(`subscriptions/${id}`, { method: 'DELETE' });
          ctx.notify('Draft deleted.');
          location.hash = '#subscriptions';
        },
      }, ctx),
    };
  }
})();
