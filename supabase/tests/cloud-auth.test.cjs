const { test } = require('node:test');
const assert = require('node:assert/strict');
const createCloudAuth = require('../../cloud-auth.js');

const base = { url: 'https://demo.supabase.co', key: 'anon-key' };
function response(status, body, json = true) {
  return { ok: status >= 200 && status < 300, status,
    ...(json ? { text: async () => JSON.stringify(body) } : { text: async () => String(body) }) };
}
function fakeFetch(handler) { return async (url, opts) => handler(url, opts); }

test('signIn parses a valid session and sends public key', async () => {
  let seen;
  const auth = createCloudAuth({ ...base, fetch: fakeFetch((url, opts) => { seen = { url, opts }; return response(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'u' } }); }) });
  const out = await auth.signIn('A@EXAMPLE.COM', 'password123');
  assert.equal(out.token, 'tok'); assert.equal(out.user.id, 'u'); assert.equal(seen.opts.headers.apikey, 'anon-key');
});

test('invalid credentials are translated', async () => {
  const auth = createCloudAuth({ ...base, fetch: fakeFetch(() => response(400, { error_code: 'invalid_credentials' })) });
  await assert.rejects(() => auth.signIn('a@example.com', 'password123'), /邮箱或密码错误/);
});

test('signup without a session requires confirmation and never fabricates a token', async () => {
  const auth = createCloudAuth({ ...base, fetch: fakeFetch(() => response(200, { user: { id: 'u' }, session: null })) });
  const out = await auth.signUp('a@example.com', 'password123');
  assert.equal(out.confirmation_required, true); assert.equal('token' in out, false);
});

test('setPassword authenticates the owner with bearer token', async () => {
  let seen;
  const auth = createCloudAuth({ ...base, fetch: fakeFetch((url, opts) => { seen = { url, opts }; return response(200, { user: { id: 'u' } }); }) });
  const out = await auth.setPassword('owner-token', 'password123');
  assert.equal(out.user.id, 'u'); assert.equal(seen.opts.headers.Authorization, 'Bearer owner-token');
  assert.equal(JSON.parse(seen.opts.body).password, 'password123');
});

test('non-json and network failures remain safe errors', async () => {
  const bad = createCloudAuth({ ...base, fetch: fakeFetch(() => response(500, '<html>oops</html>', false)) });
  await assert.rejects(() => bad.signIn('a@example.com', 'password123'), /认证服务暂时不可用/);
  const net = createCloudAuth({ ...base, fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(() => net.signIn('a@example.com', 'password123'), /网络连接失败/);
});

test('signup and weak password errors are translated', async () => {
  const auth = createCloudAuth({ ...base, fetch: fakeFetch(() => response(400, { code: 'user_already_exists' })) });
  await assert.rejects(() => auth.signUp('a@example.com', 'password123'), /该邮箱已注册/);
  await assert.rejects(() => auth.signIn('a@example.com', 'short'), /8 至 128/);
});
