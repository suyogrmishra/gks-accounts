// Salary calculation: earned salary for the days present, PF, ESIC, Professional Tax and employer cost.
// One function used by the payroll screen, the employee form, payslips and demo mode.
import { r2 } from './calc.js';

// Rates and limits as notified (Oct 2026). Admins can change them in Company & Users → Payroll rules.
//  • EPF wage ceiling ₹25,000 from 17 Sep 2026 (S.O. 5109(E)); was ₹15,000.
//  • ESIC applies while gross wages are up to ₹21,000 a month; 0.75% employee, 3.25% employer.
//  • Maharashtra Professional Tax slabs.
export const PAYROLL_DEFAULTS = {
  pf_ceiling: 25000, pf_employee_rate: 12, pf_employer_rate: 12, eps_rate: 8.33, edli_rate: 0.5, pf_admin_rate: 0.5,
  esic_limit: 21000, esic_employee_rate: 0.75, esic_employer_rate: 3.25, esic_exempt_daily: 176,
  pt_state: 'MH',
};
export const PT_STATES = [['MH', 'Maharashtra'], ['none', 'No PT / enter by hand']];
export const settingsOf = company => ({ ...PAYROLL_DEFAULTS, ...(company?.payroll_settings || {}) });

const n = x => Number(x) || 0;
const rupee = x => Math.round(n(x));             // PF is rounded to the nearest rupee
const rupeeUp = x => Math.ceil(r2(n(x)));        // ESIC is rounded up to the next rupee

export const structureOf = e => {
  const s = { basic: n(e.basic), hra: n(e.hra), conveyance: n(e.conveyance), other_allowance: n(e.other_allowance) };
  if (!s.basic && !s.hra && !s.conveyance && !s.other_allowance) s.basic = n(e.monthly_salary ?? e.base_salary);
  return s;
};
export const grossOf = s => r2(n(s.basic) + n(s.hra) + n(s.conveyance) + n(s.other_allowance));

// Maharashtra PT on the month's salary
export function professionalTax(amount, gender, month, cfg) {
  if (cfg.pt_state !== 'MH') return 0;
  const feb = String(month || '').slice(5, 7) === '02', a = n(amount);
  if (gender === 'F') return a <= 25000 ? 0 : feb ? 300 : 200;
  return a <= 7500 ? 0 : a <= 10000 ? 175 : feb ? 300 : 200;
}

// emp: employee master; row: { month, working_days, present_days, overtime, bonus, tds, deduction, pt?, basic/hra/... snapshot }
// opts.keepPt: keep a PT figure typed by hand
export function payslip(emp, row, cfg, opts = {}) {
  const rates = row && (n(row.basic) || n(row.hra) || n(row.conveyance) || n(row.other_allowance)) ? structureOf(row) : structureOf(emp || {});
  const rateGross = grossOf(rates);
  const working = n(row?.working_days), present = Math.min(n(row?.present_days), working || n(row?.present_days));
  const ratio = working > 0 ? present / working : 0;
  const earned = { basic: r2(rates.basic * ratio), hra: r2(rates.hra * ratio), conveyance: r2(rates.conveyance * ratio), other_allowance: r2(rates.other_allowance * ratio) };
  const earned_gross = grossOf(earned), overtime = r2(n(row?.overtime)), bonus = r2(n(row?.bonus));

  // PF on Basic + DA earned
  let pf_employee = 0, pf_employer = 0, eps = 0, pf_admin = 0, pf_wage = 0;
  if (emp?.pf_member !== false && earned.basic > 0) {
    const ceiling = n(cfg.pf_ceiling);
    pf_wage = emp?.pf_on_ceiling === false ? earned.basic : Math.min(earned.basic, ceiling);
    const epsWage = Math.min(earned.basic, ceiling);
    pf_employee = rupee(pf_wage * n(cfg.pf_employee_rate) / 100);
    eps = rupee(epsWage * n(cfg.eps_rate) / 100);
    pf_employer = rupee(pf_wage * n(cfg.pf_employer_rate) / 100);          // EPS share + EPF share
    pf_admin = rupee(pf_wage * n(cfg.pf_admin_rate) / 100) + rupee(epsWage * n(cfg.edli_rate) / 100);
  }
  // ESIC while the full-month gross is within the limit; on gross earned + overtime (bonus excluded)
  let esic_employee = 0, esic_employer = 0, esic_wage = 0;
  const esicCovered = emp?.esic_member !== false && rateGross > 0 && rateGross <= n(cfg.esic_limit);
  if (esicCovered) {
    esic_wage = r2(earned_gross + overtime);
    const exempt = rateGross / 26 <= n(cfg.esic_exempt_daily);          // low-wage employees pay no employee share
    esic_employee = exempt ? 0 : rupeeUp(esic_wage * n(cfg.esic_employee_rate) / 100);
    esic_employer = rupeeUp(esic_wage * n(cfg.esic_employer_rate) / 100);
  }
  const ptBase = r2(earned_gross + overtime + bonus);
  const pt = opts.keepPt && row?.pt != null ? r2(n(row.pt)) : emp?.pt_applicable === false ? 0 : professionalTax(ptBase, emp?.gender, row?.month, cfg);
  const tds = r2(n(row?.tds)), deduction = r2(n(row?.deduction));
  const total_deductions = r2(pf_employee + esic_employee + pt + tds + deduction);
  const net_pay = r2(earned_gross + overtime + bonus - total_deductions);
  const employer_cost = r2(pf_employer + pf_admin + esic_employer);
  return {
    rates, rate_gross: rateGross, ratio, earned, earned_gross, overtime, bonus,
    pf_wage, pf_employee, pf_employer, eps, epf_employer: r2(pf_employer - eps), pf_admin, esic_covered: esicCovered, esic_wage, esic_employee, esic_employer,
    pt, tds, deduction, total_deductions, net_pay, employer_cost, ctc: r2(earned_gross + overtime + bonus + employer_cost),
  };
}

// The fields stored on a payroll row
export function payrollFields(emp, row, cfg, opts) {
  const s = payslip(emp, row, cfg, opts);
  return { ...s.rates, base_salary: s.rate_gross, earned_gross: s.earned_gross, pf_employee: s.pf_employee, pf_employer: s.pf_employer, pf_admin: s.pf_admin,
    esic_employee: s.esic_employee, esic_employer: s.esic_employer, pt: s.pt };
}

// Net pay of a stored payroll row (same formula as the database column)
export const rowNet = pr => r2(n(pr.earned_gross) + n(pr.overtime) + n(pr.bonus) - n(pr.pf_employee) - n(pr.esic_employee) - n(pr.pt) - n(pr.tds) - n(pr.deduction));

export const daysInMonth = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
