export async function handlePassword(ctx, enrich = async u => u) {
  const b = await ctx.body();
  const mode = b.mode || 'login';
  const password = b.password;
  const email = String(b.email || '').trim().toLowerCase();
  const bad = (msg, status = 400) => ctx.reply({ ok: false, msg }, status);
  if (!['login', 'signup', 'set'].includes(mode)) return bad('认证操作无效');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return bad('密码长度需为 8 至 128 位');
  if (mode !== 'set' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('请输入正确的邮箱地址');
  let result;
  if (mode === 'set') {
    const token = (ctx.req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return bad('请先登录', 401);
    const verified = await ctx.anon.auth.getUser(token);
    if (verified.error || !verified.data?.user) return bad('登录已失效，请重新登录', 401);
    result = await ctx.admin.auth.admin.updateUserById(verified.data.user.id, { password });
  } else {
    result = mode === 'signup' ? await ctx.anon.auth.signUp({ email, password }) : await ctx.anon.auth.signInWithPassword({ email, password });
  }
  if (result.error) {
    const code = result.error.code;
    const msg = code === 'email_not_confirmed' ? '邮箱尚未验证，请先完成邮箱确认' : code === 'invalid_credentials' ? '邮箱或密码错误' : code === 'user_already_exists' ? '该邮箱已注册' : '认证失败，请稍后重试';
    return bad(msg, result.error.status === 429 ? 429 : 400);
  }
  if (mode === 'set') return ctx.reply({ ok: true, user: await enrich(result.data.user), msg: '密码已保存' });
  const { session, user } = result.data || {};
  if (!session && mode === 'signup') return ctx.reply({ ok: false, confirmation_required: true, msg: '请查收邮箱完成确认后再登录' });
  if (!session?.access_token || !user) return bad('登录响应无效', 502);
  return ctx.reply({ ok: true, token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at, user: await enrich(user) });
}
