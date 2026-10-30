# GKS Accounts v2

A clean rebuild of GKS Accounts & Inventory. It runs as a static web app (no build step) on a new Supabase database design.

## What's new

- **One payment can settle many bills.** Every receipt or payment links to any number of bills through an `allocations` table. Any amount left unlinked is the party's **Customer / Supplier Advance**, which you can link to bills later (Outstanding → Advances → *Link to bills*). Advances now show on the dashboard for both sides.
- **TDS on bills or on payments.** TDS deducted on a payment counts toward settling bills: amount paid + TDS = amount settled. GST & TDS shows the totals by section and party.
- **All-or-nothing saves.** An entry, its lines and its bill links are checked and saved together by one database function (`acc.save_voucher`). A half-saved split payment can no longer happen.
- **Proper entry numbers.** Numbers run per type and per financial year, for example `PUR/26-27/0001`.
- **Shared projects and bank accounts.** Projects and bank accounts belong to the group of companies and are no longer copied into each company.
- **Locking and history.** Lock the books up to a date (only admins can change entries on or before it). Every change is logged by the database itself.
- **Every screen from the old app:** dashboard, day book, outstanding with ageing, ledgers (party, cash/bank, category, project, item), inventory with stock value, parties (including merge), projects with budget vs actual across companies, payroll, fixed costs, P&L and cash flow, monthly GST with carry-forward, change history, users and roles (project-restricted users, hidden screens).
- **Demo mode** (*Try the demo* on the sign-in page, or add `?demo` to the address). It runs only in your browser with sample data and never touches the live database.

## Files

```
index.html, css/, js/          the app
manifest.webmanifest, icon.svg install-as-app support
sw.js                          lets the app be installed; clears the old app's offline cache (it caches nothing itself)
db/01_schema.sql               tables (in a new `acc` schema, so the old tables are untouched)
db/02_security.sql             access rules (row-level security), audit log, sign-up handling
db/03_functions.sql            save / delete / transfer / payroll / merge functions
db/04_migrate_from_v1.sql      copies your current data into the new tables (run once)
```

## Going live: step by step

1. **Back up first.** In Supabase, go to Database → Backups, or use `pg_dump`.
2. **Create the tables.** In the Supabase SQL editor, run `db/01_schema.sql`, then `02_security.sql`, then `03_functions.sql`.
3. **Expose the schema.** In Supabase, open Settings → API → Exposed schemas and add `acc`.
4. **Copy your data.** Run `db/04_migrate_from_v1.sql`. It only reads the old tables and runs as one transaction. The message at the end lists how many companies, parties, entries and bill links were copied. Notes on how old data maps:
   - Old entry numbers are kept in each entry's notes (`Old no: …`). Old document numbers become the reference.
   - Projects with the same name in different companies are merged into one shared project.
   - Expenses were always treated as paid immediately in the old app, so they are copied as paid from cash or the chosen bank. One exception: if a payment was linked to an expense, the expense becomes a bill settled by that payment, so the money is not counted twice.
   - Same-company internal transfers become an *Account Transfer*. Transfers between companies become a matched inter-company pair.
   - A payment linked to a bill that was already fully paid keeps the extra as an advance.
   - Payroll months marked *Paid* stay paid.
5. **Host the app.** Upload this folder wherever the current app is hosted. Also copy your existing `supabase-vendor.js` next to `index.html`. If that file is missing, the app loads the same library from the jsDelivr CDN instead.
6. **Check it.** Open the app and sign in with your usual email and password. Compare a few balances against the old app: Dashboard, Outstanding, and Cash & Bank.
7. **Switch over.** When you are happy, stop entering data in the old app. The old tables stay as they were, so you can always look back.

`js/config.js` holds the Supabase address, the publishable key and `mode`. It ships as `mode: 'demo'`; change it to `mode: 'live'` once step 2–4 are done. The publishable key is safe in a web page, because the database's access rules protect the data.

## Rules carried over from the old app

These are checked by the database itself, so they hold even if someone bypasses the screen:

- Only an **Admin** deletes entries or parties (a party that is used on entries must be merged instead).
- **Storekeeper**: Delivery Challans, Payments Received and stock adjustments only, never with a project. Can add parties, not categories.
- **Payroll & employees**: Admin and Accountant. **Paying fixed costs**: Admin, and never more than is due.
- **Financial year**: only an Admin can switch to another year.
- **Purchase, Sale and Delivery Challan** lines must be inventory items (old copied entries with free-text lines stay editable).
- **Duplicate bill numbers** are blocked: purchases and credit/debit notes per party; sales and challans across the company.
- **Credit / debit notes** need a number, a reason in Notes and the original bill; they can't be dated before it or exceed its balance. The bill's project is copied.
- **TDS on a bill** only for the Labour category in a project; otherwise TDS goes on the payment.
- **Cash** mode must use a cash account; **Bank / UPI / Cheque** must use a bank or UPI account.
- **Project company**: a payment or expense recorded by another company for a project is booked in the project's company as "Paid directly by …", with the money shown as sent between the companies. An Admin can also allocate an already-paid expense to another company.
- **Payroll**: no duplicate employee names; "Employee Advance" expenses paid to the employee in the same month are deducted from the salary payment.
- **Stopping a fixed cost** keeps the dues up to that month payable.

## Roles

| Role | Can do |
|---|---|
| Admin | Everything, including users, bank accounts, budgets, the lock date and settings |
| Partner | Add and edit entries and masters (no deleting, no payroll) |
| Accountant | Same as Partner, plus payroll and employees |
| Storekeeper | Inventory items, parties, delivery challans, payments received, stock adjustments |
| Viewer | View only |

Admins can limit a user to chosen projects. They can also hide screens from a user's menu.

## Tests (for developers)

`test/` contains a database test (`db_test.sql`), a mock of the old tables for the migration (`old_schema.sql`), and browser tests for demo mode (`flow.cjs`) and live mode against PostgREST (`live/`).
