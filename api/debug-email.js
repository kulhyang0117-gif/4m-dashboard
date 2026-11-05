const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const { URLSearchParams } = require('url');

function aesEncrypt(keyHex, ivHex, plaintext) {
  const key    = Buffer.from(keyHex, 'hex');
  const iv     = Buffer.from(ivHex,  'hex');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return encodeURIComponent(enc.toString('base64'));
}

function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const reqOpts = {
      hostname : parsed.hostname,
      port     : parsed.port || (isHttps ? 443 : 80),
      path     : parsed.pathname + parsed.search,
      method   : opts.method || 'GET',
      headers  : { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) },
    };
    if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
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

module.exports = async function handler(req2, res) {
  const log = [];
  try {
    const GW = 'http://gw.ssautotech.co.kr/groupware';

    // Step 1: 암호화 키
    const kRes  = await req(`${GW}/login.php?mode=get_encrypt_key`);
    const kData = JSON.parse(kRes.body);
    log.push({ step: '1_key', ok: !!(kData.key && kData.iv) });

    const encId = aesEncrypt(kData.key, kData.iv, 'ass');
    const encPw = aesEncrypt(kData.key, kData.iv, 'whflq123!');
    const authObj    = JSON.stringify({ gw_user_id: encId, gw_user_pw: encPw });
    const params     = `auth_mode=encrypt&auth_callbackName=encryptSubmit_Complete&auth_string=${encodeURIComponent(authObj)}`;
    const b64Token   = Buffer.from(encodeURIComponent(params)).toString('base64').replace(/\+/g, '%2b');
    const sslUrl     = `https://login2.cafe24ssl.com/crypt/AuthSSLManager.php?token=${b64Token}&com=1&id=cNJS&dummy=${Date.now()}`;

    // Step 2: cafe24ssl
    const sslRes  = await req(sslUrl);
    const lkMatch = sslRes.body.match(/encryptSubmit_Complete\(['"](.+?)['"]\)/);
    log.push({ step: '2_cafe24ssl', ok: !!lkMatch, bodySnippet: sslRes.body.substring(0, 100) });
    if (!lkMatch) throw new Error('login_key 취득 실패');

    // Step 3: 로그인
    const loginRes = await req(`${GW}/login.php?mode=loginAct`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${GW}/login.php` },
      body    : new URLSearchParams({ login_key: lkMatch[1] }).toString(),
    });
    const setCookies = loginRes.headers['set-cookie'] || [];
    const gwCookie   = setCookies.map(c => c.split(';')[0]).join('; ');
    log.push({ step: '3_login', status: loginRes.status, cookies: setCookies, bodySnippet: loginRes.body.substring(0, 150) });

    // Step 4: AutoLogin
    const ssoUri  = encodeURIComponent('http://webmail.ssautotech.co.kr/user/mail/main.php?is_gw=true');
    const ssoPage = await req(`${GW}/AutoLogin/request_front.php?uri=${ssoUri}&type=front`, {
      headers: { 'Cookie': gwCookie, 'Referer': `${GW}/index.php` },
    });
    const ssoMatch = ssoPage.body.match(/location\.replace\("([^"]+)"\)/);
    log.push({ step: '4_autologin', ok: !!ssoMatch, bodySnippet: ssoPage.body.substring(0, 300) });

    return res.status(200).json({ log });
  } catch (err) {
    return res.status(500).json({ error: err.message, log });
  }
};
