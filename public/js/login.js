const form = document.getElementById('login-form');
    const errorEl = document.getElementById('error');
    const submitBtn = document.getElementById('submit-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in...';

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
          window.location.href = '/chat';
          return;
        }
        errorEl.textContent = data.error || 'Invalid username or password.';
      } catch (err) {
        errorEl.textContent = 'Could not reach the server. Please try again.';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      }
    });
