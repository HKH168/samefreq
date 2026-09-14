/**
 * 乐遇同频 — 完整网站后端（主站 + 登录 + 数据库）
 * 技术栈：Node.js 原生 http + 内置 SQLite（node:sqlite），零第三方依赖
 *
 * 路由总览：
 *   页面   GET  /                 主站（手机版 App 首页）
 *   页面   GET  /login.html       登录页
 *
 *   认证   POST /api/auth/send-code    发送验证码（开发模式直接返回 code）
 *          POST /api/auth/verify       校验验证码，登录/注册一体化
 *          POST /api/auth/logout       退出登录
 *          GET  /api/me                当前用户信息（Bearer Token）
 *
 *   主站   GET  /api/bootstrap         启动数据（演出/帖子/后援墙 + 个人标记状态 + 未读数）
 *
 *   演出   POST /api/events            发布演出（需登录）
 *          POST /api/events/:id/want   标记/取消「想去」（需登录）
 *
 *   搭子   POST /api/posts             发布搭子招募（需登录）
 *          POST /api/posts/:id/paw     举爪报名（需登录，一次性）
 *          POST /api/posts/:id/close   关闭招募（仅发布者）
 *
 *   应援墙 POST /api/walls             创建自己的 idol 应援墙（需登录）
 *          GET  /api/walls/:id         墙详情（第二跳转界面）
 *          POST /api/walls/:id/join    加入后援墙（需登录，一次性）
 *          POST /api/walls/:id/posts   在墙内发布应援动态（需登录）
 *          POST /api/wall-posts/:id/like  给墙内动态点赞（需登录，一次性）
 *
 *   我的   GET  /api/me/profile        我的主页数据（资料 + 统计 + 作品）
 *          POST /api/me/profile        修改资料（昵称/签名/学校/城市/头像）
 *          GET  /api/messages          消息中心
 *          POST /api/messages/read     全部标记已读
 *
 * 启动：node server.js   （默认端口 3000，可用环境变量 PORT 覆盖）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tongpin.db');

/* ================================================================
 * 数据库
 * ================================================================ */
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  nickname      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verify_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_phone ON verify_codes(phone, used, expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 演出
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  title  TEXT NOT NULL,
  date   TEXT NOT NULL, month TEXT NOT NULL, genre TEXT NOT NULL,
  venue  TEXT NOT NULL, ticket TEXT NOT NULL,
  want   INTEGER NOT NULL DEFAULT 0,
  groups INTEGER NOT NULL DEFAULT 0,
  grad   TEXT NOT NULL,
  emoji  TEXT NOT NULL
);

-- 搭子招募帖
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT NOT NULL, emoji TEXT NOT NULL, school TEXT NOT NULL,
  ev         TEXT NOT NULL, count TEXT NOT NULL, note TEXT NOT NULL,
  tags       TEXT NOT NULL,
  paw        INTEGER NOT NULL DEFAULT 0,
  open       INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 歌手 / idol 应援墙
CREATE TABLE IF NOT EXISTS walls (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL,
  fans  INTEGER NOT NULL DEFAULT 0,
  hype  INTEGER NOT NULL DEFAULT 0
);

-- 墙内应援动态
CREATE TABLE IF NOT EXISTS wall_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wall_id    INTEGER NOT NULL,
  user_id    INTEGER,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  content    TEXT NOT NULL,
  likes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 消息中心
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  wall_id    INTEGER,
  read_flg   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 用户行为记录（保证一人一票）
CREATE TABLE IF NOT EXISTS event_wants    (user_id INTEGER, event_id INTEGER, PRIMARY KEY(user_id,event_id));
CREATE TABLE IF NOT EXISTS post_paws      (user_id INTEGER, post_id  INTEGER, PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS wall_joins     (user_id INTEGER, wall_id  INTEGER, PRIMARY KEY(user_id,wall_id));
CREATE TABLE IF NOT EXISTS wall_post_likes(user_id INTEGER, post_id  INTEGER, PRIMARY KEY(user_id,post_id));
`);

/* ---------------- 轻量迁移：给已有库补新字段 ---------------- */
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'avatar', `TEXT NOT NULL DEFAULT '🎧'`);
addColumn('users', 'signature', `TEXT NOT NULL DEFAULT '在看演出的路上，顺便找个人一起。'`);
addColumn('users', 'school', `TEXT NOT NULL DEFAULT '原力大学'`);
addColumn('users', 'city', `TEXT NOT NULL DEFAULT '原力城市'`);
addColumn('walls', 'owner_id', 'INTEGER');
addColumn('walls', 'slogan', `TEXT NOT NULL DEFAULT ''`);
addColumn('walls', 'grad', `TEXT NOT NULL DEFAULT '["#4A3878","#9B7EDE"]'`);
addColumn('walls', 'created_at', `TEXT NOT NULL DEFAULT ''`);
addColumn('walls', 'custom', 'INTEGER NOT NULL DEFAULT 0');

/* ---------------- 渐变配色池（新内容自动分配） ---------------- */
const GRADS = [
  ['#4A3878', '#9B7EDE'], ['#B33B5E', '#F08A5D'], ['#1F6F5C', '#3FA98A'],
  ['#2B2340', '#6C4AB6'], ['#C2410C', '#F2B263'], ['#1E3A8A', '#60A5FA'],
  ['#6D28D9', '#EC4899'], ['#0F766E', '#5EEAD4'],
];
const pickGrad = (seed) => {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return GRADS[h % GRADS.length];
};

/* ---------------- 首次运行时填充种子数据 ---------------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM events').get().c === 0) {
    const ins = db.prepare(
      `INSERT INTO events (title,date,month,genre,venue,ticket,want,groups,grad,emoji) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    [
      ['「声音碎片」巡回演唱会', '24', 'OCT', '独立摇滚', '市体育馆 · 距学校 4 站地铁', '售票中 · 380 起', 86, 3, ['#4A3878', '#9B7EDE'], '🎸'],
      ['星海跨年音乐节 · 双日', '31', 'DEC', '音乐节 · 跨城', '滨江公园 · 邻市 2h 高铁', '早鸟已罄 · 正售 780', 214, 9, ['#B33B5E', '#F08A5D'], '🎆'],
      ['校庆晚会 · 学生乐队专场', '08', 'NOV', '校园舞台', '本校大礼堂 · 凭学生证免费', '需预约 · 余 200 张', 152, 5, ['#1F6F5C', '#3FA98A'], '🎤'],
      ['码头爵士周末 · 第 12 期', '15', 'NOV', '爵士 Livehouse', '老码头 Livehouse · 公交 20 分钟', '现场票 120', 37, 1, ['#2B2340', '#6C4AB6'], '🎷'],
    ].forEach(r => ins.run(...r.map(v => Array.isArray(v) ? JSON.stringify(v) : v)));
  }
  if (db.prepare('SELECT COUNT(*) c FROM posts').get().c === 0) {
    const ins = db.prepare(
      `INSERT INTO posts (user_id,name,emoji,school,ev,count,note,tags,paw,open,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    [
      ['阿茶', '🦊', '原力大学', '星海跨年音乐节 · 双日', '1 位',
        '找 1 名女生搭子，跨年场！高铁往返拼票，酒店已订双床房，A 费用。演唱会全程不冷场型选手优先～',
        ['同校优先', '拼车', '拼住宿', '散场约饭'], 23, 1],
      ['大周', '🐻', '临江大学', '「声音碎片」巡回演唱会', '2 位',
        '内场 380 票两张，有想一起的吗？地铁 2 号线沿线集合，散场可以去吃海底捞。本人 E 人，不怕冷场。',
        ['顺路同行', '散场约饭'], 11, 1],
      ['米娅', '🐱', '海滨学院', '码头爵士周末 · 第 12 期', '1 位',
        '第一次去 Livehouse 想找个有经验的带路，本人安静的爵士爱好者，散场可以边走边聊 Chet Baker。',
        ['同校优先'], 5, 1],
      ['Kiko', '🐰', '原力大学', '星海跨年音乐节 · 双日', '3 位及以上',
        '组跨年音乐节自驾小队！已有一车 4 人，再凑 2-3 人拼油费和民宿。露营装备齐，负责放歌单的岗位急招。',
        ['拼车', '拼住宿'], 31, 1],
      ['树树', '🐨', '临江大学', '校庆晚会 · 学生乐队专场', '2 位',
        '校庆晚会志愿者和观演搭子都要！看完学生乐队专场想去后台要签名的社死勇气值不够，需要搭子壮胆。',
        ['同校优先'], 8, 1],
      ['阿哲', '🦉', '原力大学', '「声音碎片」巡回演唱会', '1 位',
        '已组到搭子啦，感谢举爪的 4 位同学！散场宵夜局还有空位，欢迎偶遇。',
        ['顺路同行'], 9, 0],
    ].forEach(r => ins.run(...r.map(v => Array.isArray(v) ? JSON.stringify(v) : v), now));
  }
  if (db.prepare('SELECT COUNT(*) c FROM walls').get().c === 0) {
    const ins = db.prepare(
      `INSERT INTO walls (name,emoji,fans,hype,owner_id,slogan,grad,created_at,custom) VALUES (?,?,?,?,NULL,?,?,?,0)`);
    const now = new Date().toISOString();
    [
      ['周杰伦', '🎹', 428, 0, '从《Jay》听到现在，一代人的青春背景音。'],
      ['Taylor Swift', '✨', 276, 0, 'The Eras Tour 老兵，欢迎来换票根和友谊手链。'],
      ['五月天', '💙', 390, 0, '人生无限公司原力分部，跨年见。'],
      ['新裤子', '🕺', 189, 0, '你要跳舞吗？一起把 Livehouse 掀了。'],
      ['万能青年旅店', '🎺', 214, 1, '冀西南林路行的尽头，我们都在这里。'],
      ['林俊杰', '🎤', 301, 0, '唱歌的人假装唱得不太用力，听的人假装没掉眼泪。'],
      ['刘宇宁', '🎙️', 238, 0, '摩登兄弟的歌声，陪你走过每一段路。'],
      ['汪苏泷', '🎹', 265, 0, '小汪的旋律，青春回忆的 BGM。'],
      ['薛之谦', '🎤', 412, 0, '用一首歌，唱尽我们的故事。'],
    ].forEach(r => ins.run(r[0], r[1], r[2], r[3], r[4], JSON.stringify(pickGrad(r[0])), now));
  }
  if (db.prepare('SELECT COUNT(*) c FROM wall_posts').get().c === 0) {
    const walls = db.prepare('SELECT id,name FROM walls').all();
    const byName = (n) => walls.find(w => w.name === n);
    const ins = db.prepare(
      `INSERT INTO wall_posts (wall_id,user_id,name,emoji,content,likes,created_at) VALUES (?,NULL,?,?,?,?,?)`);
    const now = new Date().toISOString();
    const rows = [];
    const jay = byName('周杰伦'); if (jay) rows.push([jay.id, '椰子', '🥥', '翻牌！刚把《晴天》的钢琴谱练下来了，谁要一起合奏？', 42, now]);
    const mt = byName('五月天'); if (mt) rows.push([mt.id, '阿信的同桌', '🎈', '跨年场的荧光棒拼单，还差 3 个人凑满减，有无同校的？', 67, now]);
    const om = byName('万能青年旅店'); if (om) rows.push([om.id, '石家庄人', '🛢️', '昨天在体育馆听到《杀死那个石家庄人》，全场大合唱的时候我起了一身鸡皮疙瘩。', 128, now]);
    rows.forEach(r => ins.run(...r));
  }
  // 老库补默认值：给没有配色的墙逐一分配渐变色 / 补齐创建时间 / 补应援口号
  db.prepare(`SELECT id,name FROM walls WHERE custom = 0`).all().forEach(w => {
    db.prepare(`UPDATE walls SET grad = ? WHERE id = ?`).run(JSON.stringify(pickGrad(w.name)), w.id);
  });
  db.prepare(`UPDATE walls SET created_at = ? WHERE created_at = '' OR created_at IS NULL`).run(new Date().toISOString());
  const SEED_SLOGANS = {
    '周杰伦': '从《Jay》听到现在，一代人的青春背景音。',
    'Taylor Swift': 'The Eras Tour 老兵，欢迎来换票根和友谊手链。',
    '五月天': '人生无限公司原力分部，跨年见。',
    '新裤子': '你要跳舞吗？一起把 Livehouse 掀了。',
    '万能青年旅店': '冀西南林路行的尽头，我们都在这里。',
    '林俊杰': '唱歌的人假装唱得不太用力，听的人假装没掉眼泪。',
  };
  for (const [n, s] of Object.entries(SEED_SLOGANS)) {
    db.prepare(`UPDATE walls SET slogan = ? WHERE name = ? AND (slogan = '' OR slogan IS NULL)`).run(s, n);
  }
  const EXTRA_WALLS = [
    ['刘宇宁','🎙️',238,'摩登兄弟的歌声，陪你走过每一段路。'],
    ['汪苏泷','🎹',265,'小汪的旋律，青春回忆的 BGM。'],
    ['薛之谦','🎤',412,'用一首歌，唱尽我们的故事。'],
  ];
  const addWall = db.prepare(`INSERT OR IGNORE INTO walls (name,emoji,fans,hype,owner_id,slogan,grad,created_at,custom) VALUES (?,?,?,0,NULL,?,?,?,0)`);
  for (const [n,e,f,s] of EXTRA_WALLS) addWall.run(n,e,f,s,JSON.stringify(pickGrad(n)),new Date().toISOString());
}
seed();

/* ================================================================
 * 工具函数
 * ================================================================ */
const nowStr = () => new Date().toISOString();
const isPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || ''));
const maskPhone = (p) => String(p).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
const clip = (s, n) => String(s || '').slice(0, n).trim();

function genNickname() {
  const words = ['麦浪', '信号', '回声', '夜航', '拾光', '白噪', '和弦', '走调', '安可', '节拍'];
  const w = words[Math.floor(Math.random() * words.length)];
  return `同学${w}${Math.floor(100 + Math.random() * 900)}`;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 512 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** 写一条消息中心通知 */
function notify(userId, type, title, body, wallId = null) {
  if (!userId) return;
  db.prepare(
    `INSERT INTO notifications (user_id,type,title,body,wall_id,read_flg,created_at) VALUES (?,?,?,?,?,0,?)`
  ).run(userId, type, title, body, wallId, nowStr());
}

/* ================================================================
 * 认证
 * ================================================================ */
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_GAP_MS = 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

async function handleSendCode(req, res) {
  const { phone } = await readBody(req);
  if (!isPhone(phone)) return json(res, 400, { ok: false, msg: '请输入正确的 11 位手机号' });

  const recent = db.prepare(
    `SELECT created_at FROM verify_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`).get(phone);
  if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_GAP_MS) {
    const wait = Math.ceil((RESEND_GAP_MS - (Date.now() - new Date(recent.created_at).getTime())) / 1000);
    return json(res, 429, { ok: false, msg: `发送太频繁，请 ${wait} 秒后再试` });
  }

  const code = String(crypto.randomInt(100000, 999999));
  db.prepare(
    `INSERT INTO verify_codes (phone, code, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(phone, code, Date.now() + CODE_TTL_MS, nowStr());

  /* ── 生产环境替换点 ─────────────────────────────────────────
   * 在此处接入短信服务商（阿里云 SMS / 腾讯云 SMS），把 code 发到用户手机。
   * 开发模式没有真实短信通道，直接把 code 返回给前端展示（devCode）。
   * ────────────────────────────────────────────────────────── */
  console.log(`[SMS] ${phone} 的验证码：${code}（5 分钟内有效）`);

  return json(res, 200, { ok: true, msg: '验证码已发送', devCode: code, ttl: 300 });
}

async function handleVerify(req, res) {
  const { phone, code } = await readBody(req);
  if (!isPhone(phone)) return json(res, 400, { ok: false, msg: '手机号格式不正确' });
  if (!/^\d{6}$/.test(String(code || ''))) return json(res, 400, { ok: false, msg: '请输入 6 位验证码' });

  const row = db.prepare(
    `SELECT * FROM verify_codes WHERE phone = ? AND used = 0 AND expires_at > ?
     ORDER BY id DESC LIMIT 1`).get(phone, Date.now());

  if (!row) return json(res, 400, { ok: false, msg: '验证码已过期或不存在，请重新获取' });
  if (row.code !== String(code)) return json(res, 400, { ok: false, msg: '验证码不正确' });

  db.prepare(`UPDATE verify_codes SET used = 1 WHERE id = ?`).run(row.id);

  let user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  const isNew = !user;
  if (isNew) {
    const info = db.prepare(
      `INSERT INTO users (phone, nickname, created_at, last_login_at) VALUES (?, ?, ?, ?)`
    ).run(phone, genNickname(), nowStr(), nowStr());
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
    notify(user.id, 'system', '欢迎加入乐遇同频 🎧', '先去看看附近的演出，或者发布一条搭子招募试试？');
  } else {
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowStr(), user.id);
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(token, user.id, Date.now() + SESSION_TTL_MS, nowStr());

  return json(res, 200, {
    ok: true,
    msg: isNew ? '注册成功，欢迎加入乐遇同频' : '欢迎回来',
    token,
    user: { id: user.id, phone: user.phone, nickname: user.nickname, created_at: user.created_at },
  });
}

function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return db.prepare(
    `SELECT s.token, s.expires_at, u.id, u.phone, u.nickname, u.created_at, u.avatar, u.signature, u.school, u.city
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`).get(m[1], Date.now()) || null;
}

/* ================================================================
 * 行转换
 * ================================================================ */
function postRow(id) {
  const p = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id);
  if (!p) return null;
  return { ...p, tags: JSON.parse(p.tags), open: !!p.open };
}
function wallRow(id) {
  const w = db.prepare(`SELECT * FROM walls WHERE id = ?`).get(id);
  if (!w) return null;
  return { ...w, hype: !!w.hype, custom: !!w.custom, grad: JSON.parse(w.grad) };
}

/* ================================================================
 * 业务接口
 * ================================================================ */
/** 主站启动数据 */
function handleBootstrap(req, res) {
  const auth = getAuth(req);
  const events = db.prepare(`SELECT * FROM events ORDER BY id DESC`).all()
    .map(e => ({ ...e, grad: JSON.parse(e.grad), wanted: false, mine: false }));
  const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all()
    .map(p => ({ ...p, tags: JSON.parse(p.tags), open: !!p.open, pawed: false, mine: false }));
  const walls = db.prepare(`SELECT * FROM walls ORDER BY custom DESC, id`).all()
    .map(w => ({ ...w, hype: !!w.hype, custom: !!w.custom, grad: JSON.parse(w.grad), joined: false, mine: false }));
  const unread = auth
    ? db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_flg=0`).get(auth.id).c
    : 0;

  if (auth) {
    for (const e of events) {
      e.wanted = !!db.prepare(`SELECT 1 FROM event_wants WHERE user_id=? AND event_id=?`).get(auth.id, e.id);
    }
    for (const p of posts) {
      p.pawed = !!db.prepare(`SELECT 1 FROM post_paws WHERE user_id=? AND post_id=?`).get(auth.id, p.id);
      p.mine = p.user_id === auth.id;
    }
    for (const w of walls) {
      w.joined = !!db.prepare(`SELECT 1 FROM wall_joins WHERE user_id=? AND wall_id=?`).get(auth.id, w.id);
      w.mine = w.owner_id === auth.id;
    }
  }
  return json(res, 200, {
    ok: true, events, posts, walls,
    stats: { users: db.prepare(`SELECT COUNT(*) c FROM users`).get().c },
    me: auth ? { id: auth.id, nickname: auth.nickname, avatar: auth.avatar } : null,
    unread,
  });
}

/* ---------------- 演出 ---------------- */
async function handleWant(req, res, eventId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const e = db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId);
  if (!e) return json(res, 404, { ok: false, msg: '演出不存在' });

  const has = db.prepare(`SELECT 1 FROM event_wants WHERE user_id=? AND event_id=?`).get(auth.id, eventId);
  let wanted;
  if (has) {
    db.prepare(`DELETE FROM event_wants WHERE user_id=? AND event_id=?`).run(auth.id, eventId);
    db.prepare(`UPDATE events SET want = MAX(want-1, 0) WHERE id=?`).run(eventId);
    wanted = false;
  } else {
    db.prepare(`INSERT INTO event_wants (user_id, event_id) VALUES (?,?)`).run(auth.id, eventId);
    db.prepare(`UPDATE events SET want = want+1 WHERE id=?`).run(eventId);
    wanted = true;
  }
  const cur = db.prepare(`SELECT want FROM events WHERE id=?`).get(eventId);
  return json(res, 200, { ok: true, wanted, want: cur.want });
}

/** 发布演出 */
async function handleCreateEvent(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const b = await readBody(req);

  const title = clip(b.title, 60);
  const venue = clip(b.venue, 80);
  let date = clip(b.date, 2).replace(/\D/g, '');
  const month = clip(b.month, 8).toUpperCase();
  const genre = clip(b.genre, 20) || '其他';
  const ticket = clip(b.ticket, 40) || '待公布';
  const emoji = clip(b.emoji, 4) || '🎫';

  if (!title) return json(res, 400, { ok: false, msg: '请填写演出名称' });
  if (!venue) return json(res, 400, { ok: false, msg: '请填写演出场馆' });
  if (!date) return json(res, 400, { ok: false, msg: '请填写演出日期（几号）' });
  if (date.length === 1) date = '0' + date;
  if (!/^[A-Z]{3}$/.test(month)) return json(res, 400, { ok: false, msg: '月份格式应为 3 个字母，如 OCT' });

  const grad = pickGrad(title + venue);
  const info = db.prepare(
    `INSERT INTO events (title,date,month,genre,venue,ticket,want,groups,grad,emoji)
     VALUES (?,?,?,?,?,?,0,0,?,?)`
  ).run(title, date, month, genre, venue, ticket, JSON.stringify(grad), emoji);

  const row = db.prepare(`SELECT * FROM events WHERE id=?`).get(info.lastInsertRowid);
  return json(res, 200, { ok: true, event: { ...row, grad, wanted: false, mine: true } });
}

/* ---------------- 搭子 ---------------- */
async function handleCreatePost(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });

  const b = await readBody(req);
  const ev = clip(b.ev, 80);
  const note = clip(b.note, 400);
  const name = clip(b.name, 20) || auth.nickname;
  const school = clip(b.school, 20) || auth.school || '原力大学';
  const count = clip(b.count, 12) || '1 位';
  let tags = Array.isArray(b.tags) ? b.tags.map(String).slice(0, 8) : [];

  if (!ev) return json(res, 400, { ok: false, msg: '请选择要去的演出' });
  if (!note) return json(res, 400, { ok: false, msg: '请填写需求说明' });
  if (!db.prepare(`SELECT 1 FROM events WHERE title = ?`).get(ev))
    return json(res, 400, { ok: false, msg: '演出不存在' });
  if (!tags.length) tags = ['同校优先'];

  const emoji = ['🦊', '🐻', '🐱', '🐰', '🐨', '🦉', '🐧', '🦁'][Math.floor(Math.random() * 8)];
  const info = db.prepare(
    `INSERT INTO posts (user_id,name,emoji,school,ev,count,note,tags,paw,open,created_at)
     VALUES (?,?,?,?,?,?,?,?,0,1,?)`
  ).run(auth.id, name, emoji, school, ev, count, note, JSON.stringify(tags), nowStr());

  return json(res, 200, { ok: true, post: { ...postRow(info.lastInsertRowid), pawed: false, mine: true } });
}

async function handlePaw(req, res, postId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const p = postRow(postId);
  if (!p) return json(res, 404, { ok: false, msg: '招募帖不存在' });
  if (p.user_id === auth.id) return json(res, 400, { ok: false, msg: '这是你自己发的招募哦' });

  const has = db.prepare(`SELECT 1 FROM post_paws WHERE user_id=? AND post_id=?`).get(auth.id, postId);
  if (has) return json(res, 200, { ok: true, already: true, paw: p.paw });

  db.prepare(`INSERT INTO post_paws (user_id, post_id) VALUES (?,?)`).run(auth.id, postId);
  db.prepare(`UPDATE posts SET paw = paw+1 WHERE id=?`).run(postId);
  notify(p.user_id, 'paw', '有人举爪了你的招募 🐾', `${auth.nickname} 想加入你「${p.ev}」的搭子；联系方式请通过站内消息交换。`);
  return json(res, 200, { ok: true, already: false, paw: p.paw + 1 });
}

async function handleClosePost(req, res, postId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const p = postRow(postId);
  if (!p) return json(res, 404, { ok: false, msg: '招募帖不存在' });
  if (p.user_id !== auth.id) return json(res, 403, { ok: false, msg: '只能关闭自己发布的招募' });
  db.prepare(`UPDATE posts SET open = 0 WHERE id=?`).run(postId);
  return json(res, 200, { ok: true, open: false });
}

/* ---------------- 应援墙 ---------------- */
/** 创建自己的 idol 应援墙 */
async function handleCreateWall(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const b = await readBody(req);

  const name = clip(b.name, 24);
  const emoji = clip(b.emoji, 4) || '🎤';
  const slogan = clip(b.slogan, 80) || '应援口号待补充';

  if (!name) return json(res, 400, { ok: false, msg: '请填写 idol / 歌手名称' });
  if (db.prepare(`SELECT 1 FROM walls WHERE name = ?`).get(name))
    return json(res, 400, { ok: false, msg: '这面墙已经有同学建过了，去加入它吧' });

  const grad = pickGrad(name);
  const info = db.prepare(
    `INSERT INTO walls (name,emoji,fans,hype,owner_id,slogan,grad,created_at,custom)
     VALUES (?,?,0,0,?,?,?,?,1)`
  ).run(name, emoji, auth.id, slogan, JSON.stringify(grad), nowStr());

  // 建墙的人自动算作第一位墙友
  db.prepare(`INSERT OR IGNORE INTO wall_joins (user_id, wall_id) VALUES (?,?)`).run(auth.id, info.lastInsertRowid);
  db.prepare(`UPDATE walls SET fans = 1 WHERE id=?`).run(info.lastInsertRowid);
  // 第一条墙内动态：建墙宣言
  db.prepare(
    `INSERT INTO wall_posts (wall_id,user_id,name,emoji,content,likes,created_at) VALUES (?,?,?,?,?,0,?)`
  ).run(info.lastInsertRowid, auth.id, auth.nickname, auth.avatar || '🎧',
    `这面墙由我建立 ✊ ${slogan}`, nowStr());

  return json(res, 200, { ok: true, wall: { ...wallRow(info.lastInsertRowid), joined: true, mine: true } });
}

/** 墙详情（第二个跳转界面） */
function handleWallDetail(req, res, wallId) {
  const w = wallRow(wallId);
  if (!w) return json(res, 404, { ok: false, msg: '这面墙不存在' });
  const auth = getAuth(req);

  const joined = auth
    ? !!db.prepare(`SELECT 1 FROM wall_joins WHERE user_id=? AND wall_id=?`).get(auth.id, wallId) : false;
  const mine = auth ? w.owner_id === auth.id : false;

  const posts = db.prepare(`SELECT * FROM wall_posts WHERE wall_id=? ORDER BY id DESC`).all(wallId)
    .map(p => ({ ...p, liked: auth ? !!db.prepare(`SELECT 1 FROM wall_post_likes WHERE user_id=? AND post_id=?`).get(auth.id, p.id) : false }));

  // 墙友（取最新加入的 12 位）
  const members = db.prepare(
    `SELECT u.id, u.nickname, u.avatar FROM wall_joins j JOIN users u ON u.id = j.user_id
     WHERE j.wall_id = ? ORDER BY j.rowid DESC LIMIT 12`).all(wallId);

  return json(res, 200, {
    ok: true,
    wall: { ...w, joined, mine },
    posts,
    members,
    stats: { posts: posts.length, members: w.fans },
  });
}

async function handleWallJoin(req, res, wallId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const w = db.prepare(`SELECT * FROM walls WHERE id = ?`).get(wallId);
  if (!w) return json(res, 404, { ok: false, msg: '后援墙不存在' });

  const has = db.prepare(`SELECT 1 FROM wall_joins WHERE user_id=? AND wall_id=?`).get(auth.id, wallId);
  if (has) return json(res, 200, { ok: true, already: true, fans: w.fans });

  db.prepare(`INSERT INTO wall_joins (user_id, wall_id) VALUES (?,?)`).run(auth.id, wallId);
  db.prepare(`UPDATE walls SET fans = fans+1 WHERE id=?`).run(wallId);
  if (w.owner_id) notify(w.owner_id, 'wall', '有人加入了你的应援墙 🧱', `${auth.nickname} 加入了「${w.name}」，快去墙里打个招呼吧。`, wallId);
  return json(res, 200, { ok: true, already: false, fans: w.fans + 1 });
}

/** 墙内发应援动态 */
async function handleWallPost(req, res, wallId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const w = db.prepare(`SELECT * FROM walls WHERE id = ?`).get(wallId);
  if (!w) return json(res, 404, { ok: false, msg: '后援墙不存在' });
  const joined = db.prepare(`SELECT 1 FROM wall_joins WHERE user_id=? AND wall_id=?`).get(auth.id, wallId);
  if (!joined) return json(res, 403, { ok: false, msg: '先加入这面墙才能发言哦' });

  const b = await readBody(req);
  const content = clip(b.content, 500);
  if (!content) return json(res, 400, { ok: false, msg: '说点什么再发吧' });

  const info = db.prepare(
    `INSERT INTO wall_posts (wall_id,user_id,name,emoji,content,likes,created_at) VALUES (?,?,?,?,?,0,?)`
  ).run(wallId, auth.id, auth.nickname, auth.avatar || '🎧', content, nowStr());
  const p = db.prepare(`SELECT * FROM wall_posts WHERE id=?`).get(info.lastInsertRowid);
  return json(res, 200, { ok: true, post: { ...p, liked: false } });
}

async function handleWallPostLike(req, res, postId) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const p = db.prepare(`SELECT * FROM wall_posts WHERE id=?`).get(postId);
  if (!p) return json(res, 404, { ok: false, msg: '动态不存在' });

  db.prepare(`INSERT OR IGNORE INTO wall_post_likes (user_id, post_id) VALUES (?,?)`).run(auth.id, postId);
  db.prepare(`UPDATE wall_posts SET likes = (SELECT COUNT(*) FROM wall_post_likes WHERE post_id=?) WHERE id=?`).run(postId, postId);
  const cur = db.prepare(`SELECT likes FROM wall_posts WHERE id=?`).get(postId);
  return json(res, 200, { ok: true, likes: cur.likes, liked: true });
}

/* ---------------- 我的 ---------------- */
function handleProfile(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });

  // 统计
  const likes = db.prepare(
    `SELECT COALESCE(SUM(paw),0) c FROM posts WHERE user_id=?`).get(auth.id).c
    + db.prepare(`SELECT COALESCE(SUM(likes),0) c FROM wall_posts WHERE user_id=?`).get(auth.id).c;
  const buddies = db.prepare(`SELECT COUNT(*) c FROM posts WHERE user_id=?`).get(auth.id).c;
  const follows = db.prepare(`SELECT COUNT(*) c FROM wall_joins WHERE user_id=?`).get(auth.id).c;
  const fans = db.prepare(
    `SELECT COUNT(*) c FROM wall_joins j JOIN walls w ON w.id=j.wall_id WHERE w.owner_id=?`).get(auth.id).c
    + db.prepare(
      `SELECT COUNT(*) c FROM post_paws pa JOIN posts po ON po.id=pa.post_id WHERE po.user_id=?`).get(auth.id).c;

  // 作品流：我发布的招募 + 我建的墙 + 我想去的演出
  const works = [];
  db.prepare(`SELECT * FROM posts WHERE user_id=? ORDER BY id DESC`).all(auth.id).forEach(p => works.push({
    id: 'p' + p.id, type: 'post', title: p.ev, sub: p.note,
    emoji: p.emoji, grad: pickGrad(p.ev), meta: `${p.paw} 人举爪`, postId: p.id,
  }));
  db.prepare(`SELECT * FROM walls WHERE owner_id=? ORDER BY id DESC`).all(auth.id).forEach(w => works.push({
    id: 'w' + w.id, type: 'wall', title: w.name + ' 应援墙', sub: w.slogan,
    emoji: w.emoji, grad: JSON.parse(w.grad), meta: `${w.fans} 位墙友`, wallId: w.id,
  }));
  db.prepare(
    `SELECT e.* FROM event_wants w JOIN events e ON e.id=w.event_id WHERE w.user_id=? ORDER BY w.rowid DESC`
  ).all(auth.id).forEach(e => works.push({
    id: 'e' + e.id, type: 'event', title: e.title, sub: e.venue,
    emoji: e.emoji, grad: JSON.parse(e.grad), meta: '已加入我的行程', eventId: e.id,
  }));

  return json(res, 200, {
    ok: true,
    user: {
      id: auth.id, nickname: auth.nickname, avatar: auth.avatar, signature: auth.signature,
      school: auth.school, city: auth.city,
      phone_masked: maskPhone(auth.phone), created_at: auth.created_at,
      uid: 'TP' + String(auth.id).padStart(8, '0'),
    },
    stats: { likes, buddies, follows, fans },
    works,
  });
}

async function handleUpdateProfile(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const b = await readBody(req);

  const fields = [];
  const vals = [];
  const put = (col, v, max) => { if (v !== undefined) { fields.push(`${col}=?`); vals.push(clip(v, max)); } };

  if (b.nickname !== undefined) {
    const n = clip(b.nickname, 16);
    if (!n) return json(res, 400, { ok: false, msg: '昵称不能为空' });
    if (n.length < 2) return json(res, 400, { ok: false, msg: '昵称至少 2 个字' });
    put('nickname', n, 16);
  }
  put('signature', b.signature, 60);
  put('school', b.school, 20);
  put('city', b.city, 20);
  if (b.avatar !== undefined) {
    const avatar = b.avatar;
    const photo = typeof avatar === 'string' && avatar.length <= 400000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar);
    const emoji = typeof avatar === 'string' && ['🎧','🎤','🎸','🎹','🥁','🎷','🎺','🕺','💃','🎼','✨','🔥','🌙','🐱','🦊','🐻'].includes(avatar);
    if (!photo && !emoji) return json(res, 400, { ok: false, msg: '请选择有效头像，或重新裁剪照片' });
    fields.push('avatar=?'); vals.push(avatar);
  }

  if (!fields.length) return json(res, 400, { ok: false, msg: '没有要修改的内容' });
  vals.push(auth.id);
  db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals);

  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(auth.id);
  return json(res, 200, {
    ok: true, msg: '资料已更新',
    user: {
      id: u.id, nickname: u.nickname, avatar: u.avatar, signature: u.signature,
      school: u.school, city: u.city, phone_masked: maskPhone(u.phone),
      created_at: u.created_at, uid: 'TP' + String(u.id).padStart(8, '0'),
    },
  });
}

/* ---------------- 消息中心 ---------------- */
function handleMessages(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  const list = db.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60`).all(auth.id)
    .map(n => ({ ...n, read: !!n.read_flg }));
  return json(res, 200, {
    ok: true, list,
    unread: list.filter(n => !n.read).length,
  });
}

function handleMessagesRead(req, res) {
  const auth = getAuth(req);
  if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
  db.prepare(`UPDATE notifications SET read_flg=1 WHERE user_id=?`).run(auth.id);
  return json(res, 200, { ok: true, unread: 0 });
}

/* ================================================================
 * HTTP 服务
 * ================================================================ */
db.exec(`CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
  read_flg INTEGER NOT NULL DEFAULT 0
); CREATE INDEX IF NOT EXISTS dm_pair ON direct_messages(sender_id,recipient_id,id);`);
async function handleChat(req, res, pathname) {
  const user = getAuth(req);
  if (!user) return json(res,401,{ok:false,msg:'请先登录'});
  if(pathname === '/api/chats' && req.method === 'GET') {
    const contacts=db.prepare('SELECT id,nickname,avatar,school FROM users WHERE id<>? ORDER BY id DESC LIMIT 100').all(user.id);
    const list=contacts.map(c=>({...c,
      last:db.prepare('SELECT content,created_at FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 1').get(user.id,c.id,c.id,user.id)||null,
      unread:db.prepare('SELECT COUNT(*) n FROM direct_messages WHERE sender_id=? AND recipient_id=? AND read_flg=0').get(c.id,user.id).n
    })).sort((a,b)=>(b.last?.created_at||'').localeCompare(a.last?.created_at||''));
    return json(res,200,{ok:true,list});
  }
  const match=pathname.match(/^\/api\/chats\/(\d+)$/);
  if (!match) return json(res,404,{ok:false,msg:'对话不存在'});
  const peer=db.prepare('SELECT id,nickname,avatar FROM users WHERE id=?').get(+match[1]);
  if(!peer || peer.id===user.id) return json(res,400,{ok:false,msg:'请选择其他用户'});
  if(req.method==='POST') {
    const body=await readBody(req);
    if(typeof body.content!=='string' || !body.content.trim() || body.content.trim().length>1000) return json(res,400,{ok:false,msg:'请输入1至1000字的消息'});
    const result=db.prepare('INSERT INTO direct_messages(sender_id,recipient_id,content,created_at) VALUES(?,?,?,?)').run(user.id,peer.id,body.content.trim(),nowStr());
    return json(res,200,{ok:true,message:db.prepare('SELECT * FROM direct_messages WHERE id=?').get(result.lastInsertRowid)});
  }
  if(req.method==='GET') {
    const list=db.prepare('SELECT * FROM (SELECT id,sender_id,recipient_id,content,created_at FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 200) ORDER BY id').all(user.id,peer.id,peer.id,user.id);
    if(list.length) db.prepare('UPDATE direct_messages SET read_flg=1 WHERE sender_id=? AND recipient_id=? AND id<=?').run(peer.id,user.id,list[list.length-1].id);
    return json(res,200,{ok:true,peer,list});
  }
  return json(res,405,{ok:false,msg:'不支持的操作'});
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  try {
    if(p === '/api/chats' || p.startsWith('/api/chats/')) return await handleChat(req,res,p);
    /* ---------- 页面 ---------- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    if (req.method === 'GET' && p === '/login.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'login.html')));
    }

    /* ---------- 认证 ---------- */
    if (p === '/api/auth/send-code' && req.method === 'POST') return await handleSendCode(req, res);
    if (p === '/api/auth/verify' && req.method === 'POST') return await handleVerify(req, res);
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const auth = getAuth(req);
      if (auth) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(auth.token);
      return json(res, 200, { ok: true, msg: '已退出登录' });
    }
    if (p === '/api/me' && req.method === 'GET') {
      const auth = getAuth(req);
      if (!auth) return json(res, 401, { ok: false, msg: '登录已失效，请重新登录' });
      return json(res, 200, {
        ok: true,
        user: { id: auth.id, phone: auth.phone, nickname: auth.nickname,
                phone_masked: maskPhone(auth.phone), created_at: auth.created_at },
      });
    }

    /* ---------- 主站数据 ---------- */
    if (p === '/api/bootstrap' && req.method === 'GET') return handleBootstrap(req, res);

    /* ---------- 演出 ---------- */
    if (p === '/api/events' && req.method === 'POST') return await handleCreateEvent(req, res);

    /* ---------- 搭子 ---------- */
    if (p === '/api/posts' && req.method === 'POST') return await handleCreatePost(req, res);

    /* ---------- 应援墙 ---------- */
    if (p === '/api/walls' && req.method === 'POST') return await handleCreateWall(req, res);

    /* ---------- 我的 ---------- */
    // 尚未接入身份核验机构，不接收证件资料或客户端自报认证结果。
    if (p === '/api/me/identity') {
      const auth = getAuth(req);
      if (!auth) return json(res, 401, { ok: false, msg: '请先登录' });
      if (req.method !== 'GET') return json(res, 503, { ok: false, msg: '实名认证服务尚未开通' });
      return json(res, 200, { ok: true, status: 'unverified', available: false });
    }
    if (p === '/api/me/profile' && req.method === 'GET') return handleProfile(req, res);
    if (p === '/api/me/profile' && req.method === 'POST') return await handleUpdateProfile(req, res);
    if (p === '/api/messages' && req.method === 'GET') return handleMessages(req, res);
    if (p === '/api/messages/read' && req.method === 'POST') return handleMessagesRead(req, res);

    /* ---------- 带参数 ---------- */
    let m;
    if ((m = p.match(/^\/api\/events\/(\d+)\/want$/)) && req.method === 'POST') return await handleWant(req, res, +m[1]);
    if ((m = p.match(/^\/api\/posts\/(\d+)\/paw$/)) && req.method === 'POST') return await handlePaw(req, res, +m[1]);
    if ((m = p.match(/^\/api\/posts\/(\d+)\/close$/)) && req.method === 'POST') return await handleClosePost(req, res, +m[1]);
    if ((m = p.match(/^\/api\/walls\/(\d+)$/)) && req.method === 'GET') return handleWallDetail(req, res, +m[1]);
    if ((m = p.match(/^\/api\/walls\/(\d+)\/join$/)) && req.method === 'POST') return await handleWallJoin(req, res, +m[1]);
    if ((m = p.match(/^\/api\/walls\/(\d+)\/posts$/)) && req.method === 'POST') return await handleWallPost(req, res, +m[1]);
    if ((m = p.match(/^\/api\/wall-posts\/(\d+)\/like$/)) && req.method === 'POST') return await handleWallPostLike(req, res, +m[1]);

    return json(res, 404, { ok: false, msg: '接口不存在' });
  } catch (err) {
    console.error('[ERR]', err.message);
    return json(res, 500, { ok: false, msg: '服务器开小差了，请稍后再试' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  乐遇同频 完整服务已启动`);
  console.log(`  ➜ 主站       http://localhost:${PORT}`);
  console.log(`  ➜ 登录页     http://localhost:${PORT}/login.html`);
  console.log(`  ➜ 数据库     ${DB_PATH}`);
  console.log(`  ➜ 开发模式：验证码直接返回在响应里（devCode），并打印在此日志\n`);
});
