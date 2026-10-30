// Small DOM helpers used by every screen.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tagged template that escapes interpolated values unless wrapped with raw()
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s);
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      out += v instanceof Raw ? v.s : Array.isArray(v) ? v.map(x => (x instanceof Raw ? x.s : esc(x))).join('') : v == null || v === false ? '' : esc(v);
    }
  });
  return raw(out);
}

export const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export const fmtDate = d => d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
export const fmtMonth = d => d ? new Date(d.slice(0, 7) + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '';

export function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.setAttribute('role', kind === 'error' ? 'alert' : 'status'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3000);
}

// Modal dialog. Returns {el, close}. `onClose` runs once.
export function modal(title, body, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div></div>`;
  let closed = false;
  const close = () => { if (closed) return; closed = true; wrap.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  wrap.querySelector('input,select,textarea,button:not([data-close])')?.focus();
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmBox(message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const m = modal('Please confirm', `<p>${esc(message)}</p><div class="row end gap"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
      { onClose: () => { if (!answered) resolve(false); } });
    m.el.querySelector('[data-ok]').onclick = () => { answered = true; m.close(); resolve(true); };
  });
}

// Read a form's named fields into an object
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else o[el.name] = el.value.trim() === '' ? null : el.value.trim();
  }
  return o;
}

export function options(list, selected, { blank } = {}) {
  return (blank != null ? `<option value="">${esc(blank)}</option>` : '') +
    list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

// Turn rows into CSV and download
export function downloadCSV(name, header, rows) {
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
  a.download = name.replace(/[^\w.-]+/g, '_') + '.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Print a block of HTML on its own page
export function printHTML(title, body) {
  const box = document.getElementById('printArea');
  box.innerHTML = `<div class="print-doc"><h1 class="print-title">${esc(title)}</h1>${body}</div>`;
  const old = document.title; document.title = title;
  window.print();
  setTimeout(() => { document.title = old; }, 500);
}

export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Simple sortable table: cols = [{key,label,num,render,sortVal}]
export function table(cols, rows, { empty = 'Nothing to show yet.', foot, rowAttr, id } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const head = cols.map((c, i) => `<th class="${c.num ? 'num' : ''}" data-col="${i}">${esc(c.label)}</th>`).join('');
  const body = rows.map(r => `<tr ${rowAttr ? rowAttr(r) : ''}>${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}" data-label="${esc(c.label)}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  const f = foot ? `<tfoot><tr>${foot.map((x, i) => `<td class="${cols[i]?.num ? 'num' : ''}">${x ?? ''}</td>`).join('')}</tr></tfoot>` : '';
  return `<div class="table-wrap"><table ${id ? `id="${id}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${f}</table></div>`;
}
