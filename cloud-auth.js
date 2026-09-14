/* Small Supabase Auth REST client.  Uses only the public anon key and the
 * caller's bearer token; it never invokes Auth admin APIs or logs credentials. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createCloudAuth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const messages = {
    invalid_credentials: '邮箱或密码错误',
    email_not_confirmed: '邮箱尚未验证，请先完成邮箱确认',
    user_already_exists: '该邮箱已注册',
    weak_password: '密码长度需为 8 至 128 位',
    signup_disabled: '当前未开放邮箱注册',
    over_request_rate_limit: '请求过于频繁，请稍后再试',
  };

  function translated(error, status) {
    const code = String(error ? (error.code || error.error_code || '') : '').trim();
    const raw = String(error ? (error.msg || error.message || error.error_description || '') : '').trim();
    const key = code.toLowerCase();
    if (messages[key]) return messages[key];
    if (status === 429 || /rate|limit|too many/i.test(raw)) return messages.over_request_rate_limit;
    if (/invalid credentials|invalid login credentials/i.test(raw)) return messages.invalid_credentials;
    if (/email.*not.*confirm|not.*confirm.*email/i.test(raw)) return messages.email_not_confirmed;
    if (/already.*exist|already.*registered/i.test(raw)) return messages.user_already_exists;
    if (/weak password|password.*(at least|characters)|password.*weak/i.test(raw)) return messages.weak_password;
    if (/signup.*disabled|signups?.*disabled/i.test(raw)) return messages.signup_disabled;
    return raw || '认证服务暂时不可用，请稍后再试';
  }

  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()); }
  function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }

  function sessionResult(data) {
    const token = data && (data.access_token || data.token);
    const user = data && data.user;
    if (!token || !user) return null;
    let expires = data.expires_at;
    if (expires == null && Number.isFinite(Number(data.expires_in))) expires = Math.floor(Date.now() / 1000) + Number(data.expires_in);
    return { ok: true, token, refresh_token: data.refresh_token, expires_at: expires, user };
  }

  return function createCloudAuth(config) {
    config = config || {};
    const base = String(config.url || '').replace(/\/$/, '');
    const key = String(config.key || '');
    const fetcher = config.fetch || (typeof fetch === 'function' && fetch);
    if (!base || !key || !fetcher) throw new Error('云端认证配置无效');

    async function request(path, options) {
      let response;
      try {
        response = await fetcher(base + path, {
          method: options.method || 'POST',
          headers: Object.assign({ apikey: key, 'Content-Type': 'application/json' }, options.headers || {}),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (e) {
        const err = new Error('网络连接失败，请稍后重试'); err.cause = e; throw err;
      }
      let payload = null;
      try {
        if (typeof response.text === 'function') {
          const text = await response.text();
          if (text) { try { payload = JSON.parse(text); } catch (_) { payload = null; } }
        } else if (typeof response.json === 'function') payload = await response.json();
      } catch (_) { payload = null; }
      if (!response.ok) {
        const err = new Error(translated(payload, response.status));
        err.code = payload && (payload.code || payload.error_code);
        err.status = response.status;
        throw err;
      }
      return payload || {};
    }

    async function signIn(email, password) {
      email = String(email || '').trim().toLowerCase();
      if (!validEmail(email)) throw new Error('请输入正确的邮箱地址');
      if (!validPassword(password)) throw new Error('密码长度需为 8 至 128 位');
      const data = await request('/auth/v1/token?grant_type=password', { body: { email, password } });
      const result = sessionResult(data);
      if (!result) throw new Error('登录响应无效，请稍后重试');
      return result;
    }

    async function signUp(email, password, redirectTo) {
      email = String(email || '').trim().toLowerCase();
      if (!validEmail(email)) throw new Error('请输入正确的邮箱地址');
      if (!validPassword(password)) throw new Error('密码长度需为 8 至 128 位');
      const body = { email, password };
      if (redirectTo) body.redirect_to = String(redirectTo);
      const data = await request('/auth/v1/signup', { body });
      const result = sessionResult(data);
      if (!result) return { ok: true, confirmation_required: true, msg: '注册成功，请查收邮箱完成确认' };
      return result;
    }

    async function setPassword(token, password) {
      if (!token) throw new Error('请先登录后再设置密码');
      if (!validPassword(password)) throw new Error('密码长度需为 8 至 128 位');
      const data = await request('/auth/v1/user', { method: 'PUT', headers: { Authorization: 'Bearer ' + String(token) }, body: { password } });
      return { ok: true, user: data.user || data };
    }

    return { signIn, signUp, setPassword };
  };
});
