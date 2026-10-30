// Dashboard, day book, outstanding & advances, ledgers, P&L / cash flow, GST & TDS.
import { S, company, cv, inFY, fyBounds, pending, unalloc, allocsTo, allocsFrom, companyName, partyName, projectName, accountName, categoryName, voucherStatus, parties, accounts,
  accountBalance, partyBalance, stockOf, avgRate, items, categories, visibleProjects, voucher, canWrite, accountOpening } from '../store.js';
import { TYPES, money, qtyFmt, r2, sum, plEffect, gstEffect, tdsEffect, accountEffects, partyEffect, stockEffect, SALES_BILLS, PURCHASE_BILLS, isBill } from '../calc.js';
import { $, $$, esc, html, raw, options, modal, fmtDate, fmtMonth, today, table, downloadCSV, printHTML, debounce } from '../ui.js';
import { viewVoucher } from './entry.js';
import { go } from '../app.js';

const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const cls = n => n < 0 ? 'neg' : n > 0 ? 'pos' : '';
function openRows(root) { root.addEventListener('click', e => { const tr = e.target.closest('[data-v]'); if (tr && !e.target.closest('button,a,input')) viewVoucher(tr.dataset.v); }); }

// ───────────────────────── Dashboard ─────────────────────────
export function dashboard(el) {
  const vs = cv(), fyv = vs.filter(inFY);
  const pl = fyv.reduce((a, v) => { const e = plEffect(v); a.sales += e.sales || 0; a.purchases += e.purchases || 0; a.expenses += e.expenses || 0; return a; }, { sales: 0, purchases: 0, expenses: 0 });
  const profit = r2(pl.sales - pl.purchases - pl.expenses);
  const bills = vs.filter(isBill);
  const recv = sum(bills.filter(b => SALES_BILLS.includes(b.voucher_type)), pending), pay = sum(bills.filter(b => PURCHASE_BILLS.includes(b.voucher_type)), pending);
  const custAdv = sum(vs.filter(v => ['receipt', 'customer_credit'].includes(v.voucher_type)), unalloc), suppAdv = sum(vs.filter(v => ['payment', 'supplier_credit'].includes(v.voucher_type)), unalloc);
  const accts = accounts(), cash = sum(accts, a => accountBalance(a.id));
  const stockVal = sum(items(), i => Math.max(0, stockOf(i.id)) * avgRate(i.id));
  const gst = fyv.reduce((a, v) => { const g = gstEffect(v); a.o += g.output || 0; a.i += g.input || 0; return a; }, { o: 0, i: 0 });
  const tdsPay = sum(fyv, v => tdsEffect(v).payable || 0);
  const capital = r2(sum(fyv.filter(v => v.voucher_type === 'capital_in'), v => v.total_amount) - sum(fyv.filter(v => v.voucher_type === 'capital_out'), v => v.total_amount));
  const stat = (k, v, s, link, tone = '') => html`<button class="stat" ${link ? raw(`data-go="${link}"`) : ''}><div class="k">${k}</div><div class="v ${tone}">${money(v)}</div><div class="s">${s}</div></button>`;
  // monthly sales vs purchases+expenses
  const { from } = fyBounds(); const months = [...Array(12)].map((_, i) => { const d = new Date(from + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + i); return d.toISOString().slice(0, 7); });
  const mData = months.map(m => { const mv = fyv.filter(v => v.voucher_date.startsWith(m)); const e = mv.map(plEffect); return { m, s: sum(e, x => x.sales || 0), c: sum(e, x => (x.purchases || 0) + (x.expenses || 0)) }; });
  const overdue = bills.filter(b => SALES_BILLS.includes(b.voucher_type) && pending(b) > 0.004).sort((a, b) => a.voucher_date.localeCompare(b.voucher_date)).slice(0, 6);
  const recent = [...vs].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 8);
  // balance sheet snapshot (today)
  const cashOnly = sum(accts.filter(a => a.kind === 'cash'), a => accountBalance(a.id)), bankOnly = sum(accts.filter(a => a.kind === 'bank'), a => accountBalance(a.id)), upiOnly = sum(accts.filter(a => a.kind === 'upi'), a => accountBalance(a.id));
  const ic = intercoBalances(), dueFrom = sum(ic.filter(x => x.net > 0), x => x.net), dueTo = sum(ic.filter(x => x.net < 0), x => -x.net);
  const gstNet = r2(gst.o - gst.i - Number(company().opening_gst_credit || 0));
  const assets = [['Cash in hand', cashOnly, 'banking'], ['Cash in bank', bankOnly, 'banking'], ['UPI / wallets', upiOnly, 'banking'], ['Receivable from customers', recv, 'outstanding?tab=receivable'],
    ['Advances paid to suppliers', suppAdv, 'outstanding?tab=advances'], ['Inventory', stockVal, 'inventory'], ['Due from group companies', dueFrom, 'banking'], ['GST input credit carried', gstNet < 0 ? -gstNet : 0, 'gst']].filter(r => r[1]);
  const liabilities = [['Payable to suppliers', pay, 'outstanding?tab=payable'], ['Advances from customers', custAdv, 'outstanding?tab=advances'], ['Due to group companies', dueTo, 'banking'], ['GST payable', gstNet > 0 ? gstNet : 0, 'gst']].filter(r => r[1]);
  const aTot = sum(assets, r => r[1]), lTot = sum(liabilities, r => r[1]);
  // month-wise money linked to bills, and what was still due at each month end
  const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
  const dueAt = (types, d) => sum(vs.filter(b => types.includes(b.voucher_type) && !b.account_id && b.voucher_date <= d), b => Math.max(0, Number(b.net_amount) - sum(allocsTo(b.id).filter(a => (voucher(a.from_voucher_id)?.voucher_date || '') <= d), a => a.amount)));
  const linkedIn = (m, kinds) => sum(vs.filter(v => kinds.includes(v.voucher_type) && v.voucher_date.startsWith(m)), v => sum(allocsFrom(v.id), a => a.amount));
  const firstActive = months.find(m => fyv.some(v => v.voucher_date.startsWith(m))) || today().slice(0, 7);
  const shownMonths = months.filter(m => m >= firstActive && m <= today().slice(0, 7));
  const flowRows = shownMonths.map(m => ({ m, billedS: sum(fyv.filter(v => SALES_BILLS.includes(v.voucher_type) && v.voucher_date.startsWith(m)), v => v.net_amount), recd: linkedIn(m, ['receipt']), dueR: dueAt(SALES_BILLS, monthEnd(m)),
    billedP: sum(fyv.filter(v => PURCHASE_BILLS.includes(v.voucher_type) && v.party_id && !v.account_id && v.voucher_date.startsWith(m)), v => v.net_amount), paid: linkedIn(m, ['payment']), dueP: dueAt(PURCHASE_BILLS, monthEnd(m)) }));
  el.innerHTML = String(html`
    <div class="page-head"><div><h2>${company().name}</h2><p>FY 20${S.fy} · as of ${fmtDate(today())}</p></div></div>
    <div class="grid g4">
      ${stat('Profit / loss (FY)', profit, `Sales ${money(pl.sales)} − costs ${money(pl.purchases + pl.expenses)}`, 'reports', cls(profit))}
      ${stat('Cash & bank', cash, `${accts.length} account${accts.length === 1 ? '' : 's'}`, 'banking')}
      ${stat('To receive', recv, 'Pending customer bills', 'outstanding?tab=receivable')}
      ${stat('To pay', pay, 'Pending supplier bills', 'outstanding?tab=payable')}
      ${stat('Customer advances', custAdv, 'Received, not yet billed', 'outstanding?tab=advances')}
      ${stat('Supplier advances', suppAdv, 'Paid, not yet billed', 'outstanding?tab=advances')}
      ${stat('Inventory value', stockVal, 'At average purchase rate', 'inventory')}
      ${stat('GST payable (FY)', r2(gst.o - gst.i - Number(company().opening_gst_credit || 0)), `Output ${money(gst.o)} · input ${money(gst.i)}`, 'gst')}
    </div>
    <div class="grid g2">
      <div class="card"><h3>Sales vs costs by month</h3>${raw(barChart(mData))}</div>
      <div class="card"><h3>Balance sheet snapshot <span class="muted small">today</span></h3><div class="grid g2 bs">
        <div><h4>Assets</h4><table><tbody>${assets.map(r => html`<tr class="click" data-go="${r[2]}"><td>${r[0]}</td><td class="num">${money(r[1])}</td></tr>`)}</tbody><tfoot><tr><td>Total assets</td><td class="num">${money(aTot)}</td></tr></tfoot></table></div>
        <div><h4>Liabilities</h4><table><tbody>${liabilities.map(r => html`<tr class="click" data-go="${r[2]}"><td>${r[0]}</td><td class="num">${money(r[1])}</td></tr>`)}</tbody><tfoot><tr><td>Total liabilities</td><td class="num">${money(lTot)}</td></tr></tfoot></table></div></div>
        <p class="small">Net worth (assets − liabilities): <b class="${aTot - lTot < 0 ? 'neg' : 'pos'}">${money(aTot - lTot)}</b> · capital introduced − withdrawn this FY: ${money(capital)}</p></div>
    </div>
    <div class="card"><h3>Month by month: billed, collected and still due</h3>
      ${raw(table([{ label: 'Month', render: r => fmtMonth(r.m) }, { label: 'Sales billed', num: true, render: r => money(r.billedS, { blankZero: true }) }, { label: 'Received against bills', num: true, render: r => money(r.recd, { blankZero: true }) },
        { label: 'To receive (month end)', num: true, render: r => `<b>${money(r.dueR)}</b>` }, { label: 'Purchases billed', num: true, render: r => money(r.billedP, { blankZero: true }) }, { label: 'Paid against bills', num: true, render: r => money(r.paid, { blankZero: true }) },
        { label: 'To pay (month end)', num: true, render: r => `<b>${money(r.dueP)}</b>` }], flowRows, { empty: 'No months yet in this year.' }))}
      <p class="small muted">Only payments linked to bills are counted. Unlinked advances and transfers between companies are left out. Dues carry forward month to month.</p></div>
    ${ic.length ? html`<div class="card"><h3>Balances with group companies</h3>${raw(table([{ label: 'Company', render: x => esc(companyName(x.company)) }, { label: 'Sent to them', num: true, render: x => money(x.out) }, { label: 'Received from them', num: true, render: x => money(x.in) },
      { label: 'Balance', num: true, render: x => `<b>${x.net >= 0 ? 'They owe ' + money(x.net) : 'We owe ' + money(-x.net)}</b>` }], ic))}</div>` : ''}
    <div class="grid g3">
      <div class="card"><h3>Oldest customer dues <button class="link small" data-go="outstanding?tab=receivable">See all</button></h3>
        ${raw(table([{ label: 'Bill', render: b => `<b>${esc(b.voucher_no)}</b><span class="sub">${esc(partyName(b.party_id))}</span>` }, { label: 'Age', render: b => daysBetween(b.voucher_date, today()) + ' days' }, { label: 'Pending', num: true, render: b => money(pending(b)) }],
          overdue, { empty: 'No pending customer bills.', rowAttr: b => `class="click" data-v="${b.id}"` }))}</div>
      <div class="card"><h3>Recently added</h3>${raw(table([{ label: 'Entry', render: v => `<b>${esc(v.voucher_no)}</b><span class="sub">${esc(TYPES[v.voucher_type].label)}</span>` }, { label: 'Party', render: v => esc(partyName(v.party_id) || accountName(v.account_id)) }, { label: 'Amount', num: true, render: v => money(v.total_amount) }],
        recent, { empty: 'No entries yet. Use “New entry” to add your first bill or payment.', rowAttr: v => `class="click" data-v="${v.id}"` }))}</div>
      <div class="card"><h3>Other balances</h3><table><tbody>
        <tr><td>Capital introduced − withdrawn (FY)</td><td class="num">${money(capital)}</td></tr>
        <tr><td>TDS deducted, to deposit (FY)</td><td class="num">${money(tdsPay)}</td></tr>
        ${accts.map(a => html`<tr><td>${a.name}</td><td class="num">${money(accountBalance(a.id))}</td></tr>`)}
      </tbody></table></div>
    </div>`);
  openRows(el);
  $$('[data-go]', el).forEach(b => b.onclick = () => go(b.dataset.go));
}
// Money sent to / received from each other group company (inter-company transfers)
function intercoBalances() {
  const map = new Map();
  for (const v of cv().filter(x => ['interco_out', 'interco_in'].includes(x.voucher_type))) {
    const other = S.vouchers.find(x => x.transfer_group_id === v.transfer_group_id && x.id !== v.id)?.company_id || 'unknown';
    const r = map.get(other) || { company: other, out: 0, in: 0 };
    if (v.voucher_type === 'interco_out') r.out += Number(v.total_amount); else r.in += Number(v.total_amount);
    map.set(other, r);
  }
  return [...map.values()].map(r => ({ ...r, net: r2(r.out - r.in) }));
}
function barChart(data) {
  const max = Math.max(1, ...data.flatMap(d => [d.s, d.c])), W = 560, H = 180, bw = W / data.length;
  const y = v => H - 20 - (v / max) * (H - 30);
  const bars = data.map((d, i) => `<g><title>${fmtMonth(d.m)}: sales ${money(d.s)}, costs ${money(d.c)}</title>
    <rect x="${i * bw + bw * .14}" y="${y(d.s)}" width="${bw * .34}" height="${H - 20 - y(d.s)}" rx="2" fill="var(--accent)"/>
    <rect x="${i * bw + bw * .52}" y="${y(d.c)}" width="${bw * .34}" height="${H - 20 - y(d.c)}" rx="2" fill="var(--muted)" opacity=".55"/>
    <text x="${i * bw + bw / 2}" y="${H - 5}" font-size="10" text-anchor="middle" fill="var(--muted)">${fmtMonth(d.m).slice(0, 3)}</text></g>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly sales and costs">${bars}</svg>
    <div class="row small muted"><span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px"></span> Sales</span><span><span style="display:inline-block;width:10px;height:10px;background:var(--muted);opacity:.55;border-radius:2px"></span> Purchases + expenses</span></div>`;
}

// ───────────────────────── Day book ─────────────────────────
export function entries(el, { query }) {
  const { from, to } = fyBounds();
  const f = { type: query.get('type') || '', from, to, project: query.get('project') || '', q: '', status: '' };
  el.innerHTML = String(html`<div class="page-head"><div><h2>Day Book</h2><p>Every entry for the selected company and year. Tap a row to view, edit or print.</p></div>
    <div class="row"><button class="btn" id="csv">Export CSV</button><button class="btn" id="print">Print</button></div></div>
    <div class="card"><div class="toolbar">
      <label>Type<select id="fType">${raw(options(Object.entries(TYPES).map(([k, t]) => [k, t.label]), f.type, { blank: 'All types' }))}</select></label>
      <label>From<input type="date" id="fFrom" value="${f.from}"></label><label>To<input type="date" id="fTo" value="${f.to}"></label>
      <label>Project<select id="fProject">${raw(options([['none', 'General / no project'], ...visibleProjects().map(p => [p.id, p.name])], f.project, { blank: 'All projects' }))}</select></label>
      <label>Status<select id="fStatus">${raw(options([['due', 'Pending bills'], ['adv', 'Has advance / unapplied']], f.status, { blank: 'Any' }))}</select></label>
      <label class="grow">Search<input id="fQ" placeholder="Party, number, reference, note…"></label>
    </div><div id="list"></div></div>`);
  const rows = () => cv().filter(v => (!f.type || v.voucher_type === f.type) && v.voucher_date >= f.from && v.voucher_date <= f.to &&
    (!f.project || (f.project === 'none' ? !v.project_id : v.project_id === f.project)) &&
    (!f.status || (f.status === 'due' ? pending(v) > 0.004 : unalloc(v) > 0.004)) &&
    (!f.q || [v.voucher_no, v.ref_no, v.notes, partyName(v.party_id), projectName(v.project_id), categoryName(v.category_id), ...(v.lines || []).map(l => l.description)].join(' ').toLowerCase().includes(f.q)))
    .sort((a, b) => b.voucher_date.localeCompare(a.voucher_date) || b.voucher_no.localeCompare(a.voucher_no));
  const cols = [
    { label: 'Date', render: v => fmtDate(v.voucher_date) },
    { label: 'Entry', render: v => `<b>${esc(v.voucher_no)}</b><span class="sub">${esc(TYPES[v.voucher_type].label)}</span>` },
    { label: 'Party / account', render: v => `${esc(partyName(v.party_id) || accountName(v.account_id))}${v.ref_no ? `<span class="sub">${esc(v.ref_no)}</span>` : ''}` },
    { label: 'Project', render: v => esc(projectName(v.project_id)) || '<span class="muted">—</span>' },
    { label: 'Amount', num: true, render: v => money(v.total_amount) },
    { label: 'Status', render: v => { const s = voucherStatus(v); return s.text ? `<span class="badge ${s.cls}">${esc(s.text)}</span>` : ''; } },
  ];
  const draw = () => { const r = rows(); $('#list', el).innerHTML = table(cols, r.slice(0, 1000), { empty: 'No entries match these filters.', rowAttr: v => `class="click" data-v="${v.id}"` }) + (r.length > 1000 ? `<p class="small muted">Showing the latest 1,000 of ${r.length}. Narrow the dates to see more.</p>` : ''); };
  const bind = (id, k, ev = 'change') => $(id, el).addEventListener(ev, e => { f[k] = k === 'q' ? e.target.value.trim().toLowerCase() : e.target.value; draw(); });
  bind('#fType', 'type'); bind('#fFrom', 'from'); bind('#fTo', 'to'); bind('#fProject', 'project'); bind('#fStatus', 'status');
  $('#fQ', el).addEventListener('input', debounce(e => { f.q = e.target.value.trim().toLowerCase(); draw(); }));
  $('#csv', el).onclick = () => downloadCSV(`Day book ${f.from} to ${f.to}`, ['Date', 'No', 'Type', 'Party', 'Reference', 'Project', 'Category', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'TDS', 'Net', 'Pending', 'Notes'],
    rows().map(v => [v.voucher_date, v.voucher_no, TYPES[v.voucher_type].label, partyName(v.party_id), v.ref_no, projectName(v.project_id), categoryName(v.category_id), v.taxable_amount, v.cgst_amount, v.sgst_amount, v.igst_amount, v.total_amount, v.tds_amount, v.net_amount, pending(v), v.notes]));
  $('#print', el).onclick = () => printHTML(`${company().name} — Day Book ${fmtDate(f.from)} to ${fmtDate(f.to)}`, table(cols.slice(0, 5), rows()));
  openRows(el); draw();
}

// ───────────────────────── Outstanding & advances ─────────────────────────
export function outstanding(el, { query }) {
  let tab = query.get('tab') || 'receivable';
  const buckets = [[0, 30, '0–30'], [31, 60, '31–60'], [61, 90, '61–90'], [91, 1e9, '90+']];
  function draw() {
    const vs = cv(), t = today();
    let body = '';
    if (tab === 'advances') {
      const adv = vs.filter(v => ['receipt', 'payment', 'customer_credit', 'supplier_credit'].includes(v.voucher_type) && unalloc(v) > 0.004).sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
      const side = v => ['receipt', 'customer_credit'].includes(v.voucher_type) ? 'Customer' : 'Supplier';
      body = `<p class="muted">Money received or paid that is not yet linked to a bill. When the bill is entered, open the payment and link it — no need to enter anything twice.</p>` +
        table([{ label: 'Date', render: v => fmtDate(v.voucher_date) }, { label: 'Entry', render: v => `<b>${esc(v.voucher_no)}</b><span class="sub">${esc(TYPES[v.voucher_type].label)}</span>` },
          { label: 'Party', render: v => esc(partyName(v.party_id)) }, { label: 'Kind', render: v => `<span class="badge ${side(v) === 'Customer' ? 'info' : 'warn'}">${side(v)} ${TYPES[v.voucher_type].credit ? 'credit' : 'advance'}</span>` },
          { label: 'Amount', num: true, render: v => money(v.total_amount) }, { label: 'Not linked', num: true, render: v => `<b>${money(unalloc(v))}</b>` },
          { label: '', render: v => canWrite() ? `<button class="btn sm" data-edit="${v.id}">Link to bills</button>` : '' }],
          adv, { empty: 'No advances or unapplied credits.', rowAttr: v => `class="click" data-v="${v.id}"`, foot: ['', '', '', 'Total', '', money(sum(adv, unalloc)), ''] });
    } else {
      const types = tab === 'receivable' ? SALES_BILLS : PURCHASE_BILLS;
      const bills = vs.filter(b => types.includes(b.voucher_type) && pending(b) > 0.004);
      const byParty = new Map();
      for (const b of bills) { const k = b.party_id || 'none'; (byParty.get(k) || byParty.set(k, []).get(k)).push(b); }
      const advTypes = tab === 'receivable' ? ['receipt', 'customer_credit'] : ['payment', 'supplier_credit'];
      const rows = [...byParty.entries()].map(([pid, bs]) => {
        const ages = buckets.map(([lo, hi]) => sum(bs.filter(b => { const d = daysBetween(b.voucher_date, t); return d >= lo && d <= hi; }), pending));
        const adv = sum(vs.filter(v => v.party_id === pid && advTypes.includes(v.voucher_type)), unalloc);
        return { pid, bs, ages, total: sum(bs, pending), adv, oldest: Math.max(...bs.map(b => daysBetween(b.voucher_date, t))) };
      }).sort((a, b) => b.total - a.total);
      body = table([
        { label: tab === 'receivable' ? 'Customer' : 'Supplier', render: r => `<button class="link" data-party="${r.pid}">${esc(partyName(r.pid) || 'No party')}</button><span class="sub">${r.bs.length} bill${r.bs.length > 1 ? 's' : ''} · oldest ${r.oldest} days</span>` },
        ...buckets.map(([, , l], i) => ({ label: l + ' days', num: true, render: r => money(r.ages[i], { blankZero: true }) })),
        { label: 'Pending', num: true, render: r => `<b>${money(r.total)}</b>` },
        { label: 'Advance held', num: true, render: r => r.adv ? `<span class="badge info">${money(r.adv)}</span>` : '' },
        { label: '', render: r => canWrite() && r.pid !== 'none' ? `<button class="btn sm" data-pay="${r.pid}">${tab === 'receivable' ? 'Receive' : 'Pay'}</button>` : '' },
      ], rows, { empty: tab === 'receivable' ? 'Nobody owes you anything right now.' : 'You have no unpaid supplier bills.',
        foot: ['Total', ...buckets.map((_, i) => money(sum(rows, r => r.ages[i]))), money(sum(rows, r => r.total)), money(sum(rows, r => r.adv)), ''] });
    }
    $('#body', el).innerHTML = body;
  }
  el.innerHTML = `<div class="page-head"><div><h2>Outstanding &amp; Advances</h2><p>Who owes you, whom you owe, and money waiting to be linked to bills.</p></div></div>
    <div class="card"><div class="tabs" role="tablist">${[['receivable', 'To receive'], ['payable', 'To pay'], ['advances', 'Advances & credits']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div><div id="body"></div></div>`;
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; $$('.tabs button', el).forEach(x => x.classList.toggle('active', x === b)); history.replaceState(null, '', '#/outstanding?tab=' + tab); draw(); }
    if (b.dataset.pay) go(`new?type=${tab === 'receivable' ? 'receipt' : 'payment'}&party=${b.dataset.pay}`);
    if (b.dataset.edit) go('edit/' + b.dataset.edit);
    if (b.dataset.party) go('ledgers?kind=party&id=' + b.dataset.party);
  });
  openRows(el); draw();
}

// ───────────────────────── Ledgers ─────────────────────────
export function ledgers(el, { query }) {
  const { from, to } = fyBounds();
  const f = { kind: query.get('kind') || 'party', id: query.get('id') || '', from, to };
  const kinds = [['party', 'Party ledger'], ['account', 'Cash / bank book'], ['category', 'Category ledger'], ['project', 'Project ledger'], ['item', 'Item stock ledger']];
  const choices = () => ({
    party: parties().map(p => [p.id, p.name]), account: accounts().map(a => [a.id, a.name]), category: categories().map(c => [c.id, c.name]),
    project: [['none', 'General / no project'], ...visibleProjects().map(p => [p.id, p.name])], item: items().map(i => [i.id, i.name]),
  }[f.kind]);
  el.innerHTML = `<div class="page-head"><div><h2>Ledgers</h2><p>Running balances for a party, account, category, project or item.</p></div>
    <div class="row"><button class="btn" id="csv">Export CSV</button><button class="btn" id="print">Print</button></div></div>
    <div class="card"><div class="toolbar"><label>Ledger<select id="lKind">${options(kinds, f.kind)}</select></label>
    <label class="grow">Of<select id="lId"></select></label>
    <label>From<input type="date" id="lFrom" value="${f.from}"></label><label>To<input type="date" id="lTo" value="${f.to}"></label></div><div id="out"></div></div>`;
  const fillIds = () => { const c = choices(); if (!c.some(([v]) => v === f.id)) f.id = c[0]?.[0] || ''; $('#lId', el).innerHTML = options(c, f.id); };
  let last = { title: '', cols: [], rows: [], csv: [] };
  function compute() {
    const prior = v => v.voucher_date < f.from, within = v => v.voucher_date >= f.from && v.voucher_date <= f.to;
    const vs = cv(); let open = 0, rows = [], cols, title = '';
    const desc = v => `<b>${esc(v.voucher_no)}</b> <span class="muted">${esc(TYPES[v.voucher_type].label)}</span><span class="sub">${esc([v.ref_no, projectName(v.project_id), (v.lines || [])[0]?.description, v.notes].filter(Boolean).join(' · '))}</span>`;
    if (f.kind === 'party') {
      const p = S.parties.find(x => x.id === f.id); title = 'Party ledger — ' + (p?.name || '');
      open = partyBalance(f.id, prevDay(f.from));
      for (const v of vs.filter(x => x.party_id === f.id && within(x))) for (const amt of partyEffect(v)) rows.push({ v, dr: amt > 0 ? amt : 0, cr: amt < 0 ? -amt : 0 });
      cols = ['Debit (they owe)', 'Credit (we owe)'];
    } else if (f.kind === 'account') {
      title = 'Cash / bank book — ' + accountName(f.id);
      open = accountBalance(f.id, S.companyId, prevDay(f.from));
      for (const v of vs.filter(within)) for (const e of accountEffects(v)) if (e.account_id === f.id) rows.push({ v, dr: e.amount > 0 ? e.amount : 0, cr: e.amount < 0 ? -e.amount : 0 });
      cols = ['Money in', 'Money out'];
    } else if (f.kind === 'category' || f.kind === 'project') {
      const match = v => f.kind === 'category' ? v.category_id === f.id : (f.id === 'none' ? !v.project_id : v.project_id === f.id);
      title = (f.kind === 'category' ? 'Category ledger — ' + categoryName(f.id) : 'Project ledger — ' + (f.id === 'none' ? 'General' : projectName(f.id)));
      for (const v of vs.filter(x => match(x) && within(x))) {
        const e = plEffect(v), inc = e.sales || 0, exp = (e.purchases || 0) + (e.expenses || 0);
        if (inc || exp) rows.push({ v, dr: exp, cr: inc });
        else if (f.kind === 'project' && ['receipt', 'payment', 'interco_in', 'interco_out', 'capital_in', 'capital_out'].includes(v.voucher_type)) rows.push({ v, info: true, dr: 0, cr: 0 });
      }
      cols = ['Cost (before GST)', 'Income (before GST)'];
    } else {
      const it = S.items.find(i => i.id === f.id); title = 'Stock ledger — ' + (it?.name || '');
      open = stockOf(f.id, prevDay(f.from));
      for (const v of vs.filter(within)) for (const l of v.lines || []) if (l.item_id === f.id) { const q = stockEffect(v, l); rows.push({ v, dr: q > 0 ? q : 0, cr: q < 0 ? -q : 0, qty: true }); }
      cols = ['In (' + (it?.unit || '') + ')', 'Out'];
    }
    rows.sort((a, b) => a.v.voucher_date.localeCompare(b.v.voucher_date) || a.v.voucher_no.localeCompare(b.v.voucher_no));
    const showBal = ['party', 'account', 'item'].includes(f.kind);
    let bal = open; const fmt = f.kind === 'item' ? qtyFmt : n => money(n);
    const out = rows.map(r => { if (!r.info) bal += (r.dr - r.cr) * (f.kind === 'category' || f.kind === 'project' ? -1 : 1); return { ...r, bal }; });
    const totDr = sum(rows, r => r.dr), totCr = sum(rows, r => r.cr);
    const head = `<tr><th>Date</th><th>Particulars</th><th class="num">${esc(cols[0])}</th><th class="num">${esc(cols[1])}</th>${showBal ? '<th class="num">Balance</th>' : ''}</tr>`;
    const bodyRows = (showBal ? `<tr><td>${fmtDate(f.from)}</td><td><b>Opening balance</b></td><td></td><td></td><td class="num"><b>${fmt(open)}</b></td></tr>` : '') +
      out.map(r => `<tr class="click" data-v="${r.v.id}"><td>${fmtDate(r.v.voucher_date)}</td><td>${desc(r.v)}</td>${r.info ? `<td class="num muted" colspan="2">${money(r.v.total_amount)} (money movement)</td>` : `<td class="num">${r.dr ? fmt(r.dr) : ''}</td><td class="num">${r.cr ? fmt(r.cr) : ''}</td>`}${showBal ? `<td class="num">${fmt(r.bal)}</td>` : ''}</tr>`).join('');
    const foot = `<tr><td></td><td>Totals${!showBal ? ' · net ' + money(totCr - totDr) : ''}</td><td class="num">${fmt(totDr)}</td><td class="num">${fmt(totCr)}</td>${showBal ? `<td class="num">${fmt(bal)}</td>` : ''}</tr>`;
    const tbl = rows.length || showBal ? `<div class="table-wrap"><table><thead>${head}</thead><tbody>${bodyRows}</tbody><tfoot>${foot}</tfoot></table></div>` : '<div class="empty">No entries in this period.</div>';
    const note = f.kind === 'party' ? `<p class="small muted">Positive balance = they owe you; negative = you owe them.</p>` : '';
    last = { title, html: tbl, csv: [['Opening', '', '', '', open], ...out.map(r => [r.v.voucher_date, r.v.voucher_no + ' ' + TYPES[r.v.voucher_type].label, r.dr, r.cr, showBal ? r.bal : ''])] };
    $('#out', el).innerHTML = note + tbl;
  }
  const prevDay = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
  $('#lKind', el).onchange = e => { f.kind = e.target.value; f.id = ''; fillIds(); compute(); };
  $('#lId', el).onchange = e => { f.id = e.target.value; compute(); };
  $('#lFrom', el).onchange = e => { f.from = e.target.value; compute(); };
  $('#lTo', el).onchange = e => { f.to = e.target.value; compute(); };
  $('#csv', el).onclick = () => downloadCSV(last.title, ['Date', 'Particulars', 'Debit / In', 'Credit / Out', 'Balance'], last.csv);
  $('#print', el).onclick = () => printHTML(`${company().name} — ${last.title} (${fmtDate(f.from)} to ${fmtDate(f.to)})`, last.html);
  openRows(el); fillIds(); compute();
}

// ───────────────────────── P&L and cash flow ─────────────────────────
export function reports(el) {
  const { from, to } = fyBounds();
  const f = { from, to, project: '' };
  el.innerHTML = `<div class="page-head"><div><h2>Profit &amp; Loss · Cash Flow</h2><p>Values before GST. Sales include service invoices and delivery challans; credit/debit notes are deducted.</p></div>
    <div class="row"><button class="btn" id="print">Print</button></div></div>
    <div class="card"><div class="toolbar"><label>From<input type="date" id="rFrom" value="${from}"></label><label>To<input type="date" id="rTo" value="${to}"></label>
    <label class="grow">Project<select id="rProject">${options([['none', 'General / no project'], ...visibleProjects().map(p => [p.id, p.name])], '', { blank: 'All projects' })}</select></label></div><div id="out"></div></div>`;
  function compute() {
    const vs = cv().filter(v => v.voucher_date >= f.from && v.voucher_date <= f.to && (!f.project || (f.project === 'none' ? !v.project_id : v.project_id === f.project)));
    const tot = { sales: 0, purchases: 0, expenses: 0 }, byCat = new Map(), byProj = new Map();
    for (const v of vs) {
      const e = plEffect(v); for (const k in e) tot[k] += e[k];
      if (e.expenses) byCat.set(v.category_id || '', (byCat.get(v.category_id || '') || 0) + e.expenses);
      const pk = v.project_id || ''; const p = byProj.get(pk) || { sales: 0, purchases: 0, expenses: 0 }; for (const k in e) p[k] += e[k]; byProj.set(pk, p);
    }
    const profit = r2(tot.sales - tot.purchases - tot.expenses);
    // cash flow across all money accounts
    const accs = accounts(), dbd = new Date(f.from + 'T00:00:00Z'); dbd.setUTCDate(dbd.getUTCDate() - 1); const db = dbd.toISOString().slice(0, 10);
    const opening = sum(accs, a => accountBalance(a.id, S.companyId, db)), closing = sum(accs, a => accountBalance(a.id, S.companyId, f.to));
    const flow = new Map();
    for (const v of vs) for (const e of accountEffects(v)) { if (v.voucher_type === 'transfer') continue; const k = TYPES[v.voucher_type].label; const x = flow.get(k) || { in: 0, out: 0 }; if (e.amount > 0) x.in += e.amount; else x.out -= e.amount; flow.set(k, x); }
    const flows = [...flow.entries()].sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));
    const out = html`<div class="grid g4">
        <div class="stat"><div class="k">Sales</div><div class="v">${money(tot.sales)}</div></div>
        <div class="stat"><div class="k">Purchases</div><div class="v">${money(tot.purchases)}</div></div>
        <div class="stat"><div class="k">Expenses</div><div class="v">${money(tot.expenses)}</div></div>
        <div class="stat"><div class="k">Profit / loss</div><div class="v ${cls(profit)}">${money(profit)}</div></div></div>
      <div class="grid g2" style="margin-top:16px"><div><h3>Expenses by category</h3>${raw(table([{ label: 'Category', render: r => esc(categoryName(r[0]) || 'Uncategorised') }, { label: 'Amount', num: true, render: r => money(r[1]) }],
        [...byCat.entries()].sort((a, b) => b[1] - a[1]), { empty: 'No expenses.' }))}</div>
      <div><h3>Cash flow (all cash &amp; bank accounts)</h3><div class="table-wrap"><table><tbody>
        ${!f.project ? html`<tr><td><b>Opening balance</b></td><td></td><td class="num"><b>${money(opening)}</b></td></tr>` : ''}
        ${flows.map(([k, x]) => html`<tr><td>${k}</td><td class="num pos">${x.in ? money(x.in) : ''}</td><td class="num neg">${x.out ? money(-x.out) : ''}</td></tr>`)}
        ${f.project ? html`<tr><td><b>Net cash for this project</b></td><td></td><td class="num"><b>${money(sum(flows, ([, x]) => x.in - x.out))}</b></td></tr>`
          : html`<tr><td><b>Closing balance</b></td><td></td><td class="num"><b>${money(closing)}</b></td></tr>`}</tbody></table></div>
        <p class="small muted">Transfers between your own accounts are left out.${f.project ? ' Only money entries tagged with this project are shown; payments linked to its bills but tagged to no project are not.' : ''}</p></div></div>
      ${!f.project ? html`<h3 style="margin-top:16px">Profit by project</h3>${raw(table([{ label: 'Project', render: r => esc(projectName(r[0]) || 'General / no project') }, { label: 'Sales', num: true, render: r => money(r[1].sales) },
        { label: 'Purchases', num: true, render: r => money(r[1].purchases) }, { label: 'Expenses', num: true, render: r => money(r[1].expenses) }, { label: 'Profit', num: true, render: r => { const p = r2(r[1].sales - r[1].purchases - r[1].expenses); return `<b class="${cls(p)}">${money(p)}</b>`; } }],
        [...byProj.entries()].sort((a, b) => (projectName(a[0]) || '~').localeCompare(projectName(b[0]) || '~')), { empty: 'No entries.' }))}` : ''}`;
    $('#out', el).innerHTML = String(out);
  }
  $('#rFrom', el).onchange = e => { f.from = e.target.value; compute(); };
  $('#rTo', el).onchange = e => { f.to = e.target.value; compute(); };
  $('#rProject', el).onchange = e => { f.project = e.target.value; compute(); };
  $('#print', el).onclick = () => printHTML(`${company().name} — Profit & Loss ${fmtDate(f.from)} to ${fmtDate(f.to)}${f.project ? ' — ' + (projectName(f.project) || 'General') : ''}`, $('#out', el).innerHTML);
  compute();
}

// ───────────────────────── GST & TDS ─────────────────────────
export function gst(el) {
  const c = company(), fyv = cv().filter(inFY), { from } = fyBounds();
  const months = [...Array(12)].map((_, i) => { const d = new Date(from + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + i); return d.toISOString().slice(0, 7); });
  let carry = Number(c.opening_gst_credit || 0);
  const rows = months.map(m => {
    const mv = fyv.filter(v => v.voucher_date.startsWith(m)); const o = sum(mv, v => gstEffect(v).output || 0), i = sum(mv, v => gstEffect(v).input || 0);
    const avail = r2(i + carry), payable = r2(Math.max(0, o - avail)), next = r2(Math.max(0, avail - o));
    const row = { m, o, i, open: carry, payable, next }; carry = next; return row;
  });
  const tdsRows = fyv.filter(v => Number(v.tds_amount) > 0);
  const tdsGroup = (kind) => { const map = new Map(); for (const v of tdsRows) { const e = tdsEffect(v); if (!e[kind]) continue; const k = (v.tds_section || '—') + '|' + (v.party_id || ''); const x = map.get(k) || { sec: v.tds_section || '—', party: v.party_id, amt: 0, base: 0, n: 0 }; x.amt += e[kind]; x.base += Number(TYPES[v.voucher_type].money ? v.total_amount : v.taxable_amount); x.n++; map.set(k, x); } return [...map.values()]; };
  const pay = tdsGroup('payable'), rec = tdsGroup('receivable');
  const tdsCols = [{ label: 'Section', render: r => esc(r.sec) }, { label: 'Party', render: r => esc(partyName(r.party)) }, { label: 'Entries', num: true, render: r => r.n }, { label: 'On amount', num: true, render: r => money(r.base) }, { label: 'TDS', num: true, render: r => `<b>${money(r.amt)}</b>` }];
  el.innerHTML = String(html`<div class="page-head"><div><h2>GST &amp; TDS</h2><p>${c.name} · FY 20${S.fy}. Figures come from your entries; GST paid to the government is not deducted here.</p></div><button class="btn" id="print">Print</button></div>
    <div id="gstOut"><div class="card"><h3>Monthly GST <span class="muted small">tap a month for its entries</span></h3>${raw(table([{ label: 'Month', render: r => `<button class="link" data-gm="${r.m}">${fmtMonth(r.m)}</button>` }, { label: 'Output GST (sales)', num: true, render: r => money(r.o) }, { label: 'Input credit (purchases)', num: true, render: r => money(r.i) },
      { label: 'Credit brought forward', num: true, render: r => money(r.open) }, { label: 'GST payable', num: true, render: r => `<b>${money(r.payable)}</b>` }, { label: 'Credit carried forward', num: true, render: r => money(r.next) }], rows,
      { foot: ['FY total', money(sum(rows, r => r.o)), money(sum(rows, r => r.i)), money(c.opening_gst_credit || 0), money(sum(rows, r => r.payable)), money(rows.at(-1).next)] }))}
      <p class="small muted">Opening credit for the year (${money(c.opening_gst_credit || 0)}) can be changed in Company &amp; Users.</p></div>
    <div class="grid g2"><div class="card"><h3>TDS you deducted (deposit with government)</h3>${raw(table(tdsCols, pay, { empty: 'No TDS deducted this year.', foot: ['', '', '', 'Total', money(sum(pay, r => r.amt))] }))}</div>
      <div class="card"><h3>TDS customers deducted (claim in your return)</h3>${raw(table(tdsCols, rec, { empty: 'No TDS deducted by customers this year.', foot: ['', '', '', 'Total', money(sum(rec, r => r.amt))] }))}</div></div></div>`);
  $('#print', el).onclick = () => printHTML(`${c.name} — GST & TDS FY 20${S.fy}`, $('#gstOut', el).innerHTML);
  el.addEventListener('click', e => {
    const m = e.target.closest('[data-gm]')?.dataset.gm; if (!m) return;
    const rowsM = fyv.filter(v => v.voucher_date.startsWith(m) && (gstEffect(v).output || gstEffect(v).input)).sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
    const cols = [{ label: 'Date', render: v => fmtDate(v.voucher_date) }, { label: 'Entry', render: v => `<b>${esc(v.voucher_no)}</b><span class="sub">${esc(TYPES[v.voucher_type].label)}</span>` },
      { label: 'Party / GSTIN', render: v => { const p = S.parties.find(x => x.id === v.party_id); return `${esc(p?.name || '')}<span class="sub">${esc(p?.gstin || 'Unregistered')}</span>`; } },
      { label: 'Taxable', num: true, render: v => money(v.taxable_amount) }, { label: 'CGST', num: true, render: v => money(v.cgst_amount, { blankZero: true }) }, { label: 'SGST', num: true, render: v => money(v.sgst_amount, { blankZero: true }) },
      { label: 'IGST', num: true, render: v => money(v.igst_amount, { blankZero: true }) }, { label: 'Side', render: v => gstEffect(v).output ? '<span class="badge info">Output</span>' : '<span class="badge warn">Input</span>' }];
    const body = table(cols, rowsM, { empty: 'No GST entries this month.', rowAttr: v => `class="click" data-v="${v.id}"` });
    const md = modal(`${c.name} — GST ${fmtMonth(m)}`, body + `<div class="row end" style="margin-top:.75rem"><button class="btn" data-csv>Export CSV</button><button class="btn" data-pr>Print</button></div>`, { wide: true });
    md.el.addEventListener('click', ev => {
      const tr = ev.target.closest('[data-v]'); if (tr) { md.close(); viewVoucher(tr.dataset.v); }
      if (ev.target.closest('[data-pr]')) printHTML(`${c.name} — GST details ${fmtMonth(m)}`, body);
      if (ev.target.closest('[data-csv]')) downloadCSV(`GST ${m}`, ['Date', 'No', 'Type', 'Party', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST'], rowsM.map(v => { const p = S.parties.find(x => x.id === v.party_id); return [v.voucher_date, v.voucher_no, TYPES[v.voucher_type].label, p?.name, p?.gstin, v.taxable_amount, v.cgst_amount, v.sgst_amount, v.igst_amount]; }));
    });
  });
}
