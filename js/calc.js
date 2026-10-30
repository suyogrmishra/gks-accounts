// Pure accounting calculations shared by every screen (and by demo mode).
// Amounts are rounded to paise with r2(); never compare floats without it.

export const r2 = n => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
export const sum = (rows, f) => r2(rows.reduce((s, x) => s + (Number(f(x)) || 0), 0));

export const TYPES = {
  sale:            { label: 'Sale Invoice',          short: 'Sale',        side: 'customer', bill: true,  lines: true,  stock: -1, prefix: 'SAL' },
  service:         { label: 'Service Invoice',       short: 'Service',     side: 'customer', bill: true,  lines: true,  stock: 0,  prefix: 'SRV' },
  challan:         { label: 'Delivery Challan',      short: 'Challan',     side: 'customer', bill: true,  lines: true,  stock: -1, prefix: 'DC' },
  purchase:        { label: 'Purchase Bill',         short: 'Purchase',    side: 'vendor',   bill: true,  lines: true,  stock: 1,  prefix: 'PUR' },
  expense:         { label: 'Expense',               short: 'Expense',     side: 'vendor',   bill: true,  lines: true,  stock: 0,  prefix: 'EXP' },
  customer_credit: { label: 'Credit Note — Customer', short: 'Cust. Credit', side: 'customer', credit: true, lines: true, stock: 1, prefix: 'CNC' },
  supplier_credit: { label: 'Debit Note — Supplier',  short: 'Supp. Debit', side: 'vendor',   credit: true, lines: true, stock: -1, prefix: 'CNS' },
  receipt:         { label: 'Payment Received',      short: 'Receipt',     side: 'customer', money: true, settles: true, prefix: 'RCT' },
  payment:         { label: 'Payment Made',          short: 'Payment',     side: 'vendor',   money: true, settles: true, prefix: 'PAY' },
  transfer:        { label: 'Account Transfer',      short: 'Transfer',    money: true, prefix: 'TRF' },
  capital_in:      { label: 'Capital Introduced',    short: 'Capital In',  money: true, prefix: 'CAP' },
  capital_out:     { label: 'Partner Withdrawal',    short: 'Withdrawal',  money: true, prefix: 'DRW' },
  interco_out:     { label: 'Transfer to Group Co.', short: 'Inter-co Out', money: true, prefix: 'ICO' },
  interco_in:      { label: 'Transfer from Group Co.', short: 'Inter-co In', money: true, prefix: 'ICI' },
  stock_adjust:    { label: 'Stock Adjustment',      short: 'Stock Adj.',  lines: true, stock: 1, prefix: 'ADJ' },
};
export const SALES_BILLS = ['sale', 'service', 'challan'];
export const PURCHASE_BILLS = ['purchase', 'expense'];
export const BILL_TYPES = [...SALES_BILLS, ...PURCHASE_BILLS];
export const allocationTargets = t =>
  ['receipt', 'customer_credit'].includes(t) ? SALES_BILLS : ['payment', 'supplier_credit'].includes(t) ? PURCHASE_BILLS : [];

export function fyLabel(date, startMonth = 4) {
  const d = new Date(date + 'T00:00:00'), y = d.getFullYear(), m = d.getMonth() + 1;
  const a = m >= startMonth ? y : y - 1;
  return String(a % 100).padStart(2, '0') + '-' + String((a + 1) % 100).padStart(2, '0');
}
export function fyRange(label, startMonth = 4) {
  const a = 2000 + Number(label.slice(0, 2));
  const s = new Date(Date.UTC(a, startMonth - 1, 1)), e = new Date(Date.UTC(a + 1, startMonth - 1, 0));
  return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
}

// Line & voucher totals — identical rules to acc.save_voucher in the database.
export function lineAmount(l) {
  const q = Number(l.qty) || 0, r = Number(l.rate) || 0;
  return q > 0 && r > 0 ? r2(q * r) : r2(l.amount);
}
export function voucherTotals(v) {
  const mode = v.gst_mode || 'none';
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  for (const l of v.lines || []) {
    const amt = lineAmount(l), g = mode === 'none' ? 0 : r2(amt * (Number(l.gst_rate) || 0) / 100);
    taxable = r2(taxable + amt);
    if (mode === 'intra') { cgst = r2(cgst + r2(g / 2)); sgst = r2(sgst + r2(g - r2(g / 2))); }
    else if (mode === 'inter') igst = r2(igst + g);
  }
  const round = r2(v.round_off);
  return { taxable, cgst, sgst, igst, gst: r2(cgst + sgst + igst), total: r2(taxable + cgst + sgst + igst + round) };
}

// Build fast lookups over a company's data. `data` = { vouchers, allocations, ... } (deleted vouchers already removed)
export function buildIndex(data) {
  const byId = new Map(data.vouchers.map(v => [v.id, v]));
  const allocTo = new Map(), allocFrom = new Map();
  for (const a of data.allocations) {
    // keep a link if either side is loaded (a restricted user may see the bill but not the payment)
    if (byId.has(a.to_voucher_id)) (allocTo.get(a.to_voucher_id) || allocTo.set(a.to_voucher_id, []).get(a.to_voucher_id)).push(a);
    if (byId.has(a.from_voucher_id)) (allocFrom.get(a.from_voucher_id) || allocFrom.set(a.from_voucher_id, []).get(a.from_voucher_id)).push(a);
  }
  return { byId, allocTo, allocFrom };
}

export const isBill = v => BILL_TYPES.includes(v.voucher_type);
export const paidOnSpot = v => isBill(v) && !!v.account_id;

// Amount still due on a bill
export function billPending(v, ix) {
  if (!isBill(v) || paidOnSpot(v)) return 0;
  return r2(Number(v.net_amount) - sum(ix.allocTo.get(v.id) || [], a => a.amount));
}
// Unallocated part of a receipt / payment / credit note (= advance or unapplied credit)
export function unallocated(v, ix) {
  if (!['receipt', 'payment', 'customer_credit', 'supplier_credit'].includes(v.voucher_type)) return 0;
  return r2(Number(v.total_amount) - sum(ix.allocFrom.get(v.id) || [], a => a.amount));
}

// Party ledger effect: +ve = party owes us more (debit), -ve = we owe party more (credit)
export function partyEffect(v) {
  const t = v.voucher_type, net = Number(v.net_amount), tot = Number(v.total_amount);
  const rows = [];
  if (SALES_BILLS.includes(t)) { rows.push(net); if (v.account_id) rows.push(-net); }
  else if (PURCHASE_BILLS.includes(t)) { if (v.party_id) { rows.push(-net); if (v.account_id) rows.push(net); } }
  else if (t === 'receipt' || t === 'customer_credit') rows.push(-tot);
  else if (t === 'payment' || t === 'supplier_credit') rows.push(tot);
  return rows;
}

// Money account effect for one voucher → list of {account_id, amount(+in/-out)}
export function accountEffects(v) {
  const t = v.voucher_type, net = Number(v.net_amount), tot = Number(v.total_amount), out = [];
  if (!v.account_id) return out;
  if (t === 'receipt' || t === 'capital_in' || t === 'interco_in' || SALES_BILLS.includes(t)) out.push({ account_id: v.account_id, amount: net });
  else if (t === 'payment' || t === 'capital_out' || t === 'interco_out' || PURCHASE_BILLS.includes(t)) out.push({ account_id: v.account_id, amount: -net });
  else if (t === 'transfer') { out.push({ account_id: v.account_id, amount: -tot }); out.push({ account_id: v.to_account_id, amount: tot }); }
  return out;
}

// Stock quantity effect for a line
export function stockEffect(v, l) {
  const s = TYPES[v.voucher_type]?.stock || 0;
  return s * (Number(l.qty) || 0);
}

// Profit & loss contribution (taxable values, GST excluded)
export function plEffect(v) {
  const t = v.voucher_type, tx = Number(v.taxable_amount);
  if (SALES_BILLS.includes(t)) return { sales: tx };
  if (t === 'customer_credit') return { sales: -tx };
  if (t === 'purchase') return { purchases: tx };
  if (t === 'supplier_credit') return { purchases: -tx };
  if (t === 'expense') return { expenses: tx };
  return {};
}

export function gstEffect(v) {
  const t = v.voucher_type, g = r2(Number(v.cgst_amount) + Number(v.sgst_amount) + Number(v.igst_amount));
  if (SALES_BILLS.includes(t)) return { output: g };
  if (t === 'customer_credit') return { output: -g };
  if (PURCHASE_BILLS.includes(t)) return { input: g };
  if (t === 'supplier_credit') return { input: -g };
  return {};
}

// TDS: "payable" = we deducted from a vendor (owed to government); "receivable" = customer deducted from us
export function tdsEffect(v) {
  const t = v.voucher_type, x = Number(v.tds_amount) || 0;
  if (!x) return {};
  if (t === 'payment' || PURCHASE_BILLS.includes(t)) return { payable: x };
  if (t === 'receipt' || SALES_BILLS.includes(t)) return { receivable: x };
  return {};
}

// Allocate an amount to bills oldest-first; returns {billId: amount}
export function autoAllocate(amount, bills, pendingOf) {
  let left = r2(amount); const out = {};
  for (const b of [...bills].sort((a, c) => a.voucher_date.localeCompare(c.voucher_date) || a.voucher_no.localeCompare(c.voucher_no))) {
    if (left <= 0) break;
    const take = r2(Math.min(left, pendingOf(b)));
    if (take > 0) { out[b.id] = take; left = r2(left - take); }
  }
  return out;
}

// Indian number format
export function money(n, { sign = false, blankZero = false } = {}) {
  const x = r2(n);
  if (blankZero && x === 0) return '';
  const s = Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (x < 0 ? '-' : sign && x > 0 ? '+' : '') + '₹' + s;
}
export const qtyFmt = n => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export function amountInWords(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + two(x % 100);
  const words = x => {
    if (x === 0) return 'Zero';
    const parts = [], cr = Math.floor(x / 1e7), lk = Math.floor(x / 1e5) % 100, th = Math.floor(x / 1000) % 100, rest = x % 1000;
    if (cr) parts.push(words(cr) + ' Crore'); if (lk) parts.push(two(lk) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (rest) parts.push(three(rest));
    return parts.join(' ');
  };
  const x = r2(n), rs = Math.floor(x), p = Math.round((x - rs) * 100);
  return 'Rupees ' + words(rs) + (p ? ' and ' + two(p) + ' Paise' : '') + ' Only';
}
