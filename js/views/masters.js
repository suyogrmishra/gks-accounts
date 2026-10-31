// Cash & bank, projects, inventory and parties.
import { S, company, canWrite, isAdmin, canAddParty, accounts, accountBalance, accountOpening, groupCompanies, companyName, parties, partyBalance, items, stockOf, avgRate, lastPurchaseRate, stockMovement,
  visibleProjects, projectName, pending, unalloc, cv, categoryName, role, fyBounds } from '../store.js';
import { TYPES, money, qtyFmt, r2, sum, plEffect, accountEffects, SALES_BILLS, PURCHASE_BILLS } from '../calc.js';
import { $, $$, esc, html, raw, options, modal, confirmBox, toast, formData, table, today, fmtDate, downloadCSV, printHTML, debounce } from '../ui.js';
import { errorText } from '../backend.js';
import { viewVoucher } from './entry.js';
import { go, reload } from '../app.js';
import { requireAdminPin } from '../pin.js';
import { analyseProject, COST_TYPES, parsePasted, num } from '../budget.js';
import { delBtn, deleteRecord, plural } from '../remove.js';

const open = root => root.addEventListener('click', e => { const tr = e.target.closest('[data-v]'); if (tr && !e.target.closest('button')) viewVoucher(tr.dataset.v); });
async function attempt(fn, ok) { try { await fn(); await reload(); if (ok) toast(ok); return true; } catch (err) { toast(errorText(err), 'error'); return false; } }

// ───────────────────────── Cash & bank ─────────────────────────
export function banking(el) {
  const accs = accounts(), all = S.accounts, gc = groupCompanies();
  el.innerHTML = String(html`<div class="page-head"><div><h2>Cash &amp; Bank</h2><p>Balances, transfers between your accounts, and money moved between group companies.</p></div>
    <div class="row">${canWrite() ? raw('<button class="btn" data-new="receipt">+ Money received</button><button class="btn" data-new="payment">+ Money paid</button><button class="btn" data-new="transfer">Transfer between accounts</button>') : ''}${canWrite() && gc.length > 1 ? raw('<button class="btn" id="icBtn">Inter-company transfer</button>') : ''}${canWrite() ? raw('<button class="btn primary" id="addAcc">+ Add account</button>') : ''}</div></div>
    <div class="grid g3">${accs.map(a => html`<button class="stat" data-ledger="${a.id}"><div class="k">${a.kind === 'cash' ? 'Cash' : a.kind === 'upi' ? 'UPI' : a.bank_name || 'Bank'}${a.account_last4 ? ' ••' + a.account_last4 : ''}${a.active ? '' : ' · inactive'}</div>
      <div class="v">${money(accountBalance(a.id))}</div><div class="s">${a.name} — view statement</div></button>`)}</div>
    ${!accs.length ? raw('<div class="empty">No accounts enabled for this company yet.</div>') : ''}
    ${isAdmin() ? html`<div class="card"><h3>Accounts in this group</h3><p class="small muted">One bank account can be used by several companies. Tick the companies that use it and set each one's opening balance.</p>
      ${raw(table([{ label: 'Account', render: a => `<b>${esc(a.name)}</b><span class="sub">${esc([a.kind.toUpperCase(), a.bank_name, a.account_last4 && '••' + a.account_last4, a.ifsc].filter(Boolean).join(' · '))}</span>` },
        ...gc.map(c => ({ label: c.name, render: a => { const m = S.accountCompanies.find(x => x.account_id === a.id && x.company_id === c.id); return S.memberships.some(x => x.company_id === c.id && x.role === 'admin') ? `<label class="check"><input type="checkbox" data-link="${a.id}|${c.id}" ${m ? 'checked' : ''}> use</label>${m ? `<input type="number" step="0.01" data-open="${a.id}|${c.id}" value="${m.opening_balance}" title="Opening balance" style="width:120px;margin-top:4px">` : ''}` : (m ? 'yes' : '—'); } })),
        { label: '', render: a => `<button class="btn sm" data-edit="${a.id}">Edit</button>` }], all, { empty: 'No accounts.' }))}</div>` : ''}`);
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ledger) go('ledgers?kind=account&id=' + b.dataset.ledger);
    if (b.dataset.new) go('new?type=' + b.dataset.new);
    if (b.id === 'addAcc') accountForm();
    if (b.dataset.edit) accountForm(S.accounts.find(a => a.id === b.dataset.edit));
    if (b.id === 'icBtn') intercoForm();
  });
  el.addEventListener('change', async e => {
    const t = e.target;
    if (t.dataset.link) { const [a, c] = t.dataset.link.split('|'); await attempt(() => t.checked ? S.backend.insert('money_account_companies', { account_id: a, company_id: c, opening_balance: 0 }) : S.backend.remove('money_account_companies', { account_id: a, company_id: c }), 'Saved'); }
    if (t.dataset.open) { const [a, c] = t.dataset.open.split('|'); await attempt(() => S.backend.update('money_account_companies', { account_id: a, company_id: c }, { opening_balance: Number(t.value || 0) }), 'Opening balance saved'); }
  });
}
function accountForm(a) {
  const m = modal(a ? 'Edit account' : 'Add cash / bank / UPI account', String(html`<form class="stack"><div class="form-grid">
    <label>Type<select name="kind">${raw(options([['bank', 'Bank account'], ['upi', 'UPI / wallet (separate)'], ['cash', 'Cash']], a?.kind || 'bank'))}</select></label>
    <label class="span2">Display name<input name="name" required value="${a?.name || ''}" placeholder="e.g. HDFC Current"></label>
    <label>Bank name<input name="bank_name" value="${a?.bank_name || ''}"></label><label>Last 4 digits<input name="account_last4" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" value="${a?.account_last4 || ''}"></label>
    <label>IFSC<input name="ifsc" value="${a?.ifsc || ''}"></label>
    ${!a ? html`<label>Opening balance in ${company().name}<input type="number" step="0.01" name="opening" value="0"></label>` : html`<label class="check"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> Active</label>`}
    </div><p class="small muted">Store only the last 4 digits. Never enter PINs or passwords here.</p><div class="row end">${raw(delBtn(!!a))}<button class="btn primary">Save</button></div></form>`));
  m.el.querySelector('[data-del]')?.addEventListener('click', () => {
    const n = S.vouchers.filter(v => v.account_id === a.id || v.to_account_id === a.id).length;
    deleteRecord({ what: 'account', name: a.name, used: n ? `it is used on ${plural(n, 'entry', 'entries')}. Untick “Active” to hide it instead.` : '',
      run: async () => { await S.backend.remove('money_account_companies', { account_id: a.id }); await S.backend.remove('money_accounts', { id: a.id }); }, done: () => m.close() });
  });
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const d = formData(e.target); const opening = d.opening; delete d.opening;
    const ok = await attempt(async () => {
      if (a) await S.backend.update('money_accounts', { id: a.id }, d);
      else { const [row] = await S.backend.insert('money_accounts', { ...d, group_id: company().group_id, active: true }); await S.backend.insert('money_account_companies', { account_id: row.id, company_id: S.companyId, opening_balance: opening || 0 }); }
    }, 'Account saved');
    if (ok) m.close();
  };
}
function intercoForm() {
  const gc = groupCompanies().filter(c => S.memberships.some(m => m.company_id === c.id && ['admin', 'partner', 'accountant'].includes(m.role)));
  const accFor = cid => S.accounts.filter(a => S.accountCompanies.some(m => m.account_id === a.id && m.company_id === cid) && a.active).map(a => [a.id, a.name]);
  const m = modal('Inter-company transfer', String(html`<form class="stack"><p class="small muted">Creates a matched “Transfer to” entry in one company and “Transfer from” entry in the other. It moves money between companies; it is not income or expense.</p>
    <div class="form-grid"><label>From company<select name="from_company_id">${raw(options(gc.map(c => [c.id, c.name]), S.companyId))}</select></label><label>From account<select name="from_account_id"></select></label>
    <label>To company<select name="to_company_id">${raw(options(gc.filter(c => c.id !== S.companyId).map(c => [c.id, c.name])))}</select></label><label>To account<select name="to_account_id"></select></label>
    <label>Date<input type="date" name="voucher_date" value="${today()}" required></label><label>Amount<input type="number" step="0.01" min="0.01" name="amount" required></label>
    <label>Project<select name="project_id">${raw(options(visibleProjects().map(p => [p.id, p.name]), '', { blank: 'General / no project' }))}</select></label><label>Reference<input name="ref_no"></label>
    <label class="full">Notes<input name="notes"></label></div><div class="row end"><button class="btn primary">Save transfer</button></div></form>`));
  const f = m.el.querySelector('form');
  const sync = () => { f.from_account_id.innerHTML = options(accFor(f.from_company_id.value)); f.to_account_id.innerHTML = options(accFor(f.to_company_id.value)); };
  f.from_company_id.onchange = sync; f.to_company_id.onchange = sync; sync();
  f.onsubmit = async e => { e.preventDefault(); const d = formData(f); if (await attempt(() => S.backend.rpc('save_interco', { p: d }), 'Transfer saved in both companies')) m.close(); };
}

// ───────────────────────── Projects ─────────────────────────
export function projects(el, { query }) {
  const sel = query.get('id');
  if (sel) return projectDetail(el, sel);
  const ps = visibleProjects(), memo = new Map();
  const stats = p => { if (!memo.has(p.id)) { const a = analyseProject(p); memo.set(p.id, { s: a.billed, c: a.cost, profit: r2(a.billed - a.cost), budget: a.budTot, a }); } return memo.get(p.id); };
  const general = cv().filter(v => !v.project_id && plEffect(v) && Object.keys(plEffect(v)).length).length;
  el.innerHTML = String(html`<div class="page-head"><div><h2>Projects</h2><p>Projects are shared by all companies in the group. Figures below add up every company you can see.</p></div>
    ${canWrite() ? raw('<button class="btn primary" id="addProj">+ Add project</button>') : ''}</div>
    <div class="card">${raw(table([
      { label: 'Project', render: p => { const due = completionDate(p), late = due && due < today() && p.active; return `<b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge">closed</span>'}${late ? ' <span class="badge bad">past completion date</span>' : ''}<span class="sub">${esc([p.kind, p.owner_company_id && companyName(p.owner_company_id), p.work_order_no && 'WO ' + p.work_order_no, due && 'complete by ' + fmtDate(due)].filter(Boolean).join(' · '))}</span>`; } },
      { label: 'Order value', num: true, render: p => money(p.order_value, { blankZero: true }) },
      { label: 'Billed (sales)', num: true, render: p => money(stats(p).s) },
      { label: 'Cost so far', num: true, render: p => { const st = stats(p); return money(st.c) + (st.budget ? `<div class="bar ${st.c > st.budget ? 'over' : ''}" title="${Math.round(st.c / st.budget * 100)}% of budget"><span style="width:${Math.min(100, st.c / st.budget * 100)}%"></span></div>` : ''); } },
      { label: 'Budget', render: p => { const a = stats(p).a; return a.budTot ? `<span class="badge ${a.status.cls}">${esc(a.status.label)}</span>${a.overLines.length ? `<span class="sub neg">${a.overLines.length} line${a.overLines.length > 1 ? 's' : ''} over</span>` : ''}` : '<span class="muted small">Not set</span>'; } },
      { label: 'Profit', num: true, render: p => { const x = stats(p).profit; return `<b class="${x < 0 ? 'neg' : 'pos'}">${money(x)}</b>`; } },
      { label: 'Forecast profit', num: true, render: p => { const a = stats(p).a; return a.contract && a.budTot ? `<span class="${a.forecastProfit < 0 ? 'neg' : ''}">${money(a.forecastProfit)}</span>` : ''; } },
    ], ps, { empty: 'No projects yet.', rowAttr: p => `class="click" data-p="${p.id}"` }))}
    <p class="small muted">${general} ${general === 1 ? 'entry has' : 'entries have'} no project in ${esc(company().name)} — see <a href="#/entries?project=none">Day Book → General</a>.</p></div>`);
  el.addEventListener('click', e => { const r = e.target.closest('[data-p]'); if (r) go('projects?id=' + r.dataset.p); if (e.target.id === 'addProj') projectForm(); });
}
// expected completion = work order date + days to complete
export function completionDate(p) {
  if (!p?.work_order_date || p.days_to_complete == null) return '';
  const d = new Date(p.work_order_date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(p.days_to_complete)); return d.toISOString().slice(0, 10);
}
function projectForm(p) {
  const m = modal(p ? 'Edit project' : 'Add project', String(html`<form class="stack"><div class="form-grid">
    <label class="span2">Project name<input name="name" required value="${p?.name || ''}"></label>
    <label>Type<select name="kind">${raw(options([['combined', 'Supply + service'], ['trading', 'Trading / supply'], ['service', 'Service job']], p?.kind || 'combined'))}</select></label>
    <label>Client<input name="client_party_name" value="${p?.client_party_name || ''}"></label>
    <label>Project company (owner)<select name="owner_company_id" ${isAdmin() ? '' : 'disabled'}>${raw(options(groupCompanies().map(c => [c.id, c.name]), p ? p.owner_company_id : S.companyId, { blank: 'Not set' }))}</select></label>
    <label>Work order no.<input name="work_order_no" value="${p?.work_order_no || ''}"></label><label>Work order date<input type="date" name="work_order_date" value="${p?.work_order_date || ''}"></label>
    <label>Order value (₹)<input type="number" step="0.01" min="0" name="order_value" value="${p?.order_value || ''}"></label><label>Days to complete<input type="number" min="0" name="days_to_complete" value="${p?.days_to_complete || ''}"></label>
    ${p ? html`<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active (untick when closed)</label>` : ''}
    </div><div class="row end">${raw(delBtn(!!p))}<button class="btn primary">Save</button></div></form>`));
  m.el.querySelector('[data-del]')?.addEventListener('click', () => {
    const n = S.vouchers.filter(v => v.project_id === p.id).length, emp = S.employees.filter(x => x.project_id === p.id).length, fc = S.fixedCosts.filter(x => x.project_id === p.id).length;
    const used = n ? `it has ${plural(n, 'entry', 'entries')}. Untick “Active” to close it instead.` : emp || fc ? `employees or fixed costs are linked to it. Change them first.` : '';
    deleteRecord({ what: 'project', name: p.name, used, run: () => S.backend.remove('projects', { id: p.id }), done: () => { m.close(); if (location.hash.includes('id=' + p.id)) location.hash = '#/projects'; } });
  });
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const d = formData(e.target); d.order_value = d.order_value || 0;
    if (!isAdmin()) delete d.owner_company_id;
    if (d.days_to_complete != null && (!Number.isInteger(d.days_to_complete) || d.days_to_complete < 0)) return toast('Enter a valid number of completion days.', 'error');
    const ok = await attempt(() => p ? S.backend.update('projects', { id: p.id }, d) : S.backend.insert('projects', { ...d, group_id: company().group_id, active: true }), 'Project saved');
    if (ok) m.close();
  };
}
function projectDetail(el, id) {
  const p = S.projects.find(x => x.id === id); if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }
  const gc = groupCompanies(), gcIds = new Set(gc.map(c => c.id));
  const vs = S.vouchers.filter(v => v.project_id === id && gcIds.has(v.company_id));
  const perCo = gc.map(c => {
    const cvs = vs.filter(v => v.company_id === c.id), e = cvs.map(plEffect);
    // money received / paid for this project = settled part of its bills + unlinked payments tagged to it
    const settled = v => r2(Number(v.net_amount) - pending(v));
    const moneyIn = r2(sum(cvs.filter(v => SALES_BILLS.includes(v.voucher_type)), settled) + sum(cvs.filter(v => v.voucher_type === 'receipt'), unalloc));
    const moneyOut = r2(sum(cvs.filter(v => PURCHASE_BILLS.includes(v.voucher_type)), settled) + sum(cvs.filter(v => v.voucher_type === 'payment'), unalloc));
    return { c, sales: sum(e, x => x.sales || 0), cost: sum(e, x => (x.purchases || 0) + (x.expenses || 0)), moneyIn, moneyOut,
      due: sum(cvs.filter(v => SALES_BILLS.includes(v.voucher_type)), pending), owe: sum(cvs.filter(v => PURCHASE_BILLS.includes(v.voucher_type)), pending) };
  }).filter(r => r.sales || r.cost || r.moneyIn || r.moneyOut);
  const A = analyseProject(p), { orders, budget, lineRows, budTot } = A;
  const allBud = S.budget.filter(b => b.project_id === id).sort((a, b) => a.line_no - b.line_no);
  const groups = [...orders.map(o => ({ o, rows: lineRows.filter(r => r.b.parent_id === o.id) })), { o: null, rows: lineRows.filter(r => !r.b.parent_id || !orders.some(o => o.id === r.b.parent_id)) }].filter(g => g.o || g.rows.length);
  const tot = { sales: A.billed, cost: A.cost };
  const bar = (act, bud) => bud > 0 ? `<div class="bar ${act > bud + 0.004 ? 'over' : act >= bud * 0.9 ? 'near' : ''}" title="${Math.round(act / bud * 100)}% of budget"><span style="width:${Math.min(100, act / bud * 100)}%"></span></div>` : '';
  const pct = (a, b) => b > 0 ? Math.round(a / b * 100) + '%' : '—';
  el.innerHTML = String(html`<div class="page-head"><div><button class="link small" onclick="history.back()">← Projects</button><h2>${p.name}</h2>
      <p>${[p.kind, p.owner_company_id && 'Project company: ' + companyName(p.owner_company_id), p.client_party_name, p.work_order_no && 'WO ' + p.work_order_no, p.work_order_date && fmtDate(p.work_order_date), p.days_to_complete && p.days_to_complete + ' days', completionDate(p) && 'expected completion ' + fmtDate(completionDate(p))].filter(Boolean).join(' · ')}</p></div>
    <div class="row">${canWrite() ? raw('<button class="btn" id="editP">Edit</button>') : ''}<button class="btn" id="csvP">Export CSV</button><button class="btn" id="printP">Print</button><a class="btn" href="#/ledgers?kind=project&id=${p.id}">Ledger</a></div></div>
    <div id="pOut">
    ${A.overLines.length || A.status.code === 'over' || A.status.code === 'near' ? html`<div class="card alert ${A.status.code === 'over' || A.overLines.length ? 'bad' : 'warn'}"><b>Budget alert.</b>
      ${A.status.code === 'over' ? html` Total cost ${money(A.cost)} is over the budget of ${money(budTot)} by ${money(A.cost - budTot)}.` : A.status.code === 'near' ? html` ${pct(A.cost, budTot)} of the total budget is already used.` : ''}
      ${A.overLines.length ? html` Over budget: ${A.overLines.map(r => `${r.b.description} (${money(r.actual - r.budget)} over)`).join(', ')}.` : ''}
      ${A.nearLines.length ? html` Nearly used up: ${A.nearLines.map(r => `${r.b.description} (${pct(r.actual, r.budget)})`).join(', ')}.` : ''}</div>` : ''}
    <div class="grid g4">
      <div class="stat"><div class="k">Order value</div><div class="v">${money(A.contract)}</div><div class="s">${A.contract ? pct(tot.sales, A.contract) + ' billed · ' + money(A.toBill) + ' still to bill' : ''}</div></div>
      <div class="stat"><div class="k">Billed</div><div class="v">${money(tot.sales)}</div><div class="s">Received ${money(A.received)} · due ${money(A.custDue)}</div></div>
      <div class="stat"><div class="k">Cost so far</div><div class="v ${A.status.code === 'over' ? 'neg' : ''}">${money(tot.cost)}</div><div class="s">${budTot ? pct(tot.cost, budTot) + ' of budget ' + money(budTot) : 'No budget set'}</div>${raw(bar(tot.cost, budTot))}</div>
      <div class="stat"><div class="k">Profit so far</div><div class="v ${tot.sales - tot.cost < 0 ? 'neg' : 'pos'}">${money(tot.sales - tot.cost)}</div><div class="s">${A.contract && budTot ? 'Planned ' + money(A.plannedProfit) + ' · forecast ' + money(A.forecastProfit) : ''}</div></div></div>
    ${budTot || A.contract ? html`<div class="grid g2">
      <div class="card"><h3>Forecast at completion</h3><table><tbody>
        <tr><td>Order value</td><td class="num">${money(A.contract)}</td></tr>
        <tr><td>Cost so far</td><td class="num">${money(A.cost)}</td></tr>
        <tr><td>Budget still to spend <span class="sub">unused part of each budget line</span></td><td class="num">${money(A.budgetLeft)}</td></tr>
        <tr><td><b>Forecast total cost</b></td><td class="num"><b>${money(A.forecastCost)}</b></td></tr>
        <tr><td><b>Forecast profit</b> <span class="sub">planned ${money(A.plannedProfit)}${A.contract ? ' (' + (Math.round(A.plannedProfit / A.contract * 1000) / 10) + '%)' : ''}</span></td><td class="num"><b class="${A.forecastProfit < 0 ? 'neg' : 'pos'}">${money(A.forecastProfit)}</b>${A.contract ? html`<span class="sub">${Math.round(A.forecastProfit / A.contract * 1000) / 10}% margin</span>` : ''}</td></tr>
      </tbody></table><p class="small muted">Spending outside the budget lines (see “Not in budget”) raises the forecast cost. Lines already over budget count at what was spent.</p></div>
      <div class="card"><h3>Project cash</h3><table><tbody>
        <tr><td>Received from client</td><td class="num pos">${money(A.received)}</td></tr>
        <tr><td>Paid to suppliers &amp; for expenses</td><td class="num neg">${money(-A.paid)}</td></tr>
        <tr><td><b>Project cash today</b> <span class="sub">${A.cashNow < 0 ? 'you have funded this from your own money' : 'surplus held from the client'}</span></td><td class="num"><b class="${A.cashNow < 0 ? 'neg' : 'pos'}">${money(A.cashNow)}</b></td></tr>
        <tr><td>Still to come in <span class="sub">bills due ${money(A.custDue)} + still to bill ${money(A.toBill)}</span></td><td class="num">${money(A.cashIn)}</td></tr>
        <tr><td>Still to go out <span class="sub">supplier dues ${money(A.suppDue)} + budget left ${money(A.budgetLeft)}</span></td><td class="num">${money(-A.cashOut)}</td></tr>
        <tr><td><b>Expected cash at completion</b></td><td class="num"><b class="${A.cashEnd < 0 ? 'neg' : 'pos'}">${money(A.cashEnd)}</b></td></tr>
      </tbody></table><p class="small muted">Money received and paid includes GST; budget figures are before GST, so GST on the remaining purchases is extra.</p></div></div>` : ''}
    <div class="card"><h3>By company</h3>${raw(table([{ label: 'Company', render: r => esc(r.c.name) }, { label: 'Billed', num: true, render: r => money(r.sales) }, { label: 'Cost', num: true, render: r => money(r.cost) },
      { label: 'Received', num: true, render: r => money(r.moneyIn) }, { label: 'Paid', num: true, render: r => money(r.moneyOut) }, { label: 'Customer due', num: true, render: r => money(r.due) }, { label: 'Supplier due', num: true, render: r => money(r.owe) }],
      perCo, { empty: 'No entries for this project yet.' }))}</div>
    ${A.byType.length ? html`<div class="card"><h3>Budget by cost type</h3>${raw(table([{ label: 'Cost type', render: r => `<b>${esc(r.type)}</b>` }, { label: 'Budget', num: true, render: r => money(r.budget) },
      { label: 'Spent on budget lines', num: true, render: r => money(r.matched) }, { label: 'Spent outside budget', num: true, render: r => r.unbudgeted ? `<span class="warn-text">${money(r.unbudgeted)}</span>` : '' },
      { label: 'Total spent', num: true, render: r => `<b>${money(r.actual)}</b>${bar(r.actual, r.budget)}` }, { label: 'Left', num: true, render: r => r.budget ? `<span class="${r.budget - r.actual < 0 ? 'neg' : ''}">${money(r.budget - r.actual)}</span>` : '' },
      { label: 'Status', render: r => `<span class="badge ${r.status.cls}">${esc(r.status.label)}</span>` }], A.byType,
      { foot: ['Total', money(budTot), money(sum(A.byType, r => r.matched)), money(sum(A.byType, r => r.unbudgeted)), money(sum(A.byType, r => r.actual)), money(budTot - sum(A.byType, r => r.actual)), ''] }))}</div>` : ''}
    <div class="card"><h3>Budget / BOQ vs actual ${isAdmin() ? raw('<button class="btn sm" id="editBudget">Edit budget / BOQ</button>') : ''}</h3>
      ${!groups.length ? raw('<div class="empty">No budget yet. Add the work/order items from the PO and the materials and expenses each one needs — or paste them from Excel. Lines whose names match items on purchase/expense entries are tracked automatically.</div>') : ''}
      ${A.duplicates.length ? html`<p class="small warn-text">These names appear more than once in the budget, so spending is counted on the first one only: ${A.duplicates.join(', ')}.</p>` : ''}
      ${groups.map(g => { const est = sum(g.rows, r => r.budget), val = g.o ? g.o.qty * g.o.rate : 0, unitCost = g.o && g.o.qty > 0 ? est / g.o.qty : 0, act = sum(g.rows, r => r.actual);
        return html`<div class="boq-block">${g.o ? html`<div class="row between"><h4 style="margin:0">${g.o.description}</h4><span class="muted small">${qtyFmt(g.o.qty)} ${g.o.unit || ''} × ${money(g.o.rate)} = <b>${money(val)}</b></span></div>
          <div class="grid g4 boq-stats">${g.o.profit_percent != null ? html`<div><span class="k">Allowed basic cost / ${g.o.unit || 'unit'} (${g.o.profit_percent}% profit)</span><b>${money(g.o.rate * (1 - g.o.profit_percent / 100))}</b></div>
            <div><span class="k">Target profit / ${g.o.unit || 'unit'}</span><b>${money(g.o.rate * g.o.profit_percent / 100)}</b></div>` : ''}
          <div><span class="k">Actual estimated cost / ${g.o.unit || 'unit'}</span><b class="${g.o.profit_percent != null && unitCost > g.o.rate * (1 - g.o.profit_percent / 100) ? 'neg' : ''}">${money(unitCost)}</b></div>
          <div><span class="k">Actual profit / ${g.o.unit || 'unit'}</span><b class="${g.o.rate - unitCost < 0 ? 'neg' : 'pos'}">${money(g.o.rate - unitCost)}</b></div>
          <div><span class="k">Expected profit</span><b class="${val - est < 0 ? 'neg' : 'pos'}">${money(val - est)} (${val ? (Math.round((val - est) / val * 1000) / 10) + '%' : '—'})</b></div>
          <div><span class="k">Spent so far</span><b class="${act > est ? 'neg' : ''}">${money(act)}</b>${raw(bar(act, est))}</div></div>` : html`<h4>Other budget lines</h4>`}
          ${raw(table([{ label: 'Type', render: r => esc(r.type) }, { label: 'Material / expense', render: r => esc(r.b.description) }, { label: 'Budget qty', num: true, render: r => qtyFmt(r.budgetQty) + ' ' + esc(r.b.unit || '') },
            { label: 'Used qty', num: true, render: r => `<span class="${r.usedQty > r.budgetQty + 0.0005 ? 'neg' : ''}">${qtyFmt(r.usedQty)}</span>` }, { label: 'Rate', num: true, render: r => money(r.b.rate) }, { label: 'Budget', num: true, render: r => money(r.budget) },
            { label: 'Actual', num: true, render: r => `<span class="${r.status.code === 'over' ? 'neg' : ''}">${money(r.actual)}</span>${bar(r.actual, r.budget)}` }, { label: 'Left', num: true, render: r => `<span class="${r.budget - r.actual < 0 ? 'neg' : ''}">${money(r.budget - r.actual)}</span>` }],
            g.rows, { empty: 'No materials or expenses listed for this item.', foot: ['', 'Total', '', '', '', money(est), money(act), money(est - act)] }))}</div>`; })}
      ${orders.length ? html`<p class="small">BOQ order value <b>${money(A.boqValue)}</b> · estimated cost <b>${money(budTot)}</b> · expected profit <b>${money(A.boqValue - budTot)}</b></p>` : ''}</div>
    ${A.unbudgeted.length ? html`<div class="card"><h3>Not in budget <span class="muted small">${money(sum(A.unbudgeted, u => u.amount))} spent on lines that match no budget line</span></h3>
      <p class="small muted">Add these names to the budget (or use the same names on your entries) so they are tracked against a line.</p>
      ${raw(table([{ label: 'Date', render: u => fmtDate(u.v.voucher_date) }, { label: 'Entry', render: u => `<b>${esc(u.v.voucher_no)}</b><span class="sub">${esc(TYPES[u.v.voucher_type].label)} · ${esc(companyName(u.v.company_id))}</span>` },
        { label: 'Material / expense', render: u => esc(u.description) }, { label: 'Counted as', render: u => esc(u.type) }, { label: 'Qty', num: true, render: u => u.qty ? qtyFmt(u.qty) : '' }, { label: 'Amount', num: true, render: u => money(u.amount) }],
        [...A.unbudgeted].sort((a, b) => b.v.voucher_date.localeCompare(a.v.voucher_date)), { rowAttr: u => `class="click" data-v="${u.v.id}"` }))}</div>` : ''}
    <div class="card"><h3>Entries</h3>${raw(table([{ label: 'Date', render: v => fmtDate(v.voucher_date) }, { label: 'Entry', render: v => `<b>${esc(v.voucher_no)}</b><span class="sub">${esc(TYPES[v.voucher_type].label)} · ${esc(companyName(v.company_id))}</span>` },
      { label: 'Party', render: v => esc(S.parties.find(x => x.id === v.party_id)?.name || '') }, { label: 'Amount', num: true, render: v => money(v.total_amount) }],
      [...vs].sort((a, b) => b.voucher_date.localeCompare(a.voucher_date)), { empty: 'No entries.', rowAttr: v => `class="click" data-v="${v.id}"` }))}</div></div>`);
  open(el);
  $('#editP', el)?.addEventListener('click', () => projectForm(p));
  $('#printP', el).onclick = () => printHTML(`Project — ${p.name}`, $('#pOut', el).innerHTML);
  $('#csvP', el).onclick = () => downloadCSV(`Budget ${p.name}`, ['Work item', 'Cost type', 'Material / expense', 'Unit', 'Budget qty', 'Used qty', 'Rate', 'Budget', 'Actual', 'Left', 'Status'],
    [...lineRows.map(r => [orders.find(o => o.id === r.b.parent_id)?.description || '', r.type, r.b.description, r.b.unit || '', r.budgetQty, r.usedQty, r.b.rate, r.budget, r.actual, r2(r.budget - r.actual), r.status.label]),
     ...A.unbudgeted.map(u => ['Not in budget', u.type, u.description, '', u.qty, u.qty, '', 0, u.amount, -u.amount, `${u.v.voucher_no} ${u.v.voucher_date}`]),
     ['', '', 'TOTAL', '', '', '', '', budTot, A.cost, r2(budTot - A.cost), A.status.label]]);
  $('#editBudget', el)?.addEventListener('click', () => budgetForm(p, allBud));
}
function budgetForm(p, lines) {
  // groups: one per work/order item (with its materials & expenses), plus loose cost lines
  const orders = lines.filter(l => l.kind === 'order');
  const groups = orders.map(o => ({ o: { ...o }, comps: lines.filter(l => l.kind === 'cost' && l.parent_id === o.id).map(c => ({ ...c })), profit: o.profit_percent ?? '' }));
  const loose = lines.filter(l => l.kind === 'cost' && !orders.some(o => o.id === l.parent_id)).map(c => ({ ...c }));
  if (loose.length) groups.push({ o: null, comps: loose });
  if (!groups.length) groups.push({ o: { description: '', unit: 'Sqm', qty: '', rate: '' }, comps: [{ cost_type: 'Material', description: '', unit: '', qty: '', rate: '' }], profit: '' });
  const its = items().map(i => i.name);
  const n = x => Number(x) || 0;
  const paste = { open: false, target: 'items', text: '' };
  const m = modal('Budget / BOQ — ' + p.name, '<div id="bf"></div>', { wide: true });
  const totals = g => { const est = sum(g.comps, c => n(c.qty) * n(c.rate)), val = g.o ? n(g.o.qty) * n(g.o.rate) : 0; return { est, val, unit: g.o && n(g.o.qty) ? est / n(g.o.qty) : 0 }; };
  const draw = () => {
    $('#bf', m.el).innerHTML = String(html`<datalist id="budItems">${its.map(x => html`<option value="${x}">`)}</datalist>
      <div class="row between"><p class="small muted" style="margin:0">Add each work / order item from the purchase order (e.g. "Unitized curtain wall — Sqm"), then the materials, labour and other costs needed to complete it.</p>
        <button class="btn sm" id="pasteToggle">${paste.open ? 'Close paste' : 'Paste from Excel'}</button></div>
      ${paste.open ? html`<div class="boq-block paste-box"><div class="form-grid"><label class="span2">Paste into<select id="pasteTarget">${raw(options([['items', 'New work / order items'], ...groups.map((g, gi) => g.o ? ['g' + gi, 'Materials for: ' + (g.o.description || 'work item ' + (gi + 1))] : ['g' + gi, 'Other budget lines']), ['loose', 'Other budget lines (not tied to a work item)']].filter((x, i, a) => a.findIndex(y => y[1] === x[1]) === i), paste.target))}</select></label></div>
        <p class="small muted">Copy the rows in Excel and paste here. Columns in this order — ${paste.target === 'items' ? raw('<b>Description, Unit, Qty, Rate, Profit %</b> (profit optional)') : raw('<b>Description, Unit, Qty, Rate, Cost type</b> (cost type optional: Material, Labour, Transport, Overhead, Other)')}. Heading rows and blank rows are skipped.</p>
        <textarea id="pasteText" rows="6" placeholder="${paste.target === 'items' ? 'Unitized curtain wall	Sqm	1200	9500	15' : 'Aluminium profile	Kg	5400	310	Material'}">${paste.text}</textarea>
        <div class="row end"><span class="small" id="pasteMsg"></span><button class="btn primary sm" id="pasteAdd">Add rows</button></div></div>` : ''}
      ${groups.map((g, gi) => { const t = totals(g); return html`<div class="boq-block" data-g="${gi}">
        ${g.o ? html`<div class="form-grid"><label class="span2">Work / order item<input data-o="description" value="${g.o.description}" placeholder="e.g. Unitized curtain wall system"></label>
          <label>Unit<input data-o="unit" value="${g.o.unit || ''}"></label><label>Order qty<input type="number" step="any" data-o="qty" value="${g.o.qty}"></label>
          <label>PO / work order rate (incl. all)<input type="number" step="0.01" data-o="rate" value="${g.o.rate}"></label>
          <label>Target profit %<input type="number" step="0.1" min="0" max="99" data-o="profit" value="${g.profit ?? ''}" placeholder="e.g. 15"></label></div>
          <div class="grid g4 boq-stats"><div><span class="k">Allowed basic cost / ${g.o.unit || 'unit'}</span><b>${money(n(g.o.rate) - n(g.o.rate) * n(g.profit) / 100)}</b></div>
            <div><span class="k">Target profit / ${g.o.unit || 'unit'}</span><b>${money(n(g.o.rate) * n(g.profit) / 100)}</b></div>
            <div><span class="k">Actual estimated cost / ${g.o.unit || 'unit'}</span><b class="${n(g.profit) && t.unit > n(g.o.rate) * (1 - n(g.profit) / 100) ? 'neg' : ''}">${money(t.unit)}</b></div>
            <div><span class="k">Actual profit / ${g.o.unit || 'unit'}</span><b class="${n(g.o.rate) - t.unit < 0 ? 'neg' : 'pos'}">${money(n(g.o.rate) - t.unit)}</b></div></div>
          <p class="small boq-calc">Order value <b>${money(t.val)}</b> · estimated cost <b>${money(t.est)}</b> · expected profit <b class="${t.val - t.est < 0 ? 'neg' : 'pos'}">${money(t.val - t.est)}</b>
          ${n(g.profit) && t.unit > n(g.o.rate) * (1 - n(g.profit) / 100) ? html` · <span class="neg">cost per unit is above the allowed cost for ${g.profit}% profit</span>` : ''}</p>` : html`<h4>Other budget lines (not tied to a work item)</h4>`}
        <div class="table-wrap lines-table"><table><thead><tr><th>Type</th><th>Material / expense</th><th>Unit</th><th class="num">Total qty needed</th><th class="num">Rate</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${g.comps.map((c, ci) => html`<tr data-c="${ci}"><td><select data-f="cost_type" style="width:110px">${raw(options(COST_TYPES.map(x => [x, x]), c.cost_type || 'Material'))}</select></td>
          <td class="desc"><input list="budItems" data-f="description" value="${c.description}"></td><td><input data-f="unit" value="${c.unit || ''}" style="width:70px"></td>
          <td><input type="number" step="any" data-f="qty" value="${c.qty}" style="width:100px"></td><td><input type="number" step="0.01" data-f="rate" value="${c.rate}" style="width:100px"></td>
          <td class="num">${money(n(c.qty) * n(c.rate))}</td><td><button class="icon-btn" data-delc="${ci}" aria-label="Remove line">✕</button></td></tr>`)}
        </tbody></table></div>
        <div class="row between"><button class="btn sm" data-addc>+ Add material / expense</button>${raw(`<button class="btn sm ghost neg" data-delg>Remove this ${g.o ? 'work item' : 'group'}</button>`)}</div></div>`; })}
      <p class="msg error" id="bMsg" role="alert"></p>
      <div class="row between" style="margin-top:.75rem"><button class="btn" id="addG">+ Add work / order item</button>
        <span>BOQ value <b>${money(sum(groups, g => totals(g).val))}</b> · cost <b>${money(sum(groups, g => totals(g).est))}</b></span><button class="btn primary" id="saveB">Save budget</button></div>`);
  };
  m.el.addEventListener('change', e => {
    if (e.target.id === 'pasteTarget') { paste.target = e.target.value; paste.text = $('#pasteText', m.el).value; draw(); return; }
    const blk = e.target.closest('[data-g]'); if (!blk) return; const g = groups[blk.dataset.g];
    if (e.target.dataset.o) { if (e.target.dataset.o === 'profit') g.profit = e.target.value; else g.o[e.target.dataset.o] = e.target.value; draw(); }
    const tr = e.target.closest('tr[data-c]'); if (tr && e.target.dataset.f) { g.comps[tr.dataset.c][e.target.dataset.f] = e.target.value; draw(); }
  });
  m.el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return; const blk = b.closest('[data-g]'), g = blk && groups[blk.dataset.g];
    if (b.id === 'pasteToggle') { paste.open = !paste.open; draw(); return; }
    if (b.id === 'pasteAdd') {
      paste.text = $('#pasteText', m.el).value; paste.target = $('#pasteTarget', m.el).value;
      const rows = parsePasted(paste.text).filter(r => r[0] && Number.isFinite(num(r[2])) && num(r[2]) > 0);
      if (!rows.length) { $('#pasteMsg', m.el).textContent = 'No rows found — each row needs a description and a quantity in the 3rd column.'; return; }
      const typeOf = t => COST_TYPES.find(x => x.toLowerCase() === String(t || '').trim().toLowerCase()) || (/labou?r/i.test(t || '') ? 'Labour' : 'Material');
      const rate = r => Number.isFinite(num(r[3])) ? num(r[3]) : '';
      const comps = rows.map(r => ({ cost_type: typeOf(r[4]), description: r[0], unit: r[1] || '', qty: num(r[2]), rate: rate(r) }));
      const clean = gr => { gr.comps = gr.comps.filter(c => String(c.description).trim() || n(c.qty) || n(c.rate)); };
      if (paste.target === 'items') {
        // drop the empty starter item, then add one work item per row
        const blank = groups.findIndex(x => x.o && !String(x.o.description).trim() && !x.comps.some(c => String(c.description).trim())); if (blank >= 0) groups.splice(blank, 1);
        const at = groups.filter(x => x.o).length;
        groups.splice(at, 0, ...rows.map(r => ({ o: { description: r[0], unit: r[1] || '', qty: num(r[2]), rate: rate(r) }, comps: [], profit: Number.isFinite(num(r[4])) ? num(r[4]) : '' })));
      } else if (paste.target === 'loose') {
        let lg = groups.find(x => !x.o); if (!lg) { lg = { o: null, comps: [] }; groups.push(lg); } clean(lg); lg.comps.push(...comps);
      } else { const tg = groups[Number(paste.target.slice(1))]; clean(tg); tg.comps.push(...comps); }
      paste.text = ''; paste.open = false; draw(); toast(`${rows.length} row${rows.length > 1 ? 's' : ''} added — check them, then Save budget`); return;
    }
    if (b.dataset.delc != null && g) { g.comps.splice(Number(b.dataset.delc), 1); draw(); }
    if (b.hasAttribute('data-addc') && g) { g.comps.push({ cost_type: 'Material', description: '', unit: '', qty: '', rate: '' }); draw(); }
    if (b.hasAttribute('data-delg') && g) { groups.splice(Number(blk.dataset.g), 1); draw(); }
    if (b.id === 'addG') { groups.splice(groups.filter(x => x.o).length, 0, { o: { description: '', unit: 'Sqm', qty: '', rate: '' }, comps: [{ cost_type: 'Material', description: '', unit: '', qty: '', rate: '' }], profit: '' }); draw(); }
    if (b.id === 'saveB') {
      // old-app checks
      const err = (() => {
        const real = groups.filter(g2 => (g2.o && String(g2.o.description).trim()) || g2.comps.some(c => String(c.description).trim()));
        if (!real.length) return 'Add at least one work / order item or material.';
        for (const g2 of real) {
          if (g2.o && String(g2.o.description).trim() && !(n(g2.o.qty) > 0)) return `Enter the order quantity for “${g2.o.description}”.`;
          if (g2.o && n(g2.o.rate) < 0) return 'Rates cannot be negative.';
          if (g2.o && (n(g2.profit) < 0 || n(g2.profit) > 100)) return 'Estimated Profit % must be between 0 and 100.';
          for (const c of g2.comps.filter(c => String(c.description).trim())) if (!(n(c.qty) > 0) || n(c.rate) < 0) return `Enter a valid quantity and rate for “${c.description}”.`;
        }
        return '';
      })();
      if (err) { $('#bMsg', m.el).textContent = err; return; }
      const ordersOut = [], costsOut = [];
      groups.forEach((g2, gi) => {
        let parent = null;
        if (g2.o && String(g2.o.description).trim()) { parent = crypto.randomUUID(); ordersOut.push({ id: parent, project_id: p.id, parent_id: null, line_no: gi + 1, description: g2.o.description.trim(), unit: g2.o.unit || null, qty: n(g2.o.qty), rate: n(g2.o.rate), kind: 'order', cost_type: null, profit_percent: g2.profit === '' || g2.profit == null ? null : n(g2.profit) }); }
        g2.comps.filter(c => String(c.description).trim()).forEach((c, ci) => costsOut.push({ project_id: p.id, parent_id: parent, line_no: ci + 1, description: c.description.trim(), unit: c.unit || null, qty: n(c.qty), rate: n(c.rate), kind: 'cost', cost_type: c.cost_type || 'Material' }));
      });
      if (await attempt(async () => {
        await S.backend.remove('project_budget_lines', { project_id: p.id });
        if (ordersOut.length) await S.backend.insert('project_budget_lines', ordersOut);
        if (costsOut.length) await S.backend.insert('project_budget_lines', costsOut);
      }, 'Budget saved')) m.close();
    }
  });
  draw();
}

// ───────────────────────── Inventory ─────────────────────────
export function inventory(el, { query }) {
  const canEdit = canWrite() || role() === 'storekeeper';
  let q = '', tab = query?.get('tab') || 'stock', month = today().slice(0, 7);
  el.innerHTML = `<div class="page-head"><div><h2>Inventory</h2><p>Stock moves automatically with purchases, sales, challans and notes. Use a stock adjustment for breakage, site returns or counts.</p></div>
    <div class="row"><button class="btn" id="csv">Export CSV</button><button class="btn" id="printInv">Print</button>${canEdit ? '<button class="btn" id="adj">Stock adjustment</button><button class="btn primary" id="addItem">+ Add item</button>' : ''}</div></div>
    <div class="card"><div class="tabs">${[['stock', 'Current stock'], ['monthly', 'Monthly stock report']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="toolbar"><label class="grow">Search<input id="iq" placeholder="Item name or HSN"></label><label id="monthBox" class="${tab === 'monthly' ? '' : 'hidden'}">Month<input type="month" id="im" value="${month}"></label></div><div id="il"></div></div>`;
  const list = () => items().filter(i => !q || (i.name + ' ' + (i.hsn || '')).toLowerCase().includes(q));
  const rows = () => list().map(i => ({ i, s: stockOf(i.id), r: avgRate(i.id), last: lastPurchaseRate(i.id) }));
  const monthRows = () => {
    const from = month + '-01', end = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    const prev = new Date(from + 'T00:00:00Z'); prev.setUTCDate(0); const before = prev.toISOString().slice(0, 10);
    return list().map(i => { const open = stockOf(i.id, before), mv = stockMovement(i.id, from, end), close = open + mv.inQ - mv.outQ, r = avgRate(i.id); return { i, open, ...mv, close, r, value: Math.max(0, close) * r }; })
      .filter(x => x.open || x.inQ || x.outQ || x.close);
  };
  let lastHtml = '';
  const draw = () => {
    if (tab === 'stock') {
      const r = rows();
      lastHtml = table([
        { label: 'Item', render: x => `<b>${esc(x.i.name)}</b>${x.i.active ? '' : ' <span class="badge">inactive</span>'}<span class="sub">${esc([x.i.hsn && 'HSN ' + x.i.hsn, x.i.gst_rate != null && x.i.gst_rate + '% GST'].filter(Boolean).join(' · '))}</span>` },
        { label: 'In stock', num: true, render: x => `<span class="badge ${x.s < 0 ? 'bad' : x.i.reorder_level != null && x.s <= x.i.reorder_level ? 'warn' : 'ok'}">${qtyFmt(x.s)} ${esc(x.i.unit)}</span>` },
        { label: 'Last purchase rate', num: true, render: x => x.last == null ? '—' : money(x.last) },
        { label: 'Avg. rate', num: true, render: x => money(x.r) },
        { label: 'Value', num: true, render: x => money(Math.max(0, x.s) * x.r) },
        { label: '', cls: 'no-print', render: x => `<a class="btn sm" href="#/ledgers?kind=item&id=${x.i.id}">History</a> ${canEdit ? `<button class="btn sm" data-edit="${x.i.id}">Edit</button>` : ''}` },
      ], r, { empty: 'No items yet. Add the materials you buy and sell.', foot: ['Total', '', '', '', money(sum(r, x => Math.max(0, x.s) * x.r)), ''] });
    } else {
      const r = monthRows();
      lastHtml = table([
        { label: 'Item', render: x => `<b>${esc(x.i.name)}</b><span class="sub">${esc(x.i.unit)}</span>` },
        { label: 'Opening', num: true, render: x => qtyFmt(x.open) }, { label: 'Received', num: true, render: x => x.inQ ? qtyFmt(x.inQ) : '' },
        { label: 'Issued / sold', num: true, render: x => x.outQ ? qtyFmt(x.outQ) : '' }, { label: 'Closing', num: true, render: x => `<b class="${x.close < 0 ? 'neg' : ''}">${qtyFmt(x.close)}</b>` },
        { label: 'Avg. rate', num: true, render: x => money(x.r) }, { label: 'Closing value', num: true, render: x => money(x.value) },
      ], r, { empty: 'No stock movement in this month.', foot: ['Total', '', '', '', '', '', money(sum(r, x => x.value))] });
    }
    $('#il', el).innerHTML = lastHtml;
  };
  $('#iq', el).oninput = debounce(e => { q = e.target.value.trim().toLowerCase(); draw(); });
  $('#im', el).onchange = e => { month = e.target.value || today().slice(0, 7); draw(); };
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; $$('.tabs button', el).forEach(x => x.classList.toggle('active', x === b)); $('#monthBox', el).classList.toggle('hidden', tab !== 'monthly'); draw(); }
    if (b.id === 'addItem') itemForm();
    if (b.dataset.edit) itemForm(S.items.find(i => i.id === b.dataset.edit));
    if (b.id === 'adj') go('new?type=stock_adjust');
    if (b.id === 'printInv') printHTML(`${company().name} — ${tab === 'stock' ? 'Stock as of ' + fmtDate(today()) : 'Monthly stock report ' + month}`, lastHtml);
    if (b.id === 'csv') tab === 'stock'
      ? downloadCSV('Inventory ' + today(), ['Item', 'Unit', 'HSN', 'GST %', 'Stock', 'Last purchase rate', 'Avg rate', 'Value'], rows().map(x => [x.i.name, x.i.unit, x.i.hsn, x.i.gst_rate, x.s, x.last ?? '', r2(x.r), r2(Math.max(0, x.s) * x.r)]))
      : downloadCSV('Stock ' + month, ['Item', 'Unit', 'Opening', 'Received', 'Issued', 'Closing', 'Avg rate', 'Closing value'], monthRows().map(x => [x.i.name, x.i.unit, x.open, x.inQ, x.outQ, x.close, r2(x.r), r2(x.value)]));
  });
  draw();
}
function itemForm(it) {
  const m = modal(it ? 'Edit item' : 'Add item', String(html`<form class="stack"><div class="form-grid">
    <label class="span2">Name<input name="name" required value="${it?.name || ''}"></label><label>Unit<input name="unit" list="units" required value="${it?.unit || 'Nos'}"><datalist id="units">${['Nos', 'Kg', 'Sqm', 'Sqft', 'Rmt', 'Mtr', 'Ltr', 'Box', 'Set', 'Bag'].map(u => html`<option value="${u}">`)}</datalist></label>
    <label>HSN / SAC<input name="hsn" value="${it?.hsn || ''}"></label><label>GST %<select name="gst_rate">${raw(options([['', '—'], ...[0, 5, 12, 18, 28].map(g => [g, g + '%'])], it?.gst_rate ?? 18))}</select></label>
    <label>Opening qty<input type="number" step="any" name="opening_qty" value="${it?.opening_qty ?? 0}"></label><label>Opening rate<input type="number" step="0.01" name="opening_rate" value="${it?.opening_rate ?? 0}"></label>
    <label>Low-stock alert at<input type="number" step="any" name="reorder_level" value="${it?.reorder_level ?? ''}"></label>
    ${it ? html`<label class="check"><input type="checkbox" name="active" ${it.active ? 'checked' : ''}> Active</label>` : ''}</div>
    <div class="row end">${raw(delBtn(!!it))}<button class="btn primary">Save</button></div></form>`));
  m.el.querySelector('[data-del]')?.addEventListener('click', () => {
    const n = S.vouchers.filter(v => (v.lines || []).some(l => l.item_id === it.id)).length;
    deleteRecord({ what: 'item', name: it.name, used: n ? `it is used on ${plural(n, 'entry', 'entries')}. Untick “Active” to hide it instead.` : '', run: () => S.backend.remove('items', { id: it.id }), done: () => m.close() });
  });
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const d = formData(e.target); d.gst_rate = d.gst_rate === null ? null : Number(d.gst_rate); d.opening_qty = d.opening_qty || 0; d.opening_rate = d.opening_rate || 0;
    if (await attempt(() => it ? S.backend.update('items', { id: it.id }, d) : S.backend.insert('items', { ...d, company_id: S.companyId }), 'Item saved')) m.close();
  };
}

// ───────────────────────── Parties ─────────────────────────
export { partiesView as parties };
function partiesView(el) {
  let q = '', kind = '';
  el.innerHTML = `<div class="page-head"><div><h2>Parties</h2><p>Customers and suppliers of ${esc(company().name)}. Balance: positive = they owe you, negative = you owe them.</p></div>
    <div class="row"><button class="btn" id="csv">Export CSV</button>${isAdmin() ? '<button class="btn" id="merge">Merge duplicates</button>' : ''}${canAddParty() ? '<button class="btn primary" id="addParty">+ Add party</button>' : ''}</div></div>
    <div class="card"><div class="toolbar"><label class="grow">Search<input id="pq" placeholder="Name, phone or GSTIN"></label><label>Type<select id="pk">${options([['customer', 'Customers'], ['vendor', 'Suppliers'], ['both', 'Both']], '', { blank: 'All' })}</select></label></div><div id="pl"></div></div>`;
  const rows = () => parties().filter(p => (!kind || p.kind === kind) && (!q || [p.name, p.phone, p.gstin].join(' ').toLowerCase().includes(q))).map(p => ({ p, bal: partyBalance(p.id) }));
  const draw = () => {
    const r = rows();
    $('#pl', el).innerHTML = table([
      { label: 'Party', render: x => `<b>${esc(x.p.name)}</b>${x.p.active ? '' : ' <span class="badge">inactive</span>'}<span class="sub">${esc([x.p.kind === 'vendor' ? 'Supplier' : x.p.kind === 'customer' ? 'Customer' : 'Customer & supplier', x.p.phone, x.p.gstin].filter(Boolean).join(' · '))}</span>` },
      { label: 'Balance', num: true, render: x => `<b class="${x.bal > 0 ? 'pos' : x.bal < 0 ? 'neg' : ''}">${money(x.bal)}</b>` },
      { label: '', render: x => `<a class="btn sm" href="#/ledgers?kind=party&id=${x.p.id}">Ledger</a> ${canWrite() ? `<button class="btn sm" data-edit="${x.p.id}">Edit</button>` : ''} ${isAdmin() ? `<button class="btn sm danger" data-delp="${x.p.id}">Delete</button>` : ''}` },
    ], r, { empty: 'No parties found.' });
  };
  $('#pq', el).oninput = debounce(e => { q = e.target.value.trim().toLowerCase(); draw(); });
  $('#pk', el).onchange = e => { kind = e.target.value; draw(); };
  el.addEventListener('click', e => {
    if (e.target.id === 'addParty') partyForm();
    if (e.target.dataset.edit) partyForm(S.parties.find(p => p.id === e.target.dataset.edit));
    if (e.target.id === 'merge') mergeForm();
    if (e.target.dataset.delp) deleteParty(S.parties.find(p => p.id === e.target.dataset.delp));
    if (e.target.id === 'csv') downloadCSV('Parties ' + today(), ['Name', 'Type', 'Phone', 'Email', 'GSTIN', 'PAN', 'Address', 'Balance'], rows().map(x => [x.p.name, x.p.kind, x.p.phone, x.p.email, x.p.gstin, x.p.pan, x.p.address, x.bal]));
  });
  draw();
}
async function deleteParty(p) {
  const used = S.vouchers.filter(v => v.party_id === p.id).length;
  if (used) return toast(`${p.name} is used on ${used} entr${used === 1 ? 'y' : 'ies'}. Merge it into another party instead, or mark it inactive.`, 'error');
  if (!await requireAdminPin('delete a party') || !await confirmBox(`Delete the party “${p.name}”?`, { ok: 'Delete', danger: true })) return;
  await attempt(() => S.backend.remove('parties', { id: p.id }), 'Party deleted');
}
function partyForm(p) {
  const m = modal(p ? 'Edit party' : 'Add party', String(html`<form class="stack"><div class="form-grid">
    <label class="span2">Name<input name="name" required value="${p?.name || ''}"></label><label>Type<select name="kind">${raw(options([['customer', 'Customer'], ['vendor', 'Supplier / vendor'], ['both', 'Both']], p?.kind || 'both'))}</select></label>
    <label>Phone<input name="phone" inputmode="tel" value="${p?.phone || ''}"></label><label>Email<input name="email" type="email" value="${p?.email || ''}"></label>
    <label>GSTIN<input name="gstin" maxlength="15" style="text-transform:uppercase" value="${p?.gstin || ''}"></label><label>State code<input name="state_code" maxlength="2" value="${p?.state_code || ''}"></label>
    <label>PAN<input name="pan" maxlength="10" style="text-transform:uppercase" value="${p?.pan || ''}"></label>
    <label class="full">Address<textarea name="address" rows="2">${p?.address || ''}</textarea></label>
    <label>Opening balance<input type="number" step="0.01" name="opening_balance" value="${p?.opening_balance || 0}" title="+ they owe you, − you owe them"></label>
    ${p ? html`<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active</label>` : ''}</div>
    <p class="small muted">Opening balance: enter a positive amount if they owed you at the start, negative if you owed them.</p>
    <p class="msg error" role="alert"></p><div class="row end"><button class="btn primary">Save</button></div></form>`));
  const f = m.el.querySelector('form');
  f.gstin.oninput = () => { const g = f.gstin.value.trim().toUpperCase(); if (/^\d{2}/.test(g) && !f.state_code.value) f.state_code.value = g.slice(0, 2); if (g.length === 15 && !f.pan.value) f.pan.value = g.slice(2, 12); };
  f.onsubmit = async e => {
    e.preventDefault(); const d = formData(f); d.opening_balance = d.opening_balance || 0;
    if (d.gstin) d.gstin = d.gstin.toUpperCase(); if (d.pan) d.pan = d.pan.toUpperCase();
    if (d.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(d.gstin)) { f.querySelector('.msg').textContent = 'That GSTIN does not look right.'; return; }
    if (await attempt(() => p ? S.backend.update('parties', { id: p.id }, d) : S.backend.insert('parties', { ...d, company_id: S.companyId }), 'Party saved')) m.close();
  };
}
function mergeForm() {
  const ps = parties().map(p => [p.id, p.name]);
  const m = modal('Merge duplicate parties', `<form class="stack"><p class="small muted">Every entry of the duplicate moves to the party you keep, then the duplicate is removed. This cannot be undone.</p>
    <label>Duplicate to remove<select name="from">${options(ps)}</select></label><label>Keep this party<select name="to">${options(ps)}</select></label><button class="btn danger">Merge</button></form>`);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const { from, to } = formData(e.target);
    if (from === to) return toast('Choose two different parties', 'error');
    if (!await requireAdminPin('merge parties')) return;
    if (!await confirmBox(`Move all entries of “${S.parties.find(p => p.id === from).name}” to “${S.parties.find(p => p.id === to).name}” and delete the duplicate?`, { ok: 'Merge', danger: true })) return;
    if (await attempt(() => S.backend.rpc('merge_parties', { p_from: from, p_to: to }), 'Parties merged')) m.close();
  };
}

// ───────────────────────── Project accounts (money in / out for one project across every company) ─────────────────────────
export function projectAccounts(el, { query }) {
  const ps = visibleProjects().filter(p => p.active || p.id === query.get('id'));
  let pid = query.get('id') || localStorage.getItem('gks2.paProject') || ps[0]?.id || '';
  if (!ps.some(p => p.id === pid)) pid = ps[0]?.id || '';
  const { from: fyFrom, to: fyTo } = fyBounds(); let from = fyFrom, to = fyTo;
  el.innerHTML = `<div class="page-head"><div><h2>Project Accounts</h2><p>Payment in and payment out for one project across every company of the group.</p></div><div class="row"><button class="btn" id="paCsv">Export CSV</button><button class="btn" id="paPrint">Print</button></div></div>
    <div class="card"><div class="toolbar"><label class="grow">Project<select id="paP">${options(ps.map(p => [p.id, p.name]), pid, { blank: ps.length ? null : 'No projects' })}</select></label>
    <label>From<input type="date" id="paF" value="${from}"></label><label>To<input type="date" id="paT" value="${to}"></label></div><div id="paOut"></div></div>`;
  let rows = [];
  const draw = () => {
    const gc = groupCompanies(), gcIds = new Set(gc.map(c => c.id));
    rows = [];
    for (const v of S.vouchers) {
      if (!gcIds.has(v.company_id) || v.voucher_date < from || v.voucher_date > to) continue;
      const t = v.voucher_type;
      if (v.project_id === pid && ['receipt', 'payment', 'interco_in', 'interco_out', 'capital_in', 'capital_out'].includes(t)) {
        // money entries tagged to the project (receipts/payments: only the part not linked to bills, the rest is counted through the bills below)
        const amt = ['receipt', 'payment'].includes(t) ? unalloc(v) - Number(v.tds_amount || 0) * (unalloc(v) / Number(v.total_amount || 1)) : Number(v.net_amount);
        if (amt > 0.004) rows.push({ v, dir: ['receipt', 'interco_in', 'capital_in'].includes(t) ? 'in' : 'out', amt: r2(amt), how: TYPES[t].label });
      }
      if (['receipt', 'payment'].includes(t)) {
        // payments linked to this project's bills, even if the payment itself carries no project
        for (const a of allocsFromAny(v.id)) { const b = S.ix.byId.get(a.to_voucher_id); if (b?.project_id === pid) rows.push({ v, dir: t === 'receipt' ? 'in' : 'out', amt: r2(Number(a.amount) * (Number(v.net_amount) / Number(v.total_amount || 1))), how: 'Against ' + b.voucher_no }); }
      }
      if (v.project_id === pid && v.account_id && ['sale', 'service', 'challan', 'purchase', 'expense'].includes(t))
        rows.push({ v, dir: SALES_BILLS.includes(t) ? 'in' : 'out', amt: Number(v.net_amount), how: TYPES[t].label + ' paid on the spot' });
    }
    rows.sort((a, b) => a.v.voucher_date.localeCompare(b.v.voucher_date));
    const tin = sum(rows.filter(r => r.dir === 'in'), r => r.amt), tout = sum(rows.filter(r => r.dir === 'out'), r => r.amt);
    const byCo = gc.map(c => ({ c, in: sum(rows.filter(r => r.dir === 'in' && r.v.company_id === c.id), r => r.amt), out: sum(rows.filter(r => r.dir === 'out' && r.v.company_id === c.id), r => r.amt) })).filter(x => x.in || x.out);
    $('#paOut', el).innerHTML = String(html`<div class="grid g3"><div class="stat"><div class="k">Total payment in</div><div class="v pos">${money(tin)}</div></div>
      <div class="stat"><div class="k">Total payment out</div><div class="v neg">${money(tout)}</div></div><div class="stat"><div class="k">Net movement</div><div class="v ${tin - tout < 0 ? 'neg' : 'pos'}">${money(tin - tout)}</div></div></div>
      <h3 style="margin-top:16px">Company summary</h3>${raw(table([{ label: 'Company', render: x => esc(x.c.name) }, { label: 'Payment in', num: true, render: x => money(x.in) }, { label: 'Payment out', num: true, render: x => money(x.out) }, { label: 'Net', num: true, render: x => `<b>${money(x.in - x.out)}</b>` }],
        byCo, { empty: 'No payments for this project in these dates.' }))}
      <h3 style="margin-top:16px">Payment details</h3>${raw(table([{ label: 'Date', render: r => fmtDate(r.v.voucher_date) }, { label: 'Company', render: r => esc(companyName(r.v.company_id)) },
        { label: 'Payment', render: r => `<span class="badge ${r.dir === 'in' ? 'ok' : 'warn'}">${r.dir === 'in' ? 'Payment in' : 'Payment out'}</span><span class="sub">${esc(r.v.voucher_no)} · ${esc(r.how)}</span>` },
        { label: 'Party', render: r => esc(S.parties.find(x => x.id === r.v.party_id)?.name || r.v.notes || '') },
        { label: 'Mode / bank', render: r => { const a = S.accounts.find(x => x.id === r.v.account_id); return `${esc(r.v.payment_mode || '')}${a ? `<span class="sub">${esc(a.name)}${a.account_last4 ? ' ••' + esc(a.account_last4) : ''}</span>` : ''}`; } },
        { label: 'Amount', num: true, render: r => `<b>${money(r.amt)}</b>` }], rows, { empty: 'No payment in or payment out for this project.', rowAttr: r => `class="click" data-v="${r.v.id}"` }))}`);
  };
  const allocsFromAny = id => S.ix.allocFrom.get(id) || [];
  $('#paP', el).onchange = e => { pid = e.target.value; localStorage.setItem('gks2.paProject', pid); draw(); };
  $('#paF', el).onchange = e => { from = e.target.value; draw(); };
  $('#paT', el).onchange = e => { to = e.target.value; draw(); };
  $('#paPrint', el).onclick = () => printHTML(`Project accounts — ${projectName(pid)} (${fmtDate(from)} to ${fmtDate(to)})`, $('#paOut', el).innerHTML);
  $('#paCsv', el).onclick = () => downloadCSV('Project accounts ' + projectName(pid), ['Date', 'Company', 'Entry', 'Direction', 'How', 'Party', 'Mode', 'Account', 'Amount'],
    rows.map(r => [r.v.voucher_date, companyName(r.v.company_id), r.v.voucher_no, r.dir === 'in' ? 'Payment in' : 'Payment out', r.how, S.parties.find(x => x.id === r.v.party_id)?.name || '', r.v.payment_mode || '', S.accounts.find(x => x.id === r.v.account_id)?.name || '', r.amt]));
  open(el); draw();
}
