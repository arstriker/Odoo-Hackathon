// Management screens. Each view returns { html, mount } and is rendered by app.js for its hash route.
// Loaded before app.js so the views are registered before the first render.
(() => {
  const views = (window.BrightloopViews = {});
  const INTERVALS = ['daily', 'weekly', 'monthly', 'yearly'];
  const POLICIES = [
    ['auto_close', 'Close automatically when it ends'],
    ['allow_close', 'Can be closed early'],
    ['allow_pause', 'Can be paused'],
    ['allow_renew', 'Can be renewed'],
  ];

  // ₹ in forms, paise in the API.
  const toPaise = value => Math.round(Number(value || 0) * 100);
  const toRupees = paise => (paise / 100).toFixed(2).replace(/\.00$/, '');

  const field = (e, label, name, { type = 'text', value = '', required = false, attrs = '', hint = '' } = {}) => `
    <label class="field"><span>${label}${required ? ' <b aria-hidden="true">*</b>' : ''}</span>
      <input type="${type}" name="${name}" value="${e(value ?? '')}" ${required ? 'required' : ''} ${attrs}>
      ${hint ? `<small>${hint}</small>` : ''}</label>`;
  const moneyField = (e, label, name, paise, opts = {}) =>
    field(e, label, name, { ...opts, type: 'number', value: paise == null ? '' : toRupees(paise), attrs: `step="0.01" ${opts.min === false ? '' : 'min="0"'} inputmode="decimal"` });
  const select = (e, label, name, options, selected, { required = false } = {}) => `
    <label class="field"><span>${label}${required ? ' <b aria-hidden="true">*</b>' : ''}</span>
      <select name="${name}" ${required ? 'required' : ''}>${options.map(([value, text]) =>
        `<option value="${e(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${e(text)}</option>`).join('')}</select></label>`;
  const checkbox = (e, label, name, checked) =>
    `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${e(label)}</label>`;
  const status = (text, tone = '') => `<span class="pill ${tone}">${text}</span>`;
  const capitalize = value => value.charAt(0).toUpperCase() + value.slice(1);

  // Submits a form through its data-action handler; shows the API error inline when the request fails.
  function bindForms(root, handlers, ctx) {
    root.addEventListener('submit', async event => {
      const form = event.target.closest('form[data-action]');
      if (!form) return;
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const message = form.querySelector('.form-message');
      if (button) button.disabled = true;
      if (message) { message.textContent = ''; message.className = 'form-message'; }
      try {
        await handlers[form.dataset.action](new FormData(form), form);
      } catch (error) {
        if (message) { message.textContent = error.message; message.className = 'form-message error-text'; }
        else ctx.notify(error.message, 'error');
      } finally {
        if (button) button.disabled = false;
      }
    });
    root.addEventListener('click', async event => {
      const button = event.target.closest('button[data-click]');
      if (!button) return;
      if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
      button.disabled = true;
      try { await handlers[button.dataset.click](button.dataset, button); }
      catch (error) { ctx.notify(error.message, 'error'); }
      finally { button.disabled = false; }
    });
  }

  // ---------- Products ----------
  const productForm = (e, product = {}) => `
    <div class="form-grid">
      ${field(e, 'Product name', 'name', { value: product.name, required: true, attrs: 'maxlength="120"' })}
      ${field(e, 'Type', 'type', { value: product.type ?? 'software', attrs: 'maxlength="60" list="product-types"' })}
      ${moneyField(e, 'Sales price (₹)', 'sales_price', product.sales_price, { required: true })}
      ${moneyField(e, 'Cost price (₹)', 'cost_price', product.cost_price ?? 0)}
    </div>
    <datalist id="product-types"><option value="software"><option value="add-on"><option value="service"><option value="hardware"></datalist>
    <label class="field"><span>Notes</span><textarea name="notes" rows="3" maxlength="2000">${e(product.notes ?? '')}</textarea></label>`;
  const productBody = data => ({
    name: data.get('name'), type: data.get('type') || 'software', notes: data.get('notes') ?? '',
    sales_price: toPaise(data.get('sales_price')), cost_price: toPaise(data.get('cost_price')),
  });
  const variantLabel = (ctx, variant) => `${variant.attribute}: ${variant.value} (${variant.price_adjustment >= 0 ? '+' : '−'}${ctx.money(Math.abs(variant.price_adjustment))})`;

  views.products = async ctx => {
    const e = ctx.escape;
    if (ctx.id) return productDetail(ctx, Number(ctx.id));
    const { items } = await ctx.api('products');
    const html = `${ctx.heading('Products', 'Organize your software products, prices and variants.', 'Stage 3 · Catalogue')}
      <details class="panel form-panel" ${items.length ? '' : 'open'}><summary>+ New product</summary>
        <form data-action="createProduct" class="stack">
          ${productForm(e)}
          <fieldset class="variants-input"><legend>First variant <small>Optional. For example Brand: Odoo adds ₹560.</small></legend>
            <div class="form-grid three">
              ${field(e, 'Attribute', 'variant_attribute', { attrs: 'maxlength="60" placeholder="Brand"' })}
              ${field(e, 'Value', 'variant_value', { attrs: 'maxlength="60" placeholder="Odoo"' })}
              ${moneyField(e, 'Price change (₹)', 'variant_adjustment', null, { min: false })}
            </div>
          </fieldset>
          <div class="form-actions"><button type="submit">Create product</button><span class="form-message" role="status"></span></div>
        </form></details>
      <section class="panel module-panel"><div class="table-heading"><h2>All products</h2><span>${items.length} records</span></div>
      ${items.length ? `<div class="table-scroll"><table><thead><tr><th>Product</th><th>Type</th><th>Sales price</th><th>Cost price</th><th>Variants</th><th>Status</th><th></th></tr></thead><tbody>
        ${items.map(product => `<tr>
          <td><a class="row-link" href="#products/${product.id}">${e(product.name)}</a></td><td>${e(product.type)}</td>
          <td>${ctx.money(product.sales_price)}</td><td>${ctx.money(product.cost_price)}</td>
          <td class="wrap">${product.variants.length ? product.variants.map(variant => `<span class="chip">${e(variantLabel(ctx, variant))}</span>`).join('') : '—'}</td>
          <td>${product.active ? status('Active', 'good') : status('Archived')}</td>
          <td><a class="link-button" href="#products/${product.id}">Edit</a></td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('◇', 'No products yet', 'Create your first product above to start building plans and quotations.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async createProduct(data) {
          const body = productBody(data);
          const attribute = data.get('variant_attribute')?.trim();
          const value = data.get('variant_value')?.trim();
          if (attribute || value) body.variants = [{ attribute, value, price_adjustment: toPaise(data.get('variant_adjustment')) }];
          const product = await ctx.api('products', { method: 'POST', body });
          ctx.notify(`${product.name} created.`);
          ctx.rerender();
        },
      }, ctx),
    };
  };

  async function productDetail(ctx, id) {
    const e = ctx.escape;
    const product = await ctx.api(`products/${id}`);
    const html = `${ctx.heading(e(product.name), `${e(capitalize(product.type))} · ${product.active ? 'Active' : 'Archived'} product`, 'Stage 3 · Catalogue', '#products')}
      <div class="two-column">
        <section class="panel"><h2>Product details</h2><p class="panel-intro">Price changes apply to new quotations and subscriptions.</p>
          <form data-action="saveProduct" class="stack">${productForm(e, product)}
            <label class="check"><input type="checkbox" name="active" ${product.active ? 'checked' : ''}> Available for new quotations</label>
            <div class="form-actions"><button type="submit">Save changes</button><span class="form-message" role="status"></span></div>
          </form>
          <div class="danger-zone"><button type="button" class="secondary danger" data-click="deleteProduct" data-confirm="Delete ${e(product.name)}? Products already used on subscriptions are archived instead.">Delete product</button></div>
        </section>
        <section class="panel"><h2>Variants</h2><p class="panel-intro">Each variant changes the sales price, for example Brand: Odoo adds ₹560.</p>
          ${product.variants.length ? `<ul class="variant-list">${product.variants.map(variant => `<li>
            <div><strong>${e(variant.attribute)}: ${e(variant.value)}</strong><small>Price ${ctx.money(product.sales_price)} ${variant.price_adjustment >= 0 ? '+' : '−'} ${ctx.money(Math.abs(variant.price_adjustment))} = ${ctx.money(Math.max(0, product.sales_price + variant.price_adjustment))}</small></div>
            <button type="button" class="secondary" data-click="deleteVariant" data-id="${variant.id}" data-confirm="Remove this variant?">Remove</button></li>`).join('')}</ul>`
            : '<p class="muted">No variants yet.</p>'}
          <form data-action="addVariant" class="stack variant-form">
            <div class="form-grid three">
              ${field(e, 'Attribute', 'attribute', { required: true, attrs: 'maxlength="60" placeholder="Brand"' })}
              ${field(e, 'Value', 'value', { required: true, attrs: 'maxlength="60" placeholder="Odoo"' })}
              ${moneyField(e, 'Price change (₹)', 'price_adjustment', 0, { min: false })}
            </div>
            <div class="form-actions"><button type="submit">Add variant</button><span class="form-message" role="status"></span></div>
          </form>
        </section>
      </div>`;
    return {
      html,
      mount: root => bindForms(root, {
        async saveProduct(data) {
          await ctx.api(`products/${id}`, { method: 'PATCH', body: { ...productBody(data), active: data.has('active') } });
          ctx.notify('Product saved.');
          ctx.rerender();
        },
        async addVariant(data, form) {
          await ctx.api(`products/${id}/variants`, { method: 'POST', body: { attribute: data.get('attribute'), value: data.get('value'), price_adjustment: toPaise(data.get('price_adjustment')) } });
          form.reset();
          ctx.notify('Variant added.');
          ctx.rerender();
        },
        async deleteVariant({ id: variantId }) {
          await ctx.api(`variants/${variantId}`, { method: 'DELETE' });
          ctx.notify('Variant removed.');
          ctx.rerender();
        },
        async deleteProduct() {
          const result = await ctx.api(`products/${id}`, { method: 'DELETE' });
          ctx.notify(result.archived ? 'The product is used on existing records, so it was archived.' : 'Product deleted.');
          location.hash = result.archived ? `#products/${id}` : '#products';
          if (result.archived) ctx.rerender();
        },
      }, ctx),
    };
  }

  // ---------- Plans ----------
  const intervalLabel = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
  const availability = plan => plan.available_from || plan.available_until
    ? `${plan.available_from ?? 'Any time'} → ${plan.available_until ?? 'No end'}` : 'Always';
  const planForm = (e, plan = {}) => `
    <div class="form-grid">
      ${field(e, 'Plan name', 'name', { value: plan.name, required: true, attrs: 'maxlength="120" placeholder="Business monthly"' })}
      ${moneyField(e, 'Price per period (₹)', 'price', plan.price, { required: true })}
      ${select(e, 'Billing frequency', 'interval', INTERVALS.map(value => [value, intervalLabel[value]]), plan.interval ?? 'monthly', { required: true })}
      ${field(e, 'Minimum quantity', 'minimum_quantity', { type: 'number', value: plan.minimum_quantity ?? 1, required: true, attrs: 'min="1" step="1"' })}
      ${field(e, 'Available from', 'available_from', { type: 'date', value: plan.available_from })}
      ${field(e, 'Available until', 'available_until', { type: 'date', value: plan.available_until, hint: 'Leave empty to keep the plan open.' })}
    </div>
    <fieldset><legend>Lifecycle settings</legend><div class="check-grid">
      ${POLICIES.map(([key, label]) => checkbox(e, label, key, plan[key] ?? (key === 'auto_close' ? 0 : 1))).join('')}
    </div></fieldset>`;
  const planBody = data => ({
    name: data.get('name'), price: toPaise(data.get('price')), interval: data.get('interval'),
    minimum_quantity: Number(data.get('minimum_quantity')),
    available_from: data.get('available_from') || null, available_until: data.get('available_until') || null,
    ...Object.fromEntries(POLICIES.map(([key]) => [key, data.has(key)])),
  });
  const policySummary = plan => POLICIES.filter(([key]) => plan[key]).map(([key]) =>
    ({ auto_close: 'Auto-close', allow_close: 'Close', allow_pause: 'Pause', allow_renew: 'Renew' })[key]);

  views.plans = async ctx => {
    const e = ctx.escape;
    if (ctx.id) return planDetail(ctx, Number(ctx.id));
    const { items } = await ctx.api('plans');
    const html = `${ctx.heading('Plans', 'Define recurring prices, billing intervals and plan policies.', 'Stage 3 · Catalogue')}
      <details class="panel form-panel" ${items.length ? '' : 'open'}><summary>+ New plan</summary>
        <form data-action="createPlan" class="stack">${planForm(e)}
          <div class="form-actions"><button type="submit">Create plan</button><span class="form-message" role="status"></span></div>
        </form></details>
      <section class="panel module-panel"><div class="table-heading"><h2>All plans</h2><span>${items.length} records</span></div>
      ${items.length ? `<div class="table-scroll"><table><thead><tr><th>Plan</th><th>Price</th><th>Billing</th><th>Min. qty</th><th>Available</th><th>Allowed actions</th><th>Running</th><th></th></tr></thead><tbody>
        ${items.map(plan => `<tr>
          <td><a class="row-link" href="#plans/${plan.id}">${e(plan.name)}</a></td><td>${ctx.money(plan.price)}</td><td>${intervalLabel[plan.interval]}</td>
          <td>${plan.minimum_quantity}</td><td>${e(availability(plan))}</td>
          <td class="wrap">${policySummary(plan).map(label => `<span class="chip">${label}</span>`).join('') || '—'}</td>
          <td>${plan.active_subscriptions}</td>
          <td><a class="link-button" href="#plans/${plan.id}">Edit</a></td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('▤', 'No plans yet', 'Create a plan with its price, billing frequency and lifecycle settings.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async createPlan(data) {
          const plan = await ctx.api('plans', { method: 'POST', body: planBody(data) });
          ctx.notify(`${plan.name} created.`);
          ctx.rerender();
        },
      }, ctx),
    };
  };

  async function planDetail(ctx, id) {
    const e = ctx.escape;
    const plan = await ctx.api(`plans/${id}`);
    const html = `${ctx.heading(e(plan.name), `${ctx.money(plan.price)} billed ${plan.interval}`, 'Stage 3 · Catalogue', '#plans')}
      <section class="panel"><form data-action="savePlan" class="stack">${planForm(e, plan)}
        <div class="form-actions"><button type="submit">Save changes</button><span class="form-message" role="status"></span></div></form>
        <div class="danger-zone"><button type="button" class="secondary danger" data-click="deletePlan" data-confirm="Delete ${e(plan.name)}?">Delete plan</button>
        <small>Plans that are already in use can't be deleted. Set an available-until date to retire them.</small></div>
      </section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async savePlan(data) {
          await ctx.api(`plans/${id}`, { method: 'PATCH', body: planBody(data) });
          ctx.notify('Plan saved.');
          ctx.rerender();
        },
        async deletePlan() {
          await ctx.api(`plans/${id}`, { method: 'DELETE' });
          ctx.notify('Plan deleted.');
          location.hash = '#plans';
        },
      }, ctx),
    };
  }

  // ---------- Settings: tax rules ----------
  views.settings = async ctx => {
    const e = ctx.escape;
    const { items } = await ctx.api('tax-rules');
    const html = `${ctx.heading('Settings', 'Configure tax rules used on quotations, subscriptions and invoices.', 'Stage 3 · Catalogue')}
      <section class="panel form-panel-static"><h2>New tax rule</h2>
        <form data-action="createTax" class="stack">
          <div class="form-grid three">
            ${field(e, 'Name', 'name', { required: true, attrs: 'maxlength="80" placeholder="GST 18%"' })}
            ${field(e, 'Rate (%)', 'rate', { type: 'number', required: true, attrs: 'min="0" max="100" step="0.01" placeholder="18"' })}
            <div class="form-actions align-end"><button type="submit">Add tax rule</button></div>
          </div><span class="form-message" role="status"></span>
        </form></section>
      <section class="panel module-panel"><div class="table-heading"><h2>Tax rules</h2><span>${items.length} records</span></div>
      ${items.length ? `<div class="table-scroll"><table><thead><tr><th>Tax rule</th><th>Rate</th><th>Status</th><th></th></tr></thead><tbody>
        ${items.map(rule => `<tr><td>${e(rule.name)}</td><td>${rule.rate_basis_points / 100}%</td>
          <td>${rule.active ? status('Active', 'good') : status('Inactive')}</td>
          <td class="actions"><button type="button" class="secondary" data-click="toggleTax" data-id="${rule.id}" data-active="${rule.active}">${rule.active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" class="secondary danger" data-click="deleteTax" data-id="${rule.id}" data-confirm="Delete ${e(rule.name)}? Rules already used on lines are deactivated instead.">Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : ctx.empty('⚙', 'No tax rules yet', 'Add a tax rule such as GST 18% to apply it to product lines.')}</section>`;
    return {
      html,
      mount: root => bindForms(root, {
        async createTax(data) {
          await ctx.api('tax-rules', { method: 'POST', body: { name: data.get('name'), rate_basis_points: Math.round(Number(data.get('rate')) * 100) } });
          ctx.notify('Tax rule added.');
          ctx.rerender();
        },
        async toggleTax({ id, active }) {
          await ctx.api(`tax-rules/${id}`, { method: 'PATCH', body: { active: active !== '1' } });
          ctx.rerender();
        },
        async deleteTax({ id }) {
          const result = await ctx.api(`tax-rules/${id}`, { method: 'DELETE' });
          ctx.notify(result.archived ? 'The tax rule is in use, so it was deactivated.' : 'Tax rule deleted.');
          ctx.rerender();
        },
      }, ctx),
    };
  };
})();
