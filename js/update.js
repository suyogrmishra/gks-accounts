// New-version notice: the app checks version.json now and then; when a newer version is published
// it shows a bar with an Update button (and updates by itself when the app is reopened).
const KEY = 'gks2.updateLater';
let current = null, timer = null;

async function latest() {
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function startUpdateCheck() {
  const v = await latest();
  current = v?.version || null;
  const lbl = document.getElementById('appVersion'); if (lbl && current) lbl.textContent = 'Version ' + current;
  clearInterval(timer); timer = setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('online', check);
}

async function check() {
  const v = await latest(); if (!v?.version) return;
  if (!current) { current = v.version; return; }
  if (v.version === current) return;
  // on the sign-in screen nothing can be lost, so update straight away; otherwise ask
  const signedOut = document.getElementById('app')?.classList.contains('hidden');
  if (signedOut && sessionStorage.getItem('gks2.autoUpdated') !== v.version) { sessionStorage.setItem('gks2.autoUpdated', v.version); return applyUpdate(); }
  showBar(v);
}

function showBar(v) {
  const later = Number(localStorage.getItem(KEY) || 0);
  if (later > Date.now() || document.getElementById('updBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updBar'; bar.className = 'update-bar'; bar.setAttribute('role', 'status');
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  bar.innerHTML = `<div><b>New version available</b> <span class="ver">${esc(v.version)}</span>${v.notes ? `<span class="notes">${esc(v.notes)}</span>` : ''}<span class="hint">Save anything you are typing first.</span></div>
    <div class="row"><button class="btn ghost" data-later>Later</button><button class="btn primary" data-update>Update now</button></div>`;
  bar.querySelector('[data-update]').onclick = applyUpdate;
  bar.querySelector('[data-later]').onclick = () => { localStorage.setItem(KEY, String(Date.now() + 30 * 60 * 1000)); bar.remove(); };
  document.body.appendChild(bar);
}

export async function applyUpdate() {
  try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch { }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { }
  localStorage.removeItem(KEY);
  location.reload();
}
