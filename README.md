# Enile CRM: backend (API and worker)

The REST API and background worker for Enile CRM, a CRM for Enile, a petroleum transport company running about 120 tankers. The React frontend is a separate package, **enile-crm-frontend**.

**Stack:** Node 20+, Express, MongoDB with Mongoose, zod and TypeScript. A separate worker process sends reminders and builds PDFs, exports and emails.

---

## 1. Quick start

Prerequisites: Node 20+ and MongoDB 7 running as a replica set. You can use Docker for MongoDB, or install it yourself.

```bash
# 1. Infrastructure: MongoDB replica set and Mailpit (catches reminder emails at http://localhost:8025)
docker compose up -d

# 2. Install
npm install

# 3. Configure
cp .env.example .env
#    then replace the three *_SECRET values:  openssl rand -hex 48

# 4. Create indexes and the first admin (add --demo for sample users and data)
npm run sync-indexes
npm run seed -- --demo

# 5. Run (two terminals)
npm run dev          # API on http://localhost:4000
npm run worker:dev   # reminders, PDFs, exports, emails
```

Then start the frontend (see its README); in development it proxies `/api` to `http://localhost:4000`.

Sign in as `admin@enile.local` with the password from `SEED_ADMIN_PASSWORD` (default `ChangeMe!2026`). You will be asked to change it straight away.

With `--demo` the seed also creates `manager@`, `sales@`, `operations@` and `accounts@enile.local`, all using the same starting password, plus sample customers, vehicles, drivers, documents, quotations and trips.

### Production

```bash
npm run build
NODE_ENV=production node dist/server.js   # API
NODE_ENV=production node dist/worker.js   # run at least one worker
```

- Run behind HTTPS with `COOKIE_SECURE=true` and `TRUST_PROXY=1`, and set `CORS_ORIGINS` to the public URL.
- Browser and API must share one origin, because the sign-in cookies are `SameSite=Strict`. Either set `CLIENT_DIST_DIR` to the frontend's built `dist` folder so this server also serves the UI, or put both behind a reverse proxy that routes `/api` here.
- Health checks: `GET /health/live` and `GET /health/ready`.

### Checks

```bash
npm run typecheck   # strict TypeScript
npm test            # vitest: GST/money maths, GSTIN checksum, shortage, expiry and reminder rules
```

---

## 2. Folder structure

```
enile-crm-backend/
├── docker-compose.yml      MongoDB replica set and Mailpit for local development
├── .env.example
└── src/
    ├── app.ts              Express app: security middleware, routes, error handler
    ├── server.ts           HTTP entry point
    ├── worker.ts           background worker entry point
    ├── routes.ts           mounts every module under /api/v1
    ├── config/             env (validated with zod), db, constants, permissions (role matrix)
    ├── lib/                errors, pagination, money (BigInt paise), GSTIN, time zone, storage, locks, tokens
    ├── middleware/         auth, CSRF, rate limits, validation, idempotency, sanitising, request ids
    ├── models/             Mongoose schemas with indexes
    ├── services/           settings, audit, compliance, job queue
    ├── modules/<feature>/  *.schema.ts (zod), *.service.ts (rules), *.routes.ts (HTTP)
    │                       auth, users, leads, companies, quotations, trips, vehicles, drivers,
    │                       documents, files, renewals, reports, dashboard, stats, search,
    │                       notifications, settings, admin, inventory, purchases,
    │                       expenses, payroll
    ├── jobs/               scheduler, processors, PDF renderer, exporter, mailer
    ├── scripts/            seed, syncIndexes
    └── __tests__/
```

---

## 3. Gaps from the manual review, and how they are closed

| Gap in manual v1.0 | What was built |
|---|---|
| No referral leads | `Lead` model and screen with source, referrer, estimated KL/month, follow-up date and owner. **Convert** creates the customer and links both ways. |
| Driver licence expiry not wired to reminders | Driver licence and Hazchem training expiries feed the same renewal scanner as vehicle documents. They also block trips when expired. |
| No trip end time, so overlaps could not be checked | `plannedStart` and `plannedEnd` are both required. Vehicle and driver overlap checks run inside a per-resource lock, so two planners cannot double-book the same tanker. |
| No link from trips to quotations | `Trip.quotationId`, limited to issued or accepted quotations of the same customer. The quotation page lists its trips, and the conversion report compares quoted with delivered work. |
| No role or permission matrix | `src/config/permissions.ts` defines it. Every route checks it, and **Users & roles** shows it read-only. See section 6. |
| No petroleum fields | Product (MS, HSD, ATF, SKO, LDO, FO, bitumen, ethanol, lubes), planned, loaded and received litres, compartment seals, density and temperature at loading, shortage litres and %, a tolerance flag, and proof of delivery. Vehicles record compartments and capacity. Documents include PESO licence, calibration certificate, fitness, PUC, permits, insurance, RC and road tax. |
| Quotation statuses incomplete | `draft → issued → accepted / rejected / expired`, plus `superseded` (by a revision) and `cancelled`. Numbers are assigned only on issue. A nightly job marks lapsed quotations as expired. |
| Trip statuses incomplete | `planned → in_transit → delivered`, or `cancelled` from planned or in transit. Delivered trips can be corrected only through an audited flow that keeps the old values. |

---

### Interlocks (enforced on the server)

Every rule below is checked by the API, so a stale screen or a direct API call cannot get around it. The forms show the same rules early, as warnings and disabled options.

| Action | Blocked when |
| --- | --- |
| Plan or edit a trip | Customer inactive; vehicle not active or over capacity; driver not active; vehicle or driver already on an overlapping trip; blocking documents expired by the trip end (override needs a reason and the permission); linked quotation belongs to another customer, is not issued/accepted, or is issued but past its validity date |
| Dispatch | Trip not planned; vehicle or driver no longer active; loaded quantity over capacity; seals missing when required; a seal on a compartment the tanker does not have; opening odometer below the vehicle's last recorded reading; documents expired since planning |
| Deliver | Trip not in transit; received more than 2% over dispatched; closing odometer below opening; proof missing when required |
| Reject or cancel a quotation | A planned or in-transit trip is linked to it |
| Accept a quotation | It is past its validity date |
| Deactivate a customer | It has a planned or in-transit trip, or an issued quotation still open |
| Delete a customer | It has any quotation or trip (deactivate instead) |
| Convert a lead | Already converted; marked lost (reopen first); the chosen existing customer is inactive |
| Quote against a lead | The lead is marked lost |
| Vehicle status other than active | It has a planned or in-transit trip. Retiring a vehicle also frees its assigned driver |
| Reduce vehicle capacity | A planned trip carries more than the new capacity, or compartments are not updated to match |
| Assign a driver to a vehicle | Driver inactive, or already assigned to another vehicle |
| Driver status other than active | They have a planned or in-transit trip. They are also unassigned from their vehicle |

### Auto-fill

| Form | Filled for you |
| --- | --- |
| Plan trip | From a linked quotation: product, quantity, loading and unloading points (split from the route) and freight from the quoted rate. Otherwise from the customer's last trip: route, product, quantity and usual duration. Picking a tanker brings its regular driver and caps the quantity at its capacity. Moving the start keeps the duration. Vehicles and drivers show ✅ free, ⚠️ document issues, or ⛔ busy (not selectable) for the chosen window |
| New quotation | The customer's GST supply type (CGST+SGST or IGST), GSTIN, city and contact. Lines, rates and GST rate are copied from the customer's latest quotation (with Undo). Blank descriptions and subject are written from product and route. A new line repeats the previous line's product, route, unit and HSN |
| Customer | State, PAN and supply type from the GSTIN, with the check digit verified as you type; possible duplicates shown before saving |
| Lead conversion | Name and contact copied into the customer form |
| Dispatch | One seal row per compartment; "Number the rest in sequence" fills consecutive seals; loaded quantity from the plan; opening odometer from the vehicle's last reading |
| Delivery | Received quantity from dispatched; km run from the odometers |
| Document upload | Starts on the first missing document type; expiry suggested from the issue date for documents with a usual validity |
| Vehicle | Split the total capacity equally across compartments, or use the compartments' sum as the total |
| Lead | Follow-up date two days out |

---

## 3a. Stores, trip expenses and driver payroll

### What each screen does

| Screen | Path | What it does |
| --- | --- | --- |
| Stock | `/inventory` | Items with on-hand quantity, reorder level, quantity on order, weighted average cost and stock value. Low and out-of-stock tabs. Issue to a vehicle or trip, take returns, and adjust with a reason. Every change is a ledger row. |
| Purchase orders | `/purchase-orders` | Draft → issued → partially received → received (or closed short / cancelled). GST per line, receipts per delivery with invoice number. Receiving adds stock at the rate before GST and updates the average cost. |
| Suppliers | `/suppliers` | Supplier master with GSTIN check, payment terms and open order value. |
| Trip expenses | `/trip-expenses`, and a card on each trip | Fuel, toll, loading, food, parking, repair, police/RTO and other bills against a trip, with a photo or PDF receipt. Pending → approved or rejected. Bills paid by the driver are owed back until reimbursed. Totals by category, fuel litres, and freight minus expenses on the trip card. |
| Salary sheet | `/payroll` | One row per driver for a month: basic for days worked, trip allowance for delivered trips, gross, advance recovery, net, already paid, balance and status (paid, partial, due, overdue). Pay button per row, Excel/CSV download. |
| Driver payments | `/payroll/payments` | Every payment: number, driver and employee code, type, amount, date, mode, UTR/cheque reference, paid by, salary month, slip. Filter by driver, type, mode, status, salary month and dates; download exactly the filtered list as Excel or CSV. Void with a reason (never edit or delete). |
| Driver payroll | `/payroll/drivers/:id` | Employee view: employee code, joining date, salary, per-trip allowance, salary date, recovery per month, bank (masked), UPI and PAN; salary month by month; advance given, recovered and outstanding; bills owed; totals for the financial year; statement download. |

### How salary is worked out

```
basic       = monthly salary × payable days ÷ days in month
              (payable days start at the joining date, minus unpaid leave)
allowance   = delivered trips in the month × allowance per trip
gross       = basic + allowance
net         = gross − trip allowance already paid that month − other deductions − advance recovery
balance due = net − salary already paid for that month
```

Advance recovery defaults to the driver's monthly instalment (or the whole outstanding advance when no instalment is set), and can never exceed the outstanding advance or what is left of net pay. The salary is due on the driver's salary date (day 1 to 28) of the next month; after that an unpaid balance shows as overdue. The server recalculates everything when a payment is saved, so the screen cannot drift from the rules.

### New API endpoints (all under `/api/v1`)

| Area | Endpoints |
| --- | --- |
| Stock | `GET /inventory/summary`, `GET/POST /inventory/items`, `GET/PATCH /inventory/items/:id`, `POST /inventory/items/:id/issue \| return \| adjust`, `GET /inventory/movements`, `GET/POST/PATCH /inventory/suppliers` |
| Purchase orders | `GET/POST /purchase-orders`, `GET /purchase-orders/prefill?supplierId=`, `GET/PATCH /purchase-orders/:id`, `POST /purchase-orders/:id/issue \| receive \| cancel \| close` |
| Trip expenses | `GET/POST /trip-expenses`, `GET /trip-expenses/summary`, `PATCH/DELETE /trip-expenses/:id`, `POST/GET /trip-expenses/:id/receipt`, `POST /trip-expenses/:id/approve \| reject`, `POST /trip-expenses/approve-many` |
| Payroll | `GET/POST /payroll/payments`, `GET /payroll/payments/export?format=csv\|xlsx` (same filters as the list), `GET /payroll/payments/:id`, `POST/GET /payroll/payments/:id/slip`, `POST /payroll/payments/:id/void`, `GET /payroll/salary-sheet?month=`, `GET /payroll/drivers/:id/salary-preview`, `GET /payroll/drivers/:id/summary`, `PATCH /payroll/drivers/:id/pay` |

Background exports (Reports › Exports) also cover `driver_payments`, `trip_expenses`, `stock_movements` and `purchase_orders`; each needs that module's view permission.

### Interlocks

| Action | Blocked when |
| --- | --- |
| Issue stock | Not enough on hand (checked atomically, so two issues cannot both take the last unit); item inactive; date in the future; vehicle not found or trip cancelled |
| Change an item's unit | Any stock movement exists for it |
| Deactivate an item or supplier | It is on an open purchase order |
| Edit a purchase order | It is no longer a draft |
| Receive goods | PO not issued or partly received; quantity more than what is still due on the line; receipt date before the order date. Receipts on one PO are processed one at a time |
| Cancel a purchase order | Anything has already been received (close it short instead, with a reason) |
| Add a trip expense | Trip cancelled; bill date before the trip's start or in the future; same bill number already entered for that trip and category; fuel without litres |
| Edit or delete an expense | It is already approved or rejected |
| Approve or reject an expense | You entered it yourself (unless you are an admin) |
| Record a salary payment | Month in the future; no monthly salary set; amount more than the balance due; advance recovery more than allowed |
| Record an advance | Driver inactive; a second joining advance |
| Record a reimbursement | Amount differs from the ticked bills; a bill already reimbursed or not approved |
| Pay by bank transfer, UPI or cheque | No reference (UTR / cheque number); bank transfer with no account on file |
| Void a payment | No reason given; salary has already recovered part of the advance being voided. Voiding frees the bills it settled |
| See or change pay and bank details | Without payroll permission (the fields are removed from driver responses) |

### Auto-fill

| Form | Filled for you |
| --- | --- |
| New purchase order | Supplier's last order (lines, rates, deliver-to) with one click; "Reorder low stock" adds every item at or below reorder level with a suggested quantity of 2 × reorder level − on hand − on order; rate from the item's last purchase rate (or average cost); GST 18% unless changed; totals and GST worked out per line |
| Receive goods | Each line's remaining quantity |
| Issue stock | Vehicle taken from the chosen trip; balance after the move shown live, with a warning before it would go below zero |
| Trip expense | Vehicle and driver from the trip; "Paid by" from the category (fuel → fuel card, toll → FASTag, repair → office, others → driver); payment mode from the payer; fuel amount from litres × rate |
| Driver payment | Payment mode from the bank or UPI details on file; salary month defaults to last month; leave, advance recovery and balance due worked out live; amount filled with the balance due (or the total of approved driver-paid bills for a reimbursement); "Paid by" is the signed-in user |
| Driver | Employee code assigned automatically (EMP-0001…); salary date defaults to the 7th |

### Roles for the new modules

| Area | admin | manager | sales | operations | accounts |
|---|:-:|:-:|:-:|:-:|:-:|
| Stock and suppliers: view | ✓ | ✓ | | ✓ | ✓ |
| Stock: issue, return, adjust; items | ✓ | ✓ | | ✓ | |
| Purchase orders: create, issue, receive | ✓ | ✓ | | ✓ | ✓ |
| Trip expenses: add and edit | ✓ | ✓ | | ✓ | ✓ |
| Trip expenses: approve or reject | ✓ | ✓ | | | ✓ |
| Payroll: view, pay, void, pay details, downloads | ✓ | ✓ | | | ✓ |

---

## 4. Section 13 open decisions: defaults chosen

Every value below is stored in the `systemsettings` collection and can be edited by an admin under **Admin → Settings**. Changes are versioned and audited. Confirm them with Enile before go-live.

| Decision | Default |
|---|---|
| Business time zone (day boundaries, reports, reminders) | `Asia/Kolkata`; timestamps are stored in UTC |
| GST | 12% default; allowed rates 0, 5, 12 and 18%; CGST+SGST when the customer's GSTIN state matches the home state (27), otherwise IGST |
| Rounding | Line amounts rounded half-up to the paisa; grand total rounded to the rupee, with the round-off shown |
| Numbering | `ENL/QT/<FY>/00001`, `ENL/TRP/<FY>/00001`, `ENL/PO/<FY>/00001` and `ENL/PAY/<FY>/00001`, restarting each financial year (April to March) |
| Quotation validity | 15 days |
| Duplicate customers | GSTIN unique where present; name and phone matches are shown as warnings before saving |
| Driver double-booking | Blocked |
| Maximum trip length | 168 hours |
| Shortage tolerance | 0.5% of loaded quantity |
| Seals at dispatch | Required |
| Proof of delivery file | Optional |
| Documents that block planning and dispatch | RC, insurance, fitness, PUC, PESO licence, calibration certificate; driver licence; Hazchem training |
| Compliance override | Allowed for admin and manager, with a reason that is recorded on the trip and in the audit log |
| Reminder schedule | 30, 15, 7, 1 and 0 days before expiry, then every 7 days while overdue |
| Reminder recipients and channels | Admin, manager and operations, by email and in-app |
| Reminder attempts | 5 tries with backoff, then dead-lettered under **Failed jobs** |
| Longest on-screen report range | 92 days (longer periods use Export) |
| Vehicle statuses | `active`, `in_service` (maintenance), `unavailable`, `retired`; only active vehicles can be assigned |

---

## 5. Security

- **Authentication.** Argon2id password hashing. Five failed sign-ins lock the account for 15 minutes, and sign-in has its own rate limit. A short-lived JWT access token (15 minutes) is kept in an `httpOnly`, `SameSite=Strict` cookie. Refresh tokens rotate on every use and are stored only as SHA-256 hashes; reusing an old refresh token revokes that whole session family. Changing a user's role or status, or resetting their password, signs them out everywhere.
- **CSRF.** Double-submit token (`enile_csrf` cookie echoed in `X-CSRF-Token`) on every unsafe request, together with SameSite=Strict cookies and a CORS allow-list.
- **Authorisation.** Permission checks happen on the server for every route. The UI hides what a role cannot do, but never relies on that.
- **Input.** zod validation with `.strict()` schemas, so unknown fields are rejected. Keys containing `$` or `.` are stripped to prevent NoSQL operator injection, `hpp` guards query strings, and JSON bodies are limited to 200 KB.
- **Headers.** helmet with a strict Content Security Policy, `nosniff`, frameguard, and HSTS in production.
- **Files.** Uploads are checked by magic bytes (PDF, PNG, JPEG), size-limited and checksummed. They are stored privately outside the web root. Downloads use links that expire after 5 minutes and are tied to the requesting user.
- **Exports.** CSV and XLSX cells that start with `= + - @` are escaped against formula injection.
- **Data integrity.** Optimistic concurrency (`version` on every update returns 409 when stale). `Idempotency-Key` on create, dispatch and deliver stops double submissions. Counters are atomic. The audit log is append-only: the model refuses updates and deletes.
- **Operations.** Request ids on every response and log line, pino logs with secrets redacted, and error responses that never include stack traces.

---

## 6. Roles

| Area | admin | manager | sales | operations | accounts |
|---|:-:|:-:|:-:|:-:|:-:|
| View dashboard, fleet, trips, reports | ✓ | ✓ | ✓ | ✓ | ✓ |
| Customers: view, create, edit, deactivate; convert a lead | ✓ | | | | |
| Quotations: view, draft, issue, accept or reject | ✓ | | | | |
| Customer money: trip freight, margin, quotation values, deal pipeline | ✓ | | | | |
| Customer name and code (trip lists, trip planning picker) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Leads: create and edit | ✓ | ✓ | ✓ | | |
| Vehicles, drivers, documents: manage | ✓ | ✓ | | ✓ | |
| Trips: plan, dispatch, deliver, cancel | ✓ | ✓ | | ✓ | |
| Trips: correct delivered, override compliance | ✓ | ✓ | | | |
| Exports | ✓ | ✓ | ✓ | | ✓ |
| Audit trail | ✓ | ✓ | | | |
| Users, settings, failed jobs | ✓ | | | | |

The exact list is in `src/config/permissions.ts`, and the live matrix is at `GET /api/v1/users/roles` and on the frontend Users screen.

---

## 7. Performance: indexes, pagination and fewer round trips

**Indexes.** Every list filter and sort has a supporting index. Run `npm run sync-indexes` after deploying.

| Collection | Indexes |
|---|---|
| users | `email` (unique); `role, status` |
| sessions | `tokenHash` (unique); `userId, revokedAt`; `family`; `expiresAt` (TTL) |
| leads | `status, createdAt`; `normalizedName`; `normalizedPhone`; `assignedTo, followUpAt` |
| companies | `companyCode` (unique); `gstin` (unique when present); `normalizedName`; `phones`; `status, createdAt` |
| quotations | `quotationNumber` (unique when issued); `companyId, issueDate`; `status, issueDate`; `status, validUntil`; `rootId, revision`; `createdAt` |
| trips | `tripNumber` (unique); `vehicleId, status, plannedStart`; `driverId, status, plannedStart`; `status, plannedStart`; `plannedStart`; `companyId, createdAt`; `quotationId`; `delivery.deliveredAt` |
| vehicles | `normalizedRegistration` (unique); `status, normalizedRegistration`; `assignedDriverId` |
| drivers | `normalizedLicence` (unique); `normalizedPhone`; `status, normalizedName`; `licenceExpiry, status`; `hazchemTrainingExpiry, status` |
| documents | `ownerType, ownerId, documentType, status`; `status, expiryDate`; `ownerId, checksum` |
| renewaljobs / notifications | `idempotencyKey` (unique); `status, scheduledAt` / `status, nextAttemptAt`; per-subject and per-recipient indexes |
| jobs | `status, nextAttemptAt`; `type, createdBy, createdAt` |
| auditlogs | `entityType, entityId, timestamp`; `actorId, timestamp`; `timestamp` |
| locks, idempotencykeys | `expiresAt` (TTL) |

**Pagination.** All lists are paginated on the server (`page`, `limit` up to 100), with lean queries and projections. The audit log uses keyset (cursor) pagination so it stays fast as it grows. Search on codes, numbers, registrations and phones uses anchored prefix matches on normalised, indexed fields.

**Fewer round trips.**
- One `/auth/me` call at start-up returns the user, permissions and UI settings.
- The dashboard loads with one `/dashboard` call, which runs its aggregations in parallel on the server and caches them for 15 seconds.
- List status tabs get all their counts from one `/stats/:resource/status-counts` call, a single `$group` over the status index.
- Form auto-fill uses one call each: `/trips/prefill`, `/trips/planning-options` (every vehicle and driver flagged busy or blocked, from three queries, not one per row) and `/quotations/prefill`.
- Detail endpoints populate related names, so a page never makes N+1 calls.
- TanStack Query caches results, keeps the previous page on screen while the next one loads, and prefetches page N+1.
- Each route is code-split. Hovering a sidebar link downloads that page's code and its first page of data, so clicks feel instant.
- List filters live in the URL, so back and forward navigation and reloads reuse the cache.
- PDFs, exports and emails run in the worker, so API requests never wait on them.

---

## 8. Known limits and next steps

- Files are stored on local disk behind a `StorageProvider` interface. For several API instances, swap in S3, GCS or Azure Blob with the same interface.
- The worker can run as several instances, because jobs are claimed atomically with leases.
- SMS and WhatsApp reminders are not built; the notification model already has a channel field for them.
- Real-time vehicle GPS tracking is out of scope for v1.


The UI notes and screenshots are in the frontend package's README.
