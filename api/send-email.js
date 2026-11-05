const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'to, subject, html 필드가 필요합니다.' });
  }

  const smtpHost = process.env.SMTP_HOST || 'gw.ssautotech.co.kr';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpUser = process.env.SMTP_USER || 'ass';
  const smtpPass = process.env.SMTP_PASS || 'whflq123!';
  const smtpFrom = process.env.SMTP_FROM || `"4M 변동점 관리 대시보드" <${smtpUser}@ssautotech.co.kr>`;

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
    tls: { rejectUnauthorized: false }
  });

  try {
    const toList = Array.isArray(to) ? to.join(', ') : to;
    await transporter.sendMail({
      from: smtpFrom,
      to: toList,
      subject,
      html
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[send-email] SMTP 오류:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
