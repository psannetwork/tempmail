# System Architecture

The self-hosted temporary email service consists of several distributed components working together to securely receive and process emails without requiring a dedicated public VPS or port forwarding on your home router.

## Architectural Overview

```
[ External Mail Sender ]
          │
          ▼ (MX Records)
    [ Cloudflare DNS & Email Routing ]
          │
          ▼ (Triggers)
    [ Cloudflare Email Worker ]
          │
          ▼ (HTTPS POST /webhook/email via secure tunnel)
    [ Cloudflare Tunnel (cloudflared) ]
          │
          ▼ (Localhost HTTP)
    [ Local Node.js / Hono Backend Server ]
          │
          ▼ (In-Memory / SQLite Storage & Real-time Client Delivery)
    [ Frontend / API Consumers ]
```

## Component Breakdown

1. **Cloudflare DNS & Email Routing**:
   - Manages domain MX records.
   - Captures incoming emails for any address on your custom domain (Catch-all or specific prefixes).
   - Forwards captured email payloads to the Cloudflare Email Worker.

2. **Cloudflare Email Worker**:
   - A serverless script running on Cloudflare's edge network.
   - Extracts sender, recipient, subject, and raw/parsed body content.
   - Encapsulates email metadata into a JSON payload and transmits it via secure HTTPS POST request to your Cloudflare Tunnel public endpoint.

3. **Cloudflare Tunnel (`cloudflared`)**:
   - Establishes an outbound-only encrypted connection from your home server/PC to Cloudflare's edge.
   - Exposes a public subdomain (e.g., `api.yourdomain.com`) pointing to your local development or production server without opening any inbound firewall ports or exposing your home IP address.

4. **Local Backend Server (Hono + Node.js)**:
   - Built with TypeScript and Hono framework for ultra-fast, lightweight HTTP handling.
   - Exposes `/webhook/email` to receive POST requests from the Email Worker.
   - Stores emails temporarily (in memory or SQLite) and provides API endpoints for clients to query or stream received messages.
