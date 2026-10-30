// App shell: sign-in, navigation, company / year switching, and routing to screens.
import { createBackend, errorText } from './backend.js';
import { S, company, loadMemberships, loadGroup, switchCompany, setFY, isAdmin, canManageStaff, myMembership, onChange } from './store.js';
import { $, esc, toast, modal, formData, today } from './ui.js';
import { fyLabel } from './calc.js';
import * as entry from './views/entry.js';
import * as books from './views/books.js';
import * as masters from './views/masters.js';
import * as admin from './views/admin.js';

const ROUTES = [
  ['Overview'],
  ['dashboard', 'Dashboard', '◧', books.dashboard],
  ['new', 'New Entry', '＋', entry.newEntry],
  ['entries', 'Day Book', '☰', books.entries],
  ['Money'],
  ['outstanding', 'Outstanding & Advances', '⇄', books.outstanding],
  ['banking', 'Cash & Bank', '₹', masters.banking],
  ['ledgers', 'Ledgers', '▤', books.ledgers],
  ['Business'],
  ['projects', 'Projects', '▣', masters.projects],
  ['project-accounts', 'Project Accounts', '◫', masters.projectAccounts],
  ['inventory', 'Inventory', '▦', masters.inventory],
  ['parties', 'Parties', '☺', masters.parties],
  ['payroll', 'Payroll & Fixed Costs', '◷', admin.payroll],
  ['Reports'],
  ['reports', 'Profit & Loss / Cash Flow', '↗', books.reports],
  ['gst', 'GST & TDS', '%', books.gst],
  ['history', 'Change History', '⟲', admin.history, true],
  ['settings', 'Company & Users', '⚙', admin.settings],
];
const routeMap = new Map(ROUTES.filter(r => r.length > 1).map(r => [r[0], r]));

async function boot() {
  applyTheme(localStorage.getItem('gks2.theme') || 'green');
  S.backend = createBackend();
  S.backend.onAuthChange(ev => { if (ev === 'PASSWORD_RECOVERY') askNewPassword(); if (ev === 'SIGNED_OUT') location.reload(); });
  const session = await S.backend.session().catch(() => null);
  $('#boot').classList.add('hidden');
  if (!session) return showLogin();
  S.user = session.user;
  await startApp();
}

function showLogin() {
  $('#login').classList.remove('hidden');
  if (sessionStorage.getItem('gks2.signedOut')) { sessionStorage.removeItem('gks2.signedOut'); const m = $('#loginMsg'); m.textContent = 'You were signed out after 30 minutes without activity.'; m.className = 'msg'; }
  const form = $('#loginForm'); let signup = false;
  $('#toggleSignup').onclick = e => { e.preventDefault(); signup = !signup; $('#nameRow').classList.toggle('hidden', !signup); $('#loginBtn').textContent = signup ? 'Create account' : 'Sign in'; e.target.textContent = signup ? 'I already have an account' : 'Create an account'; };
  $('#forgotLink').onclick = async e => {
    e.preventDefault(); const email = form.email.value.trim();
    if (!email) return msg('Enter your email first, then tap "Forgot password?".', true);
    try { await S.backend.resetPassword(email); msg('Check your email for a link to set a new password.'); } catch (err) { msg(errorText(err), true); }
  };
  form.onsubmit = async e => {
    e.preventDefault(); const f = formData(form); $('#loginBtn').disabled = true;
    try {
      if (signup) { const r = await S.backend.signUp(f.email, f.password, f.full_name); if (r === 'confirm_email') { msg('Account created. Confirm your email, then sign in.'); return; } }
      else await S.backend.signIn(f.email, f.password);
      location.reload();
    } catch (err) { msg(errorText(err), true); } finally { $('#loginBtn').disabled = false; }
  };
  function msg(t, bad) { const m = $('#loginMsg'); m.textContent = t; m.className = 'msg ' + (bad ? 'error' : 'ok'); }
}

function askNewPassword() {
  const m = modal('Set a new password', `<form class="stack"><label>New password<input name="pw" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn primary">Save password</button></form>`);
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    try { await S.backend.updatePassword(e.target.pw.value); toast('Password updated'); m.close(); } catch (err) { toast(errorText(err), 'error'); }
  };
}

async function startApp() {
  try { await loadMemberships(); } catch (err) { return fatal(err); }
  $('#app').classList.remove('hidden');
  armIdle();
  $('#userEmail').textContent = S.user.email;
  $('#modeBadge').textContent = S.backend.mode === 'demo' ? 'Demo mode — sample data' : 'Live';
  $('#logoutBtn').onclick = async () => {
    if (S.backend.mode === 'demo') localStorage.removeItem('gks2.mode');
    await S.backend.signOut(); location.reload();
  };
  $('#themeSelect').value = localStorage.getItem('gks2.theme') || 'green';
  $('#themeSelect').onchange = e => applyTheme(e.target.value);
  $('#menuBtn').onclick = () => $('#app').classList.toggle('nav-open');
  $('#quickNew').onclick = () => go('new');
  $('#refreshBtn').onclick = async () => { await reload(); toast('Data refreshed'); };
  $('#companySelect').onchange = async e => {
    if (e.target.value === '__add__') { e.target.value = S.companyId; return addCompanyForm(); }
    await switchCompany(e.target.value); fillCompanies(); fillYears(); route();
  };
  $('#fySelect').onchange = e => { setFY(e.target.value); route(); };
  if (!S.companies.length) return firstCompany();
  try { await loadGroup(); } catch (err) { return fatal(err); }
  fillCompanies(); fillYears();
  window.addEventListener('hashchange', route);
  route();
}

function fatal(err) {
  $('#app').classList.remove('hidden');
  const notSetUp = /schema must be one of|Invalid schema|relation "?acc\.|PGRST106|PGRST205/i.test(String(err?.message || err) + ' ' + (err?.code || ''));
  $('#view').innerHTML = `<div class="card stack"><h2>Could not load your books</h2><p class="neg">${esc(errorText(err))}</p>
    ${notSetUp ? `<p>The new database tables are probably not installed yet. Run the SQL files in <code>db/</code> in your Supabase SQL editor (see README), and add <code>acc</code> to Settings → API → Exposed schemas.</p>` : ''}
    <div class="row"><button class="btn" onclick="location.reload()">Try again</button></div></div>`;
}

function firstCompany() {
  $('#view').innerHTML = `<div class="card stack" style="max-width:520px"><h2>Welcome</h2><p class="muted">You are not part of any company yet. Create your company, or ask an admin to add <b>${esc(S.user.email)}</b>.</p>
    <form id="fc" class="stack"><label>Company name<input name="name" required></label><div class="form-grid"><label>GSTIN<input name="gstin" maxlength="15"></label><label>State code<input name="state" maxlength="2" placeholder="27"></label></div><button class="btn primary">Create company</button></form></div>`;
  $('#fc').onsubmit = async e => {
    e.preventDefault(); const f = formData(e.target);
    try { await S.backend.rpc('create_company', { p_name: f.name, p_group: null, p_gstin: f.gstin, p_state: f.state }); location.reload(); } catch (err) { toast(errorText(err), 'error'); }
  };
}

function fillCompanies() {
  $('#companySelect').innerHTML = S.companies.map(c => `<option value="${c.id}" ${c.id === S.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    + (isAdmin() ? '<option value="__add__">+ Add company…</option>' : '');
}
// create a company (old app: "Create another company"), then switch to it
export function addCompanyForm() {
  const c = company();
  const m = modal('Add a company', `<form class="stack"><label>Company name<input name="name" required></label>
    <div class="form-grid"><label>GSTIN<input name="gstin" maxlength="15" style="text-transform:uppercase"></label><label>State code<input name="state" maxlength="2" placeholder="27"></label></div>
    ${c ? `<label class="check"><input type="checkbox" name="same" checked> Part of the same group as ${esc(c.name)} — shares projects and bank accounts, allows inter-company transfers</label>` : ''}
    <p class="small muted">You become its admin. Add other users from Company &amp; Users; new access starts as Viewer unless you choose a role.</p>
    <p class="msg error" role="alert"></p><div class="row end"><button class="btn primary">Create company</button></div></form>`);
  const f = m.el.querySelector('form');
  f.gstin.oninput = () => { const g = f.gstin.value.trim().toUpperCase(); if (/^\d{2}/.test(g) && !f.state.value) f.state.value = g.slice(0, 2); };
  f.onsubmit = async e => {
    e.preventDefault(); const d = formData(f);
    if (d.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(d.gstin.toUpperCase())) { f.querySelector('.msg').textContent = 'Enter a valid 15-character GSTIN, or leave it blank.'; return; }
    try {
      const id = await S.backend.rpc('create_company', { p_name: d.name, p_group: c && d.same ? c.group_id : null, p_gstin: d.gstin ? d.gstin.toUpperCase() : null, p_state: d.state });
      localStorage.setItem('gks2.company', id); m.close(); toast('Company created'); location.hash = '#/settings'; location.reload();
    } catch (err) { f.querySelector('.msg').textContent = errorText(err); }
  };
}
function fillYears() {
  const c = company(), now = fyLabel(today(), c.fy_start_month);
  const years = new Set([now, S.fy, ...S.vouchers.filter(v => v.company_id === c.id).map(v => v.fy)]);
  const list = [...years].filter(Boolean).sort().reverse();
  if (!list.includes(S.fy)) S.fy = now;
  // old-app rule: only an admin can look at other financial years
  if (!isAdmin()) { S.fy = now; $('#fySelect').innerHTML = `<option value="${now}">FY 20${now}</option>`; $('#fySelect').disabled = true; $('#fySelect').title = 'Only an admin can change the financial year'; return; }
  $('#fySelect').disabled = false;
  $('#fySelect').innerHTML = list.map(y => `<option value="${y}" ${y === S.fy ? 'selected' : ''}>FY 20${y}</option>`).join('');
}

function renderNav(current) {
  const hidden = new Set(myMembership()?.hidden_sections || []);
  let html = '';
  for (const r of ROUTES) {
    if (r.length === 1) { html += `<div class="group">${esc(r[0])}</div>`; continue; }
    const [key, label, icon, , adminOnly] = r;
    if (hidden.has(key) || (adminOnly && !isAdmin()) || (key === 'payroll' && !canManageStaff())) continue;
    html += `<a href="#/${key}" class="${key === current ? 'active' : ''}"><span class="ic" aria-hidden="true">${icon}</span>${esc(label)}</a>`;
  }
  $('#nav').innerHTML = html;
}

export function go(path) { location.hash = '#/' + path; }
export async function reload() { await loadGroup(); fillYears(); route(); }

let renderToken = 0;
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [key, ...rest] = path.split('/');
  const r = routeMap.get(key) || (key === 'edit' ? ['edit', 'Edit', '', entry.editEntry] : routeMap.get('dashboard'));
  renderNav(r[0] === 'edit' ? 'new' : r[0]);
  $('#app').classList.remove('nav-open');
  // fresh element each time so listeners from the previous screen are dropped
  const oldView = $('#view'), view = oldView.cloneNode(false); oldView.replaceWith(view);
  const token = ++renderToken;
  try {
    const out = r[3](view, { args: rest, query: new URLSearchParams(query), token: () => token === renderToken });
    if (out?.catch) out.catch(err => showError(view, err));
  } catch (err) { showError(view, err); }
  view.focus({ preventScroll: true }); window.scrollTo(0, 0);
}
function showError(view, err) { console.error(err); view.innerHTML = `<div class="card"><h3>Something went wrong on this screen</h3><p class="neg">${esc(errorText(err))}</p></div>`; }

function applyTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem('gks2.theme', t); }

// Install as an app (where the browser offers it)
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installBtn')?.classList.remove('hidden'); });
document.addEventListener('click', async e => {
  if (e.target.id !== 'installBtn' || !installPrompt) return;
  installPrompt.prompt(); await installPrompt.userChoice.catch(() => null); installPrompt = null; e.target.classList.add('hidden');
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// Sign out after 30 minutes without any activity (live books only)
const IDLE_MS = 30 * 60 * 1000; let idleTimer;
function armIdle() {
  clearTimeout(idleTimer);
  if (!S.user || S.backend?.mode !== 'live') return;
  idleTimer = setTimeout(async () => { sessionStorage.setItem('gks2.signedOut', '1'); await S.backend.signOut(); location.reload(); }, IDLE_MS);
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, armIdle, { passive: true }));

onChange(() => {});
boot().catch(err => { const b = document.getElementById('boot'); b.classList.remove('hidden'); b.textContent = errorText(err); });
