import { authApi } from './api/index.js';
import { toast } from './utils/ui.js';

export function initAuth() {
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true; err.textContent = '';
      const username = form.username.value.trim();
      const password = form.password.value;
      try {
        await authApi.login(username, password);
        toast('Signed in', 'success');
        window.dispatchEvent(new CustomEvent('skyguard:login'));
      } catch (e2) {
        err.hidden = false; err.textContent = e2.message || 'Sign in failed';
      }
    });
  }
  const logout = document.getElementById('logout-btn');
  if (logout) logout.addEventListener('click', () => { authApi.logout(); window.dispatchEvent(new CustomEvent('skyguard:logout')); });
}

export function requireAuth() {
  if (!window.SkyGuardAPI.isAuthed()) { window.dispatchEvent(new CustomEvent('skyguard:logout')); return false; }
  return true;
}
