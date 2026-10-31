-- GKS Accounts v2 — payroll with salary structure and statutory deductions (PF, ESIC, PT, TDS).
-- Run once in the Supabase SQL editor after 01–03 (and 04 if you migrated). Safe to run on a live database:
-- it only adds columns, one table and one function. Everything runs in one transaction.
begin;
set local search_path = acc, public;

-- ── Company payroll settings (rates and limits; editable in Company & Users → Payroll rules) ──
alter table acc.companies add column if not exists payroll_settings jsonb not null default '{}'::jsonb;

-- ── Employee salary structure and statutory details ──
alter table acc.employees
  add column if not exists basic numeric(12,2) not null default 0,          -- Basic + DA (PF is worked out on this)
  add column if not exists hra numeric(12,2) not null default 0,
  add column if not exists conveyance numeric(12,2) not null default 0,
  add column if not exists other_allowance numeric(12,2) not null default 0, -- special / other allowances
  add column if not exists gender text not null default 'M' check (gender in ('M','F')),
  add column if not exists pf_member boolean not null default true,
  add column if not exists pf_on_ceiling boolean not null default true,     -- contribute on wages up to the ceiling only
  add column if not exists esic_member boolean not null default true,       -- applies only while gross is within the ESIC limit
  add column if not exists pt_applicable boolean not null default true,
  add column if not exists uan text,
  add column if not exists esic_no text,
  add column if not exists pan text;
-- existing employees: whole salary treated as basic until the structure is filled in
update acc.employees set basic = monthly_salary where basic = 0 and hra = 0 and conveyance = 0 and other_allowance = 0;

-- ── Monthly payroll: earned salary and every deduction, worked out by the app and stored ──
alter table acc.payroll
  add column if not exists basic numeric(12,2) not null default 0,          -- full-month rates for this month
  add column if not exists hra numeric(12,2) not null default 0,
  add column if not exists conveyance numeric(12,2) not null default 0,
  add column if not exists other_allowance numeric(12,2) not null default 0,
  add column if not exists earned_gross numeric(12,2) not null default 0,   -- for the days present
  add column if not exists overtime numeric(12,2) not null default 0,
  add column if not exists pf_employee numeric(12,2) not null default 0,
  add column if not exists esic_employee numeric(12,2) not null default 0,
  add column if not exists pt numeric(12,2) not null default 0,
  add column if not exists tds numeric(12,2) not null default 0,
  add column if not exists pf_employer numeric(12,2) not null default 0,    -- EPF + EPS share
  add column if not exists pf_admin numeric(12,2) not null default 0,       -- EDLI + admin charges
  add column if not exists esic_employer numeric(12,2) not null default 0;
update acc.payroll set basic = base_salary, earned_gross = round(base_salary * present_days / nullif(working_days, 0), 2)
  where earned_gross = 0 and basic = 0;
alter table acc.payroll drop column if exists net_pay;
alter table acc.payroll add column net_pay numeric(12,2) generated always as
  (earned_gross + overtime + bonus - pf_employee - esic_employee - pt - tds - deduction) stored;

-- rows added without the worked-out figures (older app versions) still get the earned salary
create or replace function acc.payroll_defaults() returns trigger language plpgsql as $$
begin
  if new.base_salary is null or new.base_salary = 0 then
    select monthly_salary into new.base_salary from acc.employees where id = new.employee_id;
  end if;
  if coalesce(new.earned_gross, 0) = 0 and new.working_days > 0 then
    new.earned_gross := round(new.base_salary * new.present_days / new.working_days, 2);
  end if;
  if coalesce(new.basic, 0) = 0 and coalesce(new.hra, 0) = 0 and coalesce(new.conveyance, 0) = 0 and coalesce(new.other_allowance, 0) = 0 then
    new.basic := new.base_salary;
  end if;
  return new;
end $$;

-- ── Payments of PF / ESIC / PT / TDS to the government ──
create table if not exists acc.statutory_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('pf','esic','pt','tds')),
  amount numeric(12,2) not null check (amount > 0),
  voucher_id uuid not null references acc.vouchers(id) on delete cascade,
  paid_on date not null,
  created_at timestamptz not null default now()
);
alter table acc.statutory_payments enable row level security;
drop policy if exists statutory_read on acc.statutory_payments;
create policy statutory_read on acc.statutory_payments for select using (acc.my_role(company_id) in ('admin','accountant'));
grant select on acc.statutory_payments to authenticated;

create or replace function acc.statutory_due(p_company uuid, p_month date, p_kind text) returns numeric
language sql stable security definer set search_path = acc, public as $$
  select round(coalesce((select sum(case p_kind when 'pf' then pf_employee + pf_employer + pf_admin when 'esic' then esic_employee + esic_employer
                                               when 'pt' then pt else tds end) from acc.payroll where company_id = p_company and month = p_month), 0)
             - coalesce((select sum(s.amount) from acc.statutory_payments s join acc.vouchers x on x.id = s.voucher_id and x.deleted_at is null
                          where s.company_id = p_company and s.month = p_month and s.kind = p_kind), 0), 2)
$$;

create or replace function acc.pay_statutory(p_company uuid, p_month date, p_kind text, p_date date, p_account uuid, p_amount numeric) returns uuid
language plpgsql security definer set search_path = acc, public as $$
declare due numeric; amt numeric := round(p_amount, 2); cat uuid; cat_name text; kind text; v jsonb; label text;
begin
  if acc.my_role(p_company) not in ('admin','accountant') then raise exception 'Only an admin or accountant can pay PF, ESIC, PT or TDS.'; end if;
  if p_kind not in ('pf','esic','pt','tds') then raise exception 'Unknown due.'; end if;
  if amt is null or amt <= 0 then raise exception 'Enter an amount more than zero.'; end if;
  due := acc.statutory_due(p_company, p_month, p_kind);
  if amt > due + 0.004 then raise exception 'Only % is due for this month.', to_char(due, 'FM99,99,99,990.00'); end if;
  cat_name := case p_kind when 'pf' then 'PF Contribution' when 'esic' then 'ESIC Contribution' when 'pt' then 'Professional Tax' else 'TDS on Salary' end;
  label := case p_kind when 'pf' then 'PF' when 'esic' then 'ESIC' when 'pt' then 'Professional Tax' else 'TDS on salary' end;
  select id into cat from acc.categories where company_id = p_company and lower(name) = lower(cat_name);
  if cat is null then insert into acc.categories(company_id, name) values (p_company, cat_name) returning id into cat; end if;
  select a.kind into kind from acc.money_accounts a where a.id = p_account;
  v := acc.save_voucher(jsonb_build_object('company_id', p_company, 'voucher_type', 'expense', 'voucher_date', p_date,
    'account_id', p_account, 'payment_mode', case when kind = 'cash' then 'cash' else 'bank' end, 'category_id', cat, 'gst_mode', 'none', 'book_here', true,
    'notes', label || ' for ' || to_char(p_month, 'Mon YYYY') || ' (employee + employer share)',
    'lines', jsonb_build_array(jsonb_build_object('description', label || ' ' || to_char(p_month, 'Mon YYYY'), 'amount', amt))));
  insert into acc.statutory_payments(company_id, month, kind, amount, voucher_id, paid_on) values (p_company, p_month, p_kind, amt, (v->>'id')::uuid, p_date);
  return (v->>'id')::uuid;
end $$;
grant execute on function acc.statutory_due(uuid, date, text), acc.pay_statutory(uuid, date, text, date, uuid, numeric) to authenticated;

-- a deleted payment no longer counts (the join above already ignores it); also tidy the link
create or replace function acc.statutory_cleanup() returns trigger language plpgsql security definer set search_path = acc, public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then delete from acc.statutory_payments where voucher_id = new.id; end if;
  return new;
end $$;
drop trigger if exists statutory_cleanup on acc.vouchers;
create trigger statutory_cleanup after update of deleted_at on acc.vouchers for each row execute function acc.statutory_cleanup();

commit;
