// One way to delete masters everywhere: admin only, admin PIN, confirmation, and a clear message when
// the record is still used (the database blocks deleting anything that entries depend on).
import { S, isAdmin } from './store.js';
import { toast, confirmBox } from './ui.js';
import { errorText } from './backend.js';
import { requireAdminPin } from './pin.js';
import { reload } from './app.js';

export const delBtn = show => show && isAdmin() ? '<button type="button" class="btn danger" data-del>Delete</button>' : '';

// what: "project"; name: shown in messages; used: why it cannot be deleted (string) or ''; run: async delete
export async function deleteRecord({ what, name, used, run, done }) {
  if (!isAdmin()) return toast('Only an admin can delete.', 'error'), false;
  if (used) return toast(`${name} cannot be deleted: ${used}`, 'error'), false;
  if (!await requireAdminPin('delete ' + what)) return false;
  if (!await confirmBox(`Delete ${what} “${name}”? This cannot be undone.`, { ok: 'Delete', danger: true })) return false;
  try { await run(); await reload(); toast(`${what[0].toUpperCase() + what.slice(1)} deleted`); done?.(); return true; }
  catch (err) { toast(errorText(err), 'error'); return false; }
}
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
