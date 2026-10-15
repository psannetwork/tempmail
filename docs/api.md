# API Reference & Usage

The Hono backend server exposes endpoints for receiving webhooks from Cloudflare Email Workers and querying received messages for frontend clients or automated scripts.

---

## Endpoints

### 1. Receive Email Webhook
- **URL**: `/webhook/email`
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Payload**:
  ```json
  {
    "from": "sender@example.com",
    "to": "user@yourdomain.com",
    "subject": "Hello from temporary mail",
    "text": "This is the raw email content or message body."
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "id": "msg_1234567890"
  }
  ```

### 2. List Received Emails
- **URL**: `/api/emails`
- **Method**: `GET`
- **Query Parameters**:
  - `to` (optional): Filter emails by recipient address.
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "count": 2,
    "emails": [
      {
        "id": "msg_1",
        "from": "alice@example.com",
        "to": "test@yourdomain.com",
        "subject": "Test Subject",
        "text": "Email body content...",
        "receivedAt": "2026-10-15T12:00:00.000Z"
      }
    ]
  }
  ```

### 3. Get Email Details
- **URL**: `/api/emails/:id`
- **Method**: `GET`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "email": {
      "id": "msg_1",
      "from": "alice@example.com",
      "to": "test@yourdomain.com",
      "subject": "Test Subject",
      "text": "Email body content...",
      "receivedAt": "2026-10-15T12:00:00.000Z"
    }
  }
  ```
- **Error Response**: `404 Not Found`
  ```json
  {
    "success": false,
    "error": "Email not found"
  }
  ```

### 4. Clear / Delete Emails (Optional)
- **URL**: `/api/emails`
- **Method**: `DELETE`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "message": "All emails cleared"
  }
  ```
