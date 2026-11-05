const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const { URLSearchParams } = require('url');

// ── AES-128-CBC-PKCS7 암호화 (그룹웨어 로그인용) ──────────────────────
function aesEncrypt(keyHex, ivHex, plaintext) {
  const key    = Buffer.from(keyHex, 'hex');
  const iv     = Buffer.from(ivHex,  'hex');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return encodeURIComponent(enc.toString('base64'));
}

// ── 간단한 HTTP/HTTPS 요청 (쿠키 직접 관리) ─────────────────────────
function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http;
    const reqOpts  = {
      hostname : parsed.hostname,
      port     : parsed.port || (isHttps ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : opts.method || 'GET',
      headers  : {
        'User-Agent'  : 'Mozilla/5.0',
        'Accept'      : 'text/html,application/json,*/*',
        ...(opts.headers || {}),
      },
    };
    if (opts.body) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
    }

    const r = lib.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ── 그룹웨어 로그인 → 웹메일 세션 획득 ─────────────────────────────
async function getWebmailSession() {
  const GW   = 'http://gw.ssautotech.co.kr/groupware';
  const WM   = 'http://webmail.ssautotech.co.kr';
  const USER = process.env.GW_USER || 'ass';
  const PASS = process.env.GW_PASS || 'whflq123!';

  // 0. 로그인 페이지 먼저 로드 → 세션 쿠키 확보
  const loginPageRes = await req(`${GW}/login.php`);
  const initCookies  = (loginPageRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // 1. 암호화 키 발급 (세션 쿠키 포함)
  const kRes  = await req(`${GW}/login.php?mode=get_encrypt_key`, { headers: { 'Cookie': initCookies } });
  const kData = JSON.parse(kRes.body);
  const keyCookies = [...(loginPageRes.headers['set-cookie'] || []), ...(kRes.headers['set-cookie'] || [])]
    .map(c => c.split(';')[0]).join('; ');
  const encId = aesEncrypt(kData.key, kData.iv, USER);
  const encPw = aesEncrypt(kData.key, kData.iv, PASS);

  // 2. cafe24ssl 경유로 login_key 취득
  const authObj    = JSON.stringify({ gw_user_id: encId, gw_user_pw: encPw });
  const authString = encodeURIComponent(authObj);
  const params     = `auth_mode=encrypt&auth_callbackName=encryptSubmit_Complete&auth_string=${authString}`;
  const b64Token   = Buffer.from(encodeURIComponent(params)).toString('base64').replace(/\+/g, '%2b');
  const sslUrl     = `https://login2.cafe24ssl.com/crypt/AuthSSLManager.php?token=${b64Token}&com=1&id=cNJS&dummy=${Date.now()}`;
  const sslRes     = await req(sslUrl);
  const lkMatch    = sslRes.body.match(/encryptSubmit_Complete\(['"](.+?)['"]\)/);
  if (!lkMatch) throw new Error('login_key 취득 실패');
  const loginKey   = lkMatch[1];

  // 3. 그룹웨어 로그인 POST
  const loginBody = new URLSearchParams({ login_key: loginKey }).toString();
  const loginRes  = await req(
    `${GW}/login.php?mode=loginAct`,
    {
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${GW}/login.php`, 'Cookie': keyCookies },
      body    : loginBody,
    }
  );
  const allCookies = [...(loginPageRes.headers['set-cookie'] || []), ...(loginRes.headers['set-cookie'] || [])];
  const gwCookie   = allCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  if (!gwCookie) throw new Error('그룹웨어 로그인 실패 — 세션 없음');

  // 4. 그룹웨어 AutoLogin → SSO URL 취득
  const ssoUri  = encodeURIComponent(`${WM}/user/mail/main.php?is_gw=true`);
  const ssoPage = await req(
    `${GW}/AutoLogin/request_front.php?uri=${ssoUri}&type=front`,
    { headers: { 'Cookie': gwCookie, 'Referer': `${GW}/index.php` } }
  );
  const ssoMatch = ssoPage.body.match(/location\.replace\("([^"]+)"\)/);
  if (!ssoMatch) throw new Error('SSO URL 취득 실패');
  const ssoUrl = ssoMatch[1];

  // 5. 웹메일 SSO 로그인 → WMSESSION 획득
  const wmRes   = await req(ssoUrl, { headers: { 'Referer': `${GW}/index.php` } });
  const wmCookie = (wmRes.headers['set-cookie'] || [])
    .map(c => c.split(';')[0]).join('; ');
  if (!wmCookie) throw new Error('웹메일 세션 획득 실패');

  return wmCookie;
}

// ── 웹메일 API로 메일 발송 ────────────────────────────────────────────
async function sendViaWebmail(wmCookie, to, subject, htmlBody) {
  const WM   = 'http://webmail.ssautotech.co.kr';
  const tid  = Date.now();
  const apiUrl = `${WM}/api/webmail/0.2/FrontSendMails.php?reqAdmin=ssautotech&reqUser=${process.env.GW_USER || 'ass'}&tId=${tid}`;

  const toList = Array.isArray(to) ? to.join(',') : to;

  const postBody = new URLSearchParams({
    to               : toList,
    cc               : '',
    bcc              : '',
    subject          : subject,
    body             : htmlBody,
    html_flag        : 'Y',
    receive_flag     : 'Y',
    bodyIncoding     : 'html',
    sent_save        : 'Y',
    each_flag        : '',
    reserve_flag     : 'N',
    bigfileQId       : '',
    attachedFilesName: '',
    attachedFilesPath: '',
    attachedFilesType: '',
    activeXFileInfo  : '',
  }).toString();

  const result = await req(apiUrl, {
    method  : 'POST',
    headers : {
      'Content-Type'     : 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie'           : wmCookie,
      'Referer'          : `${WM}/user/mail/main.php?page=write`,
      'X-Requested-With' : 'XMLHttpRequest',
      'Accept'           : 'application/json, */*',
    },
    body: postBody,
  });

  const json = JSON.parse(result.body);
  if (json.code !== '0000') throw new Error(`발송 실패 code=${json.code}`);
  return json.data;
}

// ── Vercel 핸들러 ──────────────────────────────────────────────────────
module.exports = async function handler(req2, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req2.method === 'OPTIONS') return res.status(200).end();
  if (req2.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html } = req2.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'to, subject, html 필드가 필요합니다.' });
  }

  try {
    const wmCookie = await getWebmailSession();
    const data     = await sendViaWebmail(wmCookie, to, subject, html);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[send-email]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
