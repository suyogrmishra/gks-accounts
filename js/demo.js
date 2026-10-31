// Demo backend: a small in-browser database (localStorage) that follows the same rules
// as the real database functions, so the whole app can be tried without touching live data.
import { r2, voucherTotals, lineAmount, fyLabel, allocationTargets, TYPES, BILL_TYPES } from './calc.js';
import { payrollFields, settingsOf, rowNet, structureOf, grossOf, daysInMonth } from './payroll.js';

const KEY = 'gks2.demo.db.v4';
const USER = { id: 'demo-user', email: 'demo@gks.local' };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const now = () => new Date().toISOString();
const TABLES = ['groups', 'companies', 'profiles', 'company_members', 'invitations', 'projects', 'member_projects', 'project_budget_lines',
  'parties', 'items', 'categories', 'money_accounts', 'money_account_companies', 'counters', 'vouchers', 'voucher_lines', 'allocations',
  'employees', 'payroll', 'fixed_costs', 'fixed_cost_payments', 'statutory_payments', 'audit_log'];
const fail = m => { throw new Error(m); };

export class DemoBackend {
  constructor() {
    this.mode = 'demo';
    try { this.db = JSON.parse(localStorage.getItem(KEY)); } catch { this.db = null; }
    if (!this.db) { this.db = Object.fromEntries(TABLES.map(t => [t, []])); this.seed(); }
    for (const t of TABLES) this.db[t] ||= [];
    this.signedIn = sessionStorage.getItem('gks2.demo.in') !== '0';
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch { /* storage full or blocked: keep in memory */ } }
  reset() { localStorage.removeItem(KEY); this.db = Object.fromEntries(TABLES.map(t => [t, []])); this.seed(); }

  // auth (always the demo user)
  async session() { return this.signedIn ? { user: USER } : null; }
  async signIn() { this.signedIn = true; sessionStorage.setItem('gks2.demo.in', '1'); }
  async signUp() { await this.signIn(); return 'signed_in'; }
  async signOut() { this.signedIn = false; sessionStorage.setItem('gks2.demo.in', '0'); }
  async resetPassword() { }
  async updatePassword() { }
  onAuthChange() { }

  _match(row, filter) {
    return Object.entries(filter).every(([k, v]) => Array.isArray(v) ? v.includes(row[k]) : v === null ? row[k] == null : row[k] === v);
  }
  _audit(table, action, oldRow, newRow) {
    const r = newRow || oldRow;
    let company = r.company_id || null;
    if (!company && table === 'voucher_lines') company = this.db.vouchers.find(v => v.id === r.voucher_id)?.company_id;
    if (!['vouchers', 'voucher_lines', 'allocations', 'parties', 'items', 'categories', 'company_members', 'employees', 'payroll', 'fixed_costs', 'companies'].includes(table)) return;
    this.db.audit_log.push({ id: this.db.audit_log.length + 1, company_id: table === 'companies' ? r.id : company, table_name: table, row_id: r.id || null,
      action, old_data: oldRow ? structuredClone(oldRow) : null, new_data: newRow ? structuredClone(newRow) : null, user_id: USER.id, at: now() });
  }
  _ins(table, row) {
    const r = { id: uid(), created_at: now(), ...row };
    this.db[table].push(r); this._audit(table, 'insert', null, r); return r;
  }
  _upd(table, row, patch) { const old = structuredClone(row); Object.assign(row, patch); this._audit(table, 'update', old, row); return row; }
  _del(table, pred) {
    const keep = [];
    for (const r of this.db[table]) { if (pred(r)) this._audit(table, 'delete', r, null); else keep.push(r); }
    this.db[table] = keep;
  }
  _unique(table, row) {
    if (['parties', 'items', 'categories'].includes(table) && this.db[table].some(x => x.id !== row.id && x.company_id === row.company_id && x.name.trim().toLowerCase() === String(row.name).trim().toLowerCase())) fail('That name already exists.');
    if (table === 'employees' && this.db.employees.some(x => x.id !== row.id && x.company_id === row.company_id && String(x.name).toLowerCase().replace(/[^a-z0-9]/g, '') === String(row.name).toLowerCase().replace(/[^a-z0-9]/g, ''))) fail('This employee is already added in this company.');
    if (table === 'projects' && this.db.projects.some(x => x.id !== row.id && x.group_id === row.group_id && x.name.trim().toLowerCase() === String(row.name).trim().toLowerCase())) fail('That name already exists.');
  }

  async list(table, filter = {}) {
    let rows = this.db[table].filter(r => this._match(r, filter));
    if (table === 'vouchers') rows = rows.filter(v => !v.deleted_at);
    return structuredClone(rows);
  }
  async listVouchers(companyIds) {
    const vs = await this.list('vouchers', { company_id: companyIds });
    const lines = this.db.voucher_lines;
    for (const v of vs) v.lines = structuredClone(lines.filter(l => l.voucher_id === v.id).sort((a, b) => a.line_no - b.line_no));
    return vs;
  }
  async audit(companyId, limit = 300) { return structuredClone(this.db.audit_log.filter(a => a.company_id === companyId).slice(-limit).reverse()); }
  async insert(table, rows) {
    const out = [];
    for (const row of [].concat(rows)) { this._unique(table, row); out.push(this._ins(table, this._defaults(table, row))); }
    this.save(); return structuredClone(out);
  }
  _defaults(table, row) {
    if (table === 'parties') return { kind: 'both', opening_balance: 0, active: true, ...row };
    if (table === 'items') return { unit: 'Nos', opening_qty: 0, opening_rate: 0, active: true, ...row };
    if (table === 'categories') return { kind: 'expense', active: true, ...row };
    if (table === 'projects') return { kind: 'combined', active: true, order_value: 0, ...row };
    if (table === 'money_accounts') return { active: true, ...row };
    if (table === 'money_account_companies') return { opening_balance: 0, ...row };
    if (table === 'employees') { const e = { active: true, monthly_salary: 0, gender: 'M', pf_member: true, pf_on_ceiling: true, esic_member: true, pt_applicable: true, hra: 0, conveyance: 0, other_allowance: 0, basic: 0, ...row };
      if (!Number(e.basic) && !Number(e.hra) && !Number(e.conveyance) && !Number(e.other_allowance)) e.basic = Number(e.monthly_salary); e.monthly_salary = grossOf(structureOf(e)); return e; }
    if (table === 'fixed_costs') return { active: true, ...row };
    if (table === 'payroll') {
      const emp = this.db.employees.find(e => e.id === row.employee_id);
      const dm = row.month ? daysInMonth(row.month) : 30;
      const r = { working_days: dm, present_days: dm, bonus: 0, deduction: 0, overtime: 0, tds: 0, ...row };
      const cfg = settingsOf(this.db.companies.find(c => c.id === r.company_id));
      return { ...r, ...payrollFields(emp, r, cfg, { keepPt: row.pt != null }) };
    }
    return row;
  }
  async update(table, match, patch) {
    const rows = this.db[table].filter(r => this._match(r, match));
    for (const r of rows) { this._unique(table, { ...r, ...patch }); this._upd(table, r, patch); }
    this.save(); return structuredClone(rows);
  }
  async upsert(table, rows, onConflict) {
    const keys = onConflict.split(','), out = [];
    for (const row of [].concat(rows)) {
      const ex = this.db[table].find(r => keys.every(k => r[k] === row[k]));
      out.push(ex ? this._upd(table, ex, row) : this._ins(table, this._defaults(table, row)));
    }
    this.save(); return structuredClone(out);
  }
  async remove(table, match) { this._del(table, r => this._match(r, match)); this.save(); }

  async rpc(name, args) {
    const snapshot = JSON.stringify(this.db);
    try { const res = this['rpc_' + name](args); this.save(); return structuredClone(res); }
    catch (e) { this.db = JSON.parse(snapshot); throw e; }   // all-or-nothing, like a database transaction
  }

  // ───────── server-function equivalents ─────────
  role(company) { return this.db.company_members.find(m => m.company_id === company && m.user_id === USER.id)?.role; }
  nextNo(company, fy, type) {
    let c = this.db.counters.find(x => x.company_id === company && x.fy === fy && x.voucher_type === type);
    if (!c) { c = { company_id: company, fy, voucher_type: type, last_no: 0 }; this.db.counters.push(c); }
    c.last_no++; return TYPES[type].prefix + '/' + fy + '/' + String(c.last_no).padStart(4, '0');
  }
  rpc_create_company({ p_name, p_group, p_gstin, p_state }) {
    if (!String(p_name || '').trim()) fail('Enter a company name.');
    let g = p_group;
    if (!g) g = this._ins('groups', { name: p_name.trim(), created_by: USER.id }).id;
    const c = this._ins('companies', { group_id: g, name: p_name.trim(), gstin: p_gstin || null, state_code: p_state || null, fy_start_month: 4,
      lock_date: null, allow_negative_stock: false, opening_gst_credit: 0, created_by: USER.id });
    this._ins('company_members', { company_id: c.id, user_id: USER.id, role: 'admin', project_restricted: false, hidden_sections: [] });
    if (!this.db.profiles.length) this.db.profiles.push({ id: USER.id, email: USER.email, full_name: 'Demo User' });
    const cash = this._ins('money_accounts', { group_id: g, kind: 'cash', name: 'Cash in Hand - ' + p_name.trim(), active: true });
    this.db.money_account_companies.push({ account_id: cash.id, company_id: c.id, opening_balance: 0 });
    for (const [n, k] of [['Labour', 'expense'], ['Transport', 'expense'], ['Rent', 'expense'], ['Salary', 'expense'], ['Electricity', 'expense'], ['Office Expenses', 'expense'],
      ['Site Expenses', 'expense'], ['Material', 'expense'], ['Professional Fees', 'expense'], ['Bank Charges', 'expense'], ['Interest Income', 'income'], ['Other Income', 'income'],
      ['Capital Investment', 'capital'], ['Partner Withdrawal', 'capital']]) this._ins('categories', { company_id: c.id, name: n, kind: k, active: true });
    return c.id;
  }
  rpc_invite_member({ p_company, p_email, p_role }) {
    if (this.role(p_company) !== 'admin') fail('Only an admin can add users.');
    const email = p_email.trim().toLowerCase(), ex = this.db.invitations.find(i => i.company_id === p_company && i.email === email);
    if (ex) ex.role = p_role; else this._ins('invitations', { company_id: p_company, email, role: p_role });
    return 'invited';
  }
  rpc_save_voucher({ p }) {
    const T = TYPES[p.voucher_type]; if (!T || !p.voucher_date) fail('Voucher type and date are required.');
    const old = p.id ? this.db.vouchers.find(v => v.id === p.id) : null;
    if (p.id && (!old || old.deleted_at)) fail('This entry no longer exists. Refresh and try again.');
    if (old && old.voucher_type !== p.voucher_type) fail('The entry type cannot be changed. Delete and re-enter it instead.');
    if (old?.transfer_group_id) fail('Inter-company transfers are edited from the Banking screen.');
    const company = this.db.companies.find(c => c.id === (old?.company_id || p.company_id)); if (!company) fail('Company not found.');
    const role = this.role(company.id);
    if (!role) fail('You do not have access to this company.');
    if (!(['admin', 'partner', 'accountant'].includes(role) || (role === 'storekeeper' && ['challan', 'receipt', 'stock_adjust'].includes(p.voucher_type)))) fail(`Your role (${role}) cannot save this kind of entry. Storekeepers can record Delivery Challans, Payments Received and stock adjustments.`);
    if (role === 'storekeeper' && p.project_id) fail('Storekeepers cannot assign entries to a project.');
    if (company.lock_date && role !== 'admin' && (p.voucher_date <= company.lock_date || (old && old.voucher_date <= company.lock_date)))
      fail('Books are locked up to ' + company.lock_date + '. Ask an admin to make this change.');
    const t = p.voucher_type, isBill = BILL_TYPES.includes(t) || T.credit, isMoney = !!T.money;
    let party = p.party_id || null; const account = p.account_id || null, toAccount = p.to_account_id || null;
    if (party && !this.db.parties.some(x => x.id === party && x.company_id === company.id)) fail('Party does not belong to this company.');
    const linked = a => this.db.money_account_companies.some(m => m.account_id === a && m.company_id === company.id);
    if (account && !linked(account)) fail('That cash/bank account is not enabled for this company.');
    if (toAccount && !linked(toAccount)) fail('The destination account is not enabled for this company.');
    if (['receipt', 'payment'].includes(t) && !party) {   // old-app rule: no party → Suspense Account
      party = (this.db.parties.find(x => x.company_id === company.id && x.name.toLowerCase() === 'suspense account') || this._ins('parties', { company_id: company.id, name: 'Suspense Account', kind: 'both', opening_balance: 0, active: true })).id;
    }
    if (['sale', 'service', 'challan', 'purchase', 'customer_credit', 'supplier_credit'].includes(t) && !party) fail('Select a party.');
    if (t === 'expense' && !party && !account) fail('An unpaid expense needs a party (who is owed). Otherwise choose the account it was paid from.');
    if (isMoney && !account) fail('Select the cash / bank account.');
    if (t === 'transfer' && (!toAccount || toAccount === account)) fail('Choose two different accounts for a transfer.');
    if (t === 'interco_in' || t === 'interco_out') fail('Use the inter-company transfer screen.');
    const tds = r2(p.tds_amount);
    if (!['receipt', 'payment', 'purchase', 'expense'].includes(t) && tds) fail('TDS does not apply to this entry type. For TDS a customer deducts, enter it on the Payment Received.');
    if (['purchase', 'expense'].includes(t) && tds && (!p.project_id || (this.db.categories.find(c => c.id === p.category_id)?.name || '').toLowerCase() !== 'labour'))
      fail('TDS on a bill applies only to Labour entries in a project. Otherwise deduct TDS on the payment.');
    if (account) {
      const kind = this.db.money_accounts.find(a => a.id === account)?.kind;
      if (p.payment_mode === 'cash' && kind !== 'cash') fail('Cash payments must use a cash account.');
      if (['bank', 'upi', 'cheque'].includes(p.payment_mode) && kind === 'cash') fail(`Select the bank or UPI account for this ${p.payment_mode} entry.`);
    }
    const ref = String(p.ref_no || '').trim().toLowerCase();
    if (ref && ['purchase', 'sale', 'challan', 'customer_credit', 'supplier_credit'].includes(t)) {
      const dup = this.db.vouchers.find(x => x.company_id === company.id && x.voucher_type === t && !x.deleted_at && x.id !== p.id && String(x.ref_no || '').trim().toLowerCase() === ref && (['sale', 'challan'].includes(t) || x.party_id === party));
      if (dup) fail(`Duplicate ${TYPES[t].label} number ${String(p.ref_no).trim()} already exists as ${dup.voucher_no}.`);
    }
    if (T.credit) {
      if (!String(p.ref_no || '').trim() || !String(p.notes || '').trim()) fail('Enter the credit note number and the reason in Notes.');
      if (!(p.allocations || []).some(a => Number(a.amount) > 0)) fail('Select the original bill this note is against.');
      if (!p.project_id) p.project_id = this.db.vouchers.find(x => x.id === p.allocations.find(a => Number(a.amount) > 0).to_voucher_id)?.project_id || null;
    }
    const lines = (p.lines || []).map((l, i) => ({ ...l, line_no: i + 1 }));
    let tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    const gstMode = p.gst_mode || 'none';
    if (isBill || t === 'stock_adjust') {
      if (!lines.length) fail('Add at least one line.');
      for (const l of lines) {
        if (l.item_id && !this.db.items.some(x => x.id === l.item_id && x.company_id === company.id)) fail('Item does not belong to this company.');
        if (t === 'stock_adjust') { if (!l.item_id || !Number(l.qty)) fail('Each adjustment line needs an item and a quantity.'); continue; }
        if (Number(l.qty) < 0 || Number(l.rate) < 0 || Number(l.amount) < 0) fail('Quantities, rates and amounts cannot be negative.');
        if (['purchase', 'sale', 'challan'].includes(t) && !l.item_id && !(old && this.db.voucher_lines.some(x => x.voucher_id === old.id && !x.item_id))) fail('Every line must be an inventory item. Add the item in Inventory first if it is missing.');
      }
      tot = t === 'stock_adjust' ? tot : voucherTotals({ ...p, gst_mode: gstMode, lines });
      if (isBill && tot.total <= 0) fail('The total must be more than zero.');
    } else {
      tot.total = r2(p.total_amount);
      if (tot.total <= 0) fail('Enter an amount more than zero.');
    }
    if (tds < 0 || tds > tot.total) fail('TDS must be between zero and the total.');
    const fy = fyLabel(p.voucher_date, company.fy_start_month);
    const no = !old || old.fy !== fy ? this.nextNo(company.id, fy, t) : old.voucher_no;
    const row = {
      company_id: company.id, voucher_type: t, voucher_no: no, fy, voucher_date: p.voucher_date, ref_no: p.ref_no || null, party_id: party,
      project_id: p.project_id || null, category_id: p.category_id || null, account_id: account, to_account_id: toAccount,
      payment_mode: p.payment_mode || null, doc_url: p.doc_url || null, gst_mode: gstMode, taxable_amount: tot.taxable, cgst_amount: tot.cgst, sgst_amount: tot.sgst, igst_amount: tot.igst,
      round_off: isMoney ? 0 : r2(p.round_off), total_amount: tot.total, tds_section: p.tds_section || null, tds_rate: Number(p.tds_rate) || 0,
      tds_amount: tds, net_amount: r2(tot.total - tds), notes: p.notes || null, updated_by: USER.id, updated_at: now(),
    };
    let v;
    if (!old) v = this._ins('vouchers', { ...row, created_by: USER.id, transfer_group_id: null, deleted_at: null });
    else {
      const incoming = this.db.allocations.filter(a => a.to_voucher_id === old.id);
      if (incoming.length && (party !== old.party_id || (account && !old.account_id))) fail('Payments are linked to this bill. Unlink them before changing its party or marking it paid.');
      const linkedSum = r2(incoming.reduce((s, a) => s + Number(a.amount), 0));
      if (row.net_amount + 0.005 < linkedSum) fail(`Payments of ${linkedSum} are already linked to this bill, more than its new amount. Unlink some first.`);
      v = this._upd('vouchers', old, row);
      this._del('voucher_lines', l => l.voucher_id === v.id);
    }
    for (const l of lines) this._ins('voucher_lines', {
      voucher_id: v.id, line_no: l.line_no, item_id: l.item_id || null, description: l.description || null, hsn: l.hsn || null, qty: Number(l.qty) || 0,
      unit: l.unit || null, rate: Number(l.rate) || 0, gst_rate: gstMode === 'none' ? 0 : Number(l.gst_rate) || 0, amount: t === 'stock_adjust' ? 0 : lineAmount(l),
    });
    if ('allocations' in p || !old) {
      const allocs = (p.allocations || []).filter(a => r2(a.amount) !== 0);
      if (allocs.length && !allocationTargets(t).length) fail('This entry type cannot be linked to bills.');
      this._del('allocations', a => a.from_voucher_id === v.id);
      let s = 0;
      for (const a of allocs) {
        const amt = r2(a.amount); if (amt < 0) fail('Allocation amounts must be positive.');
        const b = this.db.vouchers.find(x => x.id === a.to_voucher_id);
        if (!b || b.deleted_at || b.company_id !== v.company_id || b.party_id !== v.party_id || !allocationTargets(t).includes(b.voucher_type)) fail('Each linked bill must be a pending bill of this party in this company.');
        if (b.account_id) fail(`Bill ${b.voucher_no} was paid on the spot and has nothing pending.`);
        const already = r2(this.db.allocations.filter(x => x.to_voucher_id === b.id && x.from_voucher_id !== v.id).reduce((q, x) => q + Number(x.amount), 0));
        if (already + amt > Number(b.net_amount) + 0.005) fail(`Bill ${b.voucher_no} has only ${r2(b.net_amount - already)} pending.`);
        this._ins('allocations', { company_id: v.company_id, from_voucher_id: v.id, to_voucher_id: b.id, amount: amt, created_by: USER.id });
        s = r2(s + amt);
      }
      if (s > v.total_amount + 0.005) fail(`Linked bills (${s}) add up to more than this entry (${v.total_amount}).`);
    }
    if (T.credit) {
      const links = this.db.allocations.filter(a => a.from_voucher_id === v.id);
      if (Math.abs(r2(links.reduce((q, a) => q + Number(a.amount), 0)) - v.total_amount) > 0.005) fail(`A credit note must be fully applied: its total (${v.total_amount}) must stay within the original bill balance.`);
      if (links.some(a => this.db.vouchers.find(x => x.id === a.to_voucher_id).voucher_date > v.voucher_date)) fail('A credit note cannot be dated before the original bill.');
    }
    if (!old && ['payment', 'expense'].includes(t) && v.project_id && !p.book_here && !this.db.allocations.some(a => a.from_voucher_id === v.id)) {
      const owner = this.db.projects.find(x => x.id === v.project_id)?.owner_company_id;
      if (owner && owner !== v.company_id) return this.mirrorToOwner(v.id, owner);
    }
    return v;
  }
  mirrorToOwner(id, ownerId) {
    const v = this.db.vouchers.find(x => x.id === id && !x.deleted_at), src = this.db.companies.find(c => c.id === v?.company_id), dst = this.db.companies.find(c => c.id === ownerId);
    if (!v || !dst || dst.group_id !== src.group_id || dst.id === src.id) fail('Choose another company of the same group.');
    if (!['payment', 'expense'].includes(v.voucher_type) || !v.account_id) fail('Only a paid expense or payment can be booked in another company.');
    if (v.transfer_group_id) fail('This entry is already linked between companies.');
    if (this.db.allocations.some(a => a.from_voucher_id === v.id || a.to_voucher_id === v.id)) fail('Unlink its bills first.');
    if (!['admin', 'partner', 'accountant'].includes(this.role(dst.id))) fail(`You need entry permission in ${dst.name} to book this there.`);
    const cash = this.db.money_accounts.find(a => a.kind === 'cash' && a.active && this.db.money_account_companies.some(m => m.account_id === a.id && m.company_id === dst.id))?.id;
    if (!cash) fail(`${dst.name} has no cash account to book this through.`);
    const sp = this.db.parties.find(x => x.id === v.party_id), sc = this.db.categories.find(x => x.id === v.category_id);
    const party = sp ? (this.db.parties.find(x => x.company_id === dst.id && x.name.toLowerCase() === sp.name.toLowerCase()) || this._ins('parties', { ...sp, id: uid(), company_id: dst.id })).id : null;
    const cat = sc ? (this.db.categories.find(x => x.company_id === dst.id && x.name.toLowerCase() === sc.name.toLowerCase()) || this._ins('categories', { ...sc, id: uid(), company_id: dst.id })).id : null;
    const g = uid(), fy = fyLabel(v.voucher_date, dst.fy_start_month), base = { tds_amount: 0, taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, round_off: 0, created_by: USER.id, updated_at: now(), deleted_at: null };
    this._ins('vouchers', { ...base, company_id: dst.id, voucher_type: 'interco_in', voucher_no: this.nextNo(dst.id, fy, 'interco_in'), fy, voucher_date: v.voucher_date, account_id: cash, project_id: v.project_id,
      total_amount: v.net_amount, net_amount: v.net_amount, transfer_group_id: g, payment_mode: 'cash', notes: `Internal project funding — paid directly by ${src.name}${sp ? ' to ' + sp.name : ''}` });
    const copy = this._ins('vouchers', { ...v, id: uid(), company_id: dst.id, voucher_no: this.nextNo(dst.id, fy, v.voucher_type), fy, party_id: party, category_id: cat, account_id: cash, payment_mode: 'cash', transfer_group_id: g,
      notes: [v.notes, 'Paid directly by ' + src.name].filter(Boolean).join(' · ') });
    for (const l of this.db.voucher_lines.filter(l => l.voucher_id === v.id)) {
      const it = this.db.items.find(i => i.id === l.item_id), dItem = it && this.db.items.find(i => i.company_id === dst.id && i.name.toLowerCase() === it.name.toLowerCase());
      this._ins('voucher_lines', { ...l, id: uid(), voucher_id: copy.id, item_id: dItem?.id || null });
    }
    this._del('voucher_lines', l => l.voucher_id === v.id);
    return this._upd('vouchers', v, { voucher_type: 'interco_out', voucher_no: this.nextNo(src.id, v.fy, 'interco_out'), taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, round_off: 0,
      total_amount: v.net_amount, tds_amount: 0, tds_rate: 0, tds_section: null, category_id: null, transfer_group_id: g, gst_mode: 'none', party_id: null,
      notes: [`Paid for ${dst.name}${sp ? ' — ' + sp.name : ''}`, v.notes].filter(Boolean).join(' · ') });
  }
  rpc_allocate_expense({ p_id, p_company }) {
    const v = this.db.vouchers.find(x => x.id === p_id && !x.deleted_at); if (!v) fail('Entry not found.');
    if (this.role(v.company_id) !== 'admin') fail('Only an admin can allocate an expense to another company.');
    if (v.voucher_type !== 'expense') fail('Only expenses can be allocated to another company.');
    return this.mirrorToOwner(p_id, p_company);
  }
  rpc_delete_voucher({ p_id }) {
    const v = this.db.vouchers.find(x => x.id === p_id); if (!v || v.deleted_at) return;
    const role = this.role(v.company_id), c = this.db.companies.find(x => x.id === v.company_id);
    if (role !== 'admin') fail('Only an admin can delete entries.');
    if (c.lock_date && v.voucher_date <= c.lock_date && role !== 'admin') fail('Books are locked up to ' + c.lock_date + '.');
    const targets = v.transfer_group_id ? this.db.vouchers.filter(x => x.transfer_group_id === v.transfer_group_id) : [v];
    for (const x of targets) this._upd('vouchers', x, { deleted_at: now(), deleted_by: USER.id });
    this._del('allocations', a => a.from_voucher_id === p_id || a.to_voucher_id === p_id);
    for (const pr of this.db.payroll.filter(x => x.voucher_id === p_id)) this._upd('payroll', pr, { voucher_id: null, paid_on: null });
    this._del('fixed_cost_payments', f => f.voucher_id === p_id);
    this._del('statutory_payments', f => f.voucher_id === p_id);
  }
  rpc_save_interco({ p }) {
    const a = this.db.companies.find(c => c.id === p.from_company_id), b = this.db.companies.find(c => c.id === p.to_company_id);
    if (!a || !b || a.id === b.id || a.group_id !== b.group_id) fail('Choose two different companies of the same group.');
    const amt = r2(p.amount); if (amt <= 0 || !p.voucher_date) fail('Enter a date and an amount more than zero.');
    if (!this.db.money_account_companies.some(m => m.account_id === p.from_account_id && m.company_id === a.id) ||
      !this.db.money_account_companies.some(m => m.account_id === p.to_account_id && m.company_id === b.id)) fail('Each account must be enabled for its company.');
    const g = uid();
    for (const [c, t, acct, note] of [[a, 'interco_out', p.from_account_id, 'Transfer to ' + b.name], [b, 'interco_in', p.to_account_id, 'Transfer from ' + a.name]]) {
      const fy = fyLabel(p.voucher_date, c.fy_start_month);
      this._ins('vouchers', { company_id: c.id, voucher_type: t, voucher_no: this.nextNo(c.id, fy, t), fy, voucher_date: p.voucher_date, account_id: acct,
        project_id: p.project_id || null, total_amount: amt, tds_amount: 0, net_amount: amt, taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
        round_off: 0, transfer_group_id: g, notes: p.notes || note, ref_no: p.ref_no || null, created_by: USER.id, updated_at: now(), deleted_at: null });
    }
    return g;
  }
  rpc_move_voucher({ p_id, p_company }) {
    const v = this.db.vouchers.find(x => x.id === p_id && !x.deleted_at); if (!v) fail('Entry not found.');
    const src = this.db.companies.find(c => c.id === v.company_id), dst = this.db.companies.find(c => c.id === p_company);
    if (!dst || dst.group_id !== src.group_id || dst.id === src.id) fail('Choose another company of the same group.');
    if (v.transfer_group_id) fail('Inter-company transfers cannot be moved.');
    if (this.db.allocations.some(a => a.from_voucher_id === p_id || a.to_voucher_id === p_id)) fail("Unlink this entry's bill/payment links before moving it.");
    if (this.db.voucher_lines.some(l => l.voucher_id === p_id && l.item_id)) fail('Entries with inventory items cannot be moved.');
    if (v.account_id && !this.db.money_account_companies.some(m => m.account_id === v.account_id && m.company_id === dst.id)) fail('Its cash/bank account is not enabled for the other company.');
    let party = null;
    if (v.party_id) {
      const sp = this.db.parties.find(x => x.id === v.party_id);
      party = this.db.parties.find(x => x.company_id === dst.id && x.name.toLowerCase() === sp.name.toLowerCase())?.id
        || this._ins('parties', { ...sp, id: undefined, company_id: dst.id }).id;
    }
    const fy = fyLabel(v.voucher_date, dst.fy_start_month);
    this._upd('vouchers', v, { company_id: dst.id, party_id: party, category_id: null, voucher_no: this.nextNo(dst.id, fy, v.voucher_type), fy });
  }
  rpc_has_admin_pin({ p_company }) { return this.role(p_company) === 'admin' && !!(this.db.secrets || {})[p_company]; }
  rpc_set_admin_pin({ p_company, p_old, p_new }) {
    if (this.role(p_company) !== 'admin') fail('Only an admin can set the PIN.');
    if (!/^\d{6}$/.test(p_new || '')) fail('The PIN must be exactly six digits.');
    this.db.secrets ||= {};
    if (this.db.secrets[p_company] && this.db.secrets[p_company] !== p_old) fail('The current PIN is not correct.');
    this.db.secrets[p_company] = p_new;   // demo only — the real database stores a one-way hash
  }
  rpc_verify_admin_pin({ p_company, p_pin }) {
    if (this.role(p_company) !== 'admin') return false;
    const pin = (this.db.secrets || {})[p_company]; return !pin || pin === p_pin;
  }
  rpc_merge_parties({ p_from, p_to }) {
    const a = this.db.parties.find(x => x.id === p_from), b = this.db.parties.find(x => x.id === p_to);
    if (!a || !b || a.id === b.id || a.company_id !== b.company_id) fail('Choose two different parties of the same company.');
    if (this.role(a.company_id) !== 'admin') fail('Only an admin can merge parties.');
    for (const v of this.db.vouchers.filter(v => v.party_id === a.id)) this._upd('vouchers', v, { party_id: b.id });
    this._upd('parties', b, { opening_balance: Number(b.opening_balance) + Number(a.opening_balance), gstin: b.gstin || a.gstin, phone: b.phone || a.phone,
      email: b.email || a.email, pan: b.pan || a.pan, address: b.address || a.address, state_code: b.state_code || a.state_code, kind: b.kind !== a.kind ? 'both' : b.kind });
    this._del('parties', x => x.id === a.id);
  }
  rpc_pay_payroll({ p_ids, p_date, p_account }) {
    let n = 0;
    for (const pr of this.db.payroll.filter(x => p_ids.includes(x.id) && !x.voucher_id && !x.paid_on)) {
      const emp = this.db.employees.find(e => e.id === pr.employee_id);
      let cat = this.db.categories.find(c => c.company_id === pr.company_id && c.name.toLowerCase() === 'salary');
      if (!cat) cat = this._ins('categories', { company_id: pr.company_id, name: 'Salary', kind: 'expense', active: true });
      if (!['admin', 'accountant'].includes(this.role(pr.company_id))) fail('Only an admin or accountant can pay salaries.');
      const net = rowNet(pr); if (net <= 0) fail(`Net salary for ${emp?.name} must be above zero before payment.`);
      const key = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const advCat = this.db.categories.filter(c => c.company_id === pr.company_id && c.name.toLowerCase() === 'employee advance').map(c => c.id);
      const adv = r2(this.db.vouchers.filter(x => x.company_id === pr.company_id && !x.deleted_at && x.voucher_type === 'expense' && advCat.includes(x.category_id) && x.voucher_date.slice(0, 7) === pr.month.slice(0, 7)
        && key(this.db.parties.find(q => q.id === x.party_id)?.name || x.notes).includes(key(emp?.name))).reduce((q, x) => q + Number(x.total_amount), 0));
      const amt = r2(Math.max(0, net - adv));
      if (!amt) { this._upd('payroll', pr, { paid_on: p_date }); n++; continue; }
      const month = new Date(pr.month + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' });
      const kind = this.db.money_accounts.find(a => a.id === p_account)?.kind;
      const v = this.rpc_save_voucher({ p: { company_id: pr.company_id, voucher_type: 'expense', voucher_date: p_date, account_id: p_account, payment_mode: kind === 'cash' ? 'cash' : 'bank', category_id: cat.id, book_here: true,
        project_id: emp?.project_id || null, gst_mode: 'none', notes: `Salary ${month} — ${emp?.name}${adv ? ` (advance ${adv} deducted)` : ''}`, lines: [{ description: `Salary ${month} — ${emp?.name}`, amount: amt }] } });
      this._upd('payroll', pr, { voucher_id: v.id, paid_on: p_date }); n++;
    }
    return n;
  }
  rpc_pay_statutory({ p_company, p_month, p_kind, p_date, p_account, p_amount }) {
    if (!['admin', 'accountant'].includes(this.role(p_company))) fail('Only an admin or accountant can pay PF, ESIC, PT or TDS.');
    const amt = r2(p_amount); if (!(amt > 0)) fail('Enter an amount more than zero.');
    const due = statutoryDue(this.db.payroll.filter(x => x.company_id === p_company && x.month === p_month), this.db.statutory_payments.filter(s => s.company_id === p_company && s.month === p_month && this.db.vouchers.some(v => v.id === s.voucher_id && !v.deleted_at)), p_kind);
    if (amt > due + 0.004) fail(`Only ${due.toFixed(2)} is due for this month.`);
    const names = { pf: ['PF Contribution', 'PF'], esic: ['ESIC Contribution', 'ESIC'], pt: ['Professional Tax', 'Professional Tax'], tds: ['TDS on Salary', 'TDS on salary'] }[p_kind] || fail('Unknown due.');
    let cat = this.db.categories.find(c => c.company_id === p_company && c.name.toLowerCase() === names[0].toLowerCase());
    if (!cat) cat = this._ins('categories', { company_id: p_company, name: names[0], kind: 'expense', active: true });
    const kind = this.db.money_accounts.find(a => a.id === p_account)?.kind;
    const mon = new Date(p_month + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' });
    const v = this.rpc_save_voucher({ p: { company_id: p_company, voucher_type: 'expense', voucher_date: p_date, account_id: p_account, payment_mode: kind === 'cash' ? 'cash' : 'bank', category_id: cat.id, book_here: true,
      gst_mode: 'none', notes: `${names[1]} for ${mon} (employee + employer share)`, lines: [{ description: `${names[1]} ${mon}`, amount: amt }] } });
    this.db.statutory_payments.push({ id: uid(), company_id: p_company, month: p_month, kind: p_kind, amount: amt, voucher_id: v.id, paid_on: p_date, created_at: now() });
    this.save(); return v.id;
  }
  rpc_pay_fixed_cost({ p_fixed_cost, p_date, p_account, p_amount }) {
    const f = this.db.fixed_costs.find(x => x.id === p_fixed_cost); if (!f) fail('Fixed cost not found.');
    if (this.role(f.company_id) !== 'admin') fail('Only an admin can pay fixed costs.');
    let left = r2(p_amount); if (left <= 0) fail('Enter an amount more than zero.');
    const paidIn = mm => r2(this.db.fixed_cost_payments.filter(x => x.fixed_cost_id === f.id && x.month === mm && this.db.vouchers.some(vv => vv.id === x.voucher_id && !vv.deleted_at)).reduce((q, x) => q + Number(x.amount), 0));
    let due = 0; for (let mm = f.start_month.slice(0, 7) + '-01'; mm <= p_date.slice(0, 7) + '-01' && (!f.end_month || mm <= f.end_month); mm = addMonths(mm, 1)) due = r2(due + Math.max(0, Number(f.monthly_amount) - paidIn(mm)));
    if (left > due + 0.005) fail(`Enter a valid amount not more than the outstanding balance (${due}).`);
    const kind = this.db.money_accounts.find(a => a.id === p_account)?.kind;
    const v = this.rpc_save_voucher({ p: { company_id: f.company_id, voucher_type: 'expense', voucher_date: p_date, account_id: p_account, payment_mode: kind === 'cash' ? 'cash' : 'bank', category_id: f.category_id, book_here: true,
      project_id: f.project_id || null, gst_mode: 'none', notes: 'Fixed cost — ' + f.name, lines: [{ description: f.name, amount: left }] } });
    let m = f.start_month.slice(0, 7) + '-01';
    const limit = f.end_month || p_date.slice(0, 7) + '-01';
    while (left > 0.004 && m <= limit) {
      const paid = r2(this.db.fixed_cost_payments.filter(x => x.fixed_cost_id === f.id && x.month === m && this.db.vouchers.some(vv => vv.id === x.voucher_id && !vv.deleted_at)).reduce((s, x) => s + Number(x.amount), 0));
      const take = r2(Math.min(left, Number(f.monthly_amount) - paid));
      if (take > 0.004) { this.db.fixed_cost_payments.push({ id: uid(), fixed_cost_id: f.id, voucher_id: v.id, month: m, amount: take }); left = r2(left - take); }
      m = addMonths(m, 1);
    }
    return v.id;
  }

  // ───────── sample data ─────────
  seed() {
    const c1 = this.rpc_create_company({ p_name: 'GKS Trading', p_gstin: '27AAAAA0000A1Z5', p_state: '27' });
    const g = this.db.companies[0].group_id;
    const c2 = this.rpc_create_company({ p_name: 'GlassKraft Facades', p_group: g, p_state: '27' });
    const bank = this._ins('money_accounts', { group_id: g, kind: 'bank', name: 'HDFC Current', bank_name: 'HDFC Bank', account_last4: '4521', active: true });
    this.db.money_account_companies.push({ account_id: bank.id, company_id: c1, opening_balance: 500000 }, { account_id: bank.id, company_id: c2, opening_balance: 200000 });
    const cash1 = this.db.money_account_companies.find(m => m.company_id === c1 && this.db.money_accounts.find(a => a.id === m.account_id)?.kind === 'cash').account_id;
    cash1 && (this.db.money_account_companies.find(m => m.account_id === cash1).opening_balance = 25000);
    const P = (name, kind, extra = {}) => this._ins('parties', { company_id: c1, name, kind, opening_balance: 0, active: true, state_code: '27', ...extra }).id;
    const steel = P('Shree Aluminium Extrusions', 'vendor', { gstin: '27BBBBB1111B1Z2' });
    const glass = P('Saint Glass Pvt Ltd', 'vendor', { gstin: '24CCCCC2222C1Z3', state_code: '24' });
    const infy = P('Techpark Developers', 'customer', { gstin: '27DDDDD3333D1Z4' });
    const mall = P('City Mall LLP', 'customer');
    const labour = P('Ramesh Labour Contractor', 'vendor');
    const pr1 = this._ins('projects', { group_id: g, name: 'Techpark Tower B — Unitized Facade', kind: 'combined', work_order_no: 'WO-2026-114', work_order_date: '2026-06-10', order_value: 4200000, active: true }).id;
    const pr2 = this._ins('projects', { group_id: g, name: 'City Mall — ACP Cladding', kind: 'service', order_value: 1150000, active: true }).id;
    const I = (name, unit, hsn, gst_rate, opening_qty = 0, opening_rate = 0) => this._ins('items', { company_id: c1, name, unit, hsn, gst_rate, opening_qty, opening_rate, active: true }).id;
    const alu = I('Aluminium Mullion 6063-T6', 'Kg', '7604', 18, 200, 265);
    const dgu = I('DGU Glass 6+12+6', 'Sqm', '7008', 18);
    const acp = I('ACP Sheet 4mm', 'Sqm', '7606', 18, 50, 1150);
    const sil = I('Structural Silicone', 'Nos', '3214', 18, 40, 520);
    const panel = I('Unitized Curtain Wall Panel', 'Sqm', '7610', 18, 400, 3900);
    // BOQ: work/order items, each with the materials and expenses it needs
    const boq = (pr, item, unit, qty, rate, comps, n) => {
      const id = uid(); this.db.project_budget_lines.push({ id, project_id: pr, parent_id: null, line_no: n, description: item, unit, qty, rate, kind: 'order', cost_type: null, profit_percent: 15 });
      comps.forEach(([t, d, u, q, r], i) => this.db.project_budget_lines.push({ id: uid(), project_id: pr, parent_id: id, line_no: i + 1, description: d, unit: u, qty: q, rate: r, kind: 'cost', cost_type: t }));
    };
    boq(pr1, 'Unitized curtain wall system', 'Sqm', 900, 4800, [['Material', 'Aluminium Mullion 6063-T6', 'Kg', 2400, 275], ['Material', 'DGU Glass 6+12+6', 'Sqm', 930, 2100], ['Material', 'Structural Silicone', 'Nos', 450, 520], ['Labour', 'Fabrication labour', 'Sqm', 900, 250], ['Transport', 'Panel transport to site', 'Trip', 30, 6500]], 1);
    boq(pr1, 'Installation of unitized panels', 'Sqm', 900, 550, [['Labour', 'Installation labour — week 41', 'Sqm', 900, 300], ['Overhead', 'Crane & scaffolding hire', 'Month', 3, 45000]], 2);
    boq(pr2, 'ACP cladding 4mm with frame', 'Sqm', 600, 1900, [['Material', 'ACP Sheet 4mm', 'Sqm', 630, 1180], ['Material', 'Aluminium Mullion 6063-T6', 'Kg', 900, 270], ['Labour', 'Cladding labour', 'Sqm', 600, 300]], 1);
    const cat = n => this.db.categories.find(c => c.company_id === c1 && c.name === n).id;
    const S = p => this.rpc_save_voucher({ p: { company_id: c1, gst_mode: 'intra', ...p } });
    const b1 = S({ voucher_type: 'purchase', voucher_date: '2026-09-04', party_id: steel, project_id: pr1, ref_no: 'SAE/2026/1079', lines: [{ item_id: alu, description: 'Aluminium Mullion 6063-T6', qty: 1200, unit: 'Kg', rate: 268, gst_rate: 18, hsn: '7604' }] });
    const b2 = S({ voucher_type: 'purchase', voucher_date: '2026-09-18', party_id: steel, project_id: pr1, ref_no: 'SAE/2026/1132', lines: [{ item_id: alu, description: 'Aluminium Mullion 6063-T6', qty: 600, unit: 'Kg', rate: 270, gst_rate: 18, hsn: '7604' }] });
    const b3 = S({ voucher_type: 'purchase', voucher_date: '2026-09-22', party_id: glass, project_id: pr1, gst_mode: 'inter', ref_no: 'SG-55821', lines: [{ item_id: dgu, description: 'DGU Glass 6+12+6', qty: 420, unit: 'Sqm', rate: 2050, gst_rate: 18, hsn: '7008' }] });
    S({ voucher_type: 'purchase', voucher_date: '2026-10-03', party_id: steel, project_id: pr2, account_id: bank.id, payment_mode: 'bank', ref_no: 'SAE/2026/1201', lines: [{ item_id: acp, description: 'ACP Sheet 4mm', qty: 300, unit: 'Sqm', rate: 1160, gst_rate: 18, hsn: '7606' }] });
    S({ voucher_type: 'payment', voucher_date: '2026-10-08', party_id: steel, account_id: bank.id, payment_mode: 'bank', ref_no: 'UTR 88213', total_amount: 500000,
      allocations: [{ to_voucher_id: b1.id, amount: 379488 }, { to_voucher_id: b2.id, amount: 100000 }] });
    const s1 = S({ voucher_type: 'sale', voucher_date: '2026-09-28', party_id: infy, project_id: pr1, ref_no: 'RA Bill 1', lines: [{ item_id: panel, description: 'Unitized Curtain Wall Panel', qty: 380, unit: 'Sqm', rate: 4800, gst_rate: 18, hsn: '7610' }] });
    S({ voucher_type: 'service', voucher_date: '2026-10-05', party_id: infy, project_id: pr1, lines: [{ description: 'Installation — RA-1', qty: 380, unit: 'Sqm', rate: 550, gst_rate: 18 }] });
    S({ voucher_type: 'receipt', voucher_date: '2026-10-12', party_id: infy, account_id: bank.id, payment_mode: 'bank', ref_no: 'NEFT 4471', total_amount: 1500000, allocations: [{ to_voucher_id: s1.id, amount: 1500000 }] });
    S({ voucher_type: 'receipt', voucher_date: '2026-10-15', party_id: mall, account_id: bank.id, payment_mode: 'bank', ref_no: 'Mobilisation advance', total_amount: 250000, notes: 'Advance against ACP cladding work order' });
    S({ voucher_type: 'challan', voucher_date: '2026-10-16', party_id: mall, project_id: pr2, gst_mode: 'none', notes: 'Material to site', lines: [{ item_id: acp, description: 'ACP Sheet 4mm', qty: 280, unit: 'Sqm', rate: 1180 }] });
    S({ voucher_type: 'expense', voucher_date: '2026-10-10', party_id: labour, project_id: pr1, category_id: cat('Labour'), gst_mode: 'none', tds_section: '194C', tds_rate: 1, tds_amount: 850,
      lines: [{ description: 'Installation labour — week 41', amount: 85000 }] });
    S({ voucher_type: 'expense', voucher_date: '2026-10-11', account_id: cash1, payment_mode: 'cash', project_id: pr1, category_id: cat('Transport'), gst_mode: 'none', lines: [{ description: 'Tempo hire — glass to site', amount: 6500 }] });
    this.db.projects.find(x => x.id === pr1).owner_company_id = c1;
    this.db.projects.find(x => x.id === pr2).owner_company_id = c2;
    S({ voucher_type: 'expense', voucher_date: '2026-10-19', account_id: cash1, payment_mode: 'cash', project_id: pr2, category_id: cat('Site Expenses'), gst_mode: 'none', notes: 'Paid at site for City Mall job', lines: [{ description: 'Scaffolding hire', amount: 12000 }] });
    S({ voucher_type: 'capital_in', voucher_date: '2026-04-05', account_id: bank.id, payment_mode: 'bank', total_amount: 1000000, notes: 'Partner capital' });
    this.rpc_save_interco({ p: { from_company_id: c1, to_company_id: c2, from_account_id: bank.id, to_account_id: bank.id, voucher_date: '2026-10-18', amount: 150000, project_id: pr1 } });
    const e1 = this._ins('employees', this._defaults('employees', { company_id: c1, name: 'Sunil Patil', designation: 'Site Supervisor', basic: 16000, hra: 6400, conveyance: 1600, other_allowance: 8000, project_id: pr1, joining_date: '2025-04-01', uan: '100912345678' }));
    this._ins('employees', this._defaults('employees', { company_id: c1, name: 'Anita Desai', designation: 'Accounts Executive', gender: 'F', basic: 14000, hra: 5600, conveyance: 1600, other_allowance: 6800, joining_date: '2024-07-15' }));
    this._ins('employees', this._defaults('employees', { company_id: c1, name: 'Ramesh Jadhav', designation: 'Fitter', basic: 10500, hra: 2100, conveyance: 1000, other_allowance: 1400, project_id: pr1, joining_date: '2025-11-03', esic_no: '3100123456' }));
    this._ins('payroll', this._defaults('payroll', { company_id: c1, employee_id: e1.id, month: '2026-09-01', present_days: 28 }));
    this._ins('fixed_costs', { company_id: c1, name: 'Factory rent', category_id: cat('Rent'), monthly_amount: 45000, start_month: '2026-04-01', active: true });
    this.db.audit_log = [];
    this.save();
  }
}

export const payrollNet = rowNet;
// PF / ESIC / PT / TDS still to pay for a month: worked out on the payroll rows less what was paid
export function statutoryDue(rows, payments, kind) {
  const n = x => Number(x) || 0;
  const tot = rows.reduce((s, p) => s + (kind === 'pf' ? n(p.pf_employee) + n(p.pf_employer) + n(p.pf_admin) : kind === 'esic' ? n(p.esic_employee) + n(p.esic_employer) : kind === 'pt' ? n(p.pt) : n(p.tds)), 0);
  return r2(tot - payments.filter(s => s.kind === kind).reduce((s, x) => s + n(x.amount), 0));
}
export function addMonths(isoMonth, n) {
  const d = new Date(isoMonth.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
