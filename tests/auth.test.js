import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { authenticate as authAuthenticate, validatePassword, hashPassword, verifyPassword } from '../server/auth.js';

async function startApp() {
  const db = openDatabase(':memory:');
  const server = createApp(db, { authenticate: authAuthenticate });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, path, body, token) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    const json = await response.json();
    return { status: response.status, body: json, setCookie };
  };

  const stop = () => new Promise(resolve => server.close(() => { db.close(); resolve(); }));
  return { db, call, stop };
}

test('password policy requires >8 characters, uppercase, lowercase, and special character', () => {
  // Too short (<= 8)
  assert.throws(() => validatePassword('Ab1!'), /more than 8 characters/);
  assert.throws(() => validatePassword('Abcdef1!'), /more than 8 characters/); // exactly 8 characters

  // Missing uppercase
  assert.throws(() => validatePassword('lowercase1!'), /uppercase letter/);

  // Missing lowercase
  assert.throws(() => validatePassword('UPPERCASE1!'), /lowercase letter/);

  // Missing special character
  assert.throws(() => validatePassword('Password123'), /special character/);

  // Valid passwords (> 8 chars, uppercase, lowercase, special char)
  assert.doesNotThrow(() => validatePassword('Password123!')); // 12 chars
  assert.doesNotThrow(() => validatePassword('SuperSecret#2026')); // 16 chars

  // Hash & verify
  const hash = hashPassword('SuperSecret#2026');
  assert.equal(verifyPassword('SuperSecret#2026', hash), true);
  assert.equal(verifyPassword('WrongPassword#2026', hash), false);
  assert.equal(verifyPassword('SuperSecret#2026', 'invalid-hash'), false);
});

test('customer registration enforces unique email, password complexity and logs in', async () => {
  const { call, stop } = await startApp();
  try {
    // Bad password
    const badPw = await call('POST', '/auth/register', {
      name: 'Alice Customer',
      email: 'alice@example.com',
      password: 'short',
    });
    assert.equal(badPw.status, 400);

    // Successful registration
    const reg = await call('POST', '/auth/register', {
      name: 'Alice Customer',
      email: 'alice@example.com',
      password: 'StrongPassword@123',
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.name, 'Alice Customer');
    assert.equal(reg.body.user.email, 'alice@example.com');
    assert.equal(reg.body.user.role, 'customer');
    assert.ok(reg.body.token);
    assert.ok(reg.setCookie?.includes('session='));

    // Duplicate email rejected with 409
    const dup = await call('POST', '/auth/register', {
      name: 'Alice Imposter',
      email: 'ALICE@example.com',
      password: 'StrongPassword@123',
    });
    assert.equal(dup.status, 409);

    // Verify authenticated session
    const me = await call('GET', '/auth/me', undefined, reg.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'alice@example.com');
    assert.equal(me.body.user.role, 'customer');
  } finally {
    await stop();
  }
});

test('session authentication: login, me, and logout', async () => {
  const { db, call, stop } = await startApp();
  try {
    const pwHash = hashPassword('UserPassword@2026');
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Bob', 'bob@example.com', ?, 'customer')")
      .run(pwHash);

    // Unauthenticated GET /auth/me returns null user
    const unauthMe = await call('GET', '/auth/me');
    assert.equal(unauthMe.status, 200);
    assert.equal(unauthMe.body.user, null);

    // Wrong password login
    const wrong = await call('POST', '/auth/login', {
      email: 'bob@example.com',
      password: 'WrongPassword@123',
    });
    assert.equal(wrong.status, 401);

    // Successful login
    const login = await call('POST', '/auth/login', {
      email: 'bob@example.com',
      password: 'UserPassword@2026',
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.name, 'Bob');
    assert.ok(login.body.token);

    // Auth me with token
    const me = await call('GET', '/auth/me', undefined, login.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'bob@example.com');

    // Logout
    const logout = await call('POST', '/auth/logout', undefined, login.body.token);
    assert.equal(logout.status, 200);
    assert.equal(logout.body.success, true);

    // Old token should now be invalid
    const meAfter = await call('GET', '/auth/me', undefined, login.body.token);
    assert.equal(meAfter.body.user, null);
  } finally {
    await stop();
  }
});

test('password reset flow: request token and reset password', async () => {
  const { db, call, stop } = await startApp();
  try {
    const originalHash = hashPassword('OldPassword@123');
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Carol', 'carol@example.com', ?, 'customer')")
      .run(originalHash);

    // Request reset
    const reqReset = await call('POST', '/auth/forgot-password', { email: 'carol@example.com' });
    assert.equal(reqReset.status, 200);
    assert.ok(reqReset.body.resetToken);
    const token = reqReset.body.resetToken;

    // Non-existent email still returns 200 to prevent user enumeration
    const notFound = await call('POST', '/auth/forgot-password', { email: 'nobody@example.com' });
    assert.equal(notFound.status, 200);
    assert.equal(notFound.body.resetToken, null);

    // Bad reset token
    const badToken = await call('POST', '/auth/reset-password', {
      token: 'fake-token-1234',
      password: 'NewStrongPassword@999',
    });
    assert.equal(badToken.status, 400);

    // Weak new password
    const weakNew = await call('POST', '/auth/reset-password', {
      token,
      password: 'weak',
    });
    assert.equal(weakNew.status, 400);

    // Valid reset
    const reset = await call('POST', '/auth/reset-password', {
      token,
      password: 'NewStrongPassword@999',
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.success, true);

    // Old password should fail
    const oldLogin = await call('POST', '/auth/login', {
      email: 'carol@example.com',
      password: 'OldPassword@123',
    });
    assert.equal(oldLogin.status, 401);

    // New password succeeds
    const newLogin = await call('POST', '/auth/login', {
      email: 'carol@example.com',
      password: 'NewStrongPassword@999',
    });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.user.name, 'Carol');
  } finally {
    await stop();
  }
});

test('staff management: only admin can create and list staff', async () => {
  const { db, call, stop } = await startApp();
  try {
    const adminHash = hashPassword('AdminPass@123');
    const customerHash = hashPassword('CustomerPass@123');
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'admin@example.com', ?, 'admin')").run(adminHash);
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Dave', 'dave@example.com', ?, 'customer')").run(customerHash);

    const adminLogin = await call('POST', '/auth/login', { email: 'admin@example.com', password: 'AdminPass@123' });
    const adminToken = adminLogin.body.token;

    const custLogin = await call('POST', '/auth/login', { email: 'dave@example.com', password: 'CustomerPass@123' });
    const custToken = custLogin.body.token;

    // Unauthenticated attempt to add staff fails with 401
    const unauthStaff = await call('POST', '/staff', {
      name: 'Sam Staff',
      email: 'sam@example.com',
      password: 'StaffPassword@123',
    });
    assert.equal(unauthStaff.status, 401);

    // Customer attempt to add staff fails with 403
    const custStaff = await call('POST', '/staff', {
      name: 'Sam Staff',
      email: 'sam@example.com',
      password: 'StaffPassword@123',
    }, custToken);
    assert.equal(custStaff.status, 403);

    // Customer attempt to list staff fails with 403
    const custStaffList = await call('GET', '/staff', undefined, custToken);
    assert.equal(custStaffList.status, 403);

    // Admin adds staff succeeds
    const addStaff = await call('POST', '/staff', {
      name: 'Sam Staff',
      email: 'sam@example.com',
      password: 'StaffPassword@123',
    }, adminToken);
    assert.equal(addStaff.status, 201);
    assert.equal(addStaff.body.name, 'Sam Staff');
    assert.equal(addStaff.body.role, 'staff');

    // Admin lists staff
    const staffList = await call('GET', '/staff', undefined, adminToken);
    assert.equal(staffList.status, 200);
    assert.equal(staffList.body.items.length, 1);
    assert.equal(staffList.body.items[0].email, 'sam@example.com');
  } finally {
    await stop();
  }
});
