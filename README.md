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

Account registration, authentication, record editing, scheduling, invoicing, payments and analytical reporting belong to subsequent stages. This foundation has no authentication yet: use it locally with development data. Existing endpoints are read-only and collection responses are limited to 100 records; pagination comes with the management modules.

## Structure

```text
public/                 Browser interface: HTML, CSS and JavaScript
server/index.js         HTTP server and read-only API
server/database.js      Database connection and initialization
server/schema.sql       Initial schema and indexes
Data model.md           Relationships and value conventions
tests/foundation.test.js API, persistence and constraint tests
data/                   Runtime SQLite files (ignored)
```

## API

`GET /api/health` returns database connectivity and schema version.
`GET /api/overview` returns counts and currency.
`GET /api/{customers,products,plans,subscriptions,invoices,payments,discounts,settings}` returns `{ items, limit }`. Settings currently lists tax rules.

Frontend navigation uses hash routes, for example `/#subscriptions`.
