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
