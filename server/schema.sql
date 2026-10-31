PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT, role TEXT NOT NULL CHECK(role IN ('admin','staff','customer')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'software',
 sales_price INTEGER NOT NULL CHECK(sales_price >= 0), cost_price INTEGER NOT NULL DEFAULT 0 CHECK(cost_price >= 0),
 notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS product_variants (
 id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
 attribute TEXT NOT NULL, value TEXT NOT NULL, price_adjustment INTEGER NOT NULL DEFAULT 0,
 UNIQUE(product_id, attribute, value)
);
CREATE TABLE IF NOT EXISTS plans (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
 interval TEXT NOT NULL CHECK(interval IN ('daily','weekly','monthly','yearly')),
 minimum_quantity INTEGER NOT NULL DEFAULT 1 CHECK(minimum_quantity > 0),
 available_from TEXT, available_until TEXT,
 auto_close INTEGER NOT NULL DEFAULT 0 CHECK(auto_close IN (0,1)),
 allow_close INTEGER NOT NULL DEFAULT 1 CHECK(allow_close IN (0,1)),
 allow_pause INTEGER NOT NULL DEFAULT 1 CHECK(allow_pause IN (0,1)),
 allow_renew INTEGER NOT NULL DEFAULT 1 CHECK(allow_renew IN (0,1)),
 CHECK(available_until IS NULL OR available_from IS NULL OR available_until >= available_from)
);
CREATE TABLE IF NOT EXISTS tax_rules (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, rate_basis_points INTEGER NOT NULL CHECK(rate_basis_points BETWEEN 0 AND 10000),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS quotation_templates (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan_id INTEGER NOT NULL REFERENCES plans(id),
 validity_days INTEGER NOT NULL DEFAULT 30 CHECK(validity_days > 0)
);
CREATE TABLE IF NOT EXISTS quotation_template_lines (
 id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES quotation_templates(id) ON DELETE CASCADE,
 product_id INTEGER NOT NULL REFERENCES products(id), variant_id INTEGER REFERENCES product_variants(id),
 quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price INTEGER NOT NULL CHECK(unit_price >= 0), tax_rule_id INTEGER REFERENCES tax_rules(id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, customer_id INTEGER NOT NULL REFERENCES users(id),
 plan_id INTEGER NOT NULL REFERENCES plans(id), status TEXT NOT NULL DEFAULT 'draft'
 CHECK(status IN ('draft','quotation','confirmed','active','paused','closed')),
 start_date TEXT NOT NULL, expiry_date TEXT, next_billing_date TEXT,
 payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK(payment_terms_days >= 0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(expiry_date IS NULL OR expiry_date >= start_date)
);
CREATE TABLE IF NOT EXISTS subscription_lines (
 id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
 product_id INTEGER NOT NULL REFERENCES products(id), variant_id INTEGER REFERENCES product_variants(id),
 quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
 tax_rule_id INTEGER REFERENCES tax_rules(id)
);
CREATE TABLE IF NOT EXISTS discounts (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('fixed','percentage')),
 value INTEGER NOT NULL CHECK(value > 0), minimum_purchase INTEGER NOT NULL DEFAULT 0 CHECK(minimum_purchase >= 0),
 minimum_quantity INTEGER NOT NULL DEFAULT 1 CHECK(minimum_quantity > 0), start_date TEXT, end_date TEXT,
 usage_limit INTEGER CHECK(usage_limit > 0), usage_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_count >= 0),
 CHECK(type != 'percentage' OR value <= 10000),
 CHECK(end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
 CHECK(usage_limit IS NULL OR usage_count <= usage_limit)
);
CREATE TABLE IF NOT EXISTS discount_products (
 discount_id INTEGER NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
 product_id INTEGER NOT NULL REFERENCES products(id), PRIMARY KEY(discount_id,product_id)
);
CREATE TABLE IF NOT EXISTS subscription_discounts (
 subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
 discount_id INTEGER NOT NULL REFERENCES discounts(id), PRIMARY KEY(subscription_id,discount_id)
);
CREATE TABLE IF NOT EXISTS invoices (
 id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
 customer_id INTEGER NOT NULL REFERENCES users(id), customer_name TEXT NOT NULL, customer_email TEXT NOT NULL,
 period_start TEXT NOT NULL, period_end TEXT NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','paid','cancelled')),
 subtotal INTEGER NOT NULL CHECK(subtotal >= 0), discount_total INTEGER NOT NULL DEFAULT 0 CHECK(discount_total >= 0),
 tax_total INTEGER NOT NULL DEFAULT 0 CHECK(tax_total >= 0), total INTEGER NOT NULL CHECK(total >= 0),
 UNIQUE(subscription_id,period_start,period_end),
 CHECK(period_end > period_start), CHECK(due_date >= issue_date),
 CHECK(discount_total <= subtotal), CHECK(total = subtotal - discount_total + tax_total)
);
CREATE TABLE IF NOT EXISTS invoice_lines (
 id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
 product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
 unit_price INTEGER NOT NULL CHECK(unit_price >= 0), tax_rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_basis_points BETWEEN 0 AND 10000),
 discount_amount INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
 tax_amount INTEGER NOT NULL DEFAULT 0 CHECK(tax_amount >= 0), amount INTEGER NOT NULL CHECK(amount >= 0)
);
CREATE TABLE IF NOT EXISTS invoice_discounts (
 invoice_id INTEGER NOT NULL REFERENCES invoices(id), discount_id INTEGER NOT NULL REFERENCES discounts(id),
 amount INTEGER NOT NULL CHECK(amount >= 0), PRIMARY KEY(invoice_id,discount_id)
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), method TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount > 0), payment_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 reference TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_billing_idx ON subscriptions(status,next_billing_date);
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS invoices_due_idx ON invoices(status,due_date);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments(invoice_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
