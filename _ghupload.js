// 通过 api.github.com 上传整个项目（绕开被墙的 git 通道）
// 用法: node _ghupload.js  （依赖 gh CLI 已用有写权限的令牌登录）
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = 'HKH168', REPO = 'samefreq';
const ROOT = __dirname;

const TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
if (!TOKEN) { console.error('未取得 gh 令牌'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method, headers: H,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

const FILES = [
  ['index.html', 'index.html'],
  ['login.html', 'login.html'],
  ['404.html', '404.html'],
  ['.nojekyll', '.nojekyll'],
  ['README.md', 'README.md'],
  ['.gitignore', '.gitignore'],
  ['backend/server.js', 'backend/server.js'],
  ['start.bat', 'start.bat'],
  ['产品说明.md', '产品说明.md'],
];

(async () => {
  // 1. 创建仓库（若已存在则忽略 422）
  try {
    await api('POST', '/user/repos', {
      name: REPO,
      description: '乐遇同频 · 校园演出搭子社区（演出雷达+搭子广场+idol应援墙，iPhone 移动端原型）',
      private: false, auto_init: false
    });
    console.log('✅ 仓库已创建');
  } catch (e) {
    if (!/422/.test(e.message)) throw e;
    console.log('ℹ️  仓库已存在，继续');
  }

  // 2. 逐文件上传（contents API，首个文件自动初始化仓库）
  for (const [local, remote] of FILES) {
    const buf = fs.readFileSync(path.join(ROOT, local));
    const put = async () => {
      // 已存在则需带 sha 覆盖
      let sha;
      try {
        const old = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(remote)}`);
        sha = old.sha;
      } catch (e) { /* 不存在，忽略 */ }
      return api('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(remote)}`, {
        message: `upload ${remote}`,
        content: buf.toString('base64'), sha
      });
    };
    await put();
    console.log(`✅ 已上传 ${remote} (${buf.length}B)`);
  }
  console.log('✅ 全部文件已提交到 main');

  // 4. 开通 Pages（deploy from branch main /）
  try {
    const p = await api('POST', `/repos/${OWNER}/${REPO}/pages`, {
      source: { branch: 'main', path: '/' }
    });
    console.log('✅ Pages: ' + p.html_url);
  } catch (e) {
    console.log('⚠️  Pages 开通返回: ' + e.message.slice(0, 200));
  }
  console.log('🎉 完成: https://hkh168.github.io/samefreq/');
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
