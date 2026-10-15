import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from '@hono/node-server/serve-static'
import PostalMime from 'postal-mime'
import Database from 'better-sqlite3'
import path from 'node:path'

export interface Mailbox {
  address: string
  createdAt: string
  expiresAt: string
}

export interface EmailMessage {
  id: string
  from: string
  to: string
  subject: string
  text: string
  html?: string
  receivedAt: string
}

export interface IpBanEntry {
  ip: string
  reason: string
  bannedAt: string
}

// SQLite DB setup
const DB_PATH = path.resolve(process.cwd(), 'index.db')
const db = new Database(DB_PATH)

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS mailboxes (
    address TEXT PRIMARY KEY,
    createdAt TEXT,
    expiresAt TEXT
  );
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    text TEXT,
    html TEXT,
    receivedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS ip_bans (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    bannedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS ip_generations (
    ip TEXT,
    timestamp TEXT
  );
  CREATE TABLE IF NOT EXISTS ip_verifications (
    ip TEXT PRIMARY KEY,
    expiresAt TEXT
  );
`)

function isIpVerified(ip: string): boolean {
  try {
    const row = db.prepare('SELECT expiresAt FROM ip_verifications WHERE ip = ?').get(ip) as { expiresAt: string } | undefined
    if (!row) return false
    return new Date(row.expiresAt).getTime() > Date.now()
  } catch {
    return false
  }
}

function setIpVerified(ip: string) {
  try {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    db.prepare('INSERT OR REPLACE INTO ip_verifications (ip, expiresAt) VALUES (?, ?)').run(ip, expiresAt)
  } catch (err) {
    console.error('Error setting IP verified:', err)
  }
}

// Exported arrays for compatibility with tests and frontend
export const mailboxes: Mailbox[] = []
export const emails: EmailMessage[] = []
export const ipBans: IpBanEntry[] = []

function cleanupExpiredMailboxes() {
  const nowIso = new Date().toISOString()
  const expired = db.prepare('SELECT address FROM mailboxes WHERE expiresAt < ?').all(nowIso) as any[]
  for (const row of expired) {
    dbDeleteMailbox(row.address)
  }
}

function loadFromDb() {
  cleanupExpiredMailboxes()

  mailboxes.length = 0
  const mbRows = db.prepare('SELECT address, createdAt, expiresAt FROM mailboxes').all() as any[]
  for (const row of mbRows) {
    mailboxes.push({
      address: row.address,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt
    })
  }

  emails.length = 0
  const emailRows = db.prepare('SELECT id, from_addr, to_addr, subject, text, html, receivedAt FROM emails').all() as any[]
  for (const row of emailRows) {
    emails.push({
      id: row.id,
      from: row.from_addr,
      to: row.to_addr,
      subject: row.subject,
      text: row.text,
      html: row.html || undefined,
      receivedAt: row.receivedAt
    })
  }

  ipBans.length = 0
  const banRows = db.prepare('SELECT ip, reason, bannedAt FROM ip_bans').all() as any[]
  for (const row of banRows) {
    ipBans.push({
      ip: row.ip,
      reason: row.reason,
      bannedAt: row.bannedAt
    })
  }
}

loadFromDb()

function dbInsertMailbox(m: Mailbox) {
  db.prepare('INSERT OR REPLACE INTO mailboxes (address, createdAt, expiresAt) VALUES (?, ?, ?)').run(m.address, m.createdAt, m.expiresAt)
}

function dbDeleteMailbox(address: string) {
  db.prepare('DELETE FROM mailboxes WHERE address = ?').run(address)
  db.prepare('DELETE FROM emails WHERE to_addr = ?').run(address)
}

function dbInsertEmail(e: EmailMessage) {
  db.prepare('INSERT OR REPLACE INTO emails (id, from_addr, to_addr, subject, text, html, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.id, e.from, e.to, e.subject, e.text, e.html || null, e.receivedAt)
}

function dbDeleteEmail(id: string) {
  db.prepare('DELETE FROM emails WHERE id = ?').run(id)
}

function dbClearEmails() {
  db.prepare('DELETE FROM emails').run()
}

function dbAddIpBan(ip: string, reason: string) {
  db.prepare('INSERT OR REPLACE INTO ip_bans (ip, reason, bannedAt) VALUES (?, ?, ?)').run(ip, reason, new Date().toISOString())
  loadFromDb()
}

function dbLogIpGeneration(ip: string) {
  db.prepare('INSERT INTO ip_generations (ip, timestamp) VALUES (?, ?)').run(ip, new Date().toISOString())
}

function getIpGenerationCountLast24Hours(ip: string): number {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const row = db.prepare('SELECT COUNT(*) as count FROM ip_generations WHERE ip = ? AND timestamp > ?').get(ip, oneDayAgo) as any
  return row?.count || 0
}

function getIpGenerationCountLastMinute(ip: string): number {
  const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString()
  const row = db.prepare('SELECT COUNT(*) as count FROM ip_generations WHERE ip = ? AND timestamp > ?').get(ip, oneMinAgo) as any
  return row?.count || 0
}

// Helper to get client IP
function getClientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('cf-connecting-ip') || '127.0.0.1'
}

// Automatic Security & Rate Limiting Middleware
const requestCounts = new Map<string, { count: number; resetTime: number }>()
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 60 // 60 requests per minute
const DDOS_BAN_THRESHOLD = 120 // 120 requests per minute triggers auto IP ban

function securityMiddleware(c: any, next: any) {
  const ip = getClientIp(c)

  // Check if IP is auto-banned
  if (ipBans.some((b) => b.ip === ip)) {
    return c.json({ success: false, error: 'Access denied. Your IP has been automatically banned due to suspicious traffic or DDoS behavior.' }, 403)
  }

  // Rate limiter & Auto-Ban for excessive requests (DDoS attempt)
  const now = Date.now()
  let record = requestCounts.get(ip)

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW }
    requestCounts.set(ip, record)
  } else {
    record.count++
    if (record.count > DDOS_BAN_THRESHOLD) {
      dbAddIpBan(ip, 'Auto-banned due to request flooding / DDoS attempt')
      return c.json({ success: false, error: 'Access denied. IP banned due to excessive request volume.' }, 403)
    }
    if (record.count > RATE_LIMIT_MAX) {
      return c.json({ success: false, error: 'Too many requests, please try again later.' }, 429)
    }
  }
  return next()
}

export const app = new Hono()

// Security Middleware
app.use('/*', secureHeaders())
app.use('/*', cors())
app.use('/api/*', securityMiddleware)

// Serve static frontend files from 'public' directory
app.use('/*', serveStatic({ root: './public' }))

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

const getTurnstileSiteKey = () => {
  return (
    process.env.TURNSTILE_SITE_KEY ||
    process.env.TURNSTILE_SITEKEY ||
    process.env.RECAPTCHA_SITE_KEY ||
    process.env.RECAPTCHA_SITEKEY ||
    ''
  )
}

const getTurnstileSecret = () => {
  return (
    process.env.TURNSTILE_SECRET_KEY ||
    process.env.TURNSTILE_SECRET ||
    process.env.RECAPTCHA_SECRET_KEY ||
    process.env.RECAPTCHA_SECRET ||
    ''
  )
}

app.get('/api/config', (c) => {
  return c.json({
    success: true,
    turnstileSiteKey: getTurnstileSiteKey()
  })
})

// ==================== Mailbox Management & Limits ====================

// Create or ensure a temporary mailbox (with automatic spam/DDoS IP banning)
app.post('/api/mailboxes', async (c) => {
  const ip = getClientIp(c)

  // Check rapid creation spam (> 5 creations in 1 minute -> Auto IP Ban)
  const rapidCount = getIpGenerationCountLastMinute(ip)
  if (rapidCount >= 5) {
    dbAddIpBan(ip, 'Auto-banned due to rapid spam address generation')
    return c.json({ success: false, error: 'Access denied. Your IP has been banned due to spam mailbox creation.' }, 403)
  }
  
  // Check daily limit (e.g. max 10 creations per IP per 24 hours)
  const dailyCount = getIpGenerationCountLast24Hours(ip)
  const DAILY_LIMIT = 10
  if (dailyCount >= DAILY_LIMIT) {
    return c.json({ success: false, error: `Daily mailbox generation limit (${DAILY_LIMIT}/day) reached for your IP.` }, 429)
  }

  const body = (await c.req.json().catch(() => ({}))) as { customName?: string; domain?: string; turnstileToken?: string }

  // Verify Cloudflare Turnstile token only if explicitly configured.
  // Accept both Turnstile and legacy RECAPTCHA variable names for compatibility.
  const turnstileSecret = getTurnstileSecret()
  if (process.env.NODE_ENV !== 'test' && turnstileSecret) {
    const token = body.turnstileToken
    if (!token) {
      return c.json({ success: false, error: 'Turnstile verification required.' }, 400)
    }
    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: turnstileSecret,
          response: token,
          remoteip: ip,
        }),
      })
      const verifyData = (await verifyRes.json()) as { success: boolean }
      if (!verifyData.success) {
        return c.json({ success: false, error: 'Turnstile verification failed.' }, 403)
      }
    } catch (err) {
      console.error('Turnstile verification error:', err)
      return c.json({ success: false, error: 'Turnstile verification service error.' }, 500)
    }
  }

  const domain = body.domain || process.env.MAIL_DOMAIN || 'psannetwork.net'
  
  let username = body.customName ? body.customName.toLowerCase().replace(/[^a-z0-9._-]/g, '') : ''
  if (!username || username.length < 3) {
    username = 'temp_' + Math.random().toString(36).substring(2, 10)
  }

  const address = `${username}@${domain}`

  let mailbox = mailboxes.find((m) => m.address === address)
  if (!mailbox) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

    mailbox = {
      address,
      createdAt: now.toISOString(),
      expiresAt,
    }

    mailboxes.unshift(mailbox)
    dbInsertMailbox(mailbox)
    dbLogIpGeneration(ip)
    loadFromDb()
  }

  return c.json({ success: true, mailbox })
})

// List active mailboxes
app.get('/api/mailboxes', (c) => {
  cleanupExpiredMailboxes()
  loadFromDb()
  return c.json({ success: true, mailboxes })
})

// Ensure specific mailbox on refresh
app.post('/api/mailboxes/ensure', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { address?: string }
  if (!body.address || !body.address.includes('@')) {
    return c.json({ success: false, error: 'Invalid address' }, 400)
  }

  const address = body.address.trim().toLowerCase()
  let mailbox = mailboxes.find((m) => m.address === address)

  if (!mailbox) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    mailbox = {
      address,
      createdAt: now.toISOString(),
      expiresAt,
    }
    mailboxes.unshift(mailbox)
    dbInsertMailbox(mailbox)
  }

  return c.json({ success: true, mailbox })
})

// Delete mailbox
app.delete('/api/mailboxes/:address', (c) => {
  const address = decodeURIComponent(c.req.param('address'))
  const index = mailboxes.findIndex((m) => m.address === address)
  
  if (index === -1) {
    return c.json({ success: false, error: 'Mailbox not found' }, 404)
  }

  mailboxes.splice(index, 1)
  const filteredEmails = emails.filter((e) => e.to.toLowerCase() !== address.toLowerCase())
  emails.length = 0
  emails.push(...filteredEmails)

  dbDeleteMailbox(address)

  return c.json({ success: true, message: `Mailbox ${address} deleted` })
})

// ==================== Email Webhook & Management APIs ====================

app.post('/webhook/email', async (c) => {
  try {
    const body = await c.req.json<{
      from?: string
      to?: string
      subject?: string
      text?: string
      html?: string
    }>()

    if (!body.to) {
      return c.json({ success: false, error: 'Missing "to" field' }, 400)
    }

    const rawEmail = body.text || body.html || ''
    const parsed = await PostalMime.parse(rawEmail).catch(() => null)

    const fromObj = parsed?.from as any
    const toObj = parsed?.to as any
    const fromAddress = fromObj?.address || body.from || 'unknown@sender.com'
    const toAddress = (Array.isArray(toObj) ? toObj[0]?.address : toObj?.address) || body.to.trim().toLowerCase()
    const subject = parsed?.subject || body.subject || '(件名なし)'
    const textBody = parsed?.text || (parsed ? '' : body.text) || '(本文なし)'
    const htmlBody = parsed?.html || body.html || undefined

    const recipient = toAddress.trim().toLowerCase()

    if (!mailboxes.some((m) => m.address === recipient)) {
      const now = new Date()
      const newMb = {
        address: recipient,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }
      mailboxes.unshift(newMb)
      dbInsertMailbox(newMb)
    }

    const newEmail: EmailMessage = {
      id: 'msg_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36),
      from: fromAddress.trim(),
      to: recipient,
      subject: subject.trim().substring(0, 255),
      text: textBody,
      html: htmlBody,
      receivedAt: new Date().toISOString(),
    }

    emails.unshift(newEmail)
    dbInsertEmail(newEmail)

    console.log(`[Email Parsed & Received] To: ${newEmail.to} | From: ${newEmail.from} | Subject: ${newEmail.subject}`)

    return c.json({ success: true, id: newEmail.id })
  } catch (err) {
    console.error('Failed to process email webhook:', err)
    return c.json({ success: false, error: 'Invalid JSON payload' }, 400)
  }
})

// List emails
app.get('/api/emails', (c) => {
  const toFilter = c.req.query('to')
  let results = emails

  if (toFilter) {
    results = emails.filter((e) => e.to.toLowerCase() === toFilter.toLowerCase())
  }

  return c.json({
    success: true,
    count: results.length,
    emails: results,
  })
})

// Get email detail
app.get('/api/emails/:id', (c) => {
  const id = c.req.param('id')
  const email = emails.find((e) => e.id === id)

  if (!email) {
    return c.json({ success: false, error: 'Email not found' }, 404)
  }

  return c.json({ success: true, email })
})

// Delete email
app.delete('/api/emails/:id', (c) => {
  const id = c.req.param('id')
  const index = emails.findIndex((e) => e.id === id)

  if (index === -1) {
    return c.json({ success: false, error: 'Email not found' }, 404)
  }

  emails.splice(index, 1)
  dbDeleteEmail(id)

  return c.json({ success: true, message: 'Email deleted' })
})

app.delete('/api/emails', (c) => {
  emails.length = 0
  dbClearEmails()
  return c.json({ success: true, message: 'All emails cleared' })
})

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 1035

  // Periodically clean up expired mailboxes every hour
  setInterval(() => {
    try {
      cleanupExpiredMailboxes()
      loadFromDb()
    } catch (e) {
      console.error('Periodic cleanup error:', e)
    }
  }, 60 * 60 * 1000)

  serve({
    fetch: app.fetch,
    port,
  }, (info) => {
    console.log(`Temp Mail Server is running on http://localhost:${info.port}`)
  })
}
