import { describe, it, expect, beforeEach } from 'vitest'
import { app, emails } from './server.js'

describe('Temp Mail Server API', () => {
  beforeEach(() => {
    emails.length = 0 // Clear store before each test
  })

  it('should return health status', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('ok')
  })

  it('should read site key from legacy RECAPTCHA env vars', async () => {
    const previous = process.env.RECAPTCHA_SITE_KEY
    process.env.RECAPTCHA_SITE_KEY = 'legacy-site-key'

    try {
      const res = await app.request('/api/config')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.turnstileSiteKey).toBe('legacy-site-key')
    } finally {
      if (previous === undefined) {
        delete process.env.RECAPTCHA_SITE_KEY
      } else {
        process.env.RECAPTCHA_SITE_KEY = previous
      }
    }
  })

  it('should receive and store email webhook', async () => {
    const payload = {
      from: 'sender@example.com',
      to: 'test@yourdomain.com',
      subject: 'Hello World',
      text: 'This is a test email body.',
    }

    const res = await app.request('/webhook/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.id).toBeDefined()

    expect(emails.length).toBe(1)
    expect(emails[0].subject).toBe('Hello World')
    expect(emails[0].from).toBe('sender@example.com')
  })

  it('should preserve html email bodies', async () => {
    const html = '<div><h1>Hello</h1><p><strong>World</strong></p></div>'
    const payload = {
      from: 'sender@example.com',
      to: 'html@yourdomain.com',
      subject: 'HTML Test',
      html,
    }

    const res = await app.request('/webhook/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    expect(emails.length).toBe(1)
    expect(emails[0].html).toBe(html)

    const detailRes = await app.request(`/api/emails/${emails[0].id}`)
    expect(detailRes.status).toBe(200)
    const detailJson = await detailRes.json()
    expect(detailJson.email.html).toBe(html)
  })

  it('should reject webhook with missing fields', async () => {
    const res = await app.request('/webhook/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'sender@example.com' }), // missing 'to'
    })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('should list emails with optional filter', async () => {
    emails.push(
      { id: '1', from: 'a@ex.com', to: 'user1@domain.com', subject: 'S1', text: 'T1', receivedAt: new Date().toISOString() },
      { id: '2', from: 'b@ex.com', to: 'user2@domain.com', subject: 'S2', text: 'T2', receivedAt: new Date().toISOString() }
    )

    const resAll = await app.request('/api/emails')
    const jsonAll = await resAll.json()
    expect(jsonAll.count).toBe(2)

    const resFiltered = await app.request('/api/emails?to=user1@domain.com')
    const jsonFiltered = await resFiltered.json()
    expect(jsonFiltered.count).toBe(1)
    expect(jsonFiltered.emails[0].to).toBe('user1@domain.com')
  })

  it('should get email detail by ID and handle 404', async () => {
    emails.push({
      id: 'abc123xyz',
      from: 'sender@ex.com',
      to: 'user@domain.com',
      subject: 'Detail Test',
      text: 'Body...',
      receivedAt: new Date().toISOString(),
    })

    const resFound = await app.request('/api/emails/abc123xyz')
    expect(resFound.status).toBe(200)
    const jsonFound = await resFound.json()
    expect(jsonFound.email.subject).toBe('Detail Test')

    const resNotFound = await app.request('/api/emails/nonexistent')
    expect(resNotFound.status).toBe(404)
  })

  it('should clear all emails', async () => {
    emails.push({
      id: '1',
      from: 'a@ex.com',
      to: 'user@domain.com',
      subject: 'S',
      text: 'T',
      receivedAt: new Date().toISOString(),
    })

    const res = await app.request('/api/emails', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(emails.length).toBe(0)
  })

  it('should create mailbox with 7-day expiration', async () => {
    const res = await app.request('/api/mailboxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customName: 'testbox' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.mailbox).toBeDefined()
    expect(json.mailbox.address).toContain('testbox@')

    const createdAt = new Date(json.mailbox.createdAt).getTime()
    const expiresAt = new Date(json.mailbox.expiresAt).getTime()
    const diffDays = (expiresAt - createdAt) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeCloseTo(7, 1)
  })

  it('should delete associated emails when mailbox is discarded', async () => {
    const address = 'deletetest@psannetwork.net'
    // Send email to address
    await app.request('/webhook/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'sender@example.com',
        to: address,
        subject: 'Delete Me',
        text: 'Body...',
      }),
    })

    expect(emails.some(e => e.to === address)).toBe(true)

    // Delete mailbox
    const res = await app.request(`/api/mailboxes/${encodeURIComponent(address)}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)

    // Verify email is deleted
    expect(emails.some(e => e.to === address)).toBe(false)
  })
})
