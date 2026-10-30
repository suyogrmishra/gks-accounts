// Project budget analysis: budget vs actual by line and by cost type, unbudgeted spend,
// cash position and forecast at completion. Shared by the Projects screen and the dashboard.
import { S, groupCompanies, categoryName, pending, unalloc } from './store.js';
import { r2, sum, plEffect, SALES_BILLS, PURCHASE_BILLS } from './calc.js';

export const COST_TYPES = ['Material', 'Labour', 'Transport', 'Overhead', 'Other'];
export const NEAR = 0.9; // warn when 90% of a budget is used

const key = s => String(s || '').trim().toLowerCase();
const COST_VOUCHERS = ['purchase', 'expense', 'supplier_credit'];

// Which cost type an unbudgeted cost line belongs to
function guessType(v) {
  if (v.voucher_type === 'purchase' || v.voucher_type === 'supplier_credit') return 'Material';
  const c = key(categoryName(v.category_id));
  if (/labou?r|wages|contractor|fabricat|install/.test(c)) return 'Labour';
  if (/transport|freight|cartage|logistic|vehicle|fuel/.test(c)) return 'Transport';
  if (/overhead|rent|office|salary|admin|electric/.test(c)) return 'Overhead';
  if (/material|hardware|glass|alumin/.test(c)) return 'Material';
  return 'Other';
}

export function statusOf(actual, budget) {
  if (!(budget > 0)) return actual > 0 ? { code: 'none', label: 'No budget', cls: 'info', pct: null } : { code: 'none', label: 'No budget', cls: '', pct: null };
  const pct = actual / budget;
  if (actual > budget + 0.004) return { code: 'over', label: `Over budget (${Math.round(pct * 100)}%)`, cls: 'bad', pct };
  if (pct >= NEAR) return { code: 'near', label: `${Math.round(pct * 100)}% used`, cls: 'warn', pct };
  return { code: 'ok', label: `${Math.round(pct * 100)}% used`, cls: 'ok', pct };
}

export function analyseProject(p) {
  const gcIds = new Set(groupCompanies().map(c => c.id));
  const vs = S.vouchers.filter(v => v.project_id === p.id && gcIds.has(v.company_id));
  const allBud = S.budget.filter(b => b.project_id === p.id).sort((a, b) => a.line_no - b.line_no);
  const budget = allBud.filter(b => b.kind === 'cost'), orders = allBud.filter(b => b.kind === 'order');
  const byName = new Map(); for (const b of budget) if (!byName.has(key(b.description))) byName.set(key(b.description), b);

  // every cost line on the project's purchase / expense / debit-note entries (debit notes reduce cost)
  const lineAct = new Map(budget.map(b => [b.id, { q: 0, a: 0 }])), unbudgeted = [];
  for (const v of vs.filter(x => COST_VOUCHERS.includes(x.voucher_type))) {
    const sign = v.voucher_type === 'supplier_credit' ? -1 : 1;
    const lines = (v.lines || []).length ? v.lines : [{ description: categoryName(v.category_id) || 'Expense', qty: 0, amount: Number(v.taxable_amount) || 0 }];
    for (const l of lines) {
      const amt = sign * (Number(l.amount) || 0), q = sign * (Number(l.qty) || 0);
      const b = byName.get(key(l.description));
      if (b) { const x = lineAct.get(b.id); x.q += q; x.a = r2(x.a + amt); }
      else if (amt) unbudgeted.push({ v, description: l.description || categoryName(v.category_id) || 'Expense', qty: q, amount: r2(amt), type: guessType(v) });
    }
  }
  const lineRows = budget.map(b => {
    const bud = r2(Number(b.qty) * Number(b.rate)), act = lineAct.get(b.id);
    return { b, type: b.cost_type || 'Material', budget: bud, budgetQty: Number(b.qty), usedQty: Math.round(act.q * 1000) / 1000, actual: act.a, left: r2(Math.max(0, bud - act.a)), status: statusOf(act.a, bud) };
  });
  // a name used twice in the budget is matched to its first line only; flag the duplicates
  const seen = new Set(), duplicates = budget.filter(b => { const k = key(b.description); if (seen.has(k)) return true; seen.add(k); return false; }).map(b => b.description);

  const byType = COST_TYPES.map(t => {
    const rows = lineRows.filter(r => r.type === t), un = unbudgeted.filter(u => u.type === t);
    const bud = sum(rows, r => r.budget), act = r2(sum(rows, r => r.actual) + sum(un, u => u.amount));
    return { type: t, budget: bud, matched: sum(rows, r => r.actual), unbudgeted: sum(un, u => u.amount), actual: act, status: statusOf(act, bud) };
  }).filter(r => r.budget || r.actual);

  const e = vs.map(plEffect);
  const billed = sum(e, x => x.sales || 0), cost = sum(e, x => (x.purchases || 0) + (x.expenses || 0));
  const budTot = sum(lineRows, r => r.budget), boqValue = sum(orders, o => Number(o.qty) * Number(o.rate));
  const contract = Number(p.order_value) || boqValue;
  // money that actually moved for this project: settled part of its bills + unlinked receipts/payments tagged to it
  const settled = v => r2(Number(v.net_amount) - pending(v));
  const received = r2(sum(vs.filter(v => SALES_BILLS.includes(v.voucher_type)), settled) + sum(vs.filter(v => v.voucher_type === 'receipt'), unalloc));
  const paid = r2(sum(vs.filter(v => PURCHASE_BILLS.includes(v.voucher_type)), settled) + sum(vs.filter(v => v.voucher_type === 'payment'), unalloc));
  const custDue = sum(vs.filter(v => SALES_BILLS.includes(v.voucher_type)), pending), suppDue = sum(vs.filter(v => PURCHASE_BILLS.includes(v.voucher_type)), pending);
  const toBill = r2(Math.max(0, contract - billed));
  const budgetLeft = sum(lineRows, r => r.left);              // still to spend on budget lines not yet used up
  const forecastCost = r2(cost + budgetLeft);                 // spent so far + what each budget line still needs
  const forecastProfit = r2(contract - forecastCost);
  const cashNow = r2(received - paid);
  const cashIn = r2(toBill + custDue), cashOut = r2(budgetLeft + suppDue);
  const status = statusOf(cost, budTot);
  return { p, vs, orders, budget, lineRows, byType, unbudgeted, duplicates, billed, cost, budTot, boqValue, contract, received, paid, custDue, suppDue, toBill, budgetLeft,
    forecastCost, forecastProfit, plannedProfit: r2(contract - budTot), cashNow, cashIn, cashOut, cashEnd: r2(cashNow + cashIn - cashOut), status,
    overLines: lineRows.filter(r => r.status.code === 'over'), nearLines: lineRows.filter(r => r.status.code === 'near') };
}

// Read rows pasted from Excel (tab separated) or a CSV file; numbers may contain commas / ₹
export function parsePasted(text) {
  const rows = String(text || '').split(/\r?\n/).map(r => r.trimEnd()).filter(r => r.trim());
  const tabbed = rows.some(r => r.includes('\t'));
  const splitCsv = r => { const out = []; let cur = '', q = false; for (const ch of r) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  return rows.map(r => (tabbed ? r.split('\t') : splitCsv(r)).map(c => c.trim()));
}
export const num = s => { const x = Number(String(s ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(x) ? x : NaN; };
