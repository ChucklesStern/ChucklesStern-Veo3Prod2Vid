# IP Detection and Request Capture Guide

This guide explains how to determine the outbound IP address used by your Replit production app when making requests to external services like the n8n webhook.

## Available Endpoints

### 1. Dedicated IP Detection Endpoint
**Endpoint**: `GET /api/detect-outbound-ip`

**Purpose**: Queries multiple IP detection services to determine your app's outbound IP address.

**Services Used**:
- **ipify.org**: `https://api.ipify.org` (plain text response)
- **httpbin.org**: `https://httpbin.org/ip` (JSON response)
- **ipinfo.io**: `https://ipinfo.io/ip` (plain text response)

**Response Format**:
```json
{
  "success": true,
  "detectedIp": "203.0.113.45",
  "services": [
    {
      "service": "ipify",
      "ip": "203.0.113.45",
      "status": "success",
      "duration": 234
    },
    {
      "service": "httpbin",
      "ip": "203.0.113.45",
      "status": "success",
      "duration": 456
    },
    {
      "service": "ipinfo",
      "ip": "203.0.113.45",
      "status": "success",
      "duration": 123
    }
  ],
  "metadata": {
    "servicesQueried": 3,
    "successfulResponses": 3,
    "totalDuration": 567,
    "timestamp": "2025-09-26T02:15:00.000Z"
  },
  "correlationId": "abc123"
}
```

### 2. Enhanced Webhook Connectivity Test
**Endpoint**: `GET /api/test-webhook-connectivity`

**Purpose**: Tests webhook connectivity and includes outbound IP detection.

**Response Format**:
```json
{
  "success": true,
  "webhookResponse": {
    "status": 200,
    "statusText": "OK",
    "body": {"message": "Workflow was started"},
    "duration": 489
  },
  "outboundIp": "203.0.113.45",
  "timestamp": "2025-09-26T02:15:00.000Z",
  "correlationId": "abc123"
}
```

### 3. Webhook Health Monitoring with IP
**Endpoint**: `GET /api/monitoring/webhook-health`

**Purpose**: Real-time webhook health dashboard that includes current outbound IP.

**Response Format**:
```json
{
  "period": "1h",
  "timestamp": "2025-09-26T02:15:00.000Z",
  "webhook": {
    "endpoint": "configured",
    "status": "healthy",
    "responseTime": 234,
    "outboundIp": "203.0.113.45"
  },
  "metrics": {
    // ... webhook metrics
  },
  "correlationId": "abc123"
}
```

## RequestBin Setup for Request Capture

RequestBin allows you to capture actual HTTP requests sent from your app to see exactly what external services receive, including source IP addresses.

### Step 1: Create a RequestBin
1. Go to **[Pipedream RequestBin](https://pipedream.com/requestbin)**
2. Click "Create RequestBin"
3. You'll get a unique URL like: `https://eo12345abcdef.m.pipedream.net`

### Step 2: Temporarily Redirect Webhook Calls
**Option A: Environment Variable Override**
1. Temporarily update your `.env` file:
   ```env
   N8N_WEBHOOK_URL=https://eo12345abcdef.m.pipedream.net
   ```
2. Restart your app
3. Make a webhook call via `/api/test-webhook-connectivity`
4. Check RequestBin to see the captured request

**Option B: Test Endpoint Modification**
Create a temporary test that calls RequestBin directly:

```javascript
// Add this as a temporary endpoint
app.get("/api/test-requestbin", async (req, res) => {
  const requestBinUrl = "https://eo12345abcdef.m.pipedream.net";

  try {
    const response = await fetch(requestBinUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ hello: 'world', test: 'ip_capture' })
    });

    res.json({
      success: response.ok,
      status: response.status,
      message: "Check RequestBin to see the captured request and source IP"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Step 3: Analyze Captured Request
In your RequestBin dashboard, you'll see:
- **Source IP**: The IP address your Replit app used
- **Headers**: All HTTP headers sent
- **Body**: The payload content
- **Timestamp**: When the request was received

### Step 4: Restore Original Configuration
Don't forget to restore your original `N8N_WEBHOOK_URL` after testing!

## Understanding Replit IP Characteristics

### IP Address Behavior
- **Dynamic**: Replit uses dynamic IP pools, not static IPs
- **Google Cloud**: Runs on Google Cloud infrastructure
- **Regional**: IPs may vary by geographic region
- **Shared**: Multiple Replit apps may share IP addresses

### When IPs Change
- App restarts/redeployments
- Scaling events
- Infrastructure maintenance
- Regional failovers

### For Production Use
If n8n or other services require IP whitelisting:
1. **Monitor IP changes** using the monitoring endpoints
2. **Use IP ranges** rather than specific IPs when possible
3. **Implement dynamic DNS** or webhook callbacks for IP updates
4. **Consider authentication tokens** instead of IP-based security

## Usage Examples

### Quick IP Check
```bash
curl https://your-app.replit.app/api/detect-outbound-ip
```

### Combined Webhook + IP Test
```bash
curl https://your-app.replit.app/api/test-webhook-connectivity
```

### Monitor IP Changes
```bash
# Check every 5 minutes
while true; do
  curl -s https://your-app.replit.app/api/monitoring/webhook-health | \
    jq '.webhook.outboundIp'
  sleep 300
done
```

## Troubleshooting

### IP Detection Fails
- Check if IP detection services are blocked
- Try different services (ipify, httpbin, ipinfo)
- Verify network connectivity from Replit

### RequestBin Not Receiving Requests
- Verify the RequestBin URL is correct
- Check if webhook calls are actually being made
- Confirm environment variable updates took effect

### Inconsistent IPs
- This is normal for Replit's dynamic infrastructure
- Use multiple detection services for verification
- Monitor over time to understand IP change patterns