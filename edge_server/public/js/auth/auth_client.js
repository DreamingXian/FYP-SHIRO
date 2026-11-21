// =============================================================================
// Dashboard sign-in state
// - Before the dashboard starts, asks the server who is signed in; without a
//   session the browser goes to the sign-in page.
// - Any API answer 401 (session ended) also leads to the sign-in page.
// - Shows the signed-in clinician, the Log out button, and the ADMIN tab for admins.
// Loaded before every other dashboard script.
// =============================================================================
(function () {
  const originalFetch = window.fetch.bind(window);
  let redirecting = false;

  function goToSignIn() {
    if (redirecting) return;
    redirecting = true;
    const next = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(`/login.html?next=${encodeURIComponent(next)}`);
  }

  function isOwnApi(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/') && !parsed.pathname.startsWith('/api/auth/');
    } catch {
      return false;
    }
  }

  // Every API call: a 401 means the session ended (signed out elsewhere, expired, deactivated)
  window.fetch = async function shiroFetch(input, init) {
    const res = await originalFetch(input, init);
    if (res.status === 401 && isOwnApi(input)) goToSignIn();
    return res;
  };

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  }

  function showUser(user) {
    const nameEl = document.getElementById('session-user-name');
    const roleEl = document.getElementById('session-user-role');
    const avatarEl = document.getElementById('session-user-avatar');
    if (nameEl) nameEl.textContent = `${user.full_name} (${user.clinician_id})`;
    if (roleEl) roleEl.textContent = user.role === 'ADMIN' ? 'Admin' : 'Clinician';
    if (avatarEl) avatarEl.textContent = initials(user.full_name);
    // What only admins see is marked .admin-only; the CSS hides it for everyone else,
    // also in pages loaded later
    document.body.setAttribute('data-role', user.role === 'ADMIN' ? 'ADMIN' : 'CLINICIAN');
  }

  async function logout() {
    try {
      await originalFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.warn('[AUTH] Sign-out request failed; the session ends when it expires:', err);
    }
    redirecting = true;
    window.location.replace('/login.html');
  }

  async function check() {
    let res;
    try {
      res = await originalFetch('/api/auth/me');
    } catch (err) {
      console.error('[AUTH] The edge server does not answer:', err);
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      goToSignIn();
      return new Promise(() => {}); // the page is leaving
    }
    const data = await res.json();
    if (!data.user) {
      goToSignIn();
      return new Promise(() => {});
    }
    return data.user;
  }

  /** After the WebSocket closed: is the session still valid? */
  async function stillSignedIn() {
    try {
      const res = await originalFetch('/api/auth/me');
      if (res.status === 401 || res.status === 403) {
        goToSignIn();
        return false;
      }
      return true;
    } catch {
      return true; // server down: keep trying to reconnect
    }
  }

  const ready = check().then((user) => {
    window.shiroAuth.user = user;
    const apply = () => showUser(user);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
    return user;
  });

  window.shiroAuth = { ready, user: null, logout, stillSignedIn, isAdmin: () => Boolean(window.shiroAuth.user && window.shiroAuth.user.role === 'ADMIN') };
})();
