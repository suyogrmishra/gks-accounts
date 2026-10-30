// Admin PIN: an extra 6-digit check before sensitive admin actions (deleting or moving entries,
// changing users, merging parties, locking books). Once entered, it stays unlocked for 10 minutes.
import { S, isAdmin } from './store.js';
import { modal, esc } from './ui.js';
import { errorText } from './backend.js';

const UNLOCK_MS = 10 * 60 * 1000;
const unlockedAt = new Map();

export async function requireAdminPin(label) {
  if (!isAdmin()) return true;                       // non-admins are limited by their role instead
  const c = S.companyId;
  if (Date.now() - (unlockedAt.get(c) || 0) < UNLOCK_MS) return true;
  let hasPin = false;
  try { hasPin = await S.backend.rpc('has_admin_pin', { p_company: c }); } catch { hasPin = false; }
  if (!hasPin) return true;
  return new Promise(resolve => {
    let done = false;
    const m = modal('Admin PIN', `<form class="stack"><p>Enter the 6-digit admin PIN to ${esc(label)}.</p>
      <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label>
      <p class="msg error" role="alert"></p><div class="row end"><button class="btn primary">Unlock</button></div></form>`, { onClose: () => { if (!done) resolve(false); } });
    const f = m.el.querySelector('form');
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        const ok = await S.backend.rpc('verify_admin_pin', { p_company: c, p_pin: f.pin.value });
        if (!ok) { f.querySelector('.msg').textContent = 'That PIN is not correct.'; f.pin.select(); return; }
        unlockedAt.set(c, Date.now()); done = true; m.close(); resolve(true);
      } catch (err) { f.querySelector('.msg').textContent = errorText(err); }
    };
  });
}
