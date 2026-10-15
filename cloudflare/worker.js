/**
 * Cloudflare Email Worker
 * 
 * This script runs on Cloudflare's edge network when an email is received for your domain.
 * It parses the incoming email and forwards it to your local backend server via Cloudflare Tunnel.
 */

export default {
  async email(message, env, ctx) {
    // メールの生データをテキストとして取得
    const rawEmail = await new Response(message.raw).text();

    // 自宅サーバーのトンネルURLへPOST送信
    // ※ production環境に合わせてドメインやポートを適宜変更してください
    const webhookUrl = env.WEBHOOK_URL || 'https://api.yourdomain.com/webhook/email';

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Optional: Add a shared secret header for security if needed
          // 'X-Webhook-Secret': env.WEBHOOK_SECRET
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.headers.get('subject') || '(件名なし)',
          text: rawEmail,
        }),
      });

      if (!response.ok) {
        console.error(`Webhook returned status ${response.status}`);
        message.setReject('Failed to forward email to local server.');
      }
    } catch (e) {
      console.error('Webhook転送失敗:', e);
      message.setReject('Internal server error forwarding email.');
    }
  }
};
