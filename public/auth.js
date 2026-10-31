// Stage 2: Authentication, accounts and permission management
(function () {
  window.BrightloopViews = window.BrightloopViews || {};

  let currentUser = null;

  async function fetchCurrentUser() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
      } else {
        currentUser = null;
      }
    } catch {
      currentUser = null;
    }
    return currentUser;
  }

  function showModal(html) {
    let backdrop = document.querySelector('#auth-modal-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'auth-modal-backdrop';
      backdrop.className = 'modal-backdrop';
      document.body.append(backdrop);
    }
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    backdrop.classList.add('open');
    backdrop.querySelector('.modal-close')?.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
  }

  function closeModal() {
    const backdrop = document.querySelector('#auth-modal-backdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  function openSignInModal() {
    showModal(`
      <div class="modal-header">
        <h2>Sign in to Brightloop</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <form id="auth-signin-form" class="stack" style="padding: 20px 24px;">
        <div id="signin-error" class="form-message error-text" style="display:none;"></div>
        <label class="field">
          <span>Email address <b>*</b></span>
          <input type="email" name="email" required autocomplete="username" placeholder="you@company.com">
        </label>
        <label class="field">
          <span>Password <b>*</b></span>
          <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
        </label>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="link-button" id="btn-open-forgot">Forgot password?</button>
          <button type="submit" class="button">Sign In</button>
        </div>
        <div style="border-top:1px solid #edf1ee; padding-top:14px; text-align:center; font-size:12px; color:#68756d;">
          New customer? <button type="button" class="link-button" id="btn-open-signup">Create account</button>
        </div>
      </form>
    `);

    const form = document.querySelector('#auth-signin-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('#signin-error');
      errEl.style.display = 'none';
      const email = form.email.value.trim();
      const password = form.password.value;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to sign in');
        currentUser = data.user;
        closeModal();
        updateAuthBar();
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: currentUser }));
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });

    document.querySelector('#btn-open-forgot').addEventListener('click', openForgotPasswordModal);
    document.querySelector('#btn-open-signup').addEventListener('click', openSignUpModal);
  }

  function openSignUpModal() {
    showModal(`
      <div class="modal-header">
        <h2>Customer Registration</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <form id="auth-signup-form" class="stack" style="padding: 20px 24px;">
        <div id="signup-error" class="form-message error-text" style="display:none;"></div>
        <label class="field">
          <span>Full Name <b>*</b></span>
          <input type="text" name="name" required placeholder="Alice Sharma">
        </label>
        <label class="field">
          <span>Email address <b>*</b></span>
          <input type="email" name="email" required autocomplete="username" placeholder="alice@example.com">
        </label>
        <label class="field">
          <span>Password <b>*</b></span>
          <input type="password" name="password" required autocomplete="new-password" placeholder="Min. 9 characters with upper, lower & special">
          <small>Must be &gt;8 chars, with at least one uppercase, lowercase, and special character.</small>
        </label>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="link-button" id="btn-back-signin">Already registered? Sign in</button>
          <button type="submit" class="button">Register</button>
        </div>
      </form>
    `);

    const form = document.querySelector('#auth-signup-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('#signup-error');
      errEl.style.display = 'none';
      const name = form.name.value.trim();
      const email = form.email.value.trim();
      const password = form.password.value;
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration failed');
        currentUser = data.user;
        closeModal();
        updateAuthBar();
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: currentUser }));
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });

    document.querySelector('#btn-back-signin').addEventListener('click', openSignInModal);
  }

  function openForgotPasswordModal() {
    showModal(`
      <div class="modal-header">
        <h2>Reset Password</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <form id="auth-forgot-form" class="stack" style="padding: 20px 24px;">
        <div id="forgot-info" class="form-message" style="display:none;"></div>
        <div id="forgot-error" class="form-message error-text" style="display:none;"></div>
        <p style="font-size:12px; color:#5b6d63; margin:0;">Enter your account email to generate a secure password reset token.</p>
        <label class="field">
          <span>Email address <b>*</b></span>
          <input type="email" name="email" required placeholder="you@company.com">
        </label>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="link-button" id="btn-back-login">Back to Sign In</button>
          <button type="submit" class="button">Get Reset Link</button>
        </div>
      </form>
    `);

    const form = document.querySelector('#auth-forgot-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('#forgot-error');
      const infoEl = document.querySelector('#forgot-info');
      errEl.style.display = 'none';
      infoEl.style.display = 'none';
      const email = form.email.value.trim();
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (data.resetToken) {
          openResetPasswordModal(data.resetToken);
        } else {
          infoEl.textContent = data.message || 'If an account exists, a reset link was generated.';
          infoEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });

    document.querySelector('#btn-back-login').addEventListener('click', openSignInModal);
  }

  function openResetPasswordModal(presetToken = '') {
    showModal(`
      <div class="modal-header">
        <h2>Set New Password</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <form id="auth-reset-form" class="stack" style="padding: 20px 24px;">
        <div id="reset-error" class="form-message error-text" style="display:none;"></div>
        <label class="field">
          <span>Reset Token <b>*</b></span>
          <input type="text" name="token" required value="${presetToken}" placeholder="Paste token here">
        </label>
        <label class="field">
          <span>New Password <b>*</b></span>
          <input type="password" name="password" required placeholder="Min. 9 characters with upper, lower & special">
          <small>Must be &gt;8 chars, with at least one uppercase, lowercase, and special character.</small>
        </label>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <button type="button" class="link-button" id="btn-reset-cancel">Cancel</button>
          <button type="submit" class="button">Set Password</button>
        </div>
      </form>
    `);

    const form = document.querySelector('#auth-reset-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('#reset-error');
      errEl.style.display = 'none';
      const token = form.token.value.trim();
      const password = form.password.value;
      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Password reset failed');
        closeModal();
        alert('Password has been successfully updated! You can now sign in with your new password.');
        openSignInModal();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });

    document.querySelector('#btn-reset-cancel').addEventListener('click', closeModal);
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    currentUser = null;
    updateAuthBar();
    window.dispatchEvent(new CustomEvent('auth-changed', { detail: null }));
  }

  function updateAuthBar() {
    const container = document.querySelector('#auth-bar');
    if (!container) return;

    if (currentUser) {
      const roleClass = currentUser.role === 'admin' ? 'good' : currentUser.role === 'staff' ? 'info' : 'warn';
      container.innerHTML = `
        <div class="auth-user-badge">
          <span class="user-name">${currentUser.name || currentUser.email}</span>
          <span class="pill ${roleClass}">${currentUser.role.toUpperCase()}</span>
          <button id="btn-signout" class="button secondary" style="padding:4px 8px; font-size:11px;">Sign out</button>
        </div>
      `;
      document.querySelector('#btn-signout')?.addEventListener('click', logout);
    } else {
      container.innerHTML = `
        <div class="auth-actions">
          <button id="btn-signin" class="button secondary" style="padding:5px 10px; font-size:12px;">Sign In</button>
          <button id="btn-signup" class="button" style="padding:5px 10px; font-size:12px;">Register</button>
        </div>
      `;
      document.querySelector('#btn-signin')?.addEventListener('click', openSignInModal);
      document.querySelector('#btn-signup')?.addEventListener('click', openSignUpModal);
    }
  }

  // Stage 2: Staff Management View for Admins
  window.BrightloopViews.staff = async function ({ api, escape, heading, notify, rerender }) {
    if (currentUser && currentUser.role !== 'admin') {
      return {
        html: `
          ${heading('Staff Management', 'Internal staff accounts with day-to-day operations access.', 'Stage 2 · Accounts')}
          <div class="empty">
            <div class="empty-icon" aria-hidden="true">🔒</div>
            <h2>Admin access required</h2>
            <p>Only administrators can create and manage staff accounts.</p>
          </div>
        `,
      };
    }

    let staff = [];
    try {
      const res = await api('staff');
      staff = res.items || [];
    } catch {
      staff = [];
    }

    const html = `
      ${heading('Staff Management', 'Internal staff accounts with day-to-day operations access.', 'Stage 2 · Accounts')}
      <details class="panel form-panel" open>
        <summary>+ Add new staff member</summary>
        <form id="create-staff-form">
          <div class="form-grid three">
            <label class="field">
              <span>Full name <b>*</b></span>
              <input type="text" name="name" required placeholder="Sam Staff">
            </label>
            <label class="field">
              <span>Email address <b>*</b></span>
              <input type="email" name="email" required placeholder="sam@brightloop.io">
            </label>
            <label class="field">
              <span>Password <b>*</b></span>
              <input type="password" name="password" required placeholder="Min 9 chars (upper, lower, special)">
              <small>&gt;8 chars, uppercase, lowercase, special</small>
            </label>
          </div>
          <div class="form-actions" style="margin-top:14px;">
            <button type="submit">Create Staff Account</button>
            <span id="staff-msg" class="form-message"></span>
          </div>
        </form>
      </details>

      <section class="panel module-panel">
        <div class="table-heading">
          <h2>Active Staff Members</h2>
          <span>${staff.length} staff accounts</span>
        </div>
        ${staff.length ? `
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Created Date</th>
                </tr>
              </thead>
              <tbody>
                ${staff.map(s => `
                  <tr>
                    <td><strong>${escape(s.name)}</strong></td>
                    <td>${escape(s.email)}</td>
                    <td><span class="pill info">${escape(s.role)}</span></td>
                    <td>${escape(s.created_at ? s.created_at.slice(0, 10) : '—')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty">
            <div class="empty-icon" aria-hidden="true">🛡</div>
            <h2>No staff members yet</h2>
            <p>Add staff accounts to delegate day-to-day subscription and invoice operations.</p>
          </div>
        `}
      </section>
    `;

    return {
      html,
      mount(el) {
        const form = el.querySelector('#create-staff-form');
        form?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const msg = el.querySelector('#staff-msg');
          msg.textContent = 'Creating account…';
          msg.className = 'form-message';
          try {
            await api('staff', {
              method: 'POST',
              body: {
                name: form.name.value.trim(),
                email: form.email.value.trim(),
                password: form.password.value,
              },
            });
            notify('Staff account created successfully!');
            rerender();
          } catch (err) {
            msg.textContent = err.message;
            msg.className = 'form-message error-text';
          }
        });
      },
    };
  };

  // Stage 2: Customers View with Account Creation
  window.BrightloopViews.customers = async function ({ api, escape, heading, notify, rerender }) {
    let customers = [];
    try {
      const res = await api('customers');
      customers = res.items || [];
    } catch {
      customers = [];
    }

    const canCreate = currentUser?.role === 'admin' || currentUser?.role === 'staff';

    const html = `
      ${heading('Customers', 'Manage customer accounts and credentials.', 'Stage 2 · Accounts')}
      ${canCreate ? `
        <details class="panel form-panel">
          <summary>+ Register new customer</summary>
          <form id="create-customer-form">
            <div class="form-grid three">
              <label class="field">
                <span>Customer name <b>*</b></span>
                <input type="text" name="name" required placeholder="Acme Corp / John Doe">
              </label>
              <label class="field">
                <span>Email address <b>*</b></span>
                <input type="email" name="email" required placeholder="contact@acme.com">
              </label>
              <label class="field">
                <span>Password <b>*</b></span>
                <input type="password" name="password" required placeholder="Min 9 chars (upper, lower, special)">
                <small>&gt;8 chars, uppercase, lowercase, special</small>
              </label>
            </div>
            <div class="form-actions" style="margin-top:14px;">
              <button type="submit">Create Customer</button>
              <span id="cust-msg" class="form-message"></span>
            </div>
          </form>
        </details>
      ` : ''}

      <section class="panel module-panel">
        <div class="table-heading">
          <h2>All Customers</h2>
          <span>${customers.length} registered accounts</span>
        </div>
        ${customers.length ? `
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Created Date</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                ${customers.map(c => `
                  <tr>
                    <td><strong>${escape(c.name)}</strong></td>
                    <td>${escape(c.email)}</td>
                    <td>${escape(c.created_at ? c.created_at.slice(0, 10) : '—')}</td>
                    <td><span class="pill warn">Customer</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty">
            <div class="empty-icon" aria-hidden="true">♧</div>
            <h2>No customers registered yet</h2>
            <p>Customers can register on the portal or you can add them above.</p>
          </div>
        `}
      </section>
    `;

    return {
      html,
      mount(el) {
        const form = el.querySelector('#create-customer-form');
        form?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const msg = el.querySelector('#cust-msg');
          msg.textContent = 'Registering customer…';
          msg.className = 'form-message';
          try {
            await api('auth/register', {
              method: 'POST',
              body: {
                name: form.name.value.trim(),
                email: form.email.value.trim(),
                password: form.password.value,
              },
            });
            notify('Customer account created!');
            rerender();
          } catch (err) {
            msg.textContent = err.message;
            msg.className = 'form-message error-text';
          }
        });
      },
    };
  };

  window.BrightloopAuth = {
    fetchCurrentUser,
    get currentUser() { return currentUser; },
    openSignInModal,
    openSignUpModal,
    openForgotPasswordModal,
    logout,
    updateAuthBar,
  };

  // Initial load
  document.addEventListener('DOMContentLoaded', async () => {
    await fetchCurrentUser();
    updateAuthBar();
  });
})();
