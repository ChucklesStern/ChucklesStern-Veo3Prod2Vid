# Production Testing Guide for Enhanced N8N Webhook Logging

## 🎯 Quick Start Testing Checklist

### Step 1: Verify Enhanced Monitoring Endpoints

Test these endpoints on your production instance:

```bash
# Replace YOUR_PRODUCTION_DOMAIN with your actual domain
export PROD_DOMAIN="your-production-domain.com"

# 1. Check overall webhook health
curl "https://${PROD_DOMAIN}/api/monitoring/webhook-health"

# 2. Check recent webhook failures
curl "https://${PROD_DOMAIN}/api/monitoring/webhook-failures"

# 3. Check API manager status
curl "https://${PROD_DOMAIN}/api/monitoring/api-manager"

# 4. Check live webhook activity
curl "https://${PROD_DOMAIN}/api/monitoring/webhook-activity?limit=10"
```

### Step 2: Trigger a Test Video Generation

**Requirements:**
- You must be authenticated (logged in via Replit OAuth)
- You need a valid image uploaded to your system

**Sample Request:**
```bash
# Create a video generation request (requires authentication)
curl -X POST "https://${PROD_DOMAIN}/api/generations" \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "promptText": "Test video generation for enhanced logging validation - dancing cat",
    "imagePath": "/public-objects/uploads/test-image.jpg"
  }'
```

### Step 3: Monitor Production Logs

**Look for these log patterns in your production console:**

#### ✅ Startup Validation Logs
```json
{
  "type": "startup_validation_start",
  "correlationId": "startup-validation",
  "environment": "production"
}
```

#### ✅ Webhook Call Logs
```json
{
  "type": "webhook_call_start",
  "correlationId": "uuid-here",
  "taskId": "task-uuid",
  "webhookUrl": "https://chuckles84.app.n8n.cloud/webhook/ai-imggen-upload"
}
```

#### ✅ Request/Response Logs
```
=== N8N WEBHOOK POST REQUEST ===
Correlation ID: uuid-here
URL: https://chuckles84.app.n8n.cloud/webhook/ai-imggen-upload
Method: POST
Request Body Size: 1234 bytes
```

#### ✅ Enhanced Error Classification
```json
{
  "type": "n8n_webhook_request_error",
  "errorType": "timeout|network_error|webhook_failure|configuration_error",
  "retryable": true/false,
  "duration": 60000
}
```

### Step 4: Analyze Results

**Use the webhook trace endpoint for detailed analysis:**
```bash
# Get detailed trace for a specific request
curl "https://${PROD_DOMAIN}/api/monitoring/webhook-trace/YOUR_TASK_ID"
```

## 🔍 Key Information to Report

When testing, please capture and report:

### 1. Startup Validation Results
- ✅ Environment variables validated
- ✅ N8N webhook URL format validation
- ✅ N8N endpoint connectivity test results

### 2. Webhook Health Status
```bash
curl "https://${PROD_DOMAIN}/api/monitoring/webhook-health" | jq .
```

### 3. Sample Webhook Logs
- Full correlation ID for at least one request
- Complete request/response cycle logs
- Any error logs with classification

### 4. Error Patterns (if any)
- Error types encountered
- Response status codes
- Network connectivity issues

## 📋 Testing Scenarios

### Scenario 1: Successful Webhook Call
**Expected Outcome:**
- `webhook_call_start` → `n8n_webhook_request_start` → `n8n_webhook_response_success`
- Status 200 response from N8N
- Video generation proceeds to "processing" status

### Scenario 2: Network Error
**Expected Outcome:**
- `webhook_connectivity_test` fails
- `errorType: "network_error"`
- Detailed error classification and retry recommendations

### Scenario 3: N8N Workflow Error
**Expected Outcome:**
- `n8n_webhook_response_success` with non-200 status
- `errorType: "webhook_failure"`
- Captured response body for debugging

## 🆘 Troubleshooting

If you encounter issues:

1. **Check Authentication**: Ensure you're logged in via Replit OAuth
2. **Verify Image Path**: Make sure uploaded images use `/public-objects/uploads/` paths
3. **Monitor Rate Limits**: The system has rate limiting in place
4. **Check Correlation IDs**: Use correlation IDs to trace specific requests

## 📞 Reporting Results

Please provide:
1. Screenshots of your production logs showing the enhanced logging
2. Output from the monitoring endpoints
3. Any correlation IDs for failed requests
4. Network connectivity test results
5. Error classifications and patterns observed

This will help validate the enhanced logging system and identify any remaining n8n webhook issues!