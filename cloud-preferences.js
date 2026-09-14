/* Account preferences live in Supabase Auth's database, accessible only with the owner's session. */
(function (root) {
  function createCloudPreferences(config) {
    async function request(method, data) {
      if (!config.token() || config.token() === 'demo-local') throw new Error('请先登录云端账号');
      const send = () => (config.fetch || fetch)(config.url + '/auth/v1/user', {
        method, headers: { apikey: config.key, Authorization: 'Bearer ' + config.token(), 'Content-Type': 'application/json' },
        ...(data ? { body: JSON.stringify({ data }) } : {}),
      });
      let response = await send();
      if (response.status === 401 && config.refresh) { await config.refresh(); response = await send(); }
      if (!response.ok) throw new Error('云端行程保存或读取失败，请重试');
      const user = await response.json();
      const preferences = {};
      for (const [key, value] of Object.entries(user.user_metadata || {})) {
        if (/^sf_private_[1-9]\d*$/.test(key) && typeof value === 'boolean') preferences[key.slice(11)] = value;
      }
      return preferences;
    }
    return {
      read: () => request('GET'),
      setPrivate(id, value) {
        if (!Number.isSafeInteger(id) || id < 1 || typeof value !== 'boolean') return Promise.reject(new Error('行程设置无效'));
        // Auth merges top-level keys, so changing one event cannot overwrite another event's preference.
        return request('PUT', { ['sf_private_' + id]: value });
      },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = createCloudPreferences;
  else root.createCloudPreferences = createCloudPreferences;
})(typeof window !== 'undefined' ? window : this);
