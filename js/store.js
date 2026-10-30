// App state: who is signed in, which company / financial year is open, and that group's data in memory.
import { buildIndex, billPending, unallocated, partyEffect, accountEffects, stockEffect, fyLabel, fyRange, r2, sum, TYPES, isBill } from './calc.js';
import { today } from './ui.js';

export const S = {
  backend: null, user: null,
  memberships: [], companies: [], companyId: null, fy: null,
  // group data
  projects: [], accounts: [], accountCompanies: [], parties: [], items: [], categories: [],
  vouchers: [], allocations: [], employees: [], payroll: [], fixedCosts: [], fixedCostPayments: [], budget: [],
  members: [], profiles: [], invitations: [], memberProjects: [],
  ix: null,
  listeners: new Set(),
};

export const company = () => S.companies.find(c => c.id === S.companyId);
export const role = () => S.memberships.find(m => m.company_id === S.companyId)?.role;
export const myMembership = () => S.memberships.find(m => m.company_id === S.companyId);
export const canWrite = () => ['admin', 'partner', 'accountant'].includes(role());
export const isAdmin = () => role() === 'admin';
export const canSaveType = t => canWrite() || (role() === 'storekeeper' && ['challan', 'receipt', 'stock_adjust'].includes(t));
export const canDelete = () => isAdmin();                                   // old app: only Admin deletes entries and parties
export const canAddParty = () => canWrite() || role() === 'storekeeper';
export const canManageStaff = () => ['admin', 'accountant'].includes(role()); // payroll & employees
export const groupCompanies = () => S.companies.filter(c => c.group_id === company()?.group_id);

export function onChange(fn) { S.listeners.add(fn); return () => S.listeners.delete(fn); }
function emit() { S.listeners.forEach(f => f()); }

export async function loadMemberships() {
  const b = S.backend;
  S.memberships = await b.list('company_members', { user_id: S.user.id });
  S.companies = S.memberships.length ? await b.list('companies', { id: S.memberships.map(m => m.company_id) }) : [];
  S.companies.sort((a, b2) => a.name.localeCompare(b2.name));
  const saved = localStorage.getItem('gks2.company');
  S.companyId = S.companies.some(c => c.id === saved) ? saved : S.companies[0]?.id || null;
  if (S.companyId) S.fy = localStorage.getItem('gks2.fy') || fyLabel(today(), company().fy_start_month);
}

export async function loadGroup() {
  const b = S.backend, c = company(); if (!c) return;
  const ids = groupCompanies().map(x => x.id);
  const [projects, accounts, accountCompanies, parties, items, categories, vouchers, allocations, employees, payroll, fixedCosts, members, invitations, memberProjects] = await Promise.all([
    b.list('projects', { group_id: c.group_id }),
    b.list('money_accounts', { group_id: c.group_id }),
    b.list('money_account_companies', { company_id: ids }),
    b.list('parties', { company_id: ids }),
    b.list('items', { company_id: ids }),
    b.list('categories', { company_id: ids }),
    b.listVouchers(ids),
    b.list('allocations', { company_id: ids }),
    b.list('employees', { company_id: S.companyId }),
    b.list('payroll', { company_id: S.companyId }),
    b.list('fixed_costs', { company_id: S.companyId }),
    b.list('company_members', { company_id: S.companyId }),
    isAdmin() ? b.list('invitations', { company_id: S.companyId }) : [],
    b.list('member_projects', { company_id: S.companyId }),
  ]);
  Object.assign(S, { projects, accounts, accountCompanies, parties, items, categories, vouchers, allocations, employees, payroll, fixedCosts, members, invitations, memberProjects });
  const [budget, fixedCostPayments, profiles] = await Promise.all([
    projects.length ? b.list('project_budget_lines', { project_id: projects.map(p => p.id) }) : [],
    fixedCosts.length ? b.list('fixed_cost_payments', { fixed_cost_id: fixedCosts.map(f => f.id) }) : [],
    b.list('profiles', { id: members.map(m => m.user_id) }),
  ]);
  Object.assign(S, { budget, fixedCostPayments, profiles });
  S.projects.sort((a, b2) => a.name.localeCompare(b2.name));
  S.parties.sort((a, b2) => a.name.localeCompare(b2.name));
  S.items.sort((a, b2) => a.name.localeCompare(b2.name));
  S.categories.sort((a, b2) => a.name.localeCompare(b2.name));
  S.vouchers.sort((a, b2) => a.voucher_date.localeCompare(b2.voucher_date) || a.voucher_no.localeCompare(b2.voucher_no));
  S.ix = buildIndex(S);
  emit();
}

export async function switchCompany(id) {
  S.companyId = id; localStorage.setItem('gks2.company', id);
  await loadGroup();
}
export function setFY(fy) { S.fy = fy; localStorage.setItem('gks2.fy', fy); emit(); }

// ───────── lookups (current company unless stated) ─────────
export const cv = (companyId = S.companyId) => S.vouchers.filter(v => v.company_id === companyId);
export const fyBounds = () => fyRange(S.fy, company()?.fy_start_month || 4);
export const inFY = v => { const { from, to } = fyBounds(); return v.voucher_date >= from && v.voucher_date <= to; };
export const voucher = id => S.ix?.byId.get(id);
export const parties = (companyId = S.companyId) => S.parties.filter(p => p.company_id === companyId);
export const items = (companyId = S.companyId) => S.items.filter(p => p.company_id === companyId);
export const categories = (companyId = S.companyId) => S.categories.filter(p => p.company_id === companyId);
export const accounts = (companyId = S.companyId) => {
  const ids = new Set(S.accountCompanies.filter(m => m.company_id === companyId).map(m => m.account_id));
  return S.accounts.filter(a => ids.has(a.id));
};
export function visibleProjects() {
  const m = myMembership();
  if (!m?.project_restricted) return S.projects;
  const ok = new Set(S.memberProjects.filter(x => x.user_id === S.user.id).map(x => x.project_id));
  return S.projects.filter(p => ok.has(p.id));
}
export const partyName = id => S.parties.find(p => p.id === id)?.name || '';
export const projectName = id => S.projects.find(p => p.id === id)?.name || '';
export const accountName = id => S.accounts.find(a => a.id === id)?.name || '';
export const categoryName = id => S.categories.find(c => c.id === id)?.name || '';
export const itemById = id => S.items.find(i => i.id === id);
export const companyName = id => S.companies.find(c => c.id === id)?.name || '';
export const userEmail = id => S.profiles.find(p => p.id === id)?.email || (id === S.user?.id ? S.user.email : 'user');

export const pending = v => billPending(v, S.ix);
export const unalloc = v => unallocated(v, S.ix);
export const allocsTo = id => S.ix.allocTo.get(id) || [];
export const allocsFrom = id => S.ix.allocFrom.get(id) || [];

export function voucherStatus(v) {
  if (isBill(v)) {
    if (v.account_id) return { text: 'Paid', cls: 'ok' };
    const p = pending(v);
    if (p <= 0.004) return { text: 'Settled', cls: 'ok' };
    if (p < Number(v.net_amount)) return { text: 'Part due', cls: 'warn' };
    return { text: 'Due', cls: 'bad' };
  }
  if (['receipt', 'payment'].includes(v.voucher_type)) { const u = unalloc(v); return u > 0.004 ? { text: 'Advance ' + u.toLocaleString('en-IN'), cls: 'info' } : { text: 'Linked', cls: 'ok' }; }
  if (TYPES[v.voucher_type]?.credit) { const u = unalloc(v); return u > 0.004 ? { text: 'Unapplied', cls: 'info' } : { text: 'Applied', cls: 'ok' }; }
  return { text: '', cls: '' };
}

// Party balance up to a date (inclusive). +ve = receivable, -ve = payable
export function partyBalance(partyId, upto = '9999-12-31') {
  const p = S.parties.find(x => x.id === partyId);
  let bal = Number(p?.opening_balance || 0);
  for (const v of S.vouchers) if (v.party_id === partyId && v.voucher_date <= upto) for (const x of partyEffect(v)) bal += x;
  return r2(bal);
}

export function accountOpening(accountId, companyId = S.companyId) {
  return Number(S.accountCompanies.find(m => m.account_id === accountId && m.company_id === companyId)?.opening_balance || 0);
}
// Balance of a money account within one company (or all group companies when companyId = null)
export function accountBalance(accountId, companyId = S.companyId, upto = '9999-12-31') {
  const comps = companyId ? [companyId] : groupCompanies().map(c => c.id);
  let bal = sum(comps, c => accountOpening(accountId, c));
  for (const v of S.vouchers) if (comps.includes(v.company_id) && v.voucher_date <= upto)
    for (const e of accountEffects(v)) if (e.account_id === accountId) bal += e.amount;
  return r2(bal);
}

export function stockOf(itemId, upto = '9999-12-31') {
  const it = itemById(itemId); let q = Number(it?.opening_qty || 0);
  for (const v of S.vouchers) if (v.company_id === it?.company_id && v.voucher_date <= upto) for (const l of v.lines || []) if (l.item_id === itemId) q += stockEffect(v, l);
  return Math.round(q * 1000) / 1000;
}
// Weighted average purchase rate (opening + purchases) — used for stock value
export function avgRate(itemId) {
  const it = itemById(itemId); let q = Number(it?.opening_qty || 0), val = q * Number(it?.opening_rate || 0);
  for (const v of S.vouchers) if (v.voucher_type === 'purchase' && v.company_id === it?.company_id) for (const l of v.lines || []) if (l.item_id === itemId) { q += Number(l.qty); val += Number(l.amount); }
  return q > 0 ? val / q : Number(it?.opening_rate || 0);
}

// Rate on the most recent purchase of an item (null when never purchased)
export function lastPurchaseRate(itemId) {
  let best = null;
  for (const v of S.vouchers) if (v.voucher_type === 'purchase') for (const l of v.lines || []) if (l.item_id === itemId && Number(l.rate) > 0 && (!best || v.voucher_date >= best.d)) best = { d: v.voucher_date, r: Number(l.rate) };
  return best?.r ?? null;
}
// Stock movement of an item between two dates (inclusive): in / out quantities
export function stockMovement(itemId, from, to) {
  const it = itemById(itemId); let inQ = 0, outQ = 0;
  for (const v of S.vouchers) if (v.company_id === it?.company_id && v.voucher_date >= from && v.voucher_date <= to)
    for (const l of v.lines || []) if (l.item_id === itemId) { const q = stockEffect(v, l); if (q > 0) inQ += q; else outQ -= q; }
  return { inQ, outQ };
}
