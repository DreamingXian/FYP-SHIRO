// =============================================================================
// Sign-in page: normal sign-in, or creating the first admin on the server PC
// =============================================================================
(function () {
  const note = document.getElementById('login-note');
  const errorBox = document.getElementById('login-error');
  const loginForm = document.getElementById('form-login');
  const setupForm = document.getElementById('form-setup');

  // Only a path on this server is followed after sign-in
  function nextPage() {
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    return /^\/(?!\/)[A-Za-z0-9/_.?=&#-]*$/.test(next) ? next : '/';
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = message ? 'block' : 'none';
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      console.warn('[LOGIN] Answer was not JSON:', err);
    }
    return { ok: res.ok, data };
  }

  async function start() {
    try {
      const res = await fetch('/api/auth/status');
      const status = await res.json();
      if (status.user && status.user.type === 'CLINICIAN') {
        window.location.replace(nextPage());
        return;
      }
      if (status.setup_needed) {
        if (status.setup_allowed_here) {
          note.textContent = 'No account exists yet. Create the first admin account. It can create the other accounts afterwards.';
          setupForm.classList.add('visible');
          document.getElementById('setup-fullname').focus();
        } else {
          note.textContent = 'No account exists yet. The first admin account can only be created on the server PC itself: open http://localhost:3000 there.';
        }
        return;
      }
      note.textContent = 'Sign in with your clinician account.';
      loginForm.classList.add('visible');
      document.getElementById('login-username').focus();
    } catch (err) {
      console.error('[LOGIN] Server not reachable:', err);
      note.textContent = 'The edge server does not answer. Check that it is running, then reload this page.';
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const button = document.getElementById('login-submit');
    button.disabled = true;
    try {
      const { ok, data } = await postJson('/api/auth/login', {
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value
      });
      if (ok) {
        window.location.replace(nextPage());
        return;
      }
      showError(data.error || 'Sign-in failed.');
      document.getElementById('login-password').value = '';
    } catch (err) {
      console.error('[LOGIN] Sign-in request failed:', err);
      showError('The edge server does not answer.');
    } finally {
      button.disabled = false;
    }
  });

  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const password = document.getElementById('setup-password').value;
    if (password !== document.getElementById('setup-password2').value) {
      showError('The two passwords are not the same.');
      return;
    }
    const button = document.getElementById('setup-submit');
    button.disabled = true;
    try {
      const { ok, data } = await postJson('/api/auth/setup', {
        full_name: document.getElementById('setup-fullname').value,
        username: document.getElementById('setup-username').value,
        password
      });
      if (ok) {
        window.location.replace('/');
        return;
      }
      showError(data.error || 'The account could not be created.');
    } catch (err) {
      console.error('[LOGIN] Set-up request failed:', err);
      showError('The edge server does not answer.');
    } finally {
      button.disabled = false;
    }
  });

  start();
})();
