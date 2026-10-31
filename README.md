# Brightloop Subscription Management System

Stage 1 of the hackathon project: a runnable frontend, backend and persistent relational database.

## Run

Requires Node.js 22.13 or newer. No third-party dependencies or database service are needed.

```sh
cd /home/nandith/Work/subscription-management-system
npm start
```

Open http://127.0.0.1:3000. The database is automatically created at `data/brightloop.sqlite` and retained across restarts. The Node 22 runtime may print an experimental warning for its built-in SQLite module.

```sh
npm run dev      # restart backend when source changes
npm run db:init  # explicitly initialize database (safe to rerun)
npm test         # API, persistence and constraint checks
```

Optional shell environment variables: `PORT`, `HOST`, `DATABASE_PATH`. `.env.example` documents them; `.env` files are not automatically loaded. The server binds to localhost by default.

## Stage 1 deliverables

- Responsive workspace layout with overview, customers, products, plans, subscriptions, invoices, payments, discounts and settings pages.
- Node.js HTTP backend serving the UI and read-only JSON endpoints.
- SQLite database initialized transactionally, with foreign keys, checks, unique constraints, indexes and a schema version record.
- Overview counts and module lists read from the database. There is no sample revenue or fabricated business data.
- API loading, empty and error states with retry.

## Stage 3 deliverables · Product catalogue and plans

- **Products**: create, edit, archive and delete products with name, type, sales price, cost price and notes. Products already used on templates, subscriptions, invoices or discounts are archived instead of deleted.
- **Variants**: price-changing variants per product (for example Brand: Odoo adds ₹560). Duplicate attribute/value pairs are rejected.
- **Tax rules**: create, activate/deactivate and delete tax rules (Settings page). Rules in use are deactivated instead of deleted.
- **Recurring plans**: price, billing frequency (daily, weekly, monthly, yearly), minimum quantity, availability dates and lifecycle settings (auto-close at end, close early, pause, renew).
- Catalogue changes are admin-only on the backend (`403` for staff and customers, `401` when signed out).

Until Stage 2 adds sign-in, the server uses a local development admin (`server/access.js`). Stage 2 plugs in real authentication with `createApp(db, { authenticate })`, where `authenticate(req, db)` returns `{ id, role }` or `null`.

Account registration, authentication, record editing, scheduling, invoicing, payments and analytical reporting belong to subsequent stages. This foundation has no authentication yet: use it locally with development data. Existing endpoints are read-only and collection responses are limited to 100 records; pagination comes with the management modules.

## Structure

```text
public/                 Browser interface: HTML, CSS and JavaScript
server/index.js         HTTP server, routing and read-only collections
server/http.js          Request parsing, validation, date and transaction helpers
server/access.js        Role checks and the Stage 2 authentication hook
server/catalog.js       Stage 3 API: products, variants, tax rules and plans
server/database.js      Database connection and initialization
server/migrations.js    Ordered schema migrations after version 1
server/schema.sql       Initial schema and indexes
public/manage.js        Management screens (products, plans, settings)
Data model.md           Relationships and value conventions
tests/foundation.test.js API, persistence and constraint tests
tests/catalog.test.js   Stage 3 catalogue and permission tests
data/                   Runtime SQLite files (ignored)
```

## API

`GET /api/health` returns database connectivity and schema version.
`GET /api/overview` returns counts and currency.
`GET /api/{customers,products,plans,subscriptions,invoices,payments,discounts,settings}` returns `{ items, limit }`. Settings currently lists tax rules.

Stage 3 write endpoints (JSON bodies; money in paise, rates in basis points, dates `YYYY-MM-DD`):

| Method | Path | Role |
|---|---|---|
| GET | `/api/products`, `/api/products/:id` | any |
| POST, PATCH, DELETE | `/api/products`, `/api/products/:id` | admin |
| POST | `/api/products/:id/variants` | admin |
| PATCH, DELETE | `/api/variants/:id` | admin |
| GET | `/api/tax-rules` | admin, staff |
| POST, PATCH, DELETE | `/api/tax-rules`, `/api/tax-rules/:id` | admin |
| GET | `/api/plans`, `/api/plans/:id` | any |
| POST, PATCH, DELETE | `/api/plans`, `/api/plans/:id` | admin |

Example: `POST /api/plans` with `{"name":"Business monthly","price":99900,"interval":"monthly","minimum_quantity":1,"auto_close":true}`.

Frontend navigation uses hash routes, for example `/#subscriptions` or `/#products/3`.
