-- GKS Accounts v2 — copy data from the current app's tables (public schema) into the new `acc` schema.
-- • Run ONCE, after 01–03, in the Supabase SQL editor. It only READS the old tables; they stay untouched.
-- • Everything runs in one transaction: if anything fails, nothing is copied.
-- • Old entry ids are kept, so links between bills and payments carry over. Old entry numbers are
--   kept in each entry's notes ("Old no: …"); new entries get numbers like PUR/26-27/0001.
begin;
set local search_path = acc, public;

do $migrate$
declare
  g uuid; tmp_id uuid; parent_line uuid; bi record; r record; n int; v_from acc.vouchers; v_to acc.vouchers; amt numeric; tx_count int;
begin
  if exists (select 1 from acc.vouchers) or exists (select 1 from acc.companies) then
    raise exception 'The new tables already contain data. Migration is meant for an empty database.';
  end if;

  -- 1. one group holding every old company (projects & bank accounts were shared across them)
  insert into acc.groups(name) values ('GKS Group') returning id into g;
  insert into acc.companies(id, group_id, name, gstin, state_code, address, created_at)
  select c.id, g, c.name, nullif(to_jsonb(c)->>'gstin',''), coalesce(nullif(to_jsonb(c)->>'state_code',''), left(nullif(to_jsonb(c)->>'gstin',''), 2)),
         nullif(to_jsonb(c)->>'address',''), coalesce((to_jsonb(c)->>'created_at')::timestamptz, now())
  from public.companies c;

  -- 2. people and access
  insert into acc.profiles(id, email, full_name)
  select u.id, lower(u.email), u.raw_user_meta_data->>'full_name' from auth.users u where u.email is not null
  on conflict (id) do nothing;

  insert into acc.company_members(company_id, user_id, role, project_restricted, hidden_sections)
  select m.company_id, m.user_id,
    case when m.role::text in ('admin','partner','accountant','storekeeper','viewer') then m.role::text::acc.member_role else 'viewer' end,
    coalesce((to_jsonb(m)->>'project_restricted')::boolean, false),
    coalesce((select array_remove(array[
        case when (to_jsonb(p)->>'view_dashboard') = 'false' then 'dashboard' end,
        case when (to_jsonb(p)->>'view_transactions') = 'false' then 'entries' end,
        case when (to_jsonb(p)->>'view_inventory') = 'false' then 'inventory' end,
        case when (to_jsonb(p)->>'view_parties') = 'false' then 'parties' end,
        case when (to_jsonb(p)->>'view_bank') = 'false' then 'banking' end,
        case when (to_jsonb(p)->>'view_projects') = 'false' then 'projects' end,
        case when (to_jsonb(p)->>'view_pl') = 'false' then 'reports' end], null)
      from public.member_permissions p where p.company_id = m.company_id and p.user_id = m.user_id limit 1), '{}')
  from public.company_members m
  where exists (select 1 from acc.companies c where c.id = m.company_id) and exists (select 1 from auth.users u where u.id = m.user_id)
  on conflict do nothing;
  insert into acc.profiles(id, email) select u.id, lower(coalesce(u.email, u.id::text)) from auth.users u
    where u.id in (select user_id from acc.company_members) on conflict (id) do nothing;

  insert into acc.invitations(company_id, email, role)
  select i.company_id, lower(i.email),
    case when i.role::text in ('admin','partner','accountant','storekeeper','viewer') then i.role::text::acc.member_role else 'viewer' end
  from public.company_invitations i where exists (select 1 from acc.companies c where c.id = i.company_id)
  on conflict do nothing;

  -- 3. projects: the old app copied each project into every company — merge copies by name
  create temp table map_project(old_id uuid primary key, new_id uuid not null) on commit drop;
  for r in select distinct on (lower(trim(p.name))) p.*, to_jsonb(p) j from public.projects p order by lower(trim(p.name)), (to_jsonb(p)->>'created_at') nulls last loop
    insert into acc.projects(group_id, name, owner_company_id, kind, work_order_no, work_order_date, days_to_complete, active, created_at)
    values (g, trim(r.name), (select id from acc.companies where id = coalesce(nullif(r.j->>'origin_company_id','')::uuid, r.company_id)),
      case r.j->>'project_type' when 'trading' then 'trading' when 'service_job' then 'service' else 'combined' end,
      nullif(r.j->>'work_order_no',''), nullif(r.j->>'work_order_date','')::date, nullif(r.j->>'days_to_complete','')::int,
      coalesce((r.j->>'active')::boolean, true), coalesce((r.j->>'created_at')::timestamptz, now()))
    returning id into tmp_id;
    insert into map_project(old_id, new_id) select p.id, tmp_id from public.projects p where lower(trim(p.name)) = lower(trim(r.name));
    -- BOQ: each work/order item (with its materials & expenses as "components"), or older flat material rows
    for bi in select e, ord from jsonb_array_elements(case when jsonb_typeof(r.j->'boq_items') = 'array' then r.j->'boq_items' else '[]'::jsonb end) with ordinality as x(e, ord) loop
      continue when coalesce(nullif(bi.e->>'item_name',''), nullif(bi.e->>'description','')) is null;
      if jsonb_typeof(bi.e->'components') = 'array' then
        insert into acc.project_budget_lines(project_id, line_no, description, unit, qty, rate, kind, profit_percent)
        values (tmp_id, bi.ord::int, coalesce(nullif(bi.e->>'item_name',''), bi.e->>'description'), nullif(bi.e->>'unit',''),
                greatest(coalesce(nullif(bi.e->>'qty','')::numeric, 0), 0), greatest(coalesce(nullif(bi.e->>'rate','')::numeric, 0), 0), 'order',
                case when nullif(bi.e->>'profit_percent','')::numeric between 0 and 100 then (bi.e->>'profit_percent')::numeric end)
        returning id into parent_line;
        insert into acc.project_budget_lines(project_id, parent_id, line_no, description, unit, qty, rate, kind, cost_type)
        select tmp_id, parent_line, c.ord::int, coalesce(nullif(c.e->>'item_name',''), 'Item'), nullif(c.e->>'unit',''),
               greatest(coalesce(nullif(c.e->>'qty','')::numeric, 0), 0),
               greatest(coalesce(nullif(c.e->>'rate','')::numeric, case when coalesce(nullif(c.e->>'qty','')::numeric,0) > 0 then nullif(c.e->>'amount','')::numeric / (c.e->>'qty')::numeric end, 0), 0),
               'cost', case when c.e->>'cost_type' in ('Material','Labour','Transport','Overhead','Other') then c.e->>'cost_type' else 'Material' end
        from jsonb_array_elements(bi.e->'components') with ordinality as c(e, ord);
      else
        insert into acc.project_budget_lines(project_id, line_no, description, unit, qty, rate, kind, cost_type)
        values (tmp_id, bi.ord::int, coalesce(nullif(bi.e->>'item_name',''), bi.e->>'description'), nullif(bi.e->>'unit',''),
                greatest(coalesce(nullif(bi.e->>'qty','')::numeric, 0), 0), greatest(coalesce(nullif(bi.e->>'rate','')::numeric, 0), 0), 'cost', 'Material');
      end if;
    end loop;
  end loop;

  insert into acc.member_projects(company_id, user_id, project_id)
  select distinct p.company_id, a.user_id, mp.new_id
  from public.project_member_access a join public.projects p on p.id = a.project_id join map_project mp on mp.old_id = a.project_id
  where exists (select 1 from acc.company_members m where m.company_id = p.company_id and m.user_id = a.user_id)
  on conflict do nothing;

  -- 4. parties (old ones keep their id), plus any party name used on an entry but missing from the master
  insert into acc.parties(id, company_id, name, kind, phone, gstin, state_code, active)
  select p.id, p.company_id, trim(p.name),
    case to_jsonb(p)->>'party_type' when 'customer' then 'customer' when 'vendor' then 'vendor' else 'both' end,
    nullif(to_jsonb(p)->>'phone',''), upper(nullif(to_jsonb(p)->>'gstin','')), left(nullif(to_jsonb(p)->>'gstin',''), 2),
    coalesce((to_jsonb(p)->>'active')::boolean, true)
  from public.parties p where exists (select 1 from acc.companies c where c.id = p.company_id) and trim(coalesce(p.name,'')) <> ''
  on conflict do nothing;
  insert into acc.parties(company_id, name, kind)
  select distinct on (t.company_id, lower(trim(t.party_name))) t.company_id, trim(t.party_name),
    case when t.entry_type in ('purchase','supplier_credit','payment_out','expense') then 'vendor' else 'customer' end
  from public.transactions t
  where trim(coalesce(t.party_name,'')) <> '' and exists (select 1 from acc.companies c where c.id = t.company_id)
    and not exists (select 1 from acc.parties x where x.company_id = t.company_id and lower(x.name) = lower(trim(t.party_name)))
  on conflict do nothing;

  -- 5. items and categories
  insert into acc.items(id, company_id, name, unit, active)
  select i.id, i.company_id, trim(i.name), coalesce(nullif(to_jsonb(i)->>'unit',''), 'Nos'), coalesce((to_jsonb(i)->>'active')::boolean, true)
  from public.inventory_items i where exists (select 1 from acc.companies c where c.id = i.company_id)
  on conflict do nothing;
  insert into acc.categories(company_id, name)
  select distinct on (company_id, lower(trim(name))) company_id, trim(name) from (
    select c.company_id, c.name from public.categories c
    union all select t.company_id, t.category from public.transactions t
      where t.entry_type in ('purchase','expense','sale','service') and t.transfer_group_id is null
        and t.category !~* '^(customer|supplier) advance$|company fund - old payment'
    union all select f.company_id, to_jsonb(f)->>'category' from public.fixed_costs f
  ) x where trim(coalesce(name,'')) <> '' and exists (select 1 from acc.companies c where c.id = x.company_id)
  on conflict do nothing;

  -- 6. money accounts: old bank/UPI accounts keep their id; one cash account per company
  insert into acc.money_accounts(id, group_id, kind, name, bank_name, account_last4, active, created_at)
  select b.id, g, case when coalesce(to_jsonb(b)->>'bank_name','') ~* 'upi|paytm|phonepe|gpay|google pay' then 'upi' else 'bank' end,
    coalesce(nullif(to_jsonb(b)->>'account_name',''), b.bank_name),
    b.bank_name, case when (to_jsonb(b)->>'account_last4') ~ '^[0-9]{4}$' then to_jsonb(b)->>'account_last4' end,
    coalesce((to_jsonb(b)->>'active')::boolean, true), coalesce((to_jsonb(b)->>'created_at')::timestamptz, now())
  from public.bank_accounts b;
  insert into acc.money_account_companies(account_id, company_id, opening_balance)
  select distinct on (account_id, company_id) account_id, company_id, opening from (
    select b.id account_id, (to_jsonb(b)->>'company_id')::uuid company_id, coalesce((to_jsonb(b)->>'opening_balance')::numeric, 0) opening, 0 pri from public.bank_accounts b
    union all select l.bank_account_id, l.company_id, 0, 1 from public.bank_account_companies l
  ) x where company_id in (select id from acc.companies) order by account_id, company_id, pri
  on conflict do nothing;
  create temp table map_cash(company_id uuid primary key, account_id uuid) on commit drop;
  for r in select id, name from acc.companies loop
    insert into acc.money_accounts(group_id, kind, name) values (g, 'cash', 'Cash in Hand - ' || r.name) returning id into tmp_id;
    insert into acc.money_account_companies(account_id, company_id) values (tmp_id, r.id);
    insert into map_cash values (r.id, tmp_id);
  end loop;

  -- 7. entries
  create temp table tx on commit drop as
  select t.*, to_jsonb(t) j,
    case
      when t.entry_type = 'payment_in' and t.linked_transaction_id is null and t.transfer_group_id is null
           and coalesce(t.category,'') ~* 'company fund - old payment|capital investment|capital introduced' then 'capital_in'
      when t.entry_type = 'payment_out' and t.linked_transaction_id is null and t.transfer_group_id is null
           and coalesce(t.category,'') ~* 'capital|withdraw|drawing|partner' then 'capital_out'
      when t.entry_type = 'payment_in' then 'receipt'
      when t.entry_type = 'payment_out' then 'payment'
      else t.entry_type end as new_type
  from public.transactions t where exists (select 1 from acc.companies c where c.id = t.company_id);
  -- transfers: a same-company pair becomes one account transfer; a cross-company pair becomes inter-company
  update tx set new_type = case when (select count(distinct company_id) from tx x where x.transfer_group_id = tx.transfer_group_id) = 1
                                then case when entry_type = 'payment_out' then 'transfer' else 'skip' end
                                else case when entry_type = 'payment_out' then 'interco_out' else 'interco_in' end end
  where transfer_group_id is not null;
  select count(*) into tx_count from tx;

  insert into acc.vouchers(id, legacy_id, company_id, voucher_type, voucher_no, fy, voucher_date, ref_no, party_id, project_id, category_id,
    account_id, to_account_id, payment_mode, gst_mode, taxable_amount, cgst_amount, sgst_amount, igst_amount, round_off, total_amount,
    tds_rate, tds_amount, transfer_group_id, notes, created_by, created_at, updated_at)
  select t.id, t.id, t.company_id, t.new_type::acc.voucher_type,
    acc.voucher_prefix(t.new_type::acc.voucher_type) || '/' || acc.fy_label(t.txn_date::date, 4) || '/' ||
      lpad((row_number() over (partition by t.company_id, acc.fy_label(t.txn_date::date, 4), t.new_type order by t.txn_date, t.j->>'created_at', t.id))::text, 4, '0'),
    acc.fy_label(t.txn_date::date, 4), t.txn_date::date, nullif(t.document_no,''),
    (select p.id from acc.parties p where p.company_id = t.company_id and lower(p.name) = lower(trim(t.party_name)) limit 1),
    (select new_id from map_project where old_id = t.project_id),
    case when t.new_type in ('purchase','expense','sale','service','capital_in','capital_out') then
      (select c.id from acc.categories c where c.company_id = t.company_id and lower(c.name) = lower(trim(t.category)) limit 1) end,
    -- account: money entries and expenses (the old app treated every expense as paid immediately)
    case when t.new_type in ('receipt','payment','capital_in','capital_out','interco_in','interco_out','transfer','expense') then
      coalesce((select a.id from acc.money_accounts a where a.id = t.bank_account_id),
               case when coalesce(t.payment_mode,'Cash') ~* 'cash' or t.bank_account_id is null then (select account_id from map_cash where company_id = t.company_id) end) end,
    case when t.new_type = 'transfer' then
      (select coalesce(x.bank_account_id, (select account_id from map_cash where company_id = x.company_id)) from tx x
       where x.transfer_group_id = t.transfer_group_id and x.entry_type = 'payment_in' limit 1) end,
    case when coalesce(t.payment_mode,'') ~* 'cash' then 'cash' when coalesce(t.payment_mode,'') ~* 'upi' then 'upi'
         when coalesce(t.payment_mode,'') ~* 'bank|neft|rtgs|imps' then 'bank' when coalesce(t.payment_mode,'') ~* 'cheque' then 'cheque' end,
    case when coalesce((t.j->>'gst_amount')::numeric, 0) = 0 then 'none' when t.j->>'gst_mode' = 'inter' then 'inter' else 'intra' end,
    case when t.new_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit') then coalesce((t.j->>'amount_base')::numeric, t.total_amount) else 0 end,
    coalesce((t.j->>'cgst_amount')::numeric, case when t.j->>'gst_mode' <> 'inter' then round(coalesce((t.j->>'gst_amount')::numeric,0)/2, 2) else 0 end),
    coalesce((t.j->>'sgst_amount')::numeric, case when t.j->>'gst_mode' <> 'inter' then coalesce((t.j->>'gst_amount')::numeric,0) - round(coalesce((t.j->>'gst_amount')::numeric,0)/2, 2) else 0 end),
    coalesce((t.j->>'igst_amount')::numeric, case when t.j->>'gst_mode' = 'inter' then coalesce((t.j->>'gst_amount')::numeric,0) else 0 end),
    0, abs(t.total_amount),
    coalesce((t.j->>'tds_rate')::numeric, 0), least(coalesce((t.j->>'tds_amount')::numeric, 0), abs(t.total_amount)),
    case when t.new_type in ('interco_in','interco_out') then t.transfer_group_id end,
    nullif(concat_ws(' · ', nullif(t.notes,''), case when t.new_type in ('receipt','payment') and t.category is not null and t.category !~* 'advance' then t.category end,
                     case when t.journal_entry_no is not null then 'Old no: ' || t.journal_entry_no end), ''),
    nullif(t.j->>'created_by','')::uuid, coalesce((t.j->>'created_at')::timestamptz, now()), coalesce((t.j->>'updated_at')::timestamptz, (t.j->>'created_at')::timestamptz, now())
  from tx t where t.new_type <> 'skip' and t.new_type in (select unnest(enum_range(null::acc.voucher_type))::text);

  -- GST amounts: if old split columns were missing for inter-state rows, cgst/sgst got zero above; round-off absorbs tiny differences
  update acc.vouchers v set round_off = d.diff
  from (select id, total_amount - (taxable_amount + cgst_amount + sgst_amount + igst_amount) diff from acc.vouchers
        where voucher_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit')) d
  where v.id = d.id and abs(d.diff) between 0.005 and 99.99;
  update acc.vouchers set taxable_amount = total_amount - (cgst_amount + sgst_amount + igst_amount) - round_off
  where voucher_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit')
    and abs(total_amount - (taxable_amount + cgst_amount + sgst_amount + igst_amount + round_off)) >= 0.005;

  -- lines
  insert into acc.voucher_lines(voucher_id, line_no, item_id, description, hsn, qty, unit, rate, gst_rate, amount)
  select v.id, x.ord::int,
    (select i.id from acc.items i where i.company_id = v.company_id and lower(i.name) = lower(trim(coalesce(x.e->>'item_name', x.e->>'name'))) limit 1),
    coalesce(nullif(x.e->>'item_name',''), nullif(x.e->>'name',''), nullif(x.e->>'description','')), nullif(x.e->>'hsn',''),
    coalesce(nullif(x.e->>'qty','')::numeric, 0), nullif(x.e->>'unit',''), coalesce(nullif(x.e->>'rate','')::numeric, 0),
    case when v.gst_mode = 'none' then 0 else coalesce((t.j->>'gst_rate')::numeric, 0) end,
    coalesce(nullif(x.e->>'amount','')::numeric, coalesce(nullif(x.e->>'qty','')::numeric,0) * coalesce(nullif(x.e->>'rate','')::numeric,0))
  from acc.vouchers v join tx t on t.id = v.id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(t.j->'line_items') = 'array' then t.j->'line_items' else '[]'::jsonb end) with ordinality as x(e, ord)
  where v.voucher_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit');
  insert into acc.voucher_lines(voucher_id, line_no, description, qty, gst_rate, amount)
  select v.id, 1, coalesce(nullif(t.category,''), nullif(t.notes,''), initcap(replace(v.voucher_type::text, '_', ' '))), 0,
    case when v.gst_mode = 'none' then 0 else coalesce((t.j->>'gst_rate')::numeric, 0) end, v.taxable_amount
  from acc.vouchers v join tx t on t.id = v.id
  where v.voucher_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit')
    and not exists (select 1 from acc.voucher_lines l where l.voucher_id = v.id);

  -- 8. bill links → allocations (capped at what is still pending; any excess stays as an advance)
  n := 0;
  for r in select t.id, t.linked_transaction_id from tx t where t.linked_transaction_id is not null and t.new_type in ('receipt','payment','customer_credit','supplier_credit')
           order by t.txn_date, t.j->>'created_at' loop
    select * into v_from from acc.vouchers where id = r.id;
    select * into v_to from acc.vouchers where id = r.linked_transaction_id;
    continue when v_from.id is null or v_to.id is null or v_to.company_id <> v_from.company_id
      or not (v_to.voucher_type = any(acc.allocation_targets(v_from.voucher_type)));
    if v_to.party_id is distinct from v_from.party_id then
      raise notice 'Skipped link % → % (different party names)', v_from.voucher_no, v_to.voucher_no; continue; end if;
    if v_to.account_id is not null then
      -- an expense the old app counted as paid, but a payment was also linked to it: make it a bill settled by that payment
      if v_to.voucher_type = 'expense' and v_to.party_id is not null then update acc.vouchers set account_id = null where id = v_to.id;
      else continue; end if;
    end if;
    amt := least(v_from.total_amount - coalesce((select sum(amount) from acc.allocations where from_voucher_id = v_from.id), 0),
                 v_to.net_amount - coalesce((select sum(amount) from acc.allocations where to_voucher_id = v_to.id), 0));
    if amt > 0.004 then
      insert into acc.allocations(company_id, from_voucher_id, to_voucher_id, amount, created_at) values (v_from.company_id, v_from.id, v_to.id, round(amt, 2), v_from.created_at);
      n := n + 1;
    end if;
  end loop;

  -- 9. numbering continues after the migrated entries
  insert into acc.counters(company_id, fy, voucher_type, last_no)
  select company_id, fy, voucher_type, count(*) from acc.vouchers group by 1, 2, 3;

  -- 10. payroll and fixed costs
  insert into acc.employees(id, company_id, name, designation, monthly_salary, project_id, joining_date, active)
  select e.id, e.company_id, e.name, nullif(to_jsonb(e)->>'designation',''), coalesce((to_jsonb(e)->>'monthly_salary')::numeric, 0),
    (select new_id from map_project where old_id = nullif(to_jsonb(e)->>'project_id','')::uuid), nullif(to_jsonb(e)->>'joining_date','')::date,
    coalesce((to_jsonb(e)->>'active')::boolean, true)
  from public.employees e where e.company_id in (select id from acc.companies);
  insert into acc.payroll(company_id, employee_id, month, working_days, present_days, base_salary, bonus, deduction, paid_on)
  select p.company_id, p.employee_id, date_trunc('month', p.payroll_month::date)::date,
    coalesce((to_jsonb(p)->>'working_days')::numeric, 30), coalesce((to_jsonb(p)->>'present_days')::numeric, 30),
    coalesce((to_jsonb(p)->>'base_salary')::numeric, 0), coalesce((to_jsonb(p)->>'bonus')::numeric, 0), coalesce((to_jsonb(p)->>'deduction')::numeric, 0),
    case when to_jsonb(p)->>'payment_status' = 'Paid' then coalesce(nullif(to_jsonb(p)->>'paid_on','')::date, p.payroll_month::date) end
  from public.employee_payroll p where p.employee_id in (select id from acc.employees)
  on conflict do nothing;
  insert into acc.fixed_costs(id, company_id, name, category_id, project_id, monthly_amount, start_month, end_month, notes, active)
  select f.id, f.company_id, f.name,
    (select c.id from acc.categories c where c.company_id = f.company_id and lower(c.name) = lower(trim(to_jsonb(f)->>'category')) limit 1),
    (select new_id from map_project where old_id = nullif(to_jsonb(f)->>'project_id','')::uuid),
    f.monthly_amount, date_trunc('month', (to_jsonb(f)->>'start_month')::date)::date,
    date_trunc('month', nullif(to_jsonb(f)->>'end_month','')::date)::date, nullif(to_jsonb(f)->>'notes',''), coalesce((to_jsonb(f)->>'active')::boolean, true)
  from public.fixed_costs f where f.company_id in (select id from acc.companies) and f.monthly_amount > 0;
  insert into acc.fixed_cost_payments(fixed_cost_id, voucher_id, month, amount)
  select p.fixed_cost_id, p.transaction_id, date_trunc('month', p.period_month::date)::date, p.amount
  from public.fixed_cost_payments p
  where p.fixed_cost_id in (select id from acc.fixed_costs) and p.transaction_id in (select id from acc.vouchers) and p.amount > 0;

  -- migration rows are not user changes: clear the audit log it produced
  delete from acc.audit_log;

  raise notice 'Copied % companies, % parties, % projects, % entries (of % old rows), % bill links, % employees.',
    (select count(*) from acc.companies), (select count(*) from acc.parties), (select count(*) from acc.projects),
    (select count(*) from acc.vouchers), tx_count, n, (select count(*) from acc.employees);
end $migrate$;

commit;
