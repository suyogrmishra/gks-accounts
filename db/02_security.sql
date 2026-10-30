-- GKS Accounts v2 — access rules (row level security), audit triggers, sign-up handling
set search_path = acc, public;

-- ───────────── helper functions (security definer so policies don't recurse) ─────────────
create or replace function acc.my_role(p_company uuid) returns acc.member_role
language sql stable security definer set search_path = acc, public as $$
  select role from acc.company_members where company_id = p_company and user_id = auth.uid()
$$;

create or replace function acc.is_member(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select exists (select 1 from acc.company_members where company_id = p_company and user_id = auth.uid())
$$;

create or replace function acc.can_write(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select coalesce(acc.my_role(p_company) in ('admin','partner','accountant'), false)
$$;

create or replace function acc.is_admin(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select coalesce(acc.my_role(p_company) = 'admin', false)
$$;

create or replace function acc.in_group(p_group uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select exists (select 1 from acc.company_members m join acc.companies c on c.id = m.company_id
                 where c.group_id = p_group and m.user_id = auth.uid())
$$;

create or replace function acc.can_write_group(p_group uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select exists (select 1 from acc.company_members m join acc.companies c on c.id = m.company_id
                 where c.group_id = p_group and m.user_id = auth.uid() and m.role in ('admin','partner','accountant'))
$$;

create or replace function acc.is_group_admin(p_group uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select exists (select 1 from acc.company_members m join acc.companies c on c.id = m.company_id
                 where c.group_id = p_group and m.user_id = auth.uid() and m.role = 'admin')
$$;

-- project visibility for project-restricted members
create or replace function acc.can_see_project(p_company uuid, p_project uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select case
    when not exists (select 1 from acc.company_members where company_id = p_company and user_id = auth.uid()) then false
    when not (select project_restricted from acc.company_members where company_id = p_company and user_id = auth.uid()) then true
    when p_project is null then false
    else exists (select 1 from acc.member_projects where company_id = p_company and user_id = auth.uid() and project_id = p_project)
  end
$$;

create or replace function acc.can_see_voucher(p_voucher uuid) returns boolean
language sql stable security definer set search_path = acc, public as $$
  select coalesce((select acc.can_see_project(company_id, project_id) from acc.vouchers where id = p_voucher), false)
$$;

-- ───────────── enable RLS everywhere ─────────────
do $$ declare t text; begin
  foreach t in array array['groups','companies','profiles','company_members','invitations','projects','member_projects',
    'project_budget_lines','company_secrets','parties','items','categories','money_accounts','money_account_companies','counters','vouchers',
    'voucher_lines','allocations','employees','payroll','fixed_costs','fixed_cost_payments','audit_log'] loop
    execute format('alter table acc.%I enable row level security', t);
  end loop;
end $$;

-- groups / companies
create policy groups_read on acc.groups for select using (acc.in_group(id) or created_by = auth.uid());
create policy groups_insert on acc.groups for insert with check (created_by = auth.uid());
create policy groups_update on acc.groups for update using (acc.is_group_admin(id));

create policy companies_read on acc.companies for select using (acc.is_member(id));
create policy companies_update on acc.companies for update using (acc.is_admin(id));
-- companies are created through acc.create_company() so the creator becomes admin atomically

-- profiles: you can see people who share a company with you
create policy profiles_read on acc.profiles for select using (
  id = auth.uid() or exists (select 1 from acc.company_members a join acc.company_members b on a.company_id = b.company_id
                             where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy profiles_update on acc.profiles for update using (id = auth.uid());

-- members & invitations: admins manage; everyone sees fellow members
create policy members_read on acc.company_members for select using (acc.is_member(company_id));
create policy members_write on acc.company_members for all using (acc.is_admin(company_id)) with check (acc.is_admin(company_id));
create policy invitations_admin on acc.invitations for all using (acc.is_admin(company_id)) with check (acc.is_admin(company_id));
create policy member_projects_read on acc.member_projects for select using (acc.is_member(company_id));
create policy member_projects_admin on acc.member_projects for all using (acc.is_admin(company_id)) with check (acc.is_admin(company_id));

-- group-level masters
create policy projects_read on acc.projects for select using (acc.in_group(group_id));
create policy projects_write on acc.projects for all using (acc.can_write_group(group_id)) with check (acc.can_write_group(group_id));
create policy budget_read on acc.project_budget_lines for select using (exists (select 1 from acc.projects p where p.id = project_id and acc.in_group(p.group_id)));
create policy budget_write on acc.project_budget_lines for all
  using (exists (select 1 from acc.projects p where p.id = project_id and acc.is_group_admin(p.group_id)))
  with check (exists (select 1 from acc.projects p where p.id = project_id and acc.is_group_admin(p.group_id)));
create policy accounts_read on acc.money_accounts for select using (acc.in_group(group_id));
create policy accounts_insert on acc.money_accounts for insert with check (acc.can_write_group(group_id));
create policy accounts_update on acc.money_accounts for update using (acc.is_group_admin(group_id)) with check (acc.is_group_admin(group_id));
create policy accounts_delete on acc.money_accounts for delete using (acc.is_group_admin(group_id));
create policy account_companies_read on acc.money_account_companies for select using (acc.is_member(company_id));
create policy account_companies_insert on acc.money_account_companies for insert with check (acc.can_write(company_id));
create policy account_companies_update on acc.money_account_companies for update using (acc.is_admin(company_id)) with check (acc.is_admin(company_id));
create policy account_companies_delete on acc.money_account_companies for delete using (acc.is_admin(company_id));

-- company-level masters: members read, writers write
create policy parties_read on acc.parties for select using (acc.is_member(company_id));
create policy parties_insert on acc.parties for insert with check (acc.can_write(company_id) or acc.my_role(company_id) = 'storekeeper');
create policy parties_update on acc.parties for update using (acc.can_write(company_id)) with check (acc.can_write(company_id));
create policy parties_delete on acc.parties for delete using (acc.is_admin(company_id));
create policy items_read on acc.items for select using (acc.is_member(company_id));
create policy items_write on acc.items for all using (acc.can_write(company_id) or acc.my_role(company_id) = 'storekeeper')
  with check (acc.can_write(company_id) or acc.my_role(company_id) = 'storekeeper');
create policy categories_read on acc.categories for select using (acc.is_member(company_id));
create policy categories_write on acc.categories for all using (acc.can_write(company_id)) with check (acc.can_write(company_id));
create policy counters_read on acc.counters for select using (acc.is_member(company_id));

-- vouchers: read only; every write goes through acc.save_voucher / acc.delete_voucher
create policy vouchers_read on acc.vouchers for select using (acc.can_see_project(company_id, project_id));
create policy lines_read on acc.voucher_lines for select using (acc.can_see_voucher(voucher_id));
-- a bill's settlement is visible to anyone who can see the bill (so its pending amount is right), even if the payment itself is in another project
create policy allocations_read on acc.allocations for select using (acc.can_see_voucher(from_voucher_id) or acc.can_see_voucher(to_voucher_id));

create policy employees_read on acc.employees for select using (acc.my_role(company_id) in ('admin','accountant'));
create policy employees_write on acc.employees for all using (acc.my_role(company_id) in ('admin','accountant')) with check (acc.my_role(company_id) in ('admin','accountant'));
create policy payroll_read on acc.payroll for select using (acc.my_role(company_id) in ('admin','accountant'));
create policy payroll_write on acc.payroll for all using (acc.my_role(company_id) in ('admin','accountant')) with check (acc.my_role(company_id) in ('admin','accountant'));
create policy fixed_costs_read on acc.fixed_costs for select using (acc.is_member(company_id));
create policy fixed_costs_write on acc.fixed_costs for all using (acc.my_role(company_id) in ('admin','accountant')) with check (acc.my_role(company_id) in ('admin','accountant'));
create policy fcp_read on acc.fixed_cost_payments for select using (exists (select 1 from acc.fixed_costs f where f.id = fixed_cost_id and acc.is_member(f.company_id)));

create policy audit_read on acc.audit_log for select using (acc.is_admin(company_id));

-- ───────────── audit trigger ─────────────
create or replace function acc.audit() returns trigger
language plpgsql security definer set search_path = acc, public as $$
declare v_company uuid; v_row uuid; v_old jsonb; v_new jsonb;
begin
  v_old := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row := coalesce(v_new->>'id', v_old->>'id')::uuid;
  v_company := coalesce(v_new->>'company_id', v_old->>'company_id')::uuid;
  if v_company is null and tg_table_name = 'voucher_lines' then
    select company_id into v_company from acc.vouchers where id = coalesce(v_new->>'voucher_id', v_old->>'voucher_id')::uuid;
  end if;
  insert into acc.audit_log(company_id, table_name, row_id, action, old_data, new_data, user_id)
  values (v_company, tg_table_name, v_row, lower(tg_op), v_old, v_new, auth.uid());
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['vouchers','voucher_lines','allocations','parties','items','categories','company_members',
                           'employees','payroll','fixed_costs','companies'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on acc.%1$I for each row execute function acc.audit()', t);
  end loop;
end $$;

-- ───────────── sign-up: create profile and accept pending invitations ─────────────
create or replace function acc.handle_new_user() returns trigger
language plpgsql security definer set search_path = acc, public as $$
begin
  insert into acc.profiles(id, email, full_name)
  values (new.id, lower(new.email), new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  insert into acc.company_members(company_id, user_id, role)
  select company_id, new.id, role from acc.invitations where lower(email) = lower(new.email)
  on conflict do nothing;
  delete from acc.invitations where lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists acc_on_auth_user_created on auth.users;
create trigger acc_on_auth_user_created after insert on auth.users
  for each row execute function acc.handle_new_user();

-- ───────────── grants for the Supabase API roles ─────────────
grant usage on schema acc to authenticated;
grant select, insert, update, delete on all tables in schema acc to authenticated;
revoke insert, update, delete on acc.vouchers, acc.voucher_lines, acc.allocations, acc.counters, acc.audit_log from authenticated;
revoke all on acc.company_secrets from authenticated;
grant usage, select on all sequences in schema acc to authenticated;
