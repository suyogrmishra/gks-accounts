-- GKS Accounts v2 — database schema for Supabase (PostgreSQL 15+)
-- Run files in order: 01_schema.sql, 02_security.sql, 03_functions.sql
-- Everything lives in the `acc` schema so it cannot clash with your current tables.
-- In Supabase: Settings → API → "Exposed schemas" → add `acc`.

create schema if not exists acc;
set search_path = acc, public;

-- ───────────────────────── Organisation ─────────────────────────
-- A group owns several companies. Projects and bank accounts are shared across
-- the companies of one group (the old app copied them into every company).
create table acc.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table acc.companies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references acc.groups(id) on delete restrict,
  name text not null,
  gstin text,
  state_code text,                      -- 2-digit GST state code, e.g. '27'
  address text,
  phone text,
  email text,
  fy_start_month int not null default 4 check (fy_start_month between 1 and 12),
  lock_date date,                       -- entries on/before this date can only be changed by an admin
  allow_negative_stock boolean not null default false,
  opening_gst_credit numeric(14,2) not null default 0,
  logo_url text,
  bank_details text,                    -- printed on sale invoices
  invoice_terms text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- secrets readable only through functions (no select policy)
create table acc.company_secrets (
  company_id uuid primary key references acc.companies(id) on delete cascade,
  admin_pin_hash text,
  updated_at timestamptz not null default now()
);

create table acc.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

create type acc.member_role as enum ('admin','partner','accountant','storekeeper','viewer');

create table acc.company_members (
  company_id uuid not null references acc.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role acc.member_role not null default 'viewer',
  project_restricted boolean not null default false,   -- true → sees only projects in member_projects
  hidden_sections text[] not null default '{}',         -- UI sections hidden for this member
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table acc.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  email text not null,
  role acc.member_role not null default 'viewer',
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, email)
);

-- ───────────────────────── Masters ─────────────────────────
create table acc.projects (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references acc.groups(id) on delete cascade,
  name text not null,
  kind text not null default 'combined' check (kind in ('trading','service','combined')),
  client_party_name text,
  work_order_no text,
  work_order_date date,
  order_value numeric(14,2) not null default 0,
  owner_company_id uuid references acc.companies(id),   -- "project company": payments by other companies are booked here
  days_to_complete int,
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index projects_group_name on acc.projects (group_id, lower(name));

create table acc.member_projects (
  company_id uuid not null,
  user_id uuid not null,
  project_id uuid not null references acc.projects(id) on delete cascade,
  primary key (company_id, user_id, project_id),
  foreign key (company_id, user_id) references acc.company_members(company_id, user_id) on delete cascade
);

create table acc.project_budget_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references acc.projects(id) on delete cascade,
  parent_id uuid references acc.project_budget_lines(id) on delete cascade,  -- cost line → its work/order item
  line_no int not null default 0,
  description text not null,
  unit text,
  qty numeric(14,3) not null default 0,
  rate numeric(14,2) not null default 0,
  kind text not null default 'cost' check (kind in ('cost','order')),  -- order = work/order item (PO qty & rate), cost = material/expense needed
  cost_type text check (cost_type in ('Material','Labour','Transport','Overhead','Other')),
  profit_percent numeric(5,2) check (profit_percent between 0 and 100),   -- order items: estimated profit %
  check (qty >= 0 and rate >= 0)
);

create table acc.parties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  name text not null,
  kind text not null default 'both' check (kind in ('customer','vendor','both')),
  phone text,
  email text,
  gstin text,
  state_code text,
  pan text,
  address text,
  opening_balance numeric(14,2) not null default 0,   -- +ve = they owe us, -ve = we owe them
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index parties_company_name on acc.parties (company_id, lower(name));

create table acc.items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  name text not null,
  unit text not null default 'Nos',
  hsn text,
  gst_rate numeric(5,2),
  opening_qty numeric(14,3) not null default 0,
  opening_rate numeric(14,2) not null default 0,
  reorder_level numeric(14,3),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index items_company_name on acc.items (company_id, lower(name));

create table acc.categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  name text not null,
  kind text not null default 'expense' check (kind in ('expense','income','capital','other')),
  active boolean not null default true
);
create unique index categories_company_name on acc.categories (company_id, lower(name));

-- Cash, bank and UPI accounts. Owned by the group, usable by the companies linked to it.
create table acc.money_accounts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references acc.groups(id) on delete cascade,
  kind text not null check (kind in ('cash','bank','upi')),
  name text not null,
  bank_name text,
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),
  ifsc text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table acc.money_account_companies (
  account_id uuid not null references acc.money_accounts(id) on delete cascade,
  company_id uuid not null references acc.companies(id) on delete cascade,
  opening_balance numeric(14,2) not null default 0,
  primary key (account_id, company_id)
);

-- ───────────────────────── Vouchers ─────────────────────────
create type acc.voucher_type as enum (
  'sale','service','challan','purchase','expense',
  'customer_credit','supplier_credit',
  'receipt','payment',
  'transfer',                 -- between two money accounts of the same company
  'capital_in','capital_out', -- partner investment / withdrawal
  'interco_out','interco_in', -- matched pair between two companies of the group
  'stock_adjust'
);

create table acc.counters (
  company_id uuid not null references acc.companies(id) on delete cascade,
  fy text not null,
  voucher_type acc.voucher_type not null,
  last_no int not null default 0,
  primary key (company_id, fy, voucher_type)
);

create table acc.vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete restrict,
  voucher_type acc.voucher_type not null,
  voucher_no text not null,
  fy text not null,
  voucher_date date not null,
  ref_no text,                               -- supplier invoice no., challan no., cheque/UTR
  party_id uuid references acc.parties(id),
  project_id uuid references acc.projects(id),
  category_id uuid references acc.categories(id),
  account_id uuid references acc.money_accounts(id),      -- money account the cash moved through (null = not paid yet)
  to_account_id uuid references acc.money_accounts(id),   -- transfers only
  payment_mode text check (payment_mode in ('cash','bank','upi','cheque','other')),
  gst_mode text check (gst_mode in ('intra','inter','none')),
  taxable_amount numeric(14,2) not null default 0,
  cgst_amount numeric(14,2) not null default 0,
  sgst_amount numeric(14,2) not null default 0,
  igst_amount numeric(14,2) not null default 0,
  round_off numeric(8,2) not null default 0,
  total_amount numeric(14,2) not null check (total_amount >= 0),
  -- bills: TDS deducted on the bill; receipts/payments: TDS deducted at payment time
  tds_section text,
  tds_rate numeric(5,2) not null default 0,
  tds_amount numeric(14,2) not null default 0 check (tds_amount >= 0),
  -- bills: amount actually due (total - TDS). receipts/payments: cash that moved (total - TDS).
  net_amount numeric(14,2) generated always as (total_amount - tds_amount) stored,
  transfer_group_id uuid,                    -- links interco_out ↔ interco_in
  notes text,
  doc_url text,                              -- link to the bill scan / document
  legacy_id uuid unique,                     -- id in the old `transactions` table (migration)
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  unique (company_id, fy, voucher_type, voucher_no),
  check (tds_amount <= total_amount)
);
create index vouchers_company_date on acc.vouchers (company_id, voucher_date) where deleted_at is null;
create index vouchers_party on acc.vouchers (party_id) where deleted_at is null;
create index vouchers_project on acc.vouchers (project_id) where deleted_at is null;

create table acc.voucher_lines (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references acc.vouchers(id) on delete cascade,
  line_no int not null default 0,
  item_id uuid references acc.items(id),
  description text,
  hsn text,
  qty numeric(14,3) not null default 0,
  unit text,
  rate numeric(14,2) not null default 0,
  gst_rate numeric(5,2) not null default 0,
  amount numeric(14,2) not null default 0      -- taxable value of the line
);
create index voucher_lines_voucher on acc.voucher_lines (voucher_id);
create index voucher_lines_item on acc.voucher_lines (item_id);

-- Settlement of bills. One receipt/payment/credit note can settle many bills;
-- one bill can be settled by many. Whatever part of a receipt/payment is not
-- allocated is that party's advance — no separate "advance" entry is needed.
create table acc.allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  from_voucher_id uuid not null references acc.vouchers(id) on delete cascade,  -- receipt / payment / credit note
  to_voucher_id uuid not null references acc.vouchers(id) on delete cascade,    -- sale / service / challan / purchase / expense
  amount numeric(14,2) not null check (amount > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (from_voucher_id, to_voucher_id)
);
create index allocations_to on acc.allocations (to_voucher_id);

-- ───────────────────────── Payroll & fixed costs ─────────────────────────
create table acc.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  name text not null,
  designation text,
  phone text,
  monthly_salary numeric(12,2) not null default 0,
  project_id uuid references acc.projects(id),
  joining_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index employees_company_name on acc.employees (company_id, (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')));

create table acc.payroll (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  employee_id uuid not null references acc.employees(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  working_days numeric(5,2) not null default 30,
  present_days numeric(5,2) not null default 30,
  base_salary numeric(12,2) not null default 0,
  bonus numeric(12,2) not null default 0,
  deduction numeric(12,2) not null default 0,
  net_pay numeric(12,2) generated always as
    (round(base_salary * present_days / nullif(working_days,0), 2) + bonus - deduction) stored,
  voucher_id uuid references acc.vouchers(id) on delete set null,   -- the salary expense voucher once paid
  paid_on date,                                                      -- set when paid (also for payroll paid in the old app)
  unique (employee_id, month)
);

create table acc.fixed_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  name text not null,
  category_id uuid references acc.categories(id),
  project_id uuid references acc.projects(id),
  monthly_amount numeric(12,2) not null check (monthly_amount > 0),
  start_month date not null,
  end_month date,
  notes text,
  active boolean not null default true
);

create table acc.fixed_cost_payments (
  id uuid primary key default gen_random_uuid(),
  fixed_cost_id uuid not null references acc.fixed_costs(id) on delete cascade,
  voucher_id uuid not null references acc.vouchers(id) on delete cascade,
  month date not null,
  amount numeric(12,2) not null check (amount > 0)
);

-- ───────────────────────── Audit ─────────────────────────
create table acc.audit_log (
  id bigint generated always as identity primary key,
  company_id uuid,
  table_name text not null,
  row_id uuid,
  action text not null,         -- insert / update / delete
  old_data jsonb,
  new_data jsonb,
  user_id uuid,
  at timestamptz not null default now()
);
create index audit_company_at on acc.audit_log (company_id, at desc);
