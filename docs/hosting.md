# Hosting & Setup Guide

This guide covers setting up your domain, configuring Cloudflare Email Routing and Workers, running `cloudflared`, and launching the local Hono backend server.

---

## Prerequisites

1. **A Custom Domain** managed via [Cloudflare](https://www.cloudflare.com/).
2. **Node.js** (v18 or higher) installed on your local server or PC.
3. **Cloudflared** CLI tool installed on your local server or PC.

---

## Step 1: Install & Configure Cloudflare Tunnel (`cloudflared`)

1. **Install cloudflared** (Linux / Ubuntu example):
   ```bash
   curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   chmod +x cloudflared
   sudo mv cloudflared /usr/local/bin/
   ```

2. **Authenticate with Cloudflare**:
   ```bash
   cloudflared tunnel login
   ```
   *(A browser window will open. Log in to your Cloudflare account and authorize the domain.)*

3. **Create the Tunnel**:
   ```bash
   cloudflared tunnel create temp-mail-tunnel
   ```

4. **Route DNS to the Tunnel**:
   Replace `api.yourdomain.com` with your desired subdomain:
   ```bash
   cloudflared tunnel route dns temp-mail-tunnel api.yourdomain.com
   ```

5. **Run the Tunnel**:
   ```bash
   cloudflared tunnel run --url http://localhost:1035 temp-mail-tunnel
   ```

---

## Step 2: Configure Cloudflare Email Routing & Email Worker

1. **Cloudflareダッシュボードでの設定**:
   - ダッシュボードを開き、該当のドメインを選択します。
   - 左メニューの **[Email] > [Email Routing]** を開き、有効化（MXレコード等の自動設定）を完了させます。

2. **Email Worker の作成**:
   - 左メニューの **[Workers & Pages]** から **[Create application]** ＞ **[Create Worker]** を選択します。
   - ワーカー名（例: `temp-mail-worker`）をつけて作成します。
   - 「Edit code」を開き、リポジトリ内の **`cloudflare/worker.js`** にある以下のコードを貼り付けてデプロイ（Save and deploy）します。

   ```javascript
   export default {
     async email(message, env, ctx) {
       // メールの生データをテキストとして取得
       const rawEmail = await new Response(message.raw).text();

       // 自宅サーバーのトンネルURLへPOST送信
       try {
         await fetch('https://api.yourdomain.com/webhook/email', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             from: message.from,
             to: message.to,
             subject: message.headers.get('subject') || '(件名なし)',
             text: rawEmail,
           }),
         });
       } catch (e) {
         console.error('Webhook転送失敗:', e);
         message.setReject('Internal server error forwarding email.');
       }
     }
   };
   ```

3. **ルーティングルールの紐付け**:
   - 再び Cloudflare の **[Email] > [Email Routing]** に戻ります。
   - **[Routing rules]** タブを開き、**[Catch-all]**（または特定の宛先アドレス）のアクションを **[Send to Worker]** に設定し、先ほど作成した `temp-mail-worker` を指定します。

これでセットアップは完了です！
外からあなたのドメイン宛てにメールを送ると、Cloudflareが受信 ➔ Workerがキャッチ ➔ トンネル経由で自宅PCのHonoサーバーへ転送 ➔ ターミナルにログが出力される という一連の流れが動作します。

---

## Step 3: Run the Local Hono Server

1. **Clone/Setup Repository**:
   ```bash
   cd temp-mail-server
   npm install
   ```

2. **Start Development Server**:
   ```bash
   npm run dev
   ```

3. **Production Run**:
   ```bash
   npm run build
   npm start
   ```

---

## 🛠️ 構築の道のりとトラブルシューティング（開発ストーリー）

### 1. 構想・インフラの設計
- **目標**: 自宅ドメイン（例: `psannetwork.net`）を使った完全無料の「捨てアドサービス」の構築。
- **選択したスタック**:
  - 外部からのメール受信：Cloudflare Email Routing & Email Workers
  - 外部公開：Cloudflare Tunnel (`cloudflared`)
  - バックエンド：自宅PC上で動かす Node.js + Hono サーバー（ポート `1035`）

### 2. トンネルとバックエンドの立ち上げ
- `cloudflared` を使って自宅サーバーを外の世界に安全に露出させ、Honoで `/webhook/email` を待ち受けるサーバーを稼働させました。

### 3. 第1の壁：Cloudflareによるメールの門前払い
- **症状**: 外部（Gmailなど）からテストメールを送ると、すぐさま「アドレスが見つからなかったか、メールを受信できないアドレスであるため配信されませんでした」というバウンスメールが返ってくる。
- **原因**: CloudflareのEmail Routingのデフォルト設定が **「Catch-all（すべて）: ドロップ（破棄）」** になっていたため、届いたメールが即座に拒否されていました。
- **対策**: キャッチオールのルールを「ワーカーに送信（Send to Worker）」に変更し、`temp-mail-worker` を指定しました。

### 4. 第2の壁：ダッシュボードのタブ迷宮
- **症状**: 設定を変えたものの、まだエラーが返ってくる状態が続き、Cloudflareの管理画面の「宛先アドレス (Destination addresses)」という見慣れないタブに迷い込んで「アドレスが見つからない」と表示される。
- **原因**: 外部の通常メールボックスに転送する設定と、Cloudflare Workerに流す設定が混同しやすい仕様になっていたため、「どこに最終的な宛先があるのか」Cloudflare側が迷う状態になっていました。
- **対策**: 余計な宛先登録ではなく、あくまで **Email Routingの「ルーティング ルール」と「Email Workers」の紐付け（ルート作成）** が正しく直結していることを確認し、デプロイ状態を整理しました。

### 5. 完遂：見事な疎通成功！
すべてのパズルのピースがかみ合い、外部から送ったテストメールが以下のルートを完璧に駆け抜けました：

$$\text{Gmail等} \rightarrow \text{Cloudflare MX} \rightarrow \text{Email Worker} \rightarrow \text{Cloudflare Tunnel} \rightarrow \text{自宅のHonoサーバー (Port 1035)}$$

自宅サーバーのターミナルに `[Email Received] To: ...` の受信ログがポコッと現れ、無事にインフラが完全稼働しました！
