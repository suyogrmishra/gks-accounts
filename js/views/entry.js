// New / edit entry screen, plus the shared "view entry" dialog and invoice printing.
import { S, company, canSaveType, canWrite, isAdmin, canDelete, canAddParty, role, parties, items, categories, accounts, visibleProjects, voucher, pending, unalloc,
  allocsTo, allocsFrom, partyName, projectName, accountName, categoryName, companyName, voucherStatus, stockOf, lastPurchaseRate, groupCompanies, userEmail } from '../store.js';
import { TYPES, voucherTotals, lineAmount, r2, sum, money, qtyFmt, allocationTargets, autoAllocate, amountInWords, SALES_BILLS, plEffect } from '../calc.js';
import { $, $$, esc, html, raw, toast, modal, confirmBox, options, today, fmtDate, printHTML, formData } from '../ui.js';
import { errorText } from '../backend.js';
import { go, reload } from '../app.js';
import { requireAdminPin } from '../pin.js';

const ENTRY_TYPES = ['purchase', 'sale', 'service', 'challan', 'expense', 'receipt', 'payment', 'customer_credit', 'supplier_credit', 'transfer', 'capital_in', 'capital_out', 'stock_adjust'];
const TDS_SECTIONS = [['', '—'], ['194C', '194C Contractor'], ['194J', '194J Professional'], ['194I', '194I Rent'], ['194H', '194H Commission'], ['194Q', '194Q Purchase of goods'], ['194A', '194A Interest'], ['other', 'Other']];
const MODES = [['bank', 'Bank transfer'], ['upi', 'UPI'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['other', 'Other']];
const blankLine = () => ({ item_id: null, description: '', hsn: '', qty: '', unit: '', rate: '', gst_rate: 18, amount: '' });

export function newEntry(el, { query }) {
  const type = ENTRY_TYPES.includes(query.get('type')) ? query.get('type') : 'purchase';
  const st = fresh(type);
  if (query.get('party')) st.party_id = query.get('party');
  if (query.get('project')) st.project_id = query.get('project');
  if (query.get('account')) { st.account_id = query.get('account'); const a = S.accounts.find(x => x.id === st.account_id); if (a) st.payment_mode = a.kind === 'cash' ? 'cash' : a.kind; }
  form(el, st);
}

export function editEntry(el, { args }) {
  const v = voucher(args[0]);
  if (!v) { el.innerHTML = '<div class="empty">This entry was not found. It may have been deleted.</div>'; return; }
  if (v.company_id !== S.companyId) { el.innerHTML = `<div class="empty">This entry belongs to ${esc(companyName(v.company_id))}. Switch company to edit it.</div>`; return; }
  const st = {
    ...v, editing: true,
    lines: (v.lines || []).map(l => ({ ...l, qty: l.qty || '', rate: l.rate || '', amount: l.amount })),
    cash_amount: r2(v.total_amount - v.tds_amount),
    allocations: Object.fromEntries(allocsFrom(v.id).map(a => [a.to_voucher_id, a.amount])),
    paid_now: !!v.account_id && !!TYPES[v.voucher_type].lines,
  };
  if (!st.lines.length) st.lines = [blankLine()];
  form(el, st);
}

function fresh(type) {
  const c = company();
  return {
    voucher_type: type, voucher_date: today(), party_id: null, project_id: null, category_id: null, account_id: null, to_account_id: null,
    payment_mode: accounts().some(a => a.active && a.kind !== 'cash') ? 'bank' : 'cash', gst_mode: 'intra', round_off: 0, tds_section: '', tds_rate: 0, tds_amount: 0, ref_no: '', notes: '',
    lines: [blankLine()], cash_amount: '', allocations: {}, paid_now: false, company_id: c.id,
  };
}

function form(el, st) {
  const T = () => TYPES[st.voucher_type];
  const writable = canSaveType(st.voucher_type);
  const allowedTypes = ENTRY_TYPES.filter(canSaveType);
  // when "rates include GST" is ticked, convert entered rates/amounts to the value before GST
  const exLines = () => st.lines.map(l => {
    if (!st.incl_gst || st.gst_mode === 'none') return l;
    const k = 1 + (Number(l.gst_rate) || 0) / 100;
    return { ...l, rate: Number(l.rate) ? r2(Number(l.rate) / k) : l.rate, amount: Number(l.amount) ? r2(Number(l.amount) / k) : l.amount };
  });
  const eff = () => ({ ...st, lines: exLines() });
  // cash mode → cash accounts; bank / UPI / cheque → bank and UPI accounts (old-app rule)
  const modeAccounts = () => accounts().filter(a => (a.active || a.id === st.account_id) && (st.payment_mode === 'cash' ? a.kind === 'cash' : ['bank', 'upi', 'cheque'].includes(st.payment_mode) ? a.kind !== 'cash' : true)).map(a => [a.id, a.name]);
  const stockHint = l => { const lr = lastPurchaseRate(l.item_id); return `In stock: ${qtyFmt(stockOf(l.item_id))} ${l.unit || ''}` + (lr != null ? ` · last bought @ ${money(lr)}` : ''); };

  function render() {
    const t = st.voucher_type, def = T();
    el.innerHTML = String(html`
      <div class="page-head"><div><h2>${st.editing ? 'Edit ' + def.label + ' ' + st.voucher_no : 'New entry'}</h2>
        <p>${st.editing ? 'Changes are saved together with lines and bill links.' : 'Choose what happened, then fill in the details.'}</p></div>
        ${st.editing ? html`<button class="btn" id="cancelEdit">Back</button>` : ''}</div>
      ${!writable ? html`<div class="callout warn">Your role can view entries but cannot save this kind of entry.</div>` : ''}
      ${!st.editing ? html`<div class="card"><div class="type-pills" role="tablist">${allowedTypes.map(x => html`<button type="button" data-type="${x}" class="${x === t ? 'active' : ''}">${TYPES[x].label}</button>`)}</div></div>` : ''}
      <form id="entryForm" class="card stack" autocomplete="off" novalidate>
        <div class="form-grid">
          <label>Date<input type="date" name="voucher_date" value="${st.voucher_date}" required></label>
          ${raw(partyField())}
          ${raw(refField())}
          ${t !== 'transfer' && t !== 'stock_adjust' && role() !== 'storekeeper' ? html`<label>Project<select name="project_id">${raw(options(visibleProjects().filter(p => p.active || p.id === st.project_id).map(p => [p.id, p.name]), st.project_id, { blank: 'General / no project' }))}</select></label>` : ''}
          ${['expense', 'purchase', 'capital_in', 'capital_out', 'sale', 'service'].includes(t) ? html`<label>Category<select name="category_id">${raw(options(categories().filter(c => c.active || c.id === st.category_id).map(c => [c.id, c.name]).concat(canWrite() ? [['__new__', '+ New category…']] : []), st.category_id, { blank: '—' }))}</select></label>` : ''}
          ${def.lines && t !== 'stock_adjust' ? html`<label>GST<select name="gst_mode">${raw(options([['intra', 'Intra-state (CGST + SGST)'], ['inter', 'Inter-state (IGST)'], ['none', 'No GST']], st.gst_mode))}</select></label>` : ''}
        </div>
        ${def.lines ? raw('<div id="linesBox" class="stack">' + linesBlock() + '</div>') : raw(moneyBlock())}
        ${def.bill ? raw(paidBlock()) : ''}
        <div id="ownerNote"></div>
        ${def.settles || def.credit ? raw('<div id="allocBlock"></div>') : ''}
        <div class="form-grid"><label class="span2">Notes<textarea name="notes" rows="2">${st.notes || ''}</textarea></label>
          <label class="span2">Document link (bill scan, Drive / WhatsApp link)<input name="doc_url" type="url" value="${st.doc_url || ''}" placeholder="https://…"></label></div>
        <div class="row end gap">
          <span class="msg error" id="formMsg" role="alert"></span>
          ${!st.editing ? html`<button type="button" class="btn" id="clearBtn">Clear</button>` : ''}
          <button class="btn primary" id="saveBtn" ${writable ? '' : 'disabled'}>${st.editing ? 'Save changes' : 'Save entry'}</button>
        </div>
      </form>`);
    wire();
    renderAlloc();
    renderTotals();
  }

  function partyField() {
    const t = st.voucher_type;
    if (['transfer', 'stock_adjust'].includes(t)) return '';
    const label = t === 'expense' ? 'Paid to / owed to (optional if paid now)' : ['receipt', 'payment'].includes(t) ? (t === 'receipt' ? 'Received from' : 'Paid to') + ' (blank = Suspense Account)' : ['capital_in', 'capital_out'].includes(t) ? 'Partner (optional)' : T().side === 'vendor' ? 'Supplier' : 'Customer';
    return String(html`<label class="party-pick span2">${label}<div class="row" style="flex-wrap:nowrap"><input id="partyInput" value="${partyName(st.party_id)}" placeholder="Type to search…" aria-autocomplete="list">${canAddParty() ? raw('<button type="button" class="btn" id="addPartyBtn" title="Add a new party">+ New</button>') : ''}</div><div class="suggest hidden" id="partySuggest"></div></label>`);
  }
  function refField() {
    const t = st.voucher_type;
    const label = { purchase: "Supplier's bill no.", expense: 'Bill / voucher no.', sale: 'PO / reference', service: 'PO / RA bill ref.', challan: 'Vehicle / ref.',
      receipt: 'UTR / cheque no.', payment: 'UTR / cheque no.', supplier_credit: "Supplier's note no.", customer_credit: 'Reference', stock_adjust: 'Reason' }[t] || 'Reference';
    return String(html`<label>${label}<input name="ref_no" value="${st.ref_no || ''}"></label>`);
  }

  function linesBlock() {
    const t = st.voucher_type, adj = t === 'stock_adjust', its = items().filter(i => i.active);
    const rows = st.lines.map((l, i) => {
      const stock = l.item_id ? stockOf(l.item_id) : null;
      return html`<tr data-i="${i}">
        <td class="desc"><input list="itemList" data-f="item" value="${l.item_id ? (its.find(x => x.id === l.item_id)?.name || l.description || '') : (l.description || '')}" placeholder="${adj ? 'Item' : 'Item or description'}">
          ${stock != null ? html`<span class="sub">${stockHint(l)}</span>` : ''}</td>
        ${adj ? '' : html`<td><input data-f="hsn" value="${l.hsn || ''}" style="width:80px"></td>`}
        <td><input type="number" step="any" data-f="qty" value="${l.qty}" style="width:90px" ${adj ? 'placeholder="+ in / − out"' : ''}></td>
        <td><input data-f="unit" value="${l.unit || ''}" style="width:64px"></td>
        ${adj ? '' : html`<td><input type="number" step="0.01" min="0" data-f="rate" value="${l.rate}" style="width:100px"></td>
        <td><select data-f="gst_rate" style="width:78px" ${st.gst_mode === 'none' ? 'disabled' : ''}>${raw(options([0, 5, 12, 18, 28].map(g => [g, g + '%']), l.gst_rate))}</select></td>
        <td><input type="number" step="0.01" min="0" data-f="amount" value="${Number(l.qty) > 0 && Number(l.rate) > 0 ? lineAmount(l) : l.amount}" style="width:120px" ${Number(l.qty) > 0 && Number(l.rate) > 0 ? 'readonly' : ''}></td>`}
        <td><button type="button" class="icon-btn" data-del="${i}" aria-label="Remove line">✕</button></td></tr>`;
    });
    return String(html`
      <datalist id="itemList">${its.map(i => html`<option value="${i.name}">${i.unit} · stock ${qtyFmt(stockOf(i.id))}</option>`)}</datalist>
      <div class="table-wrap lines-table"><table><thead><tr><th>${adj ? 'Item' : 'Item / description'}</th>${adj ? '' : raw('<th>HSN/SAC</th>')}<th class="num">Qty</th><th>Unit</th>${adj ? '' : raw('<th class="num">Rate</th><th>GST</th><th class="num">Amount</th>')}<th></th></tr></thead>
      <tbody id="lineRows">${rows}</tbody></table></div>
      <div class="row between"><span class="row"><button type="button" class="btn sm" id="addLine">+ Add line</button>${adj || st.gst_mode === 'none' ? '' : html`<label class="check small"><input type="checkbox" id="inclGst" ${st.incl_gst ? 'checked' : ''}> Rates include GST</label>`}</span>${adj ? '' : raw('<div id="totals" class="totals"></div>')}</div>
      ${adj ? '' : raw(tdsRow())}`);
  }
  function tdsRow() {
    const t = st.voucher_type;
    if (!['purchase', 'expense'].includes(t)) return '';
    const who = 'TDS you deduct from this bill — Labour entries in a project only';
    return String(html`<details ${Number(st.tds_amount) ? 'open' : ''}><summary class="small muted" style="cursor:pointer">${who} (optional)</summary>
      <div class="form-grid" style="margin-top:.5rem"><label>Section<select name="tds_section">${raw(options(TDS_SECTIONS, st.tds_section))}</select></label>
      <label>Rate %<input type="number" step="0.01" min="0" name="tds_rate" value="${st.tds_rate || ''}"></label>
      <label>TDS amount<input type="number" step="0.01" min="0" name="tds_amount" value="${st.tds_amount || ''}"></label></div>
      <p class="small muted">Worked out on the value before GST. On a bill, TDS applies only to the Labour category with a project chosen; for anything else deduct TDS on the payment. Never both.</p></details>`);
  }
  function paidBlock() {
    const side = T().side === 'vendor' ? 'Paid' : 'Received';
    return String(html`<div class="form-grid">
      <label>Payment<select name="paid_now">${raw(options([['0', T().side === 'vendor' ? 'Not paid yet (on credit)' : 'Not received yet (on credit)'], ['1', side + ' in full now']], st.paid_now ? '1' : '0'))}</select></label>
      ${st.paid_now ? html`<label>Mode<select name="payment_mode">${raw(options(MODES, st.payment_mode))}</select></label>
        <label>${side} ${T().side === 'vendor' ? 'from' : 'into'}<select name="account_id" required>${raw(options(modeAccounts(), st.account_id, { blank: 'Choose account' }))}</select></label>` : ''}</div>`);
  }
  function moneyBlock() {
    const t = st.voucher_type;
    const acc = accounts().filter(a => a.active || a.id === st.account_id || a.id === st.to_account_id).map(a => [a.id, a.name]);
    const accFrom = t === 'transfer' ? acc : modeAccounts();
    const inward = ['receipt', 'capital_in'].includes(t);
    return String(html`<div class="form-grid">
      <label>${t === 'transfer' ? 'From account' : inward ? 'Received into' : 'Paid from'}<select name="account_id" required>${raw(options(accFrom, st.account_id, { blank: 'Choose account' }))}</select></label>
      ${t === 'transfer' ? html`<label>To account<select name="to_account_id" required>${raw(options(acc, st.to_account_id, { blank: 'Choose account' }))}</select></label>` : html`<label>Mode<select name="payment_mode">${raw(options(MODES, st.payment_mode))}</select></label>`}
      <label>${t === 'receipt' ? 'Amount received' : t === 'payment' ? 'Amount paid' : 'Amount'} <button type="button" class="link small" id="roundUp" title="Round up to the next whole rupee">round up</button><input type="number" step="0.01" min="0" name="cash_amount" value="${st.cash_amount}" required></label>
      ${['receipt', 'payment'].includes(t) ? html`<label>TDS ${t === 'receipt' ? 'deducted by customer' : 'you deducted'}<input type="number" step="0.01" min="0" name="tds_amount" value="${st.tds_amount || ''}" placeholder="0"></label>
        <label>TDS section<select name="tds_section">${raw(options(TDS_SECTIONS, st.tds_section))}</select></label>` : ''}
    </div>`);
  }

  // settlement of bills
  function candidateBills() {
    const targets = allocationTargets(st.voucher_type);
    if (!st.party_id || !targets.length) return [];
    return S.vouchers.filter(b => b.company_id === S.companyId && b.party_id === st.party_id && targets.includes(b.voucher_type) && !b.account_id &&
      (pending(b) + Number(st.editing ? (allocsFrom(st.id).find(a => a.to_voucher_id === b.id)?.amount || 0) : 0) > 0.004))
      .sort((a, b) => a.voucher_date.localeCompare(b.voucher_date));
  }
  const pendingFor = b => r2(pending(b) + Number(st.editing ? (allocsFrom(st.id).find(a => a.to_voucher_id === b.id)?.amount || 0) : 0));
  const grossTotal = () => {
    if (TYPES[st.voucher_type].credit) return voucherTotals(eff()).total;
    return r2(Number(st.cash_amount || 0) + Number(st.tds_amount || 0));
  };
  function renderAlloc() {
    const box = $('#allocBlock', el); if (!box) return;
    const bills = candidateBills(), credit = !!T().credit;
    for (const id of Object.keys(st.allocations)) if (!bills.some(b => b.id === id)) delete st.allocations[id];
    if (!st.party_id) { box.innerHTML = `<div class="callout">Choose the party to see their pending bills.</div>`; return; }
    if (!bills.length) {
      box.innerHTML = `<div class="callout">${credit ? 'No pending bills to apply this note to — it will stay as unapplied credit for this party.' : `This party has no pending bills. The full amount will be kept as ${T().side === 'vendor' ? 'Supplier' : 'Customer'} Advance and can be linked to a bill later.`}</div>`;
      return;
    }
    box.innerHTML = String(html`<h4 class="row between"><span>${credit ? 'Apply to bills' : 'Settle bills'} <span class="muted small">— one ${credit ? 'note' : 'payment'} can settle several bills</span></span>
      <span class="row"><button type="button" class="btn sm" id="autoAlloc">Fill oldest first</button><button type="button" class="btn sm" id="clearAlloc">Clear</button></span></h4>
      <div class="table-wrap"><table><thead><tr><th>Bill</th><th>Date</th><th>Project</th><th class="num">Bill amount</th><th class="num">Pending</th><th class="num">Settle now</th></tr></thead><tbody>
      ${bills.map(b => html`<tr><td><b>${b.voucher_no}</b>${b.ref_no ? html`<span class="sub">${b.ref_no}</span>` : ''}</td><td>${fmtDate(b.voucher_date)}</td><td>${projectName(b.project_id) || '—'}</td>
        <td class="num">${money(b.net_amount)}</td><td class="num">${money(pendingFor(b))}</td>
        <td class="num"><input type="number" step="0.01" min="0" max="${pendingFor(b)}" class="alloc" data-bill="${b.id}" value="${st.allocations[b.id] ?? ''}" style="width:130px" aria-label="Amount for ${b.voucher_no}"></td></tr>`)}
      </tbody></table></div><div id="allocSummary" class="alloc-summary"></div>`);
    $('#autoAlloc', box).onclick = () => { st.allocations = autoAllocate(grossTotal(), bills, pendingFor); renderAlloc(); };
    $('#clearAlloc', box).onclick = () => { st.allocations = {}; renderAlloc(); };
    $$('.alloc', box).forEach(inp => inp.oninput = () => { st.allocations[inp.dataset.bill] = inp.value === '' ? undefined : Number(inp.value); if (inp.value === '') delete st.allocations[inp.dataset.bill]; allocSummary(); });
    allocSummary();
  }
  function allocSummary() {
    const box = $('#allocSummary', el); if (!box) return;
    const total = grossTotal(), used = sum(Object.values(st.allocations), x => x), left = r2(total - used);
    const over = left < -0.004, credit = !!T().credit;
    const overBill = candidateBills().find(b => Number(st.allocations[b.id] || 0) > pendingFor(b) + 0.004);
    box.className = 'alloc-summary' + (over || overBill ? ' over' : '');
    box.innerHTML = String(html`<span>${credit ? 'Note total' : 'Total settled (amount + TDS)'}: ${money(total)}</span><span>Linked to bills: ${money(used)}</span>
      <span>${over ? 'Over by ' + money(-left) : overBill ? overBill.voucher_no + ' has only ' + money(pendingFor(overBill)) + ' pending' : (credit ? 'Unapplied credit: ' : (T().side === 'vendor' ? 'Supplier' : 'Customer') + ' Advance: ') + money(left)}</span>`);
  }

  function renderTotals() {
    const box = $('#totals', el); if (!box) return;
    const tt = voucherTotals(eff()), tds = Number(st.tds_amount || 0);
    box.innerHTML = String(html`<span class="muted">Taxable value</span><span class="num">${money(tt.taxable)}</span>
      ${st.gst_mode === 'intra' ? html`<span class="muted">CGST</span><span class="num">${money(tt.cgst)}</span><span class="muted">SGST</span><span class="num">${money(tt.sgst)}</span>` : ''}
      ${st.gst_mode === 'inter' ? html`<span class="muted">IGST</span><span class="num">${money(tt.igst)}</span>` : ''}
      <span class="muted">Round off <button type="button" class="link small" id="autoRound">round</button></span><span><input type="number" step="0.01" name="round_off" value="${st.round_off || ''}" style="width:90px;text-align:right" placeholder="0.00"></span>
      <span class="big">Total</span><span class="num big">${money(tt.total)}</span>
      ${tds ? html`<span class="muted">Less TDS</span><span class="num">${money(-tds)}</span><span><b>Net ${T().side === 'vendor' ? 'payable' : 'receivable'}</b></span><span class="num"><b>${money(tt.total - tds)}</b></span>` : ''}`);
    const ro = $('[name=round_off]', box);
    ro.oninput = () => { st.round_off = Number(ro.value || 0); renderTotalsKeepFocus(); };
    $('#autoRound', box).onclick = () => { const raw0 = r2(tt.total - Number(st.round_off || 0)); st.round_off = r2(Math.round(raw0) - raw0); renderTotals(); allocSummary(); };
  }
  function renderTotalsKeepFocus() {
    const pos = document.activeElement?.name === 'round_off';
    renderTotals(); allocSummary();
    if (pos) { const i = $('[name=round_off]', el); i.focus(); const n = i.value.length; try { i.setSelectionRange(n, n); } catch { } }
  }

  function setParty(p) {
    st.party_id = p?.id || null;
    $('#partyInput', el).value = p?.name || '';
    $('#partySuggest', el).classList.add('hidden');
    // GST mode follows the party's state when known
    const c = company();
    if (p && st.voucher_type === 'purchase' && !p.gstin && st.gst_mode !== 'none') {
      st.gst_mode = 'none'; const sel = $('[name=gst_mode]', el); if (sel) sel.value = 'none'; refreshLines();
      toast('No GSTIN for this supplier — GST set to "No GST". Change it if the bill shows GST.');
    } else if (p?.gstin && st.voucher_type === 'purchase' && st.gst_mode === 'none') { st.gst_mode = 'intra'; }
    if (p?.state_code && c.state_code && T().lines && st.voucher_type !== 'stock_adjust' && st.gst_mode !== 'none') {
      st.gst_mode = p.state_code === c.state_code ? 'intra' : 'inter';
      const sel = $('[name=gst_mode]', el); if (sel) sel.value = st.gst_mode;
      refreshLines();
    }
    st.allocations = {}; renderAlloc();
  }

  function wire() {
    const f = $('#entryForm', el);
    $$('[data-type]', el).forEach(b => b.onclick = () => {
      const keep = { voucher_date: st.voucher_date, project_id: st.project_id };
      Object.assign(st, fresh(b.dataset.type), keep);
      history.replaceState(null, '', '#/new?type=' + b.dataset.type);
      render();
    });
    $('#cancelEdit', el)?.addEventListener('click', () => history.back());
    $('#clearBtn', el)?.addEventListener('click', () => { Object.assign(st, fresh(st.voucher_type)); render(); });

    // party search
    const pin = $('#partyInput', el), sug = $('#partySuggest', el);
    if (pin) {
      let hi = 0;
      const side = T().side;
      const list = () => {
        const q = pin.value.trim().toLowerCase();
        return parties().filter(p => p.active && (!side || p.kind === 'both' || p.kind === side || p.id === st.party_id) && (!q || p.name.toLowerCase().includes(q))).slice(0, 12);
      };
      const show = () => {
        const L = list(); hi = Math.min(hi, Math.max(0, L.length - 1));
        sug.innerHTML = L.length ? L.map((p, i) => `<button type="button" data-id="${p.id}" class="${i === hi ? 'hi' : ''}"><span>${esc(p.name)}</span><span class="muted small">${esc(p.gstin || p.kind)}</span></button>`).join('')
          : `<div class="small muted" style="padding:.6rem">No match. Use “+ New” to add “${esc(pin.value)}”.</div>`;
        sug.classList.remove('hidden');
        $$('button', sug).forEach(b => b.onmousedown = e => { e.preventDefault(); setParty(parties().find(p => p.id === b.dataset.id)); });
      };
      pin.onfocus = show; pin.oninput = () => { hi = 0; st.party_id = null; show(); renderAlloc(); };
      pin.onblur = () => setTimeout(() => {
        sug.classList.add('hidden');
        if (!st.party_id && pin.value.trim()) { const exact = parties().find(p => p.name.toLowerCase() === pin.value.trim().toLowerCase()); if (exact) setParty(exact); }
      }, 120);
      pin.onkeydown = e => {
        const L = list();
        if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, L.length - 1); show(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); show(); e.preventDefault(); }
        else if (e.key === 'Enter' && L[hi] && !sug.classList.contains('hidden')) { e.preventDefault(); setParty(L[hi]); }
      };
      if ($('#addPartyBtn', el)) $('#addPartyBtn', el).onclick = () => quickParty(pin.value.trim(), side, p => setParty(p));
    }

    // simple fields
    f.addEventListener('input', e => {
      const n = e.target.name; if (!n) return;
      if (['voucher_date', 'ref_no', 'notes', 'doc_url'].includes(n)) st[n] = e.target.value;
      if (n === 'cash_amount') { st.cash_amount = e.target.value; allocSummary(); }
      if (n === 'tds_amount') { st.tds_amount = Number(e.target.value || 0); allocSummary(); if (T().lines) renderTotalsKeepFocusTds(); }
      if (n === 'tds_rate') { st.tds_rate = Number(e.target.value || 0); const tt = voucherTotals(eff()); st.tds_amount = r2(tt.taxable * st.tds_rate / 100); const a = $('[name=tds_amount]', f); if (a) a.value = st.tds_amount || ''; renderTotals(); }
    });
    f.addEventListener('change', e => {
      const n = e.target.name; if (!n) return;
      if (n === 'category_id' && e.target.value === '__new__') { newCategory(e.target); return; }
      if (['project_id', 'category_id', 'account_id', 'to_account_id', 'payment_mode', 'tds_section'].includes(n)) st[n] = e.target.value || null;
      if (n === 'payment_mode') {
        const sel = $('[name=account_id]', f), list = modeAccounts();
        if (sel && st.voucher_type !== 'transfer') { if (!list.some(([id]) => id === st.account_id)) st.account_id = list.length === 1 ? list[0][0] : null; sel.innerHTML = options(list, st.account_id, { blank: 'Choose account' }); }
      }
      if (n === 'project_id') ownerNote();
      if (n === 'gst_mode') { st.gst_mode = e.target.value; refreshLines(); }
      if (n === 'paid_now') { st.paid_now = e.target.value === '1'; if (!st.paid_now) st.account_id = null; render(); }
    });
    wireLines();
    $('#roundUp', el)?.addEventListener('click', () => {
      const a = Number(st.cash_amount || 0); if (!a) return toast('Enter a payment amount before rounding it up.', 'error');
      st.cash_amount = String(Math.ceil(a - 0.0001)); $('[name=cash_amount]', f).value = st.cash_amount; allocSummary();
    });
    ownerNote();
    f.onsubmit = e => { e.preventDefault(); save(); };
  }
  // payments/expenses for another company's project are booked in that company (old-app "project company" rule)
  function ownerNote() {
    const box = $('#ownerNote', el); if (!box) return;
    const pr = S.projects.find(x => x.id === st.project_id), owner = pr?.owner_company_id;
    box.innerHTML = !st.editing && ['payment', 'expense'].includes(st.voucher_type) && owner && owner !== S.companyId
      ? `<div class="callout">${esc(pr.name)} belongs to <b>${esc(companyName(owner))}</b>. Saving books this ${st.voucher_type} there as “Paid directly by ${esc(company().name)}”, and records it here as money sent to ${esc(companyName(owner))}.${st.voucher_type === 'payment' ? ' Bill links are not carried over.' : ''}</div>` : '';
  }
  function newCategory(sel) {
    const m = modal('New category', `<form class="stack"><label>Name<input name="name" required></label><div class="row end"><button class="btn primary">Add</button></div></form>`);
    m.el.querySelector('form').onsubmit = async ev => {
      ev.preventDefault();
      try {
        const [c] = await S.backend.insert('categories', { company_id: S.companyId, name: ev.target.name.value.trim(), kind: 'expense' });
        S.categories.push(c); st.category_id = c.id; m.close();
        sel.innerHTML = options(categories().filter(x => x.active).map(x => [x.id, x.name]).concat([['__new__', '+ New category…']]), c.id, { blank: '—' });
      } catch (err) { toast(errorText(err), 'error'); }
    };
    sel.value = st.category_id || '';
  }
  function renderTotalsKeepFocusTds() { renderTotals(); }

  function refreshLines() {
    const box = $('#linesBox', el); if (!box) return;
    box.innerHTML = linesBlock();
    wireLines(); renderTotals(); allocSummary();
  }
  function wireLines() {
    const tb = $('#lineRows', el); if (!tb) return;
    $('#addLine', el).onclick = () => { st.lines.push({ ...blankLine(), gst_rate: st.lines.at(-1)?.gst_rate ?? 18 }); refreshLines(); $$('#lineRows tr', el).at(-1)?.querySelector('input')?.focus(); };
    const ig = $('#inclGst', el); if (ig) ig.onchange = () => { st.incl_gst = ig.checked; renderTotals(); allocSummary(); };
    $$('[data-del]', tb).forEach(b => b.onclick = () => { st.lines.splice(Number(b.dataset.del), 1); if (!st.lines.length) st.lines.push(blankLine()); refreshLines(); });
    tb.oninput = e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const l = st.lines[Number(tr.dataset.i)], fld = e.target.dataset.f;
      if (fld === 'item') {
        const it = items().find(i => i.name.toLowerCase() === e.target.value.trim().toLowerCase());
        if (it) { l.item_id = it.id; l.description = it.name; l.unit = it.unit; l.hsn = it.hsn || l.hsn; if (it.gst_rate != null) l.gst_rate = Number(it.gst_rate); refreshRow(tr, l); }
        else { l.item_id = null; l.description = e.target.value; }
        return;
      }
      l[fld] = e.target.value;
      if (fld === 'qty' || fld === 'rate') { const a = tr.querySelector('[data-f=amount]'); if (a) { const auto = Number(l.qty) > 0 && Number(l.rate) > 0; a.readOnly = auto; if (auto) a.value = lineAmount(l); } }
      if (st.tds_rate && T().lines) { st.tds_amount = r2(voucherTotals(eff()).taxable * st.tds_rate / 100); const ta = $('[name=tds_amount]', el); if (ta) ta.value = st.tds_amount || ''; }
      renderTotals(); allocSummary();
    };
    tb.onchange = e => { if (e.target.dataset.f === 'gst_rate') { st.lines[Number(e.target.closest('tr').dataset.i)].gst_rate = Number(e.target.value); renderTotals(); allocSummary(); } };
  }
  function refreshRow(tr, l) {
    for (const k of ['hsn', 'unit']) { const i = tr.querySelector(`[data-f=${k}]`); if (i) i.value = l[k] || ''; }
    const g = tr.querySelector('[data-f=gst_rate]'); if (g) g.value = l.gst_rate;
    const td = tr.querySelector('.desc'); let s = td.querySelector('.sub');
    if (!s) { s = document.createElement('span'); s.className = 'sub'; td.append(s); }
    s.textContent = stockHint(l);
    renderTotals(); allocSummary();
  }

  async function save() {
    const msg = $('#formMsg', el), btn = $('#saveBtn', el); msg.textContent = '';
    const t = st.voucher_type, def = T();
    const p = {
      id: st.editing ? st.id : undefined, company_id: S.companyId, voucher_type: t, voucher_date: st.voucher_date, ref_no: st.ref_no, party_id: st.party_id,
      project_id: st.project_id, category_id: st.category_id, notes: st.notes, doc_url: st.doc_url, payment_mode: st.payment_mode,
      tds_section: st.tds_section, tds_rate: st.tds_rate, tds_amount: Number(st.tds_amount || 0),
    };
    if (st.doc_url && !/^https?:\/\//i.test(st.doc_url)) return fail('The document link must start with https://');
    const pinVal = $('#partyInput', el)?.value.trim();
    if (pinVal && !st.party_id) return fail(`“${pinVal}” is not in your party list. Pick it from the list or use “+ New”.`);
    if (def.lines) {
      p.gst_mode = t === 'stock_adjust' ? 'none' : st.gst_mode; p.round_off = Number(st.round_off || 0);
      p.lines = exLines().filter(l => l.item_id || String(l.description || '').trim() || Number(l.amount) || Number(l.qty)).map(l => ({
        item_id: l.item_id, description: l.description, hsn: l.hsn, qty: Number(l.qty) || 0, unit: l.unit, rate: Number(l.rate) || 0, gst_rate: Number(l.gst_rate) || 0, amount: lineAmount(l) }));
      if (!p.lines.length) return fail('Add at least one line.');
      const legacyFree = st.editing && (voucher(st.id)?.lines || []).some(l => !l.item_id) && t !== 'stock_adjust';
      if (!legacyFree && p.lines.some(l => !l.item_id) && ['stock_adjust', 'purchase', 'sale', 'challan'].includes(t)) return fail(`Every line must be an inventory item (${p.lines.find(l => !l.item_id).description || 'blank line'}). Pick it from the list, or add it in Inventory first.`);
      if (['purchase', 'expense'].includes(t) && Number(st.tds_amount) && (!st.project_id || categoryName(st.category_id).toLowerCase() !== 'labour')) return fail('TDS on a bill applies only to Labour entries in a project. Otherwise deduct TDS on the payment.');
      const ref = String(st.ref_no || '').trim().toLowerCase();
      if (ref && ['purchase', 'sale', 'challan', 'customer_credit', 'supplier_credit'].includes(t)) {
        const dup = S.vouchers.find(x => x.company_id === S.companyId && x.voucher_type === t && x.id !== st.id && String(x.ref_no || '').trim().toLowerCase() === ref && (['sale', 'challan'].includes(t) || x.party_id === st.party_id));
        if (dup) return fail(`Duplicate ${def.label} number ${st.ref_no.trim()} already exists as ${dup.voucher_no}.`);
      }
      if (def.credit && (!ref || !String(st.notes || '').trim())) return fail('Enter the credit note number (reference) and the reason in Notes.');
      if (def.bill) { p.account_id = st.paid_now ? st.account_id : null; if (st.paid_now && !p.account_id) return fail('Choose the account it was paid from / received into.'); }
      // stock check
      const c = company();
      if (!c.allow_negative_stock) {
        for (const l of p.lines.filter(x => x.item_id)) {
          const sign = TYPES[t].stock || 0; if (sign >= 0 && t !== 'stock_adjust') continue;
          const before = stockOf(l.item_id) - (st.editing ? sum((voucher(st.id)?.lines || []).filter(x => x.item_id === l.item_id), x => (TYPES[t].stock || 0) * x.qty) : 0);
          const after = before + (t === 'stock_adjust' ? l.qty : sign * l.qty);
          if (after < -0.0005) return fail(`Not enough stock of ${l.description}: only ${qtyFmt(before)} available. (Allow negative stock in Company settings if needed.)`);
        }
      }
    } else {
      p.account_id = st.account_id; p.to_account_id = t === 'transfer' ? st.to_account_id : null;
      p.total_amount = r2(Number(st.cash_amount || 0) + (['receipt', 'payment'].includes(t) ? Number(st.tds_amount || 0) : 0));
      if (!['receipt', 'payment'].includes(t)) p.tds_amount = 0;
      if (!p.account_id) return fail(accounts().some(a => a.kind !== 'cash' && a.active) || st.payment_mode === 'cash' ? 'Choose the cash / bank account.' : 'Add or activate a bank / UPI account first (Cash & Bank).');
      if (!(Number(st.cash_amount) > 0)) return fail('Enter the amount.');
    }
    if (def.settles || def.credit) {
      p.allocations = Object.entries(st.allocations).filter(([, a]) => Number(a) > 0).map(([to_voucher_id, amount]) => ({ to_voucher_id, amount: r2(amount) }));
      const used = sum(p.allocations, a => a.amount), total = def.credit ? voucherTotals({ ...eff(), gst_mode: p.gst_mode }).total : p.total_amount;
      if (used > total + 0.004) return fail('Bills linked add up to more than this entry. Reduce the amounts.');
      if (def.credit && !p.allocations.length) return fail('Select the original bill this note is against.');
      if (def.credit && Math.abs(used - total) > 0.004) return fail(`Apply the full note (${money(total)}) to the original bill${p.allocations.length > 1 ? 's' : ''}. A credit note cannot exceed the bill balance.`);
      if (def.credit && p.allocations.some(a => voucher(a.to_voucher_id)?.voucher_date > st.voucher_date)) return fail('A credit note cannot be dated before the original bill.');
    }
    // budget check: warn when this cost takes the project above its BOQ budget
    if (['purchase', 'expense'].includes(t) && st.project_id) {
      const budget = sum(S.budget.filter(b => b.project_id === st.project_id && b.kind === 'cost'), b => b.qty * b.rate);
      if (budget > 0) {
        const gc = new Set(groupCompanies().map(c => c.id));
        const spent = sum(S.vouchers.filter(v => v.project_id === st.project_id && gc.has(v.company_id) && v.id !== st.id), v => { const e = plEffect(v); return (e.purchases || 0) + (e.expenses || 0); });
        const after = r2(spent + voucherTotals(eff()).taxable);
        if (after > budget + 0.004 && !await confirmBox(`This takes ${projectName(st.project_id)} to ${money(after)} of cost, over its budget of ${money(budget)} by ${money(after - budget)}. Save anyway?`, { ok: 'Save anyway' })) return;
      }
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const saved = await S.backend.rpc('save_voucher', { p });
      await reload();
      toast(`${def.label} ${saved.voucher_no} saved`);
      if (st.editing) { history.back(); setTimeout(() => viewVoucher(saved.id), 50); }
      else afterSave(saved);
    } catch (err) { fail(errorText(err)); btn.disabled = false; btn.textContent = st.editing ? 'Save changes' : 'Save entry'; }
    function fail(m) { msg.textContent = m; msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  function afterSave(saved) {
    // reload() re-rendered the page; show a little confirmation bar with next steps
    const bar = document.createElement('div');
    bar.className = 'card row between';
    bar.innerHTML = String(html`<span><b>Saved ${saved.voucher_no}.</b> <span class="muted">Ready for the next ${TYPES[saved.voucher_type].label.toLowerCase()}.</span></span>
      <span class="row"><button class="btn sm" data-a="view">View</button>${SALES_BILLS.includes(saved.voucher_type) ? raw('<button class="btn sm" data-a="print">Print</button>') : ''}</span>`);
    const view = document.getElementById('view');
    view.querySelector('.page-head')?.after(bar);
    bar.querySelector('[data-a=view]').onclick = () => viewVoucher(saved.id);
    bar.querySelector('[data-a=print]')?.addEventListener('click', () => printVoucher(voucher(saved.id)));
  }

  render();
}

// Add a party without leaving the entry
export function quickParty(name, side, done) {
  const m = modal('Add party', String(html`<form class="stack"><label>Name<input name="name" value="${name}" required></label>
    <div class="form-grid"><label>Type<select name="kind">${raw(options([['customer', 'Customer'], ['vendor', 'Supplier / vendor'], ['both', 'Both']], side || 'both'))}</select></label>
    <label>Phone<input name="phone" inputmode="tel"></label><label>GSTIN<input name="gstin" maxlength="15" style="text-transform:uppercase"></label>
    <label>State code<input name="state_code" maxlength="2" placeholder="from GSTIN"></label></div>
    <p class="msg error" role="alert"></p><div class="row end"><button class="btn primary">Save party</button></div></form>`));
  const f = m.el.querySelector('form');
  f.gstin.oninput = () => { const g = f.gstin.value.trim().toUpperCase(); if (/^\d{2}/.test(g) && !f.state_code.value) f.state_code.value = g.slice(0, 2); };
  f.onsubmit = async e => {
    e.preventDefault(); const d = formData(f);
    if (d.gstin) d.gstin = d.gstin.toUpperCase();
    if (d.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(d.gstin)) { f.querySelector('.msg').textContent = 'That GSTIN does not look right (15 characters, e.g. 27ABCDE1234F1Z5).'; return; }
    try {
      const [p] = await S.backend.insert('parties', { company_id: S.companyId, ...d });
      S.parties.push(p); S.parties.sort((a, b) => a.name.localeCompare(b.name));
      m.close(); toast('Party added'); done(p);
    } catch (err) { f.querySelector('.msg').textContent = errorText(err); }
  };
}

// ───────── View one entry ─────────
export function viewVoucher(id) {
  const v = voucher(id); if (!v) return toast('Entry not found', 'error');
  const T = TYPES[v.voucher_type], st = voucherStatus(v);
  const links = [...allocsFrom(v.id).map(a => ({ a, other: voucher(a.to_voucher_id) })), ...allocsTo(v.id).map(a => ({ a, other: voucher(a.from_voucher_id) }))];
  const pair = v.transfer_group_id ? S.vouchers.find(x => x.transfer_group_id === v.transfer_group_id && x.id !== v.id) : null;
  const sameCo = v.company_id === S.companyId;
  const body = html`
    <div class="row between"><div><span class="badge">${T.label}</span> <span class="badge ${st.cls}">${st.text}</span></div><b class="mono">${v.voucher_no}</b></div>
    <div class="form-grid" style="margin:1rem 0">
      ${[['Date', fmtDate(v.voucher_date)], ['Company', companyName(v.company_id)], ['Party', partyName(v.party_id)], ['Project', projectName(v.project_id)], ['Category', categoryName(v.category_id)],
        ['Reference', v.ref_no], [v.voucher_type === 'transfer' ? 'From account' : 'Account', accountName(v.account_id)], ['To account', accountName(v.to_account_id)], ['Mode', v.payment_mode]]
        .filter(([, x]) => x).map(([k, x]) => html`<div><div class="small muted">${k}</div><b>${x}</b></div>`)}
    </div>
    ${(v.lines || []).length ? raw(table2(v)) : ''}
    <div class="totals" style="margin-top:.75rem">
      ${T.lines && v.voucher_type !== 'stock_adjust' ? html`<span class="muted">Taxable</span><span class="num">${money(v.taxable_amount)}</span>
        ${Number(v.cgst_amount) ? html`<span class="muted">CGST + SGST</span><span class="num">${money(Number(v.cgst_amount) + Number(v.sgst_amount))}</span>` : ''}
        ${Number(v.igst_amount) ? html`<span class="muted">IGST</span><span class="num">${money(v.igst_amount)}</span>` : ''}
        ${Number(v.round_off) ? html`<span class="muted">Round off</span><span class="num">${money(v.round_off)}</span>` : ''}` : ''}
      ${v.voucher_type !== 'stock_adjust' ? html`<span class="big">Total</span><span class="num big">${money(v.total_amount)}</span>` : ''}
      ${Number(v.tds_amount) ? html`<span class="muted">TDS ${v.tds_section || ''}</span><span class="num">${money(-v.tds_amount)}</span><b>${T.money ? 'Cash moved' : 'Net due'}</b><b class="num">${money(v.net_amount)}</b>` : ''}
    </div>
    ${links.length ? html`<h4 style="margin-top:1rem">Linked ${T.settles || T.credit ? 'bills' : 'payments & notes'}</h4>
      <div class="table-wrap"><table><tbody>${links.map(({ a, other }) => other ? html`<tr class="click" data-open="${other.id}"><td><b>${other.voucher_no}</b><span class="sub">${TYPES[other.voucher_type].label}</span></td><td>${fmtDate(other.voucher_date)}</td><td class="num">${money(a.amount)}</td></tr>` : html`<tr><td class="muted" colspan="2">Entry outside your projects</td><td class="num">${money(a.amount)}</td></tr>`)}</tbody></table></div>` : ''}
    ${T.bill && !v.account_id ? html`<p class="small">Pending: <b>${money(pending(v))}</b></p>` : ''}
    ${(T.settles || T.credit) && unalloc(v) > 0.004 ? html`<p class="small">Not linked to any bill: <b>${money(unalloc(v))}</b> (${T.credit ? 'unapplied credit' : 'advance'})</p>` : ''}
    ${pair ? html`<p class="small">Matching entry: <b>${pair.voucher_no}</b> in ${companyName(pair.company_id)}</p>` : ''}
    ${v.notes ? html`<p class="small muted">${v.notes}</p>` : ''}
    ${v.doc_url && /^https?:\/\//i.test(v.doc_url) ? html`<p class="small"><a href="${v.doc_url}" target="_blank" rel="noopener">Open attached document ↗</a></p>` : ''}
    <p class="small muted">Created ${fmtDate(v.created_at?.slice(0, 10))} by ${userEmail(v.created_by)}${v.updated_at && v.updated_at !== v.created_at ? ' · last changed ' + fmtDate(v.updated_at.slice(0, 10)) : ''}</p>
    <div class="row end gap no-print">
      ${sameCo && isAdmin() && !v.transfer_group_id && groupCompanies().length > 1 ? raw('<button class="btn" data-act="move">Move to company…</button>') : ''}
      ${sameCo && isAdmin() && v.voucher_type === 'expense' && v.account_id && !v.transfer_group_id && !links.length && groupCompanies().length > 1 ? raw('<button class="btn" data-act="allocate">Allocate to company…</button>') : ''}
      ${sameCo && canDelete() ? raw('<button class="btn danger" data-act="delete">Delete</button>') : ''}
      <button class="btn" data-act="print">Print</button>
      ${sameCo && canSaveType(v.voucher_type) && !v.transfer_group_id ? raw('<button class="btn primary" data-act="edit">Edit</button>') : ''}
    </div>`;
  const m = modal(`${T.label} ${v.voucher_no}`, String(body), { wide: true });
  m.el.addEventListener('click', async e => {
    const o = e.target.closest('[data-open]'); if (o) { m.close(); viewVoucher(o.dataset.open); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'edit') { m.close(); go('edit/' + v.id); }
    if (act === 'print') printVoucher(v);
    if (['delete', 'move', 'allocate'].includes(act) && !await requireAdminPin(act === 'delete' ? 'delete this entry' : 'move this entry')) return;
    if (act === 'allocate') {
      const others = groupCompanies().filter(c => c.id !== v.company_id);
      const mm = modal('Allocate expense to another company', `<form class="stack"><label>Company<select name="c">${options(others.map(c => [c.id, c.name]))}</select></label><p class="small muted">The payment stays in ${esc(companyName(v.company_id))} as money sent to that company. The expense is booked there as paid directly by ${esc(companyName(v.company_id))}.</p><button class="btn primary">Allocate</button></form>`);
      mm.el.querySelector('form').onsubmit = async ev => {
        ev.preventDefault();
        try { await S.backend.rpc('allocate_expense', { p_id: v.id, p_company: ev.target.c.value }); mm.close(); m.close(); await reload(); toast('Expense allocated'); } catch (err) { toast(errorText(err), 'error'); }
      };
    }
    if (act === 'delete') {
      const extra = links.length ? ' Its links to other bills/payments will be removed (payments become advances again).' : '';
      if (!await confirmBox(`Delete ${v.voucher_no}?${extra} This is recorded in the change history.`, { ok: 'Delete', danger: true })) return;
      try { await S.backend.rpc('delete_voucher', { p_id: v.id }); m.close(); await reload(); toast('Entry deleted'); } catch (err) { toast(errorText(err), 'error'); }
    }
    if (act === 'move') {
      const others = groupCompanies().filter(c => c.id !== v.company_id);
      const mm = modal('Move entry to another company', `<form class="stack"><label>Company<select name="c">${options(others.map(c => [c.id, c.name]))}</select></label><p class="small muted">The party is matched by name in the other company (created if missing). Category is cleared. A new entry number is given.</p><button class="btn primary">Move</button></form>`);
      mm.el.querySelector('form').onsubmit = async ev => {
        ev.preventDefault();
        try { await S.backend.rpc('move_voucher', { p_id: v.id, p_company: ev.target.c.value }); mm.close(); m.close(); await reload(); toast('Entry moved'); } catch (err) { toast(errorText(err), 'error'); }
      };
    }
  });
}
function table2(v) {
  const adj = v.voucher_type === 'stock_adjust';
  return String(html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Description</th>${adj ? '' : raw('<th>HSN</th>')}<th class="num">Qty</th><th>Unit</th>${adj ? '' : raw('<th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th>')}</tr></thead><tbody>
    ${v.lines.map((l, i) => html`<tr><td>${i + 1}</td><td>${l.description || ''}</td>${adj ? '' : html`<td>${l.hsn || ''}</td>`}<td class="num">${qtyFmt(l.qty) === '0' ? '' : qtyFmt(l.qty)}</td><td>${l.unit || ''}</td>
      ${adj ? '' : html`<td class="num">${Number(l.rate) ? money(l.rate) : ''}</td><td class="num">${l.gst_rate}%</td><td class="num">${money(l.amount)}</td>`}</tr>`)}</tbody></table></div>`);
}

// Printable document — tax invoice layout for sales, simple voucher for the rest
export function printVoucher(v) {
  const c = S.companies.find(x => x.id === v.company_id), p = S.parties.find(x => x.id === v.party_id), T = TYPES[v.voucher_type];
  const title = v.voucher_type === 'sale' || v.voucher_type === 'service' ? (Number(v.cgst_amount) + Number(v.igst_amount) > 0 ? 'Tax Invoice' : 'Invoice') : T.label;
  const gstRows = Number(v.igst_amount) ? `<tr><td colspan="6" class="num">IGST</td><td class="num">${money(v.igst_amount)}</td></tr>` :
    Number(v.cgst_amount) ? `<tr><td colspan="6" class="num">CGST</td><td class="num">${money(v.cgst_amount)}</td></tr><tr><td colspan="6" class="num">SGST</td><td class="num">${money(v.sgst_amount)}</td></tr>` : '';
  const body = String(html`
    <div class="inv-head"><div><h2 style="margin:0">${c.name}</h2>${c.address ? html`<div>${c.address}</div>` : ''}${c.gstin ? html`<div>GSTIN: <b>${c.gstin}</b></div>` : ''}${c.phone ? html`<div>${c.phone}</div>` : ''}</div>
      <div class="inv-box"><div>No: <b>${v.voucher_no}</b></div><div>Date: <b>${fmtDate(v.voucher_date)}</b></div>${v.ref_no ? html`<div>Ref: ${v.ref_no}</div>` : ''}${v.project_id ? html`<div>Project: ${projectName(v.project_id)}</div>` : ''}</div></div>
    ${p ? html`<div class="inv-box" style="margin-bottom:10px"><div class="small">${T.side === 'vendor' ? 'Supplier' : 'Bill to'}</div><b>${p.name}</b>${p.address ? html`<div>${p.address}</div>` : ''}${p.gstin ? html`<div>GSTIN: ${p.gstin}</div>` : ''}</div>` : ''}
    ${(v.lines || []).length ? html`<table><thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead><tbody>
      ${v.lines.map((l, i) => html`<tr><td>${i + 1}</td><td>${l.description || ''}</td><td>${l.hsn || ''}</td><td class="num">${Number(l.qty) ? qtyFmt(l.qty) : ''}</td><td>${l.unit || ''}</td><td class="num">${Number(l.rate) ? money(l.rate) : ''}</td><td class="num">${money(l.amount)}</td></tr>`)}
      <tr><td colspan="6" class="num">Taxable value</td><td class="num">${money(v.taxable_amount)}</td></tr>${raw(gstRows)}
      ${Number(v.round_off) ? html`<tr><td colspan="6" class="num">Round off</td><td class="num">${money(v.round_off)}</td></tr>` : ''}
      <tr><th colspan="6" class="num">Total</th><th class="num">${money(v.total_amount)}</th></tr></tbody></table>`
      : html`<table><tbody><tr><td>Amount</td><td class="num"><b>${money(v.total_amount)}</b></td></tr>${Number(v.tds_amount) ? html`<tr><td>TDS ${v.tds_section || ''}</td><td class="num">${money(v.tds_amount)}</td></tr><tr><td>Paid / received</td><td class="num">${money(v.net_amount)}</td></tr>` : ''}
        ${v.account_id ? html`<tr><td>Account</td><td>${accountName(v.account_id)}${v.to_account_id ? ' → ' + accountName(v.to_account_id) : ''}</td></tr>` : ''}</tbody></table>`}
    <p><b>${amountInWords(v.total_amount)}</b></p>
    ${allocsFrom(v.id).length ? html`<p>Against: ${allocsFrom(v.id).map(a => (voucher(a.to_voucher_id)?.voucher_no || 'bill') + ' (' + money(a.amount) + ')').join(', ')}</p>` : ''}
    ${v.notes ? html`<p>${v.notes}</p>` : ''}
    ${SALES_BILLS.includes(v.voucher_type) && c.bank_details ? html`<div class="inv-box"><b>Bank details</b><div style="white-space:pre-line">${c.bank_details}</div></div>` : ''}
    ${SALES_BILLS.includes(v.voucher_type) && c.invoice_terms ? html`<p class="small" style="white-space:pre-line">${c.invoice_terms}</p>` : ''}
    <div style="display:flex;justify-content:space-between;margin-top:40px"><span>Receiver's signature</span><span>For ${c.name}<br><br><br>Authorised signatory</span></div>`);
  printHTML(title, body);
}
