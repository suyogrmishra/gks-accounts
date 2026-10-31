// Payroll & fixed costs, change history, company & user settings.
import { S, company, canWrite, isAdmin, canManageStaff, accounts, categories, visibleProjects, projectName, categoryName, userEmail, voucher, groupCompanies, myMembership } from '../store.js';
import { TYPES, money, r2, sum, amountInWords } from '../calc.js';
import { $, $$, esc, html, raw, options, modal, confirmBox, toast, formData, table, today, fmtDate, fmtMonth, downloadCSV, printHTML, debounce } from '../ui.js';
import { errorText } from '../backend.js';
import { addMonths } from '../demo.js';
import { payslip, payrollFields, settingsOf, structureOf, grossOf, rowNet, daysInMonth, PAYROLL_DEFAULTS, PT_STATES } from '../payroll.js';
import { viewVoucher } from './entry.js';
import { reload, addCompanyForm } from '../app.js';
import { requireAdminPin } from '../pin.js';

async function attempt(fn, ok) { try { await fn(); await reload(); if (ok) toast(ok); return true; } catch (err) { toast(errorText(err), 'error'); return false; } }

// ───────────────────────── Payroll & fixed costs ─────────────────────────
const KINDS = [['pf', 'Provident Fund (PF)'], ['esic', 'ESIC'], ['pt', 'Professional Tax'], ['tds', 'TDS on salary']];
const cfg = () => settingsOf(company());
const emp = id => S.employees.find(e => e.id === id);
export function payroll(el, { query }) {
  if (!canManageStaff()) { el.innerHTML = '<div class="empty">Payroll and employees are available to Admin and Accountant only.</div>'; return; }
  let tab = query.get('tab') || 'payroll';
  let month = localStorage.getItem('gks2.payMonth') || addMonths(today().slice(0, 7) + '-01', -1);
  el.innerHTML = `<div class="page-head"><div><h2>Payroll &amp; Fixed Costs</h2><p>Salary with PF, ESIC, Professional Tax and TDS. Paying salary, statutory dues or a fixed cost creates an expense entry automatically.</p></div></div>
    <div class="card"><div class="tabs">${[['payroll', 'Monthly payroll'], ['dues', 'PF / ESIC / PT dues'], ['employees', 'Employees'], ['fixed', 'Fixed costs']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div><div id="pb"></div></div>`;
  const isPaid = p => p.voucher_id || p.paid_on;
  const monthRows = () => S.employees.filter(e => e.active || S.payroll.some(p => p.employee_id === e.id && p.month === month)).map(e => ({ e, p: S.payroll.find(p => p.employee_id === e.id && p.month === month) }));
  const inp = (p, f, w = 80, step = '0.01') => isPaid(p) ? money(p[f], { blankZero: true }) : `<input type="number" step="${step}" min="0" data-pr="${p.id}" data-f="${f}" value="${Number(p[f]) || ''}" placeholder="0" style="width:${w}px">`;
  const monthPicker = () => `<label>Month<input type="month" id="pm" value="${month.slice(0, 7)}"></label>`;
  const draw = () => {
    const box = $('#pb', el), c = cfg();
    if (tab === 'employees') {
      const full = e => payslip(e, { month, working_days: 30, present_days: 30 }, c);
      box.innerHTML = (canWrite() ? '<div class="row end" style="margin-bottom:.6rem"><button class="btn primary" data-act="addEmp">+ Add employee</button></div>' : '') +
        table([{ label: 'Name', render: e => `<b>${esc(e.name)}</b>${e.active ? '' : ' <span class="badge">left</span>'}<span class="sub">${esc([e.designation, e.uan && 'UAN ' + e.uan, e.esic_no && 'ESIC ' + e.esic_no].filter(Boolean).join(' · '))}</span>` },
          { label: 'Gross / month', num: true, render: e => money(full(e).rate_gross) },
          { label: 'PF', num: true, render: e => e.pf_member === false ? '<span class="muted small">No</span>' : money(full(e).pf_employee) },
          { label: 'ESIC', num: true, render: e => full(e).esic_covered ? money(full(e).esic_employee) : '<span class="muted small">Not covered</span>' },
          { label: 'PT', num: true, render: e => money(full(e).pt) },
          { label: 'Take-home', num: true, render: e => `<b>${money(full(e).net_pay)}</b>` },
          { label: 'Cost to company', num: true, render: e => money(full(e).ctc) },
          { label: 'Project', render: e => esc(projectName(e.project_id)) || '—' },
          { label: '', render: e => canWrite() ? `<button class="btn sm" data-emp="${e.id}">Edit</button>` : '' }], S.employees, { empty: 'No employees yet.' }) +
        '<p class="small muted">Full-month figures at this month’s rules. Take-home is before TDS and other deductions.</p>';
    } else if (tab === 'payroll') {
      const rows = monthRows(), withP = rows.filter(r => r.p);
      const unpaid = rows.filter(r => r.p && !isPaid(r.p) && rowNet(r.p) > 0);
      const tot = f => sum(withP, r => typeof f === 'function' ? f(r.p) : r.p[f]);
      box.innerHTML = String(html`<div class="toolbar">${raw(monthPicker())}<div class="grow"></div>
        ${canWrite() ? html`<button class="btn" data-act="gen">Add all active employees</button><button class="btn" data-act="recalc" title="Use the latest salary structure and rules for unpaid rows">Recalculate</button>
          <button class="btn" data-act="sheet">PF / ESIC sheet</button><button class="btn primary" data-act="pay" ${unpaid.length ? '' : 'disabled'}>Pay ${unpaid.length} selected…</button>` : ''}</div>
        ${raw(table([{ label: '', render: r => r.p && !isPaid(r.p) ? `<input type="checkbox" class="paysel" value="${r.p.id}" checked aria-label="Select ${esc(r.e.name)}">` : '' },
          { label: 'Employee', render: r => `<b>${esc(r.e.name)}</b><span class="sub">${esc(r.e.designation || '')}${r.p ? ' · gross ' + money(r.p.base_salary) : ''}</span>` },
          { label: 'Days present / in month', render: r => r.p ? (isPaid(r.p) ? `${r.p.present_days} / ${r.p.working_days}` : `<span class="row" style="gap:4px;flex-wrap:nowrap">${inp(r.p, 'present_days', 62, '0.5')}<span class="muted">/</span>${inp(r.p, 'working_days', 62, '0.5')}</span>`) : '' },
          { label: 'Earned', num: true, render: r => r.p ? money(r.p.earned_gross) : '' },
          { label: 'Overtime', num: true, render: r => r.p ? inp(r.p, 'overtime') : '' },
          { label: 'Bonus', num: true, render: r => r.p ? inp(r.p, 'bonus') : '' },
          { label: 'PF', num: true, render: r => r.p ? money(r.p.pf_employee, { blankZero: true }) : '' },
          { label: 'ESIC', num: true, render: r => r.p ? money(r.p.esic_employee, { blankZero: true }) : '' },
          { label: 'PT', num: true, render: r => r.p ? inp(r.p, 'pt', 70) : '' },
          { label: 'TDS', num: true, render: r => r.p ? inp(r.p, 'tds') : '' },
          { label: 'Advance / other', num: true, render: r => r.p ? inp(r.p, 'deduction') : '' },
          { label: 'Net pay', num: true, render: r => r.p ? `<b>${money(rowNet(r.p))}</b>` : '<span class="muted">not added</span>' },
          { label: 'Status', render: r => (r.p?.voucher_id ? `<button class="link" data-open="${r.p.voucher_id}">Paid · ${esc(voucher(r.p.voucher_id)?.voucher_no || '')}</button>` : r.p?.paid_on ? `<span class="badge ok">Paid ${esc(fmtDate(r.p.paid_on))}</span>` : r.p ? '<span class="badge warn">Unpaid</span>' : '') + (r.p ? ` <button class="link small" data-slip="${r.p.id}">Payslip</button>` : '') }],
          rows, { empty: 'No employees. Add them in the Employees tab.', foot: ['', 'Total', '', money(tot('earned_gross')), money(tot('overtime')), money(tot('bonus')), money(tot('pf_employee')), money(tot('esic_employee')), money(tot('pt')), money(tot('tds')), money(tot('deduction')), money(tot(rowNet)), ''] }))}
        ${withP.length ? html`<div class="grid g4" style="margin-top:12px">
          <div class="stat"><div class="k">Salary earned</div><div class="v">${money(tot(p => Number(p.earned_gross) + Number(p.overtime) + Number(p.bonus)))}</div><div class="s">Before deductions</div></div>
          <div class="stat"><div class="k">Net pay to employees</div><div class="v">${money(tot(rowNet))}</div><div class="s">Advances of the month are deducted when paying</div></div>
          <div class="stat"><div class="k">Employer PF + ESIC</div><div class="v">${money(tot(p => Number(p.pf_employer) + Number(p.pf_admin) + Number(p.esic_employer)))}</div><div class="s">PF ${money(tot(p => Number(p.pf_employer) + Number(p.pf_admin)))} · ESIC ${money(tot('esic_employer'))}</div></div>
          <div class="stat"><div class="k">Total cost to company</div><div class="v">${money(tot(p => Number(p.earned_gross) + Number(p.overtime) + Number(p.bonus) + Number(p.pf_employer) + Number(p.pf_admin) + Number(p.esic_employer)))}</div><div class="s">Salary + employer contributions</div></div></div>` : ''}
        <p class="small muted">Days present can include paid leave and weekly offs. PF and ESIC work out automatically from the salary structure; PT follows ${esc(PT_STATES.find(x => x[0] === c.pt_state)?.[1] || 'your')} slabs and can be changed by hand. Rules: Company &amp; Users → Payroll rules.</p>`);
    } else if (tab === 'dues') {
      const rows = S.payroll.filter(p => p.month === month), pays = S.statutoryPayments.filter(x => x.month === month && voucher(x.voucher_id));
      const share = { pf: [p => p.pf_employee, p => Number(p.pf_employer) + Number(p.pf_admin)], esic: [p => p.esic_employee, p => p.esic_employer], pt: [p => p.pt, () => 0], tds: [p => p.tds, () => 0] };
      const next = addMonths(month, 1), dueBy = { pf: 'Pay by 15 ' + fmtMonth(next), esic: 'Pay by 15 ' + fmtMonth(next), pt: 'Due date as per your PT registration', tds: 'Pay by 7 ' + fmtMonth(next) };
      const data = KINDS.map(([k, l]) => { const ee = sum(rows, share[k][0]), er = sum(rows, share[k][1]), paid = sum(pays.filter(x => x.kind === k), x => x.amount); return { k, l, ee, er, total: r2(ee + er), paid, left: r2(ee + er - paid) }; }).filter(d => d.total || d.paid);
      box.innerHTML = String(html`<div class="toolbar">${raw(monthPicker())}<div class="grow"></div></div>
        ${raw(table([{ label: 'Due', render: d => `<b>${esc(d.l)}</b><span class="sub">${esc(dueBy[d.k])}</span>` }, { label: 'Employee share', num: true, render: d => money(d.ee) }, { label: 'Employer share', num: true, render: d => money(d.er, { blankZero: true }) },
          { label: 'Total', num: true, render: d => `<b>${money(d.total)}</b>` }, { label: 'Paid', num: true, render: d => money(d.paid, { blankZero: true }) }, { label: 'Balance', num: true, render: d => `<b class="${d.left > 0.004 ? 'neg' : 'pos'}">${money(d.left)}</b>` },
          { label: '', render: d => d.left > 0.004 && canWrite() ? `<button class="btn sm primary" data-stat="${d.k}">Pay</button>` : d.total ? '<span class="badge ok">Paid</span>' : '' }],
          data, { empty: 'No payroll for this month yet — add it in Monthly payroll.' }))}
        ${pays.length ? html`<h4 style="margin-top:1rem">Payments</h4>${raw(table([{ label: 'Paid on', render: x => fmtDate(x.paid_on) }, { label: 'For', render: x => esc(KINDS.find(k => k[0] === x.kind)[1]) }, { label: 'Entry', render: x => `<button class="link" data-open="${x.voucher_id}">${esc(voucher(x.voucher_id)?.voucher_no || '')}</button>` }, { label: 'Amount', num: true, render: x => money(x.amount) }], pays))}` : ''}
        <p class="small muted">PF includes the employer’s EPF + EPS share and EDLI / admin charges. Paying a due records an expense (PF Contribution, ESIC Contribution, Professional Tax or TDS on Salary). Salary payments record only the net pay, so the employee share is booked when you pay these dues.</p>`);
    } else {
      const paidFor = (f, m) => sum(S.fixedCostPayments.filter(x => x.fixed_cost_id === f.id && x.month === m && voucher(x.voucher_id)), x => x.amount);
      const monthsDue = f => { const out = []; let m = f.start_month.slice(0, 7) + '-01'; const end = f.end_month && f.end_month < today() ? f.end_month : today().slice(0, 7) + '-01'; while (m <= end) { out.push(m); m = addMonths(m, 1); } return out; };
      const due = f => sum(monthsDue(f), m => Math.max(0, Number(f.monthly_amount) - paidFor(f, m)));
      box.innerHTML = (canWrite() ? '<div class="row end" style="margin-bottom:.6rem"><button class="btn primary" data-act="addFixed">+ Add fixed cost</button></div>' : '') +
        table([{ label: 'Cost', render: f => `<b>${esc(f.name)}</b>${f.active ? '' : ' <span class="badge">stopped</span>'}<span class="sub">${esc(categoryName(f.category_id))} · from ${fmtMonth(f.start_month)}${f.end_month ? ' to ' + fmtMonth(f.end_month) : ''}</span>` },
          { label: 'Project', render: f => esc(projectName(f.project_id)) || '<span class="muted">General</span>' },
          { label: 'Monthly', num: true, render: f => money(f.monthly_amount) }, { label: 'Accrued to date', num: true, render: f => money(monthsDue(f).length * Number(f.monthly_amount)) },
          { label: 'Paid', num: true, render: f => money(sum(monthsDue(f), m => paidFor(f, m))) }, { label: 'Unpaid', num: true, render: f => { const d = due(f); return `<b class="${d > 0 ? 'neg' : ''}">${money(d)}</b>`; } },
          { label: '', render: f => `${isAdmin() && due(f) > 0.004 ? `<button class="btn sm" data-payfc="${f.id}">Pay</button> ` : ''}<button class="btn sm" data-fc="${f.id}">Edit</button>` }],
          S.fixedCosts, { empty: 'No fixed costs. Add rent, internet, EMIs and similar monthly costs.' });
    }
  };
  // work a payroll row out again and save it
  const recompute = (p, patch, keepPt) => { const row = { ...p, ...patch }; return { ...patch, ...payrollFields(emp(p.employee_id), row, cfg(), { keepPt }) }; };
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; window.history.replaceState(null, '', '#/payroll?tab=' + tab); $$('.tabs button', el).forEach(x => x.classList.toggle('active', x === b)); draw(); }
    if (b.dataset.open) viewVoucher(b.dataset.open);
    if (b.dataset.slip) payslipView(S.payroll.find(p => p.id === b.dataset.slip));
    if (b.dataset.act === 'addEmp' || b.dataset.emp) employeeForm(S.employees.find(x => x.id === b.dataset.emp));
    if (b.dataset.act === 'addFixed' || b.dataset.fc) fixedForm(S.fixedCosts.find(x => x.id === b.dataset.fc));
    if (b.dataset.payfc) payFixed(S.fixedCosts.find(x => x.id === b.dataset.payfc));
    if (b.dataset.stat) payStatutory(b.dataset.stat, month);
    if (b.dataset.act === 'gen') {
      const missing = S.employees.filter(x => x.active && !S.payroll.some(p => p.employee_id === x.id && p.month === month));
      if (!missing.length) return toast('Everyone is already added for this month');
      const dm = daysInMonth(month);
      await attempt(() => S.backend.insert('payroll', missing.map(x => { const row = { company_id: S.companyId, employee_id: x.id, month, working_days: dm, present_days: dm, bonus: 0, deduction: 0, overtime: 0, tds: 0, ...structureOf(x) };
        return { ...row, ...payrollFields(x, row, cfg()) }; })), `${missing.length} added`);
    }
    if (b.dataset.act === 'recalc') {
      const rows = S.payroll.filter(p => p.month === month && !isPaid(p)); if (!rows.length) return toast('No unpaid rows this month');
      await attempt(async () => { for (const p of rows) { const st = structureOf(emp(p.employee_id) || p); await S.backend.update('payroll', { id: p.id }, recompute(p, st, false)); } }, `${rows.length} recalculated`);
    }
    if (b.dataset.act === 'sheet') {
      const c = cfg(), rows = S.payroll.filter(p => p.month === month);
      downloadCSV(`PF ESIC ${month.slice(0, 7)}`, ['Employee', 'UAN', 'ESIC no.', 'Days present', 'Gross earned', 'PF wages', 'EPS wages', 'PF employee 12%', 'EPS employer', 'EPF employer', 'EDLI + admin', 'ESIC wages', 'ESIC employee', 'ESIC employer', 'PT', 'TDS', 'Net pay'],
        rows.map(p => { const e = emp(p.employee_id) || {}, s = payslip(e, p, c, { keepPt: true }); return [e.name, e.uan || '', e.esic_no || '', p.present_days, p.earned_gross, s.pf_wage, Math.min(s.earned.basic, c.pf_ceiling), p.pf_employee, s.eps, r2(p.pf_employer - s.eps), p.pf_admin, s.esic_wage, p.esic_employee, p.esic_employer, p.pt, p.tds, rowNet(p)]; }));
    }
    if (b.dataset.act === 'pay') {
      const ids = $$('.paysel:checked', el).map(x => x.value); if (!ids.length) return toast('Tick who to pay', 'error');
      const total = sum(S.payroll.filter(p => ids.includes(p.id)), rowNet);
      const m = modal('Pay salaries', String(html`<form class="stack"><p>Pay <b>${ids.length}</b> salaries for ${fmtMonth(month)} — total net pay <b>${money(total)}</b>. One expense entry is made per employee under “Salary”. PF, ESIC, PT and TDS are paid from the “PF / ESIC / PT dues” tab.</p>
        <div class="form-grid"><label>Paid on<input type="date" name="d" value="${today()}" required></label><label>Paid from<select name="a" required>${raw(options(accounts().filter(a => a.active).map(a => [a.id, a.name])))}</select></label></div>
        <div class="row end"><button class="btn primary">Pay now</button></div></form>`));
      m.el.querySelector('form').onsubmit = async ev => { ev.preventDefault(); if (await attempt(() => S.backend.rpc('pay_payroll', { p_ids: ids, p_date: ev.target.d.value, p_account: ev.target.a.value }), 'Salaries paid')) m.close(); };
    }
  });
  el.addEventListener('change', async e => {
    if (e.target.id === 'pm') { month = e.target.value + '-01'; localStorage.setItem('gks2.payMonth', month); draw(); }
    if (e.target.dataset.pr) {
      const p = S.payroll.find(x => x.id === e.target.dataset.pr), f = e.target.dataset.f, v = Number(e.target.value || 0);
      if (f === 'present_days' && v > Number(p.working_days)) { toast('Days present cannot be more than the days in the month.', 'error'); e.target.value = p.present_days; return; }
      await attempt(() => S.backend.update('payroll', { id: p.id }, recompute(p, { [f]: v }, f === 'pt' || f === 'tds' || f === 'deduction')));
    }
  });
  draw();
}

function payslipView(p) {
  const e = emp(p.employee_id) || {}, c = cfg(), s = payslip(e, p, c, { keepPt: true });
  const rowsE = [['Basic + DA', s.rates.basic, s.earned.basic], ['HRA', s.rates.hra, s.earned.hra], ['Conveyance', s.rates.conveyance, s.earned.conveyance], ['Other allowances', s.rates.other_allowance, s.earned.other_allowance], ['Overtime', '', p.overtime], ['Bonus', '', p.bonus]].filter(r => Number(r[1]) || Number(r[2]));
  const rowsD = [['Provident Fund (12%)', p.pf_employee], ['ESIC (' + c.esic_employee_rate + '%)', p.esic_employee], ['Professional Tax', p.pt], ['TDS', p.tds], ['Advance / other', p.deduction]].filter(r => Number(r[1]));
  const body = String(html`<div class="payslip"><div class="row between"><div><b>${company().name}</b><div class="small muted">${company().address || ''}</div></div><div class="num"><b>Payslip — ${fmtMonth(p.month)}</b><div class="small muted">${p.paid_on ? 'Paid ' + fmtDate(p.paid_on) : 'Not paid yet'}</div></div></div>
    <table class="kv" style="margin:.75rem 0"><tbody><tr><td>Employee</td><td><b>${e.name}</b></td><td>Designation</td><td>${e.designation || ''}</td></tr>
      <tr><td>UAN</td><td>${e.uan || '—'}</td><td>ESIC no.</td><td>${e.esic_no || '—'}</td></tr><tr><td>PAN</td><td>${e.pan || '—'}</td><td>Days paid</td><td>${p.present_days} of ${p.working_days}</td></tr></tbody></table>
    <div class="grid g2"><table><thead><tr><th>Earnings</th><th class="num">Rate</th><th class="num">Earned</th></tr></thead><tbody>${rowsE.map(r => html`<tr><td>${r[0]}</td><td class="num">${r[1] === '' ? '' : money(r[1])}</td><td class="num">${money(r[2])}</td></tr>`)}</tbody>
        <tfoot><tr><td>Total earnings</td><td class="num">${money(s.rate_gross)}</td><td class="num">${money(r2(Number(p.earned_gross) + Number(p.overtime) + Number(p.bonus)))}</td></tr></tfoot></table>
      <table><thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead><tbody>${rowsD.length ? rowsD.map(r => html`<tr><td>${r[0]}</td><td class="num">${money(r[1])}</td></tr>`) : html`<tr><td colspan="2" class="muted">None</td></tr>`}</tbody>
        <tfoot><tr><td>Total deductions</td><td class="num">${money(sum(rowsD, r => r[1]))}</td></tr></tfoot></table></div>
    <p style="margin-top:.75rem"><b>Net pay: ${money(rowNet(p))}</b><br><span class="small">${amountInWords(rowNet(p))}</span></p>
    <p class="small muted">Employer contributions (not deducted from salary): PF ${money(p.pf_employer)} (EPS ${money(s.eps)}, EPF ${money(r2(p.pf_employer - s.eps))}) · EDLI + admin ${money(p.pf_admin)} · ESIC ${money(p.esic_employer)}. Advances given this month are also deducted when the salary is paid.</p></div>`);
  const m = modal('Payslip — ' + (e.name || ''), body + '<div class="row end" style="margin-top:.75rem"><button class="btn" data-pr>Print</button></div>', { wide: true });
  m.el.querySelector('[data-pr]').onclick = () => printHTML(`Payslip ${e.name} ${fmtMonth(p.month)}`, body);
}

function payStatutory(kind, month) {
  const rows = S.payroll.filter(p => p.month === month), pays = S.statutoryPayments.filter(x => x.month === month && x.kind === kind && voucher(x.voucher_id));
  const due = r2(sum(rows, p => kind === 'pf' ? Number(p.pf_employee) + Number(p.pf_employer) + Number(p.pf_admin) : kind === 'esic' ? Number(p.esic_employee) + Number(p.esic_employer) : Number(p[kind])) - sum(pays, x => x.amount));
  const label = KINDS.find(k => k[0] === kind)[1];
  const m = modal(`Pay ${label} — ${fmtMonth(month)}`, String(html`<form class="stack"><div class="form-grid">
    <label>Amount (due ${money(due)})<input type="number" step="0.01" min="0.01" max="${due}" name="amt" value="${due}" required></label><label>Paid on<input type="date" name="d" value="${today()}" required></label>
    <label>Paid from<select name="a">${raw(options(accounts().filter(a => a.active && a.kind !== 'cash').map(a => [a.id, a.name]).concat(accounts().filter(a => a.active && a.kind === 'cash').map(a => [a.id, a.name]))))}</select></label></div>
    <div class="row end"><button class="btn primary">Pay</button></div></form>`));
  m.el.querySelector('form').onsubmit = async e => { e.preventDefault(); const t = e.target; if (await attempt(() => S.backend.rpc('pay_statutory', { p_company: S.companyId, p_month: month, p_kind: kind, p_date: t.d.value, p_account: t.a.value, p_amount: Number(t.amt.value) }), label + ' paid')) m.close(); };
}

function employeeForm(x) {
  const c = cfg();
  const m = modal(x ? 'Edit employee' : 'Add employee', String(html`<form class="stack"><div class="form-grid">
    <label class="span2">Name<input name="name" required value="${x?.name || ''}"></label><label>Designation<input name="designation" value="${x?.designation || ''}"></label>
    <label>Phone<input name="phone" value="${x?.phone || ''}"></label><label>Gender (for Professional Tax)<select name="gender">${raw(options([['M', 'Male'], ['F', 'Female']], x?.gender || 'M'))}</select></label>
    <label>Joining date<input type="date" name="joining_date" value="${x?.joining_date || today()}"></label>
    <label class="span2">Project (salary cost goes here)<select name="project_id">${raw(options(visibleProjects().map(p => [p.id, p.name]), x?.project_id, { blank: 'General / office' }))}</select></label></div>
    <h4>Monthly salary structure</h4><div class="form-grid">
    <label>Basic + DA<input type="number" step="0.01" min="0" name="basic" required value="${x ? structureOf(x).basic || '' : ''}"></label><label>HRA<input type="number" step="0.01" min="0" name="hra" value="${x?.hra || ''}"></label>
    <label>Conveyance<input type="number" step="0.01" min="0" name="conveyance" value="${x?.conveyance || ''}"></label><label>Other / special allowances<input type="number" step="0.01" min="0" name="other_allowance" value="${x?.other_allowance || ''}"></label></div>
    <h4>PF, ESIC, PT</h4><div class="form-grid">
    <label class="check"><input type="checkbox" name="pf_member" ${x?.pf_member === false ? '' : 'checked'}> PF member</label>
    <label class="check"><input type="checkbox" name="pf_on_ceiling" ${x?.pf_on_ceiling === false ? '' : 'checked'}> PF only on wages up to ${money(c.pf_ceiling)}</label>
    <label>UAN<input name="uan" value="${x?.uan || ''}" inputmode="numeric"></label>
    <label class="check"><input type="checkbox" name="esic_member" ${x?.esic_member === false ? '' : 'checked'}> ESIC (when gross is up to ${money(c.esic_limit)})</label>
    <label>ESIC IP number<input name="esic_no" value="${x?.esic_no || ''}"></label>
    <label class="check"><input type="checkbox" name="pt_applicable" ${x?.pt_applicable === false ? '' : 'checked'}> Professional Tax applies</label>
    <label>PAN<input name="pan" value="${x?.pan || ''}" maxlength="10" style="text-transform:uppercase"></label>
    ${x ? html`<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Currently employed</label>` : ''}</div>
    <div id="empPrev" class="boq-block"></div>
    <div class="row end"><button class="btn primary">Save</button></div></form>`), { wide: true });
  const f = m.el.querySelector('form');
  const preview = () => {
    const d = formData(f); const s = payslip({ ...x, ...d }, { month: today().slice(0, 7) + '-01', working_days: 30, present_days: 30 }, c);
    $('#empPrev', m.el).innerHTML = String(html`<div class="grid g4 boq-stats">
      <div><span class="k">Gross / month</span><b>${money(s.rate_gross)}</b></div>
      <div><span class="k">Employee deductions</span><b>${money(s.pf_employee + s.esic_employee + s.pt)}</b><span class="sub">PF ${money(s.pf_employee)} · ESIC ${money(s.esic_employee)} · PT ${money(s.pt)}</span></div>
      <div><span class="k">Take-home</span><b class="pos">${money(s.net_pay)}</b><span class="sub">before TDS</span></div>
      <div><span class="k">Cost to company</span><b>${money(s.ctc)}</b><span class="sub">employer PF ${money(s.pf_employer + s.pf_admin)} · ESIC ${money(s.esic_employer)}</span></div></div>
      ${!s.esic_covered && d.esic_member && s.rate_gross > c.esic_limit ? html`<p class="small muted">Gross is above ${money(c.esic_limit)}, so ESIC does not apply.</p>` : ''}`);
  };
  f.addEventListener('input', debounce(preview, 150)); f.addEventListener('change', preview); preview();
  f.onsubmit = async e => {
    e.preventDefault(); const d = formData(f);
    for (const k of ['basic', 'hra', 'conveyance', 'other_allowance']) d[k] = d[k] || 0;
    if (!(d.basic > 0)) return toast('Enter Basic + DA.', 'error');
    if (d.pan) d.pan = d.pan.toUpperCase();
    d.monthly_salary = grossOf(d);
    if (await attempt(() => x ? S.backend.update('employees', { id: x.id }, d) : S.backend.insert('employees', { ...d, company_id: S.companyId }), 'Employee saved')) m.close();
  };
}
function fixedForm(f) {
  const m = modal(f ? 'Edit fixed cost' : 'Add fixed cost', String(html`<form class="stack"><div class="form-grid">
    <label class="span2">Name<input name="name" required value="${f?.name || ''}" placeholder="e.g. Factory rent"></label>
    <label>Category<select name="category_id">${raw(options(categories().map(c => [c.id, c.name]), f?.category_id, { blank: '—' }))}</select></label>
    <label>Project (cost goes to)<select name="project_id">${raw(options(visibleProjects().map(p => [p.id, p.name]), f?.project_id, { blank: 'General / office' }))}</select></label>
    <label>Monthly amount<input type="number" step="0.01" min="0.01" name="monthly_amount" required value="${f?.monthly_amount || ''}"></label>
    <label>From month<input type="month" name="start_month" required value="${(f?.start_month || today()).slice(0, 7)}"></label><label>Until month (optional)<input type="month" name="end_month" value="${(f?.end_month || '').slice(0, 7)}"></label>
    <label class="full">Notes<input name="notes" value="${f?.notes || ''}"></label>${f ? html`<label class="check"><input type="checkbox" name="active" ${f.active ? 'checked' : ''}> Active</label>` : ''}</div>
    <div class="row end"><button class="btn primary">Save</button></div></form>`));
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const d = formData(e.target); d.start_month += '-01'; d.end_month = d.end_month ? d.end_month + '-01' : null;
    if (!d.name || !(d.monthly_amount > 0) || !d.start_month) return toast('Enter cost name, monthly amount, and start month.', 'error');
    // stopping a cost keeps what is already due: dues accrue up to the month it was stopped
    if (f && f.active && d.active === false && !d.end_month) d.end_month = today().slice(0, 7) + '-01';
    if (await attempt(() => f ? S.backend.update('fixed_costs', { id: f.id }, d) : S.backend.insert('fixed_costs', { ...d, company_id: S.companyId }), 'Saved')) m.close();
  };
}
function dueOf(f) {
  const paidFor = m => sum(S.fixedCostPayments.filter(x => x.fixed_cost_id === f.id && x.month === m && voucher(x.voucher_id)), x => x.amount);
  let due = 0; for (let m = f.start_month.slice(0, 7) + '-01'; m <= today().slice(0, 7) + '-01' && (!f.end_month || m <= f.end_month); m = addMonths(m, 1)) due += Math.max(0, Number(f.monthly_amount) - paidFor(m));
  return r2(due);
}
function payFixed(f) {
  const m = modal('Pay ' + f.name, String(html`<form class="stack"><p class="small muted">The payment is applied to the oldest unpaid months first.</p><div class="form-grid">
    <label>Amount (due ${money(dueOf(f))})<input type="number" step="0.01" min="0.01" max="${dueOf(f)}" name="amt" value="${dueOf(f)}" required></label><label>Paid on<input type="date" name="d" value="${today()}" required></label>
    <label>Paid from<select name="a">${raw(options(accounts().filter(a => a.active).map(a => [a.id, a.name])))}</select></label></div><div class="row end"><button class="btn primary">Pay</button></div></form>`));
  m.el.querySelector('form').onsubmit = async e => { e.preventDefault(); const t = e.target; if (await attempt(() => S.backend.rpc('pay_fixed_cost', { p_fixed_cost: f.id, p_date: t.d.value, p_account: t.a.value, p_amount: Number(t.amt.value) }), 'Payment saved')) m.close(); };
}

// ───────────────────────── Change history ─────────────────────────
export async function history(el, { token }) {
  el.innerHTML = '<div class="page-head"><div><h2>Change History</h2><p>Every entry created, changed or deleted — and who did it. Admins only.</p></div></div><div class="card" id="hb"><p class="muted">Loading…</p></div>';
  let rows;
  try { rows = await S.backend.audit(S.companyId); } catch (err) { $('#hb', el).innerHTML = `<p class="neg">${esc(errorText(err))}</p>`; return; }
  if (!token()) return;
  const label = { vouchers: 'Entry', voucher_lines: 'Entry line', allocations: 'Bill link', parties: 'Party', items: 'Item', categories: 'Category', company_members: 'User access', employees: 'Employee', payroll: 'Payroll', fixed_costs: 'Fixed cost', companies: 'Company' };
  const describe = a => {
    const d = a.new_data || a.old_data || {};
    if (a.table_name === 'vouchers') {
      const del = a.action === 'update' && a.new_data?.deleted_at && !a.old_data?.deleted_at;
      const changes = a.action === 'update' && !del ? Object.keys(a.new_data).filter(k => !['updated_at', 'updated_by'].includes(k) && JSON.stringify(a.new_data[k]) !== JSON.stringify(a.old_data[k])) : [];
      return `${del ? '<span class="badge bad">deleted</span> ' : ''}<b>${esc(d.voucher_no)}</b> ${esc(TYPES[d.voucher_type]?.label || '')} · ${money(d.total_amount)}${changes.length ? `<span class="sub">Changed: ${esc(changes.join(', '))}${changes.includes('total_amount') ? ` (was ${money(a.old_data.total_amount)})` : ''}</span>` : ''}`;
    }
    if (a.table_name === 'allocations') return `${money(d.amount)} between ${esc(voucher(d.from_voucher_id)?.voucher_no || 'payment')} and ${esc(voucher(d.to_voucher_id)?.voucher_no || 'bill')}`;
    return esc(d.name || d.email || d.role || d.description || '');
  };
  const all = rows.filter(a => a.table_name !== 'voucher_lines');
  const users = [...new Set(all.map(a => a.user_id).filter(Boolean))];
  $('#hb', el).innerHTML = `<div class="toolbar"><label>User<select id="hu">${options(users.map(u => [u, userEmail(u)]), '', { blank: 'All users' })}</select></label>
    <label>What<select id="ht">${options(Object.entries(label), '', { blank: 'Everything' })}</select></label><label class="grow">Search<input id="hq" placeholder="Entry number, party, amount…"></label></div><div id="hl"></div>`;
  const f = { u: '', t: '', q: '' };
  const draw = () => {
    const shown = all.filter(a => (!f.u || a.user_id === f.u) && (!f.t || a.table_name === f.t) && (!f.q || JSON.stringify([a.new_data, a.old_data]).toLowerCase().includes(f.q)));
    $('#hl', el).innerHTML = table([{ label: 'When', render: a => esc(new Date(a.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })) },
      { label: 'Who', render: a => esc(userEmail(a.user_id)) }, { label: 'What', render: a => `${esc(label[a.table_name] || a.table_name)} <span class="badge ${a.action === 'delete' ? 'bad' : a.action === 'insert' ? 'ok' : 'info'}">${a.action === 'insert' ? 'added' : a.action === 'update' ? 'changed' : 'removed'}</span>` },
      { label: 'Details', render: describe }], shown, { empty: 'No changes match.', rowAttr: a => a.table_name === 'vouchers' && voucher(a.row_id) ? `class="click" data-v="${a.row_id}"` : '' }) + `<p class="small muted">Showing ${shown.length} of the latest ${all.length} changes.</p>`;
  };
  $('#hu', el).onchange = e => { f.u = e.target.value; draw(); };
  $('#ht', el).onchange = e => { f.t = e.target.value; draw(); };
  $('#hq', el).oninput = e => { f.q = e.target.value.trim().toLowerCase(); draw(); };
  el.addEventListener('click', e => { const tr = e.target.closest('[data-v]'); if (tr) viewVoucher(tr.dataset.v); });
  draw();
}

// ───────────────────────── Company & users ─────────────────────────
const SECTIONS = [['dashboard', 'Dashboard'], ['entries', 'Day Book'], ['outstanding', 'Outstanding'], ['banking', 'Cash & Bank'], ['ledgers', 'Ledgers'], ['projects', 'Projects'], ['inventory', 'Inventory'], ['parties', 'Parties'], ['payroll', 'Payroll'], ['reports', 'P&L / Cash flow'], ['gst', 'GST & TDS']];
export function settings(el) {
  const c = company(), admin = isAdmin();
  const roleHelp = { admin: 'Everything, including users and settings', partner: 'Enter and edit all entries', accountant: 'Enter and edit all entries', storekeeper: 'Inventory, delivery challans and stock adjustments', viewer: 'View only' };
  el.innerHTML = String(html`<div class="page-head"><div><h2>Company &amp; Users</h2><p>${admin ? 'Settings for ' + c.name + '.' : 'Your role does not allow company or user management. Ask a company admin if access needs to change.'}</p></div>
    ${admin ? html`<div class="row"><span class="small muted">${S.companies.length} compan${S.companies.length === 1 ? 'y' : 'ies'} you can open</span><button class="btn primary" id="addCo">+ Add company</button></div>` : ''}</div>
    <form id="coForm" class="card stack"><h3>Company details</h3><div class="form-grid">
      <label class="span2">Name<input name="name" required value="${c.name}" ${admin ? '' : 'disabled'}></label><label>GSTIN<input name="gstin" value="${c.gstin || ''}" ${admin ? '' : 'disabled'}></label>
      <label>State code<input name="state_code" maxlength="2" value="${c.state_code || ''}" ${admin ? '' : 'disabled'}></label><label>Phone<input name="phone" value="${c.phone || ''}" ${admin ? '' : 'disabled'}></label>
      <label>Email<input name="email" value="${c.email || ''}" ${admin ? '' : 'disabled'}></label><label class="full">Address (printed on invoices)<textarea name="address" rows="2" ${admin ? '' : 'disabled'}>${c.address || ''}</textarea></label>
      <label class="span2">Bank details for invoices<textarea name="bank_details" rows="3" ${admin ? '' : 'disabled'}>${c.bank_details || ''}</textarea></label>
      <label class="span2">Invoice terms<textarea name="invoice_terms" rows="3" ${admin ? '' : 'disabled'}>${c.invoice_terms || ''}</textarea></label>
      <label>Books locked up to<input type="date" name="lock_date" value="${c.lock_date || ''}" ${admin ? '' : 'disabled'}></label>
      <label>Opening GST credit this FY<input type="number" step="0.01" name="opening_gst_credit" value="${c.opening_gst_credit || 0}" ${admin ? '' : 'disabled'}></label>
      <label class="check"><input type="checkbox" name="allow_negative_stock" ${c.allow_negative_stock ? 'checked' : ''} ${admin ? '' : 'disabled'}> Allow stock to go below zero</label></div>
      <p class="small muted">Locking the books stops everyone except admins from adding or changing entries on or before that date — useful after filing returns.</p>
      ${admin ? raw('<div class="row end"><button class="btn primary">Save company</button></div>') : ''}</form>
    ${admin ? html`<div class="card"><h3>Users</h3>
      ${raw(table([{ label: 'User', render: m => `<b>${esc(userEmail(m.user_id))}</b>${m.user_id === S.user.id ? ' <span class="badge">you</span>' : ''}` },
        { label: 'Role', render: m => m.user_id === S.user.id ? esc(m.role) : `<select data-role="${m.user_id}" style="width:auto">${options(Object.keys(roleHelp).map(r => [r, r[0].toUpperCase() + r.slice(1)]), m.role)}</select>` },
        { label: 'Projects', render: m => m.role === 'admin' ? 'All' : `<label class="check"><input type="checkbox" data-restrict="${m.user_id}" ${m.project_restricted ? 'checked' : ''}> Only chosen</label>${m.project_restricted ? `<button class="link small" data-projs="${m.user_id}">${S.memberProjects.filter(x => x.user_id === m.user_id).length} chosen — change</button>` : ''}` },
        { label: 'Hidden screens', render: m => m.role === 'admin' ? '' : `<button class="link small" data-hide="${m.user_id}">${(m.hidden_sections || []).length || 'None'} — change</button>` },
        { label: '', render: m => `${S.backend.mode === 'live' ? `<button class="btn sm" data-reset="${m.user_id}">Send password link</button> ` : ''}${m.user_id === S.user.id ? '' : `<button class="btn sm danger" data-remove="${m.user_id}">Remove</button>`}` }], S.members))}
      ${S.invitations.length ? html`<h4 style="margin-top:1rem">Waiting to sign up</h4>${raw(table([{ label: 'Email', key: 'email' }, { label: 'Role', key: 'role' }, { label: '', render: i => `<button class="btn sm" data-uninvite="${i.id}">Cancel</button>` }], S.invitations))}` : ''}
      <form id="invite" class="toolbar" style="margin-top:1rem"><label class="grow">Add user by email<input name="email" type="email" required placeholder="name@company.com"></label>
        <label>Role<select name="role">${raw(options(Object.keys(roleHelp).filter(r => r !== 'admin').concat('admin').map(r => [r, r[0].toUpperCase() + r.slice(1)]), 'accountant'))}</select></label><button class="btn primary">Add</button></form>
      <p class="small muted">${Object.entries(roleHelp).map(([r, h]) => `<b>${r}</b>: ${h}`).join(' · ')}. People who don't have an account yet get access automatically when they sign up with this email.</p></div>
    <div class="card"><h3>Company access by user</h3><p class="small muted">Which group companies each person can open, and their role in each. You can change companies where you are an admin.</p><div id="matrix"><p class="muted">Loading…</p></div></div>
    <div class="card"><h3>Admin PIN</h3><p class="small muted">A 6-digit PIN asked before deleting or moving entries, changing users, merging parties or locking the books. Stays unlocked for 10 minutes after entry.</p>
      <form id="pinForm" class="toolbar"><label>Current PIN (if set)<input name="old" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label><label>New PIN<input name="new" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="off"></label><button class="btn">Set PIN</button></form></div>
    <form id="prForm" class="card stack"><h3>Payroll rules</h3><p class="small muted">Used to work out PF, ESIC and Professional Tax. Defaults follow the rules notified as of Oct 2026 (EPF wage ceiling ₹25,000 from 17 Sep 2026; ESIC up to ₹21,000 gross). Change them here if the government revises them.</p>
      <div class="form-grid">${(() => { const pc = settingsOf(c); const f = (k, l, step = '0.01') => html`<label>${l}<input type="number" step="${step}" min="0" name="${k}" value="${pc[k]}" required></label>`;
        return html`${f('pf_ceiling', 'PF wage ceiling (₹/month)', '1')}${f('pf_employee_rate', 'PF employee %')}${f('pf_employer_rate', 'PF employer % (EPF + EPS)')}${f('eps_rate', 'EPS (pension) %')}
        ${f('edli_rate', 'EDLI %')}${f('pf_admin_rate', 'PF admin charges %')}${f('esic_limit', 'ESIC gross limit (₹/month)', '1')}${f('esic_employee_rate', 'ESIC employee %')}
        ${f('esic_employer_rate', 'ESIC employer %')}${f('esic_exempt_daily', 'No ESIC employee share up to daily wage (₹)', '1')}
        <label>Professional Tax<select name="pt_state">${raw(options(PT_STATES, pc.pt_state))}</select></label>`; })()}</div>
      <div class="row between"><button class="btn ghost" type="button" id="prReset">Use defaults</button><button class="btn primary">Save payroll rules</button></div></form>
    <div class="card"><h3>Expense categories</h3><div class="row" id="cats">${categories().map(x => html`<span class="badge ${x.active ? '' : 'warn'}">${x.name} <button class="link small" data-cat="${x.id}" title="${x.active ? 'Hide' : 'Show'}">${x.active ? '✕' : '↺'}</button></span>`)}</div>
      <form id="catForm" class="toolbar" style="margin-top:.75rem"><label class="grow">New category<input name="name" required></label><label>Kind<select name="kind">${raw(options([['expense', 'Expense'], ['income', 'Other income'], ['capital', 'Capital'], ['other', 'Other']], 'expense'))}</select></label><button class="btn">Add</button></form></div>
` : ''}
    <div class="card"><h3>Your account</h3><div class="row"><span>${S.user.email}</span><span class="badge">${myMembership()?.role}</span><div class="grow"></div>
      ${S.backend.mode === 'live' ? raw('<button class="btn" id="pwBtn">Change password</button>') : raw('<button class="btn danger" id="resetDemo">Reset demo data</button>')}</div></div>`);

  $('#coForm', el).onsubmit = async e => {
    e.preventDefault(); if (!admin) return; const d = formData(e.target); d.opening_gst_credit = d.opening_gst_credit || 0;
    if ((d.lock_date || null) !== (c.lock_date || null) && !await requireAdminPin('change the lock date')) return;
    await attempt(() => S.backend.update('companies', { id: c.id }, d), 'Company saved').then(ok => ok && (S.companies.find(x => x.id === c.id) && Object.assign(S.companies.find(x => x.id === c.id), d)));
    $('#companySelect').querySelector(`option[value="${c.id}"]`).textContent = d.name;
  };
  $('#prForm', el)?.addEventListener('submit', async e => {
    e.preventDefault(); const d = formData(e.target);
    const ok = await attempt(() => S.backend.update('companies', { id: c.id }, { payroll_settings: d }), 'Payroll rules saved');
    if (ok) { const co = S.companies.find(x => x.id === c.id); if (co) co.payroll_settings = d; }
  });
  $('#prReset', el)?.addEventListener('click', async () => {
    if (!await confirmBox('Go back to the default payroll rules?', { ok: 'Use defaults' })) return;
    if (await attempt(() => S.backend.update('companies', { id: c.id }, { payroll_settings: {} }), 'Defaults restored')) { const co = S.companies.find(x => x.id === c.id); if (co) co.payroll_settings = {}; }
  });
  $('#invite', el)?.addEventListener('submit', async e => {
    e.preventDefault(); const d = formData(e.target);
    try { const r = await S.backend.rpc('invite_member', { p_company: c.id, p_email: d.email, p_role: d.role }); await reload(); toast(r === 'added' ? 'User added' : 'Invitation saved — they get access when they sign up'); } catch (err) { toast(errorText(err), 'error'); }
  });
  $('#catForm', el)?.addEventListener('submit', async e => { e.preventDefault(); const d = formData(e.target); await attempt(() => S.backend.insert('categories', { ...d, company_id: c.id }), 'Category added'); });
  $('#addCo', el)?.addEventListener('click', () => addCompanyForm());
  $('#resetDemo', el)?.addEventListener('click', async () => { if (await confirmBox('Wipe the demo data and start again with fresh sample data?', { ok: 'Reset', danger: true })) { S.backend.reset(); location.reload(); } });
  $('#pwBtn', el)?.addEventListener('click', () => {
    const m = modal('Change password', '<form class="stack"><label>New password<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn primary">Save</button></form>');
    m.el.querySelector('form').onsubmit = async e => { e.preventDefault(); try { await S.backend.updatePassword(e.target.pw.value); toast('Password changed'); m.close(); } catch (err) { toast(errorText(err), 'error'); } };
  });
  $('#pinForm', el)?.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await S.backend.rpc('set_admin_pin', { p_company: c.id, p_old: f.old.value || null, p_new: f.new.value }); f.reset(); toast('Admin PIN saved'); } catch (err) { toast(errorText(err), 'error'); }
  });
  if (admin) accessMatrix();
  async function accessMatrix() {
    const box = $('#matrix', el); const gc = groupCompanies();
    const adminOf = new Set(S.memberships.filter(m => m.role === 'admin').map(m => m.company_id));
    let mem;
    try { mem = await S.backend.list('company_members', { company_id: gc.map(x => x.id) }); } catch (err) { box.innerHTML = `<p class="neg">${esc(errorText(err))}</p>`; return; }
    const uids = [...new Set(mem.map(m => m.user_id))];
    let profs = []; try { profs = await S.backend.list('profiles', { id: uids }); } catch { }
    const email = u => profs.find(p => p.id === u)?.email || userEmail(u);
    const roles = ['admin', 'partner', 'accountant', 'storekeeper', 'viewer'];
    box.innerHTML = table([{ label: 'User', render: u => `<b>${esc(email(u))}</b>` }, ...gc.map(co => ({ label: co.name, render: u => {
      const m = mem.find(x => x.user_id === u && x.company_id === co.id);
      if (!adminOf.has(co.id) || u === S.user.id) return esc(m?.role || '—');
      return `<select data-mx="${u}|${co.id}" style="width:auto">${options([['', 'No access'], ...roles.map(r => [r, r[0].toUpperCase() + r.slice(1)])], m?.role || '')}</select>`;
    } }))], uids, { empty: 'No users.' });
    box.onchange = async e => {
      const [u, co] = (e.target.dataset.mx || '').split('|'); if (!u) return;
      if (!await requireAdminPin('change company access')) { accessMatrix(); return; }
      const exists = mem.some(x => x.user_id === u && x.company_id === co), r = e.target.value;
      await attempt(() => !r ? S.backend.remove('company_members', { company_id: co, user_id: u })
        : exists ? S.backend.update('company_members', { company_id: co, user_id: u }, { role: r })
          : S.backend.insert('company_members', { company_id: co, user_id: u, role: r }), 'Access updated');
    };
  }
  el.addEventListener('change', async e => {
    const t = e.target;
    if ((t.dataset.role || t.dataset.restrict) && !await requireAdminPin('change user access')) { await reload(); return; }
    if (t.dataset.role) await attempt(() => S.backend.update('company_members', { company_id: c.id, user_id: t.dataset.role }, { role: t.value }), 'Role changed');
    if (t.dataset.restrict) await attempt(() => S.backend.update('company_members', { company_id: c.id, user_id: t.dataset.restrict }, { project_restricted: t.checked }), 'Saved');
  });
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.reset) { const email = userEmail(b.dataset.reset); try { await S.backend.resetPassword(email); toast('Password link sent to ' + email); } catch (err) { toast(errorText(err), 'error'); } }
    if (b.dataset.remove && await requireAdminPin('remove a user') && await confirmBox(`Remove ${userEmail(b.dataset.remove)} from ${c.name}?`, { ok: 'Remove', danger: true })) await attempt(() => S.backend.remove('company_members', { company_id: c.id, user_id: b.dataset.remove }), 'User removed');
    if (b.dataset.uninvite) await attempt(() => S.backend.remove('invitations', { id: b.dataset.uninvite }), 'Invitation cancelled');
    if (b.dataset.cat) { const cat = S.categories.find(x => x.id === b.dataset.cat); await attempt(() => S.backend.update('categories', { id: cat.id }, { active: !cat.active })); }
    if (b.dataset.projs) pickProjects(b.dataset.projs);
    if (b.dataset.hide) pickHidden(b.dataset.hide);
  });
  function pickProjects(uid) {
    const chosen = new Set(S.memberProjects.filter(x => x.user_id === uid).map(x => x.project_id));
    const m = modal('Projects for ' + userEmail(uid), `<form class="stack">${S.projects.map(p => `<label class="check"><input type="checkbox" name="p" value="${p.id}" ${chosen.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<p class="muted">No projects yet.</p>'}<div class="row end"><button class="btn primary">Save</button></div></form>`);
    m.el.querySelector('form').onsubmit = async ev => {
      ev.preventDefault(); const want = new Set($$('[name=p]:checked', ev.target).map(x => x.value));
      const ok = await attempt(async () => {
        for (const p of chosen) if (!want.has(p)) await S.backend.remove('member_projects', { company_id: c.id, user_id: uid, project_id: p });
        const add = [...want].filter(p => !chosen.has(p)).map(p => ({ company_id: c.id, user_id: uid, project_id: p }));
        if (add.length) await S.backend.insert('member_projects', add);
      }, 'Project access saved');
      if (ok) m.close();
    };
  }
  function pickHidden(uid) {
    const mem = S.members.find(x => x.user_id === uid), hidden = new Set(mem.hidden_sections || []);
    const m = modal('Hide screens for ' + userEmail(uid), `<form class="stack"><p class="small muted">Hidden screens are removed from their menu. Their role still decides what they can change.</p>${SECTIONS.map(([k, l]) => `<label class="check"><input type="checkbox" name="s" value="${k}" ${hidden.has(k) ? 'checked' : ''}> ${l}</label>`).join('')}<div class="row end"><button class="btn primary">Save</button></div></form>`);
    m.el.querySelector('form').onsubmit = async ev => { ev.preventDefault(); const list = $$('[name=s]:checked', ev.target).map(x => x.value); if (await attempt(() => S.backend.update('company_members', { company_id: c.id, user_id: uid }, { hidden_sections: list }), 'Saved')) m.close(); };
  }
}
