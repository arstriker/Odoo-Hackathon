// Ordered schema migrations applied after schema.sql (version 1). Append new versions; never edit applied ones.
export const migrations = [
  {
    version: 2,
    description: 'Catalogue lookup indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants(product_id);
      CREATE INDEX IF NOT EXISTS products_active_name_idx ON products(active, name);
    `,
  },
  {
    version: 3,
    description: 'Quotation validity, template payment terms and subscription status history',
    sql: `
      ALTER TABLE subscriptions ADD COLUMN quotation_template_id INTEGER REFERENCES quotation_templates(id);
      ALTER TABLE subscriptions ADD COLUMN valid_until TEXT;
      ALTER TABLE subscriptions ADD COLUMN notes TEXT NOT NULL DEFAULT '';
      ALTER TABLE quotation_templates ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK(payment_terms_days >= 0);
      CREATE TABLE IF NOT EXISTS subscription_events (
        id INTEGER PRIMARY KEY,
        subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        action TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id), note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS subscription_events_subscription_idx ON subscription_events(subscription_id);
      CREATE INDEX IF NOT EXISTS subscriptions_status_expiry_idx ON subscriptions(status, expiry_date);
      CREATE INDEX IF NOT EXISTS subscription_lines_subscription_idx ON subscription_lines(subscription_id);
      CREATE INDEX IF NOT EXISTS quotation_template_lines_template_idx ON quotation_template_lines(template_id);
    `,
  },
  {
    version: 4,
    description: 'Tax rate snapshot on lines and original renewal term on subscriptions',
    sql: `
      ALTER TABLE subscription_lines ADD COLUMN tax_rate_basis_points INTEGER CHECK(tax_rate_basis_points BETWEEN 0 AND 10000);
      ALTER TABLE quotation_template_lines ADD COLUMN tax_rate_basis_points INTEGER CHECK(tax_rate_basis_points BETWEEN 0 AND 10000);
      UPDATE subscription_lines SET tax_rate_basis_points = (SELECT rate_basis_points FROM tax_rules WHERE id = subscription_lines.tax_rule_id) WHERE tax_rule_id IS NOT NULL;
      UPDATE quotation_template_lines SET tax_rate_basis_points = (SELECT rate_basis_points FROM tax_rules WHERE id = quotation_template_lines.tax_rule_id) WHERE tax_rule_id IS NOT NULL;
      ALTER TABLE subscriptions ADD COLUMN term_intervals INTEGER CHECK(term_intervals > 0);
    `,
  },
  {
    version: 5,
    description: 'Reporting and date performance indexes for finance and payments',
    sql: `
      CREATE INDEX IF NOT EXISTS payments_payment_date_idx ON payments(payment_date);
      CREATE INDEX IF NOT EXISTS invoices_issue_date_idx ON invoices(issue_date);
      CREATE INDEX IF NOT EXISTS invoices_status_due_idx ON invoices(status, due_date);
      CREATE INDEX IF NOT EXISTS discounts_dates_idx ON discounts(start_date, end_date);
    `,
  },
];

export const latestSchemaVersion = Math.max(1, ...migrations.map(migration => migration.version));

export function applyMigrations(db) {
  const current = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version ?? 0;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(migration.version);
  }
}
