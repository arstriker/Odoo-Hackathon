const modules = {
  overview: { title: 'Overview', icon: '◫' },
  finance: { title: 'Finance & Reports', icon: '📊', stage: 7, description: 'Executive dashboard for active subscriptions, cash collection, outstanding balances and overdue invoices.' },
  customers: { title: 'Customers', icon: '♧', stage: 2, description: 'Customer accounts and contact details will live here.', columns: ['Name','Email','Created'], fields: ['name','email','created_at'] },
  staff: { title: 'Staff', icon: '🛡', stage: 2, description: 'Manage internal staff accounts and access permissions.' },
  products: { title: 'Products', icon: '◇', stage: 3, description: 'Organize your software products, prices and variants.', columns: ['Product','Type','Sales price','Cost price'], fields: ['name','type','sales_price','cost_price'] },
  plans: { title: 'Plans', icon: '▤', stage: 3, description: 'Define recurring prices, billing intervals and plan policies.', columns: ['Plan','Price','Billing interval','Minimum quantity'], fields: ['name','price','interval','minimum_quantity'] },
  templates: { title: 'Quotation templates', icon: '❏', stage: 4, description: 'Reusable quotations with a plan, product lines and validity.', columns: [], fields: [] },
  subscriptions: { title: 'Subscriptions', icon: '↻', stage: 4, description: 'Track every subscription from quotation to renewal.', columns: ['Number','Customer','Plan','Status','Next billing'], fields: ['number','customer','plan','status','next_billing_date'] },
  invoices: { title: 'Invoices', icon: '▧', stage: 5, description: 'Recurring invoices, taxes and outstanding balances in one place.', columns: ['Invoice','Customer','Status','Due date','Total'], fields: ['number','customer_name','status','due_date','total'] },
  payments: { title: 'Payments', icon: '↗', stage: 6, description: 'Record incoming payments and match them to invoices.', columns: ['Invoice','Method','Amount','Date'], fields: ['invoice','method','amount','payment_date'] },
  discounts: { title: 'Discounts', icon: '%', stage: 6, description: 'Manage offers, eligibility rules and discount usage limits.', columns: ['Name','Type','Value','Uses'], fields: ['name','type','value','usage_count'] },
  settings: { title: 'Settings', icon: '⚙', stage: 3, description: 'Configure tax rules and workspace preferences.', columns: ['Tax rule','Rate','Active'], fields: ['name','rate_basis_points','active'] },
};
let content = document.querySelector('#content');
const escape = (value) => String(value ?? '—').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR',maximumFractionDigits:2}).format(value/100);
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api/${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('The server could not be reached. Check that the backend is running.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The server could not complete this request.');
  return data;
}
const heading = (title, description, badge = 'Stage 1 · Foundation', back) => `<div class="page-heading"><div>${back ? `<a class="back-link" href="${back}">← Back</a>` : '<p class="eyebrow">YOUR WORKSPACE, CONNECTED</p>'}<h1>${title}</h1><p class="subtitle">${description}</p></div><span class="badge">${badge}</span></div>`;
const empty = (icon, title, text) => `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><h2>${title}</h2><p>${text}</p></div>`;
let toastTimer;
function notify(message, tone = 'success') {
  let toast = document.querySelector('#toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; toast.setAttribute('role', 'status'); document.body.append(toast); }
  toast.textContent = message;
  toast.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}
function overview(data, health) {
  const cards = [
    ['Customers', data.counts.customers, 'Customer accounts', '♧'],
    ['Subscriptions', data.counts.subscriptions, 'Across all lifecycle stages', '↻'],
    ['Invoices', data.counts.invoices, 'Draft, confirmed, paid', '▧'],
    ['Payments', data.counts.payments, 'Recorded incoming payments', '↗']
  ];
  return `${heading('Workspace overview','A clear view of your subscription business.')}<section class="hero"><p class="eyebrow">BUILT FOR RECURRING BUSINESS</p><h2>Every subscription.<br>One connected workspace.</h2><p>Your foundation is ready. Track active subscriptions, collect revenue, and manage recurring billing.</p><div style="display:flex; gap:1rem;"><a href="#finance">Open finance dashboard <span aria-hidden="true">↗</span></a><a href="#invoices">Manage invoices <span aria-hidden="true">↗</span></a></div></section><section class="stats" aria-label="Workspace totals">${cards.map(([label,value,note,icon])=>`<article class="stat"><div class="stat-label">${label}<span aria-hidden="true">${icon}</span></div><div class="stat-value">${value}</div><small>${note}</small></article>`).join('')}</section><div class="two-column"><section class="panel"><h2>Subscription operations</h2><p class="panel-intro">Stage 07 / 08 · Billing, Payments & Finance</p>${[['Recurring Invoicing','Catch-up billing with period calculation and tax/discount snapshots.'],['Payment Processing','Payment collection with multi-method tracking and auto-settlement.'],['Finance Analytics','Real-time KPIs, receivables aging and sub-second performance.']].map(([title,note])=>`<div class="check-row"><span class="check-icon" aria-hidden="true">✓</span><div><strong>${title}</strong><small>${note}</small></div></div>`).join('')}</section><section class="panel"><h2>System status</h2><p class="panel-intro">Your local development environment</p><div class="connection"><span>Database connection</span><span><span class="pulse"></span>${escape(health.database)}</span></div><div class="detail-row"><span>Storage engine</span><strong>SQLite</strong></div><div class="detail-row"><span>Schema version</span><strong>v${health.schemaVersion}</strong></div><div class="detail-row"><span>Workspace currency</span><strong>INR · ₹</strong></div><p class="note">Performance indexes enabled for sub-second responses with thousands of subscriptions.</p></section></div>`;
}
function format(field, value, item) {
  if (['sales_price','cost_price','price','total','amount'].includes(field)) return money(value);
  if (field === 'rate_basis_points' || (field === 'value' && item.type === 'percentage')) return `${value/100}%`;
  if (field === 'value' && item.type === 'fixed') return money(value);
  if (field === 'active') return value ? 'Yes' : 'No';
  return value;
}
function moduleView(key, data) {
  const module = modules[key];
  return `${heading(module.title,module.description)}<section class="panel module-panel"><div class="table-heading"><h2>${key === 'settings' ? 'Tax rules' : 'All '+module.title.toLowerCase()}</h2><span>${data.items.length} records${data.items.length === data.limit ? ' · first '+data.limit : ''}</span></div>${data.items.length ? `<div class="table-scroll"><table><thead><tr>${module.columns.map(col=>`<th scope="col">${col}</th>`).join('')}</tr></thead><tbody>${data.items.map(item=>`<tr>${module.fields.map(field=>`<td>${escape(format(field,item[field],item))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="empty"><div class="empty-icon" aria-hidden="true">${module.icon}</div><h2>No ${key === 'settings' ? 'tax rules' : key} yet</h2><p>${module.description} This workspace starts with an empty database.</p></div>`}</section><div class="stage-note"><strong>Coming in Stage ${module.stage}.</strong> ${key === 'customers' ? 'Registration, login and account permissions' : key === 'settings' ? 'Tax configuration' : module.title+' management'} will be implemented there. This screen currently shows records from the database.</div>`;
}
let revision = 0;
async function render() {
  const current = ++revision;
  // Hash routes look like #plans, #plans/3, #subscriptions?status=active or #subscriptions/new?template=2.
  const [routePart, id] = location.hash.slice(1).split('/');
  const route = routePart.split('?')[0];
  const key = Object.hasOwn(modules, route) ? route : 'overview';
  const view = window.BrightloopViews?.[key];
  const title = modules[key].title;
  document.title = `${title} · Brightloop`;
  document.querySelector('#breadcrumb').textContent = title;
  const user = window.BrightloopAuth?.currentUser;
  const visibleModules = Object.entries(modules).filter(([name]) => {
    if (user?.role === 'customer') {
      return ['overview', 'subscriptions', 'invoices', 'payments'].includes(name);
    }
    if (user?.role === 'staff') {
      return name !== 'staff';
    }
    return true;
  });
  document.querySelector('#navigation').innerHTML = visibleModules.map(([name,item])=>`<a class="nav-link ${name === key ? 'active' : ''}" ${name === key ? 'aria-current="page"' : ''} href="#${name}"><span class="nav-icon" aria-hidden="true">${item.icon}</span>${item.title}</a>`).join('');
  content.innerHTML = '<p class="subtitle" role="status">Loading workspace…</p>';
  try {
    if (view) {
      const result = await view({ id, api, escape, money, heading, empty, notify, rerender: render });
      if (current !== revision) return;
      // Replacing the node drops listeners bound by the previous view.
      const fresh = content.cloneNode(false);
      fresh.innerHTML = result.html;
      content.replaceWith(fresh);
      content = fresh;
      result.mount?.(fresh);
      return;
    }
    const html = key === 'overview' ? await Promise.all([api('overview'),api('health')]).then(([data,health])=>overview(data,health)) : moduleView(key,await api(key));
    if (current === revision) content.innerHTML = html;
  } catch (error) {
    if (current === revision) { content.innerHTML = `<div class="error" role="alert">${escape(error.message)} <button id="retry">Retry</button></div>`; document.querySelector('#retry').onclick = render; }
  }
}
window.addEventListener('hashchange',render);
window.addEventListener('auth-changed',render);
render();
