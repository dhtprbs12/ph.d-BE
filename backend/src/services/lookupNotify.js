const { query } = require('../database/connection');

async function sendExpoPush(token, body, data) {
  if (!token) return;
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      title: 'PHD',
      body,
      data,
      sound: 'default',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn('[Lookup] push failed:', res.status, text.slice(0, 200));
  }
}

async function sendEmail(to, body) {
  const key = process.env.RESEND_API_KEY;
  if (!to) return;
  if (!key) {
    console.log(`[Lookup] email skipped (no RESEND_API_KEY) to=${to} body="${body}"`);
    return;
  }
  const from = process.env.LOOKUP_EMAIL_FROM || 'PHD <reports@phd.app>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: body,
      text: `${body}\n\nOpen PHD and go to History → Analysis requests.`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn('[Lookup] email failed:', res.status, text.slice(0, 200));
  }
}

async function notifyLookup(row, message, data) {
  console.log(`[Notify] lookup=${row.id} starting notification check`);
  const [fresh] = await query('SELECT client_acked_at, notify_push, email_to, user_id FROM lookup_requests WHERE id = ?', [row.id]);
  if (!fresh) { console.log(`[Notify] lookup=${row.id} not found`); return; }
  if (fresh.client_acked_at) { console.log(`[Notify] lookup=${row.id} already acked`); return; }
  console.log(`[Notify] lookup=${row.id} notify_push=${fresh.notify_push} email_to=${fresh.email_to || '(none)'} user_id=${fresh.user_id}`);
  if (fresh.notify_push) {
    const [user] = await query('SELECT expo_push_token FROM users WHERE id = ?', [fresh.user_id]);
    if (user?.expo_push_token) {
      console.log(`[Notify] lookup=${row.id} sending push to ${user.expo_push_token.slice(0, 30)}...`);
      await sendExpoPush(user.expo_push_token, message, data);
    } else {
      console.log(`[Notify] lookup=${row.id} NO expo_push_token for user=${fresh.user_id}`);
    }
  }
  if (fresh.email_to) {
    await sendEmail(fresh.email_to, message);
  }
}

module.exports = { notifyLookup };
