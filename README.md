# Brightloop Subscription Management System

A subscription management system for recurring businesses: product catalogue and plans, quotations and subscriptions, automatic billing and invoicing, payments, discounts, and finance reporting. It runs locally on Node.js with a built-in SQLite database and no third-party dependencies.

## Run

Requires Node.js 22.13 or newer. No third-party dependencies or database service are needed.

```sh
git clone https://github.com/arstriker/Odoo-Hackathon.git
cd Odoo-Hackathon
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
- **Variants**: price-changing variants per product (for example Brand: Odoo adds ₹560). Duplicate attribute/value pairs are rejected, and a variant cannot make the product price negative.
- **Tax rules**: create, activate/deactivate and delete tax rules (Settings page). Rules in use are deactivated instead of deleted.
- **Recurring plans**: price, billing frequency (daily, weekly, monthly, yearly), minimum quantity, availability dates and lifecycle settings (auto-close at end, close early, pause, renew). Billing frequency and minimum quantity cannot change once a plan has confirmed or running subscriptions.
- Catalogue changes are admin-only on the backend (`403` for staff and customers, `401` when signed out).

## Stage 4 deliverables · Quotations and subscriptions

- **Customers**: staff and admins can add customer accounts (name and email, one account per email) to quote for.
- **Quotation templates**: a plan, product lines, validity in days and payment terms. Starting a quotation from a template copies all of these.
- **Subscriptions**: unique numbers (`SUB-00001`), customer, plan, start and expiry dates, quotation validity, payment terms, notes and product lines with quantity, unit price, taxes and amounts. Lines default to the catalogue price plus the variant adjustment. Each line keeps the tax rate it was created with, so editing a tax rule later does not change existing documents.
- **Lifecycle**: Draft → Quotation → Confirmed → Active → Closed, plus pause/resume and renewal while active. Pause, renew and early closing are only offered when the plan allows them. Every renewal extends the expiry date by the original term length.
- **Rules**: line quantities respect the plan minimum, the start date must fall within plan availability, expired quotations cannot be confirmed, and only draft/quotation subscriptions can be edited. Only drafts can be deleted.
- **Automatic closing**: subscriptions on plans set to close automatically are closed after their expiry date, and confirmed subscriptions that expire before activation are closed too (checked at start-up and hourly).
- **History**: every status change is recorded and shown on the subscription page. The user who made it is recorded once Stage 2 sign-in is in place; the local development admin has no account, so its changes show no user.
- **Access**: admins and staff manage quotations and list customers; customers can only read their own subscriptions.

Until Stage 2 adds sign-in, the server uses a local development admin (`server/access.js`). Stage 2 plugs in real authentication with `createApp(db, { authenticate })`, where `authenticate(req, db)` returns `{ id, role }` or `null`.

Account registration, authentication, record editing, scheduling, invoicing, payments and analytical reporting belong to subsequent stages. This foundation has no authentication yet: use it locally with development data. Existing endpoints are read-only and collection responses are limited to 100 records; pagination comes with the management modules.

## Stage 5 deliverables · Billing

- **Billing engine**: every active subscription that is due gets one draft invoice per billing period (`INV-00001`), with customer and line snapshots, tax per line and a due date from the payment terms.
- **No duplicates or gaps**: missed periods are caught up in order, and a period that already has an invoice (even a cancelled one) is never billed again. Running billing twice is safe.
- **Paused and expired**: paused periods are skipped rather than back-billed on resume, and billing stops at the expiry date until a renewal extends it.
- **Scheduling**: billing runs at start-up and every hour, after expired subscriptions are closed. Admins can also run it on demand with `POST /api/billing/run`.
- **Invoices**: Draft → Confirmed → Paid (Stage 6), or Cancelled. Staff confirm drafts before they go to the customer, and can cancel draft or confirmed invoices that have no payments. Each invoice shows its lines, payments, amount paid and balance.
- **Access**: admins and staff see and manage all invoices; customers see only their own, and never drafts.
- **Screens**: an Invoices page with status tabs, overdue flags and a “Run billing now” button; an invoice page with lines, totals, amount paid, balance and Confirm/Cancel; and an Invoices section on each subscription.

## Stage 6 deliverables · Payments and discounts

- **Payments**: staff record payments (method, amount, date, optional reference and note) against confirmed invoices. Methods: bank transfer, UPI, card, cash, cheque, other.
- **Partial payments**: each payment reduces the balance; the invoice becomes Paid automatically when the balance reaches ₹0. Overpayments, future dates, duplicate references and payments on draft, paid or cancelled invoices are rejected.
- **Corrections**: admins can remove a payment recorded by mistake; a paid invoice then goes back to Confirmed.
- **₹0 invoices** are marked Paid as soon as they are confirmed.
- **Access**: customers see only payments on their own invoices and cannot record or remove payments.
- **Screens**: a “Record payment” form on each confirmed invoice (amount defaults to the balance due), payments listed on the invoice with a Remove option, and a Payments page with totals and search.
- **Discounts**: admins create percentage or fixed discounts with optional products, minimum quantity, minimum purchase, start/end dates and a usage limit. Staff add them to subscriptions; billing applies every qualifying discount to each new invoice, before tax.
- **Discount rules**: discounts apply in the order they were created, each on what earlier ones left, so a line never goes below ₹0. A fixed amount is shared across qualifying lines by value with no rounding loss. Each invoice a discount is applied to counts as one use, in the same transaction, so the usage limit is never exceeded; cancelling an invoice gives its uses back. Discounts used on invoices can't be deleted (set an end date instead).
- **Discount screens**: a Discounts page (create, edit, status, uses and amount given), a Discounts section on each subscription to add or remove them, and each invoice lists the discounts it received.

## Stage 7 deliverables · Finance lead and performance reporting

- **Executive summary**: one place for the finance lead to inspect active subscriptions (with MRR run rate), total revenue collected, outstanding balance, and overdue receivables.
- **Overdue collections**: dedicated "Chase overdue invoices" table with aging calculation (`days_overdue`), customer contact, balance, and direct navigation to invoices.
- **Cashflow breakdown**: collections categorized by payment method and monthly trend table.
- **Date-range filtering**: presets for "This month", "Last month", "This quarter", "This year", and "All time", with custom date support.
- **Sub-2-second performance SLA**: indexed database queries (`payments_payment_date_idx`, `invoices_issue_date_idx`, `invoices_status_due_idx`) executing in under 50ms even with thousands of active subscriptions.

## Structure

```text
public/                 Browser interface: HTML, CSS and JavaScript
server/index.js         HTTP server, routing and read-only collections
server/http.js          Request parsing, validation, date and transaction helpers
server/access.js        Role checks and the Stage 2 authentication hook
server/catalog.js       Stage 3 API: products, variants, tax rules and plans
server/subscriptions.js Stage 4 API: customers, quotation templates and subscription lifecycle
server/billing.js       Stage 5 billing engine and invoice API
server/payments.js      Stage 6 payments API
server/discounts.js     Stage 6 discounts API and the discount calculation used by billing
server/finance.js       Stage 7 finance summary and overdue reporting
server/database.js      Database connection and initialization
server/migrations.js    Ordered schema migrations after version 1
server/schema.sql       Initial schema and indexes
public/manage.js        Stage 3 screens (products, plans, settings) and shared form helpers
public/subscriptions.js Stage 4 screens (customers, templates, subscriptions)
public/invoices.js      Stage 5 screens (invoice list and detail, run billing)
public/payments.js      Stage 6 Payments page (record payments from the invoice page in public/invoices.js)
public/discounts.js     Stage 6 Discounts page and the subscription Discounts section
public/finance.js       Stage 7 Finance & Reports executive dashboard
Data model.md           Relationships and value conventions
tests/foundation.test.js API, persistence and constraint tests
tests/catalog.test.js   Stage 3 catalogue and permission tests
tests/subscriptions.test.js Stage 4 lifecycle, rules and access tests
tests/billing.test.js   Stage 5 billing periods, totals, invoice actions and access tests
tests/payments.test.js  Stage 6 payment rules, corrections and access tests
tests/discounts.test.js Stage 6 discount calculation, conditions, usage limits and access tests
tests/finance.test.js   Stage 7 finance summary, aging, receivables and benchmark test
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

Stage 4 endpoints:

| Method | Path | Role |
|---|---|---|
| POST | `/api/customers` | admin, staff |
| GET, POST | `/api/quotation-templates` | admin, staff |
| GET, PATCH, DELETE | `/api/quotation-templates/:id` | admin, staff |
| GET | `/api/subscriptions` (`?status=`, `?q=`), `/api/subscriptions/:id` | admin, staff; customers see their own |
| POST | `/api/subscriptions` | admin, staff |
| PATCH, DELETE | `/api/subscriptions/:id` (draft/quotation only; delete drafts only) | admin, staff |
| POST | `/api/subscriptions/:id/actions/{send,confirm,activate,pause,resume,renew,close}` | admin, staff |
| POST | `/api/subscriptions/close-expired` | admin |

Example: `POST /api/subscriptions` with `{"customer_id":1,"template_id":1,"start_date":"2026-11-01","expiry_date":"2027-10-31"}`, then `POST /api/subscriptions/1/actions/confirm` and `/activate`.

Stage 5 endpoints:

| Method | Path | Role |
|---|---|---|
| POST | `/api/billing/run` (returns `{ invoices, skipped_paused }`) | admin |
| GET | `/api/invoices` (`?status=`, `?q=`, `?subscription_id=`), `/api/invoices/:id` | admin, staff; customers see their own, not drafts |
| POST | `/api/invoices/:id/actions/{confirm,cancel}` | admin, staff |

Stage 6 endpoints:

| Method | Path | Role |
|---|---|---|
| GET | `/api/payments` (`?q=`, `?invoice_id=`; returns `{ items, totals }`) | admin, staff; customers see their own |
| POST | `/api/invoices/:id/payments` (`{ method, amount, payment_date?, reference?, note? }`) | admin, staff |
| DELETE | `/api/payments/:id` | admin |
| GET | `/api/discounts`, `/api/discounts/:id` | admin, staff |
| POST, PATCH, DELETE | `/api/discounts`, `/api/discounts/:id` (`{ name, type, value, minimum_purchase?, minimum_quantity?, start_date?, end_date?, usage_limit?, product_ids? }`) | admin |
| GET | `/api/subscriptions/:id/discounts` | admin, staff; customers see their own |
| POST, DELETE | `/api/subscriptions/:id/discounts` (`{ discount_id }`), `/api/subscriptions/:id/discounts/:discountId` | admin, staff |

Stage 7 endpoints:

| Method | Path | Role |
|---|---|---|
| GET | `/api/finance/summary` (`?preset=`, `?from=`, `?to=`) | admin, staff |
| GET | `/api/finance/overdue` | admin, staff |

Example: `POST /api/plans` with `{"name":"Business monthly","price":99900,"interval":"monthly","minimum_quantity":1,"auto_close":true}`.

Frontend navigation uses hash routes, for example `/#subscriptions`, `/#invoices/3`, `/#payments`, `/#discounts`, or `/#finance`.
