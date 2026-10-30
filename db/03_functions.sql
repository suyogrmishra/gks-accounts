-- GKS Accounts v2 — server functions. All voucher writes go through these so that a voucher,
-- its lines and its bill allocations are validated and saved together (all or nothing).
set search_path = acc, public;

create or replace function acc.fy_label(p_date date, p_start_month int default 4) returns text
language sql immutable as $$
  select case when extract(month from p_date) >= p_start_month
    then to_char(p_date, 'YY') || '-' || to_char(p_date + interval '1 year', 'YY')
    else to_char(p_date - interval '1 year', 'YY') || '-' || to_char(p_date, 'YY') end
$$;

create or replace function acc.voucher_prefix(t acc.voucher_type) returns text
language sql immutable as $$
  select case t
    when 'sale' then 'SAL' when 'service' then 'SRV' when 'challan' then 'DC' when 'purchase' then 'PUR'
    when 'expense' then 'EXP' when 'customer_credit' then 'CNC' when 'supplier_credit' then 'CNS'
    when 'receipt' then 'RCT' when 'payment' then 'PAY' when 'transfer' then 'TRF'
    when 'capital_in' then 'CAP' when 'capital_out' then 'DRW' when 'interco_out' then 'ICO'
    when 'interco_in' then 'ICI' when 'stock_adjust' then 'ADJ' end
$$;

create or replace function acc.next_voucher_no(p_company uuid, p_fy text, p_type acc.voucher_type) returns text
language plpgsql security definer set search_path = acc, public as $$
declare n int;
begin
  insert into acc.counters(company_id, fy, voucher_type, last_no) values (p_company, p_fy, p_type, 1)
  on conflict (company_id, fy, voucher_type) do update set last_no = acc.counters.last_no + 1
  returning last_no into n;
  return acc.voucher_prefix(p_type) || '/' || p_fy || '/' || lpad(n::text, 4, '0');
end $$;

-- which bill types each settling voucher may be allocated to
create or replace function acc.allocation_targets(t acc.voucher_type) returns acc.voucher_type[]
language sql immutable as $$
  select case
    when t in ('receipt','customer_credit') then array['sale','service','challan']::acc.voucher_type[]
    when t in ('payment','supplier_credit') then array['purchase','expense']::acc.voucher_type[]
    else array[]::acc.voucher_type[] end
$$;

create or replace function acc.num(j jsonb, k text, d numeric default 0) returns numeric
language sql immutable as $$ select coalesce(nullif(j->>k, '')::numeric, d) $$;

create or replace function acc.uid_or_null(j jsonb, k text) returns uuid
language sql immutable as $$ select nullif(j->>k, '')::uuid $$;

-- ───────────────────────── book a paid payment/expense in another group company ─────────────────────────
-- Used when a company pays for a project owned by another company, and when an admin re-allocates a paid
-- expense. The payer keeps the money movement as "Transfer to group company"; the owner gets matching
-- "Transfer from group company" funding and the payment/expense itself, both through its cash account.
create or replace function acc.mirror_to_owner(p_id uuid, p_owner uuid) returns acc.vouchers
language plpgsql security definer set search_path = acc, public as $$
declare v acc.vouchers; src acc.companies; dst acc.companies; g uuid := gen_random_uuid(); cash uuid; party uuid; cat uuid; copy_id uuid; r acc.vouchers; fy text;
begin
  select * into v from acc.vouchers where id = p_id and deleted_at is null for update;
  select * into src from acc.companies where id = v.company_id;
  select * into dst from acc.companies where id = p_owner;
  if v.id is null or dst.id is null or dst.group_id <> src.group_id or dst.id = src.id then raise exception 'Choose another company of the same group.'; end if;
  if v.voucher_type not in ('payment','expense') or v.account_id is null then raise exception 'Only a paid expense or payment can be booked in another company.'; end if;
  if v.transfer_group_id is not null then raise exception 'This entry is already linked between companies.'; end if;
  if exists (select 1 from acc.allocations where from_voucher_id = v.id or to_voucher_id = v.id) then raise exception 'Unlink its bills first.'; end if;
  if not acc.can_write(dst.id) then raise exception 'You need entry permission in % to book this there.', dst.name; end if;
  select a.id into cash from acc.money_accounts a join acc.money_account_companies m on m.account_id = a.id
    where m.company_id = dst.id and a.kind = 'cash' and a.active order by a.created_at limit 1;
  if cash is null then raise exception '% has no cash account to book this through.', dst.name; end if;
  if v.party_id is not null then
    select d.id into party from acc.parties s join acc.parties d on d.company_id = dst.id and lower(d.name) = lower(s.name) where s.id = v.party_id;
    if party is null then
      insert into acc.parties(company_id, name, kind, phone, gstin, state_code, pan, address)
      select dst.id, name, kind, phone, gstin, state_code, pan, address from acc.parties where id = v.party_id returning id into party;
    end if;
  end if;
  if v.category_id is not null then
    select d.id into cat from acc.categories s join acc.categories d on d.company_id = dst.id and lower(d.name) = lower(s.name) where s.id = v.category_id;
    if cat is null then insert into acc.categories(company_id, name, kind) select dst.id, name, kind from acc.categories where id = v.category_id returning id into cat; end if;
  end if;
  fy := acc.fy_label(v.voucher_date, dst.fy_start_month);
  -- owner: funding received, then the payment / expense itself
  insert into acc.vouchers(company_id, voucher_type, voucher_no, fy, voucher_date, account_id, project_id, total_amount, transfer_group_id, payment_mode, notes, created_by, updated_by)
  values (dst.id, 'interco_in', acc.next_voucher_no(dst.id, fy, 'interco_in'), fy, v.voucher_date, cash, v.project_id, v.net_amount, g, 'cash',
          'Internal project funding — paid directly by ' || src.name || coalesce(' to ' || (select name from acc.parties where id = v.party_id), ''), auth.uid(), auth.uid());
  insert into acc.vouchers(company_id, voucher_type, voucher_no, fy, voucher_date, ref_no, party_id, project_id, category_id, account_id, payment_mode, gst_mode,
    taxable_amount, cgst_amount, sgst_amount, igst_amount, round_off, total_amount, tds_section, tds_rate, tds_amount, transfer_group_id, notes, doc_url, created_by, updated_by)
  values (dst.id, v.voucher_type, acc.next_voucher_no(dst.id, fy, v.voucher_type), fy, v.voucher_date, v.ref_no, party, v.project_id, cat, cash, 'cash', v.gst_mode,
    v.taxable_amount, v.cgst_amount, v.sgst_amount, v.igst_amount, v.round_off, v.total_amount, v.tds_section, v.tds_rate, v.tds_amount, g,
    concat_ws(' · ', v.notes, 'Paid directly by ' || src.name), v.doc_url, auth.uid(), auth.uid())
  returning id into copy_id;
  insert into acc.voucher_lines(voucher_id, line_no, item_id, description, hsn, qty, unit, rate, gst_rate, amount)
  select copy_id, l.line_no, (select d.id from acc.items s join acc.items d on d.company_id = dst.id and lower(d.name) = lower(s.name) where s.id = l.item_id),
         l.description, l.hsn, l.qty, l.unit, l.rate, l.gst_rate, l.amount from acc.voucher_lines l where l.voucher_id = v.id;
  -- payer: the money that left becomes a transfer to the owner company
  delete from acc.voucher_lines where voucher_id = v.id;
  update acc.vouchers set voucher_type = 'interco_out', voucher_no = acc.next_voucher_no(src.id, v.fy, 'interco_out'),
    taxable_amount = 0, cgst_amount = 0, sgst_amount = 0, igst_amount = 0, round_off = 0, total_amount = v.net_amount, tds_amount = 0, tds_rate = 0, tds_section = null,
    category_id = null, transfer_group_id = g, gst_mode = 'none',
    notes = concat_ws(' · ', 'Paid for ' || dst.name || coalesce(' — ' || (select name from acc.parties where id = v.party_id), ''), v.notes),
    party_id = null, updated_by = auth.uid(), updated_at = now()
  where id = v.id returning * into r;
  return r;
end $$;

-- admin: move a paid expense's cost to another company while the payment stays where it was made
create or replace function acc.allocate_expense(p_id uuid, p_company uuid) returns jsonb
language plpgsql security definer set search_path = acc, public as $$
declare v acc.vouchers;
begin
  select * into v from acc.vouchers where id = p_id and deleted_at is null;
  if v.id is null then raise exception 'Entry not found.'; end if;
  if not acc.is_admin(v.company_id) then raise exception 'Only an admin can allocate an expense to another company.'; end if;
  if v.voucher_type <> 'expense' then raise exception 'Only expenses can be allocated to another company.'; end if;
  return to_jsonb(acc.mirror_to_owner(p_id, p_company));
end $$;

-- ───────────────────────── save_voucher ─────────────────────────
-- p: { id?, company_id, voucher_type, voucher_date, ref_no, party_id, project_id, category_id,
--      account_id, to_account_id, payment_mode, gst_mode, round_off, tds_section, tds_rate, tds_amount,
--      total_amount (money vouchers only), notes,
--      lines: [{item_id, description, hsn, qty, unit, rate, gst_rate, amount}],
--      allocations: [{to_voucher_id, amount}] }
create or replace function acc.save_voucher(p jsonb) returns jsonb
language plpgsql security definer set search_path = acc, public as $$
declare
  v_id uuid := acc.uid_or_null(p, 'id');
  v_old acc.vouchers;
  v_company acc.companies;
  v_type acc.voucher_type := (p->>'voucher_type')::acc.voucher_type;
  v_date date := (p->>'voucher_date')::date;
  v_role acc.member_role;
  v_fy text; v_no text;
  v_party uuid := acc.uid_or_null(p, 'party_id');
  v_project uuid := acc.uid_or_null(p, 'project_id');
  v_category uuid := acc.uid_or_null(p, 'category_id');
  v_account uuid := acc.uid_or_null(p, 'account_id');
  v_to_account uuid := acc.uid_or_null(p, 'to_account_id');
  v_gst_mode text := coalesce(nullif(p->>'gst_mode',''), 'none');
  v_is_bill boolean := v_type in ('sale','service','challan','purchase','expense','customer_credit','supplier_credit');
  v_is_money boolean := v_type in ('receipt','payment','transfer','capital_in','capital_out','interco_out','interco_in');
  v_taxable numeric := 0; v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0;
  v_round numeric := round(acc.num(p,'round_off'), 2);
  v_total numeric; v_tds numeric := round(acc.num(p,'tds_amount'), 2);
  v_line jsonb; v_amt numeric; v_gst numeric; v_i int := 0;
  v_alloc jsonb; v_target acc.vouchers; v_alloc_sum numeric := 0; v_already numeric;
  v_result acc.vouchers; v_acct_kind text; v_dup text; v_owner uuid;
begin
  if v_type is null or v_date is null then raise exception 'Voucher type and date are required.'; end if;

  if v_id is not null then
    select * into v_old from acc.vouchers where id = v_id for update;
    if not found or v_old.deleted_at is not null then raise exception 'This entry no longer exists. Refresh and try again.'; end if;
    if v_old.voucher_type <> v_type then raise exception 'The entry type cannot be changed. Delete and re-enter it instead.'; end if;
    if v_old.transfer_group_id is not null then raise exception 'Inter-company transfers are edited from the Banking screen.'; end if;
  end if;

  select * into v_company from acc.companies where id = coalesce(v_old.company_id, acc.uid_or_null(p,'company_id'));
  if not found then raise exception 'Company not found.'; end if;
  if v_old.id is not null and acc.uid_or_null(p,'company_id') is not null and acc.uid_or_null(p,'company_id') <> v_old.company_id then
    raise exception 'Use "Move to company" to change an entry''s company.'; end if;

  v_role := acc.my_role(v_company.id);
  if v_role is null then raise exception 'You do not have access to this company.'; end if;
  if not (v_role in ('admin','partner','accountant') or (v_role = 'storekeeper' and v_type in ('challan','receipt','stock_adjust'))) then
    raise exception 'Your role (%) cannot save this kind of entry. Storekeepers can record Delivery Challans, Payments Received and stock adjustments.', v_role; end if;
  if v_role = 'storekeeper' and v_project is not null then raise exception 'Storekeepers cannot assign entries to a project.'; end if;
  if v_project is not null and not acc.can_see_project(v_company.id, v_project) then
    raise exception 'You do not have access to this project.'; end if;
  if v_old.id is not null and not acc.can_see_project(v_company.id, v_old.project_id) then
    raise exception 'You do not have access to this entry''s project.'; end if;

  if v_company.lock_date is not null and v_role <> 'admin'
     and (v_date <= v_company.lock_date or (v_old.id is not null and v_old.voucher_date <= v_company.lock_date)) then
    raise exception 'Books are locked up to %. Ask an admin to make this change.', to_char(v_company.lock_date, 'DD Mon YYYY'); end if;

  -- masters must belong to this company / its group
  if v_party is not null and not exists (select 1 from acc.parties where id = v_party and company_id = v_company.id) then
    raise exception 'Party does not belong to this company.'; end if;
  if v_project is not null and not exists (select 1 from acc.projects where id = v_project and group_id = v_company.group_id) then
    raise exception 'Project does not belong to this group.'; end if;
  if v_category is not null and not exists (select 1 from acc.categories where id = v_category and company_id = v_company.id) then
    raise exception 'Category does not belong to this company.'; end if;
  if v_account is not null and not exists (select 1 from acc.money_account_companies where account_id = v_account and company_id = v_company.id) then
    raise exception 'That cash/bank account is not enabled for this company.'; end if;
  if v_to_account is not null and not exists (select 1 from acc.money_account_companies where account_id = v_to_account and company_id = v_company.id) then
    raise exception 'The destination account is not enabled for this company.'; end if;

  -- type rules
  -- old-app rule: a payment received / made without a party goes to "Suspense Account"
  if v_type in ('receipt','payment') and v_party is null then
    select id into v_party from acc.parties where company_id = v_company.id and lower(name) = 'suspense account';
    if v_party is null then insert into acc.parties(company_id, name, kind) values (v_company.id, 'Suspense Account', 'both') returning id into v_party; end if;
  end if;
  if v_type in ('sale','service','challan','purchase','customer_credit','supplier_credit') and v_party is null then
    raise exception 'Select a party.'; end if;
  if v_type = 'expense' and v_party is null and v_account is null then
    raise exception 'An unpaid expense needs a party (who is owed). Otherwise choose the account it was paid from.'; end if;
  if v_is_money and v_account is null then raise exception 'Select the cash / bank account.'; end if;
  if v_type = 'transfer' and (v_to_account is null or v_to_account = v_account) then
    raise exception 'Choose two different accounts for a transfer.'; end if;
  if v_type in ('interco_out','interco_in') then raise exception 'Use the inter-company transfer screen.'; end if;
  if v_type not in ('receipt','payment','purchase','expense') and v_tds <> 0 then
    raise exception 'TDS does not apply to this entry type. For TDS a customer deducts, enter it on the Payment Received.'; end if;
  if v_type in ('purchase','expense') and v_tds <> 0 and (v_project is null or not exists
     (select 1 from acc.categories where id = v_category and lower(name) = 'labour')) then
    raise exception 'TDS on a bill applies only to Labour entries in a project. Otherwise deduct TDS on the payment.'; end if;
  if v_account is not null then
    select kind into v_acct_kind from acc.money_accounts where id = v_account;
    if nullif(p->>'payment_mode','') = 'cash' and v_acct_kind <> 'cash' then raise exception 'Cash payments must use a cash account.'; end if;
    if nullif(p->>'payment_mode','') in ('bank','upi','cheque') and v_acct_kind = 'cash' then raise exception 'Select the bank or UPI account for this % entry.', p->>'payment_mode'; end if;
  end if;
  -- duplicate bill numbers: purchases and notes per party; sales and challans across the company
  if nullif(trim(p->>'ref_no'),'') is not null and v_type in ('purchase','sale','challan','customer_credit','supplier_credit') then
    select voucher_no into v_dup from acc.vouchers x where x.company_id = v_company.id and x.voucher_type = v_type and x.deleted_at is null
      and x.id is distinct from v_id and lower(trim(x.ref_no)) = lower(trim(p->>'ref_no'))
      and (v_type in ('sale','challan') or x.party_id is not distinct from v_party) limit 1;
    if v_dup is not null then raise exception 'Duplicate % number % already exists as %.', initcap(replace(v_type::text,'_',' ')), trim(p->>'ref_no'), v_dup; end if;
  end if;
  -- credit / debit notes: number, reason and the original bill are required
  if v_type in ('customer_credit','supplier_credit') then
    if nullif(trim(p->>'ref_no'),'') is null or nullif(trim(p->>'notes'),'') is null then raise exception 'Enter the credit note number and the reason in Notes.'; end if;
    if jsonb_array_length(coalesce(p->'allocations','[]')) = 0 then raise exception 'Select the original bill this note is against.'; end if;
    if v_project is null then
      select project_id into v_project from acc.vouchers where id = acc.uid_or_null(p->'allocations'->0, 'to_voucher_id');
    end if;
  end if;
  if v_gst_mode not in ('intra','inter','none') then raise exception 'Invalid GST mode.'; end if;

  -- totals
  if v_is_bill or v_type = 'stock_adjust' then
    if jsonb_array_length(coalesce(p->'lines','[]')) = 0 then raise exception 'Add at least one line.'; end if;
    for v_line in select * from jsonb_array_elements(p->'lines') loop
      if acc.uid_or_null(v_line,'item_id') is not null and not exists
        (select 1 from acc.items where id = acc.uid_or_null(v_line,'item_id') and company_id = v_company.id) then
        raise exception 'Item does not belong to this company.'; end if;
      if v_type = 'stock_adjust' then
        if acc.uid_or_null(v_line,'item_id') is null or acc.num(v_line,'qty') = 0 then raise exception 'Each adjustment line needs an item and a quantity.'; end if;
        continue;
      end if;
      if acc.num(v_line,'qty') < 0 or acc.num(v_line,'rate') < 0 or acc.num(v_line,'amount') < 0 then raise exception 'Quantities, rates and amounts cannot be negative.'; end if;
      -- entries copied from the old app may have free-text lines; they stay editable
      if v_type in ('purchase','sale','challan') and acc.uid_or_null(v_line,'item_id') is null
         and (v_old.id is null or not exists (select 1 from acc.voucher_lines where voucher_id = v_old.id and item_id is null)) then
        raise exception 'Every line must be an inventory item. Add the item in Inventory first if it is missing.'; end if;
      v_amt := case when acc.num(v_line,'qty') > 0 and acc.num(v_line,'rate') > 0
                 then round(acc.num(v_line,'qty') * acc.num(v_line,'rate'), 2) else round(acc.num(v_line,'amount'), 2) end;
      v_gst := case when v_gst_mode = 'none' then 0 else round(v_amt * acc.num(v_line,'gst_rate') / 100, 2) end;
      v_taxable := v_taxable + v_amt;
      if v_gst_mode = 'intra' then
        v_cgst := v_cgst + round(v_gst / 2, 2); v_sgst := v_sgst + (v_gst - round(v_gst / 2, 2));
      elsif v_gst_mode = 'inter' then v_igst := v_igst + v_gst; end if;
    end loop;
    v_total := case when v_type = 'stock_adjust' then 0 else v_taxable + v_cgst + v_sgst + v_igst + v_round end;
    if v_is_bill and v_total <= 0 then raise exception 'The total must be more than zero.'; end if;
  else
    v_total := round(acc.num(p,'total_amount'), 2);
    if v_total <= 0 then raise exception 'Enter an amount more than zero.'; end if;
    v_round := 0;
  end if;
  if v_tds < 0 or v_tds > v_total then raise exception 'TDS must be between zero and the total.'; end if;

  -- numbering
  v_fy := acc.fy_label(v_date, v_company.fy_start_month);
  if v_old.id is null or v_old.fy <> v_fy then v_no := acc.next_voucher_no(v_company.id, v_fy, v_type);
  else v_no := v_old.voucher_no; end if;

  if v_old.id is null then
    insert into acc.vouchers(company_id, voucher_type, voucher_no, fy, voucher_date, ref_no, party_id, project_id, category_id,
      account_id, to_account_id, payment_mode, gst_mode, taxable_amount, cgst_amount, sgst_amount, igst_amount, round_off,
      total_amount, tds_section, tds_rate, tds_amount, notes, doc_url, created_by, updated_by)
    values (v_company.id, v_type, v_no, v_fy, v_date, nullif(p->>'ref_no',''), v_party, v_project, v_category,
      v_account, v_to_account, nullif(p->>'payment_mode',''), v_gst_mode, v_taxable, v_cgst, v_sgst, v_igst, v_round,
      v_total, nullif(p->>'tds_section',''), acc.num(p,'tds_rate'), v_tds, nullif(p->>'notes',''), nullif(p->>'doc_url',''), auth.uid(), auth.uid())
    returning * into v_result;
  else
    -- a bill whose party or "paid on the spot" status changes cannot keep its settlements
    if exists (select 1 from acc.allocations where to_voucher_id = v_old.id)
       and (v_party is distinct from v_old.party_id or (v_account is not null and v_old.account_id is null)) then
      raise exception 'Payments are linked to this bill. Unlink them before changing its party or marking it paid.'; end if;
    update acc.vouchers set voucher_no = v_no, fy = v_fy, voucher_date = v_date, ref_no = nullif(p->>'ref_no',''),
      party_id = v_party, project_id = v_project, category_id = v_category, account_id = v_account, to_account_id = v_to_account,
      payment_mode = nullif(p->>'payment_mode',''), gst_mode = v_gst_mode, taxable_amount = v_taxable, cgst_amount = v_cgst,
      sgst_amount = v_sgst, igst_amount = v_igst, round_off = v_round, total_amount = v_total,
      tds_section = nullif(p->>'tds_section',''), tds_rate = acc.num(p,'tds_rate'), tds_amount = v_tds,
      notes = nullif(p->>'notes',''), doc_url = nullif(p->>'doc_url',''), updated_by = auth.uid(), updated_at = now()
    where id = v_old.id returning * into v_result;
    if v_result.net_amount + 0.005 < coalesce((select sum(amount) from acc.allocations where to_voucher_id = v_result.id), 0) then
      raise exception 'Payments of % are already linked to this bill, more than its new amount. Unlink some first.',
        (select sum(amount) from acc.allocations where to_voucher_id = v_result.id); end if;
    delete from acc.voucher_lines where voucher_id = v_result.id;
  end if;

  -- lines
  for v_line in select * from jsonb_array_elements(coalesce(p->'lines','[]')) loop
    v_i := v_i + 1;
    v_amt := case when v_type = 'stock_adjust' then 0
                  when acc.num(v_line,'qty') > 0 and acc.num(v_line,'rate') > 0 then round(acc.num(v_line,'qty') * acc.num(v_line,'rate'), 2)
                  else round(acc.num(v_line,'amount'), 2) end;
    insert into acc.voucher_lines(voucher_id, line_no, item_id, description, hsn, qty, unit, rate, gst_rate, amount)
    values (v_result.id, v_i, acc.uid_or_null(v_line,'item_id'), nullif(v_line->>'description',''), nullif(v_line->>'hsn',''),
      acc.num(v_line,'qty'), nullif(v_line->>'unit',''), acc.num(v_line,'rate'),
      case when v_gst_mode = 'none' then 0 else acc.num(v_line,'gst_rate') end, v_amt);
  end loop;

  -- allocations (only settling vouchers carry them; the list replaces any earlier one)
  if p ? 'allocations' or v_old.id is null then
    if jsonb_array_length(coalesce(p->'allocations','[]')) > 0 and cardinality(acc.allocation_targets(v_type)) = 0 then
      raise exception 'This entry type cannot be linked to bills.'; end if;
    delete from acc.allocations where from_voucher_id = v_result.id;
    for v_alloc in select * from jsonb_array_elements(coalesce(p->'allocations','[]')) loop
      v_amt := round(acc.num(v_alloc,'amount'), 2);
      if v_amt = 0 then continue; end if;
      if v_amt < 0 then raise exception 'Allocation amounts must be positive.'; end if;
      select * into v_target from acc.vouchers where id = acc.uid_or_null(v_alloc,'to_voucher_id') for update;
      if not found or v_target.deleted_at is not null or v_target.company_id <> v_result.company_id
         or v_target.party_id is distinct from v_result.party_id or not (v_target.voucher_type = any(acc.allocation_targets(v_type))) then
        raise exception 'Each linked bill must be a pending bill of this party in this company.'; end if;
      if v_target.account_id is not null then raise exception 'Bill % was paid on the spot and has nothing pending.', v_target.voucher_no; end if;
      if not acc.can_see_project(v_target.company_id, v_target.project_id) then raise exception 'You do not have access to bill %.', v_target.voucher_no; end if;
      select coalesce(sum(amount),0) into v_already from acc.allocations where to_voucher_id = v_target.id and from_voucher_id <> v_result.id;
      if v_already + v_amt > v_target.net_amount + 0.005 then
        raise exception 'Bill % has only % pending.', v_target.voucher_no, v_target.net_amount - v_already; end if;
      insert into acc.allocations(company_id, from_voucher_id, to_voucher_id, amount, created_by)
      values (v_result.company_id, v_result.id, v_target.id, v_amt, auth.uid());
      v_alloc_sum := v_alloc_sum + v_amt;
    end loop;
  end if;
  if v_alloc_sum > v_result.total_amount + 0.005
     or coalesce((select sum(amount) from acc.allocations where from_voucher_id = v_result.id),0) > v_result.total_amount + 0.005 then
    raise exception 'Linked bills (%) add up to more than this entry (%).', v_alloc_sum, v_result.total_amount; end if;

  if v_type in ('customer_credit','supplier_credit') then
    if abs(coalesce((select sum(amount) from acc.allocations where from_voucher_id = v_result.id), 0) - v_result.total_amount) > 0.005 then
      raise exception 'A credit note must be fully applied: its total (%) must stay within the original bill balance.', v_result.total_amount; end if;
    if exists (select 1 from acc.allocations a join acc.vouchers b on b.id = a.to_voucher_id where a.from_voucher_id = v_result.id and b.voucher_date > v_result.voucher_date) then
      raise exception 'A credit note cannot be dated before the original bill.'; end if;
  end if;

  -- a payment or expense for a project owned by another group company is booked in the owner company
  if v_old.id is null and v_type in ('payment','expense') and v_project is not null
     and not exists (select 1 from acc.allocations where from_voucher_id = v_result.id) then
    select owner_company_id into v_owner from acc.projects where id = v_project;
    if v_owner is not null and v_owner <> v_result.company_id and coalesce(p->>'book_here','') <> 'true' then
      v_result := acc.mirror_to_owner(v_result.id, v_owner);
    end if;
  end if;

  return to_jsonb(v_result);
end $$;

-- ───────────────────────── delete_voucher (soft) ─────────────────────────
create or replace function acc.delete_voucher(p_id uuid) returns void
language plpgsql security definer set search_path = acc, public as $$
declare v acc.vouchers; c acc.companies; r acc.member_role;
begin
  select * into v from acc.vouchers where id = p_id for update;
  if not found or v.deleted_at is not null then return; end if;
  select * into c from acc.companies where id = v.company_id;
  r := acc.my_role(v.company_id);
  if r is distinct from 'admin' then raise exception 'Only an admin can delete entries.'; end if;
  if not acc.can_see_project(v.company_id, v.project_id) then raise exception 'You do not have access to this entry.'; end if;
  if c.lock_date is not null and v.voucher_date <= c.lock_date and r <> 'admin' then
    raise exception 'Books are locked up to %.', to_char(c.lock_date, 'DD Mon YYYY'); end if;
  if v.transfer_group_id is not null then
    if exists (select 1 from acc.vouchers x where x.transfer_group_id = v.transfer_group_id and not acc.can_write(x.company_id)) then
      raise exception 'You need write access in both companies to delete an inter-company transfer.'; end if;
    update acc.vouchers set deleted_at = now(), deleted_by = auth.uid() where transfer_group_id = v.transfer_group_id and deleted_at is null;
  else
    update acc.vouchers set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
  end if;
  delete from acc.allocations where from_voucher_id = p_id or to_voucher_id = p_id;
  update acc.payroll set voucher_id = null, paid_on = null where voucher_id = p_id;
  delete from acc.fixed_cost_payments where voucher_id = p_id;
end $$;

-- ───────────────────────── inter-company transfer ─────────────────────────
create or replace function acc.save_interco(p jsonb) returns uuid
language plpgsql security definer set search_path = acc, public as $$
declare
  a acc.companies; b acc.companies; g uuid := gen_random_uuid(); amt numeric := round(acc.num(p,'amount'),2);
  d date := (p->>'voucher_date')::date; fa uuid := acc.uid_or_null(p,'from_account_id'); ta uuid := acc.uid_or_null(p,'to_account_id');
  pr uuid := acc.uid_or_null(p,'project_id');
begin
  select * into a from acc.companies where id = acc.uid_or_null(p,'from_company_id');
  select * into b from acc.companies where id = acc.uid_or_null(p,'to_company_id');
  if a.id is null or b.id is null or a.id = b.id or a.group_id <> b.group_id then raise exception 'Choose two different companies of the same group.'; end if;
  if not (acc.can_write(a.id) and acc.can_write(b.id)) then raise exception 'You need write access in both companies.'; end if;
  if amt <= 0 or d is null then raise exception 'Enter a date and an amount more than zero.'; end if;
  if not exists (select 1 from acc.money_account_companies where account_id = fa and company_id = a.id)
     or not exists (select 1 from acc.money_account_companies where account_id = ta and company_id = b.id) then
    raise exception 'Each account must be enabled for its company.'; end if;
  if pr is not null and not exists (select 1 from acc.projects where id = pr and group_id = a.group_id) then raise exception 'Unknown project.'; end if;
  if (a.lock_date is not null and d <= a.lock_date and not acc.is_admin(a.id)) or (b.lock_date is not null and d <= b.lock_date and not acc.is_admin(b.id)) then
    raise exception 'Books are locked for that date.'; end if;
  insert into acc.vouchers(company_id, voucher_type, voucher_no, fy, voucher_date, account_id, project_id, total_amount, transfer_group_id, notes, ref_no, created_by, updated_by)
  values (a.id, 'interco_out', acc.next_voucher_no(a.id, acc.fy_label(d, a.fy_start_month), 'interco_out'), acc.fy_label(d, a.fy_start_month), d, fa, pr, amt, g,
          coalesce(nullif(p->>'notes',''), 'Transfer to ' || b.name), nullif(p->>'ref_no',''), auth.uid(), auth.uid()),
         (b.id, 'interco_in', acc.next_voucher_no(b.id, acc.fy_label(d, b.fy_start_month), 'interco_in'), acc.fy_label(d, b.fy_start_month), d, ta, pr, amt, g,
          coalesce(nullif(p->>'notes',''), 'Transfer from ' || a.name), nullif(p->>'ref_no',''), auth.uid(), auth.uid());
  return g;
end $$;

-- ───────────────────────── move entry to another company ─────────────────────────
create or replace function acc.move_voucher(p_id uuid, p_company uuid) returns void
language plpgsql security definer set search_path = acc, public as $$
declare v acc.vouchers; src acc.companies; dst acc.companies; new_party uuid;
begin
  select * into v from acc.vouchers where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Entry not found.'; end if;
  select * into src from acc.companies where id = v.company_id;
  select * into dst from acc.companies where id = p_company;
  if dst.id is null or dst.group_id <> src.group_id or dst.id = src.id then raise exception 'Choose another company of the same group.'; end if;
  if not (acc.is_admin(src.id) and acc.can_write(dst.id)) then raise exception 'Only an admin of the source company can move entries.'; end if;
  if v.transfer_group_id is not null then raise exception 'Inter-company transfers cannot be moved.'; end if;
  if exists (select 1 from acc.allocations where from_voucher_id = p_id or to_voucher_id = p_id) then
    raise exception 'Unlink this entry''s bill/payment links before moving it.'; end if;
  if exists (select 1 from acc.voucher_lines where voucher_id = p_id and item_id is not null) then
    raise exception 'Entries with inventory items cannot be moved.'; end if;
  if v.account_id is not null and not exists (select 1 from acc.money_account_companies where account_id = v.account_id and company_id = dst.id) then
    raise exception 'Its cash/bank account is not enabled for the other company.'; end if;
  if v.party_id is not null then
    select d.id into new_party from acc.parties s join acc.parties d on lower(d.name) = lower(s.name) and d.company_id = dst.id where s.id = v.party_id;
    if new_party is null then
      insert into acc.parties(company_id, name, kind, phone, email, gstin, state_code, pan, address)
      select dst.id, name, kind, phone, email, gstin, state_code, pan, address from acc.parties where id = v.party_id returning id into new_party;
    end if;
  end if;
  update acc.vouchers set company_id = dst.id, party_id = new_party, category_id = null,
    voucher_no = acc.next_voucher_no(dst.id, acc.fy_label(v.voucher_date, dst.fy_start_month), v.voucher_type),
    fy = acc.fy_label(v.voucher_date, dst.fy_start_month), updated_by = auth.uid(), updated_at = now()
  where id = p_id;
end $$;

-- ───────────────────────── companies & members ─────────────────────────
create or replace function acc.create_company(p_name text, p_group uuid default null, p_gstin text default null, p_state text default null)
returns uuid language plpgsql security definer set search_path = acc, public as $$
declare g uuid := p_group; c uuid; cash uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Enter a company name.'; end if;
  if g is null then
    insert into acc.groups(name, created_by) values (trim(p_name), auth.uid()) returning id into g;
  elsif not acc.is_group_admin(g) then raise exception 'Only a group admin can add companies to it.';
  end if;
  insert into acc.companies(group_id, name, gstin, state_code, created_by) values (g, trim(p_name), nullif(p_gstin,''), nullif(p_state,''), auth.uid()) returning id into c;
  insert into acc.company_members(company_id, user_id, role) values (c, auth.uid(), 'admin');
  insert into acc.profiles(id, email) select id, lower(email) from auth.users where id = auth.uid() on conflict do nothing;
  insert into acc.money_accounts(group_id, kind, name) values (g, 'cash', 'Cash in Hand - ' || trim(p_name)) returning id into cash;
  insert into acc.money_account_companies(account_id, company_id) values (cash, c);
  insert into acc.categories(company_id, name, kind) values
    (c,'Labour','expense'),(c,'Transport','expense'),(c,'Rent','expense'),(c,'Salary','expense'),(c,'Electricity','expense'),
    (c,'Office Expenses','expense'),(c,'Site Expenses','expense'),(c,'Material','expense'),(c,'Professional Fees','expense'),
    (c,'Bank Charges','expense'),(c,'Interest Income','income'),(c,'Other Income','income'),(c,'Capital Investment','capital'),
    (c,'Partner Withdrawal','capital');
  return c;
end $$;

create or replace function acc.invite_member(p_company uuid, p_email text, p_role acc.member_role) returns text
language plpgsql security definer set search_path = acc, public as $$
declare u uuid;
begin
  if not acc.is_admin(p_company) then raise exception 'Only an admin can add users.'; end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is not null then
    insert into acc.profiles(id, email) values (u, lower(trim(p_email))) on conflict do nothing;
    insert into acc.company_members(company_id, user_id, role) values (p_company, u, p_role)
    on conflict (company_id, user_id) do update set role = excluded.role;
    return 'added';
  end if;
  insert into acc.invitations(company_id, email, role, invited_by) values (p_company, lower(trim(p_email)), p_role, auth.uid())
  on conflict (company_id, email) do update set role = excluded.role;
  return 'invited';
end $$;

-- ───────────────────────── payroll & fixed costs ─────────────────────────
create or replace function acc.pay_payroll(p_ids uuid[], p_date date, p_account uuid) returns int
language plpgsql security definer set search_path = acc, public as $$
declare r record; v jsonb; n int := 0; cat uuid; adv numeric; amt numeric; kind text;
begin
  select a.kind into kind from acc.money_accounts a where a.id = p_account;
  for r in select pr.*, e.name emp_name, e.project_id from acc.payroll pr join acc.employees e on e.id = pr.employee_id
           where pr.id = any(p_ids) and pr.voucher_id is null and pr.paid_on is null loop
    if acc.my_role(r.company_id) not in ('admin','accountant') then raise exception 'Only an admin or accountant can pay salaries.'; end if;
    if r.net_pay <= 0 then raise exception 'Net salary for % must be above zero before payment.', r.emp_name; end if;
    -- Employee Advance expenses paid to this person in the same month are deducted
    select coalesce(sum(x.total_amount), 0) into adv from acc.vouchers x join acc.categories c on c.id = x.category_id
      left join acc.parties pt on pt.id = x.party_id
    where x.company_id = r.company_id and x.deleted_at is null and x.voucher_type = 'expense' and lower(c.name) = 'employee advance'
      and date_trunc('month', x.voucher_date) = r.month
      and regexp_replace(lower(coalesce(pt.name, x.notes, '')), '[^a-z0-9]', '', 'g') like '%' || regexp_replace(lower(r.emp_name), '[^a-z0-9]', '', 'g') || '%';
    amt := greatest(0, r.net_pay - adv);
    if amt = 0 then update acc.payroll set paid_on = p_date where id = r.id; n := n + 1; continue; end if;
    select id into cat from acc.categories where company_id = r.company_id and lower(name) = 'salary';
    if cat is null then insert into acc.categories(company_id, name) values (r.company_id, 'Salary') returning id into cat; end if;
    v := acc.save_voucher(jsonb_build_object('company_id', r.company_id, 'voucher_type', 'expense', 'voucher_date', p_date,
      'account_id', p_account, 'payment_mode', case when kind = 'cash' then 'cash' else 'bank' end, 'category_id', cat, 'project_id', r.project_id, 'gst_mode', 'none', 'book_here', true,
      'notes', 'Salary ' || to_char(r.month, 'Mon YYYY') || ' — ' || r.emp_name || case when adv > 0 then ' (advance ' || adv || ' deducted)' else '' end,
      'lines', jsonb_build_array(jsonb_build_object('description', 'Salary ' || to_char(r.month, 'Mon YYYY') || ' — ' || r.emp_name, 'amount', amt))));
    update acc.payroll set voucher_id = (v->>'id')::uuid, paid_on = p_date where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function acc.pay_fixed_cost(p_fixed_cost uuid, p_date date, p_account uuid, p_amount numeric) returns uuid
language plpgsql security definer set search_path = acc, public as $$
declare f acc.fixed_costs; v jsonb; m date; left_amt numeric := round(p_amount,2); paid numeric; take numeric; vid uuid;
begin
  select * into f from acc.fixed_costs where id = p_fixed_cost;
  if not found then raise exception 'Fixed cost not found.'; end if;
  if not acc.is_admin(f.company_id) then raise exception 'Only an admin can pay fixed costs.'; end if;
  if left_amt <= 0 then raise exception 'Enter an amount more than zero.'; end if;
  -- cannot pay more than has fallen due up to the payment month
  select coalesce(sum(greatest(0, f.monthly_amount - coalesce((select sum(fp.amount) from acc.fixed_cost_payments fp join acc.vouchers x on x.id = fp.voucher_id and x.deleted_at is null
      where fp.fixed_cost_id = f.id and fp.month = m2::date), 0))), 0) into paid
  from generate_series(date_trunc('month', f.start_month), least(date_trunc('month', p_date), coalesce(f.end_month, date_trunc('month', p_date))), interval '1 month') m2;
  if left_amt > paid + 0.005 then raise exception 'Enter a valid amount not more than the outstanding balance (%).', paid; end if;
  v := acc.save_voucher(jsonb_build_object('company_id', f.company_id, 'voucher_type', 'expense', 'voucher_date', p_date,
    'account_id', p_account, 'payment_mode', case when (select kind from acc.money_accounts where id = p_account) = 'cash' then 'cash' else 'bank' end,
    'category_id', f.category_id, 'project_id', f.project_id, 'gst_mode', 'none', 'book_here', true, 'notes', 'Fixed cost — ' || f.name,
    'lines', jsonb_build_array(jsonb_build_object('description', f.name, 'amount', left_amt))));
  vid := (v->>'id')::uuid;
  m := date_trunc('month', f.start_month)::date;
  while left_amt > 0.004 and m <= coalesce(f.end_month, date_trunc('month', p_date)::date) loop
    select coalesce(sum(amount),0) into paid from acc.fixed_cost_payments fp join acc.vouchers x on x.id = fp.voucher_id and x.deleted_at is null
      where fp.fixed_cost_id = f.id and fp.month = m;
    take := least(left_amt, f.monthly_amount - paid);
    if take > 0.004 then
      insert into acc.fixed_cost_payments(fixed_cost_id, voucher_id, month, amount) values (f.id, vid, m, take);
      left_amt := left_amt - take;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return vid;
end $$;

-- ───────────────────────── merge duplicate parties ─────────────────────────
create or replace function acc.merge_parties(p_from uuid, p_to uuid) returns void
language plpgsql security definer set search_path = acc, public as $$
declare a acc.parties; b acc.parties;
begin
  select * into a from acc.parties where id = p_from;
  select * into b from acc.parties where id = p_to;
  if a.id is null or b.id is null or a.id = b.id or a.company_id <> b.company_id then raise exception 'Choose two different parties of the same company.'; end if;
  if not acc.is_admin(a.company_id) then raise exception 'Only an admin can merge parties.'; end if;
  update acc.vouchers set party_id = b.id, updated_by = auth.uid(), updated_at = now() where party_id = a.id;
  update acc.parties set opening_balance = b.opening_balance + a.opening_balance,
    gstin = coalesce(b.gstin, a.gstin), phone = coalesce(b.phone, a.phone), email = coalesce(b.email, a.email),
    pan = coalesce(b.pan, a.pan), address = coalesce(b.address, a.address), state_code = coalesce(b.state_code, a.state_code),
    kind = case when b.kind <> a.kind then 'both' else b.kind end
  where id = b.id;
  delete from acc.parties where id = a.id;
end $$;

-- ───────────────────────── admin PIN (extra check before sensitive admin actions) ─────────────────────────
create extension if not exists pgcrypto with schema extensions;

create or replace function acc.has_admin_pin(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select acc.is_admin(p_company) and exists (select 1 from acc.company_secrets where company_id = p_company and admin_pin_hash is not null)
$$;

create or replace function acc.set_admin_pin(p_company uuid, p_old text, p_new text) returns void
language plpgsql security definer set search_path = acc, public, extensions as $$
declare h text;
begin
  if not acc.is_admin(p_company) then raise exception 'Only an admin can set the PIN.'; end if;
  if p_new !~ '^[0-9]{6}$' then raise exception 'The PIN must be exactly six digits.'; end if;
  select admin_pin_hash into h from acc.company_secrets where company_id = p_company;
  if h is not null and (p_old is null or extensions.crypt(p_old, h) <> h) then raise exception 'The current PIN is not correct.'; end if;
  insert into acc.company_secrets(company_id, admin_pin_hash) values (p_company, extensions.crypt(p_new, extensions.gen_salt('bf')))
  on conflict (company_id) do update set admin_pin_hash = excluded.admin_pin_hash, updated_at = now();
end $$;

create or replace function acc.verify_admin_pin(p_company uuid, p_pin text) returns boolean
language plpgsql security definer set search_path = acc, public, extensions as $$
declare h text;
begin
  if not acc.is_admin(p_company) then return false; end if;
  select admin_pin_hash into h from acc.company_secrets where company_id = p_company;
  if h is null then return true; end if;   -- no PIN set yet
  perform pg_sleep(0.3);                   -- slow down guessing
  return extensions.crypt(coalesce(p_pin,''), h) = h;
end $$;

grant execute on all functions in schema acc to authenticated;

-- payroll rows take the employee's current salary unless one is given
create or replace function acc.payroll_defaults() returns trigger language plpgsql as $$
begin
  if new.base_salary is null or new.base_salary = 0 then
    select monthly_salary into new.base_salary from acc.employees where id = new.employee_id;
  end if;
  return new;
end $$;
create trigger payroll_defaults before insert on acc.payroll for each row execute function acc.payroll_defaults();
