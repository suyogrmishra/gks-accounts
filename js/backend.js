// Data access. Two interchangeable backends with the same interface:
//   SupabaseBackend — your live database (schema `acc`)
//   DemoBackend     — everything in this browser only (localStorage), for trying the app safely
import { CONFIG } from './config.js';
import { DemoBackend } from './demo.js';

const PAGE = 1000;
// stable sort key for paging (tables without an `id` column use their primary key)
const ORDER_KEY = { company_members: ['company_id', 'user_id'], money_account_companies: ['account_id', 'company_id'], member_projects: ['company_id', 'user_id', 'project_id'] };

class SupabaseBackend {
  constructor() {
    this.mode = 'live';
    this.sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { db: { schema: 'acc' } });
  }
  // auth
  async session() { const { data } = await this.sb.auth.getSession(); return data.session ? { user: { id: data.session.user.id, email: data.session.user.email } } : null; }
  async signIn(email, password) { const { error } = await this.sb.auth.signInWithPassword({ email, password }); if (error) throw error; }
  async signUp(email, password, full_name) {
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { data: { full_name } } });
    if (error) throw error; return data.session ? 'signed_in' : 'confirm_email';
  }
  async signOut() { await this.sb.auth.signOut({ scope: 'local' }); }
  async resetPassword(email) { const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw error; }
  async updatePassword(password) { const { error } = await this.sb.auth.updateUser({ password }); if (error) throw error; }
  onAuthChange(cb) { this.sb.auth.onAuthStateChange((event) => cb(event)); }

  _apply(q, filter = {}) {
    for (const [k, v] of Object.entries(filter)) {
      if (Array.isArray(v)) q = q.in(k, v.length ? v : ['00000000-0000-0000-0000-000000000000']);
      else if (v === null) q = q.is(k, null);
      else q = q.eq(k, v);
    }
    return q;
  }
  async list(table, filter = {}, { select = '*', order } = {}) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      let q = this._apply(this.sb.from(table).select(select), filter);
      if (table === 'vouchers') q = q.is('deleted_at', null);
      if (order) q = q.order(order.col, { ascending: !order.desc });
      for (const k of ORDER_KEY[table] || ['id']) q = q.order(k);
      q = q.range(from, from + PAGE - 1);
      const { data, error } = await q;
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }
  async listVouchers(companyIds) {
    const rows = await this.list('vouchers', { company_id: companyIds }, { select: '*, lines:voucher_lines(*)' });
    rows.forEach(v => v.lines.sort((a, b) => a.line_no - b.line_no));
    return rows;
  }
  async audit(companyId, limit = 300) {
    const { data, error } = await this.sb.from('audit_log').select('*').eq('company_id', companyId).order('at', { ascending: false }).limit(limit);
    if (error) throw error; return data;
  }
  async insert(table, rows) { const { data, error } = await this.sb.from(table).insert(rows).select(); if (error) throw error; return data; }
  async update(table, match, patch) { const { data, error } = await this._apply(this.sb.from(table).update(patch), match).select(); if (error) throw error; return data; }
  async upsert(table, rows, onConflict) { const { data, error } = await this.sb.from(table).upsert(rows, { onConflict }).select(); if (error) throw error; return data; }
  async remove(table, match) { const { error } = await this._apply(this.sb.from(table).delete(), match); if (error) throw error; }
  async rpc(name, args) { const { data, error } = await this.sb.rpc(name, args); if (error) throw error; return data; }
}

// Count saves in progress, so the screen can refuse a second click while the first is still saving
export const busy = { n: 0 };
function trackWrites(b) {
  for (const m of ['insert', 'update', 'upsert', 'remove', 'rpc']) {
    const orig = b[m].bind(b);
    b[m] = async (...a) => { busy.n++; document.body.classList.add('saving'); try { return await orig(...a); } finally { if (--busy.n <= 0) { busy.n = 0; document.body.classList.remove('saving'); } } };
  }
  return b;
}
export function createBackend() { return trackWrites(makeBackend()); }
function makeBackend() {
  if (CONFIG.mode !== 'live' || !CONFIG.supabaseKey) return new DemoBackend();
  try { localStorage.removeItem('gks2.mode'); localStorage.removeItem('gks2.demo.db.v4'); } catch {}
  if (!window.supabase) throw new Error('Could not load the database library. Check your internet connection and reload.');
  return new SupabaseBackend();
}

// Friendly text for database / network errors
export function errorText(e) {
  const m = String(e?.message || e || 'Something went wrong');
  if (/duplicate key.*(parties|items|categories|projects)/i.test(m) || e?.code === '23505') return 'That name already exists.';
  if (e?.code === '23503' || /foreign key constraint/i.test(m)) return 'This is still used by entries (including deleted ones kept in the history), so it cannot be deleted. Mark it inactive instead.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No internet connection. Nothing was saved — try again.';
  if (/row-level security|permission denied/i.test(m)) return 'Your role does not allow this.';
  if (/JWT expired/i.test(m)) return 'Your session expired. Please sign in again.';
  return m;
}
