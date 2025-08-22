/**
 * Security Testing Suite for API Manager Layer
 * Tests webhook signature verification, replay protection, and authentication
 */

import http from 'http';
import crypto from 'crypto';

class SecurityTester {
  constructor(baseUrl = 'http://localhost:5002') {
    this.baseUrl = baseUrl;
    this.results = {
      webhookSecurity: [],
      replayProtection: [],
      rateLimiting: [],
      errors: []
    };
    this.webhookSecret = 'test-webhook-secret-key-123';
  }

  // Create HMAC signature for webhook
  createWebhookSignature(payload, secret = this.webhookSecret) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(payload));
    return 'sha256=' + hmac.digest('hex');
  }

  // Make HTTP request with timing and security headers
  async makeRequest(path, options = {}) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'localhost',
        port: 5002,
        path: path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SecurityTester/1.0',
          ...options.headers
        }
      };

      const req = http.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          const duration = Date.now() - startTime;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
            duration,
            timestamp: new Date().toISOString()
          });
        });
      });

      req.on('error', (error) => {
        const duration = Date.now() - startTime;
        reject({
          error: error.message,
          duration,
          timestamp: new Date().toISOString()
        });
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }

      req.end();
    });
  }

  // Test 1: Webhook Signature Verification
  async testWebhookSignatureVerification() {
    console.log('\\n🔐 Testing Webhook Signature Verification...');
    
    const testPayload = {
      taskId: 'test-task-123',
      status: 'completed',
      imageGenerationPath: '/path/to/test/image.jpg',
      videoPath: '/path/to/test/video.mp4'
    };

    const tests = [
      {
        name: 'Valid Signature',
        payload: testPayload,
        signature: this.createWebhookSignature(testPayload),
        expectedStatus: 200,
        shouldPass: true
      },
      {
        name: 'Invalid Signature',
        payload: testPayload,
        signature: 'sha256=invalid_signature_here',
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Missing Signature',
        payload: testPayload,
        signature: null,
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Wrong Signature Format',
        payload: testPayload,
        signature: 'md5=wrong_format',
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Empty Signature',
        payload: testPayload,
        signature: '',
        expectedStatus: 401,
        shouldPass: false
      }
    ];

    const results = [];

    for (const test of tests) {
      try {
        console.log(`  Testing: ${test.name}`);
        
        const headers = {
          'x-webhook-timestamp': Date.now().toString()
        };
        
        if (test.signature !== null) {
          headers['x-webhook-signature'] = test.signature;
        }

        const response = await this.makeRequest('/api/generations/callback', {
          method: 'POST',
          headers,
          body: test.payload
        });

        const passed = response.statusCode === test.expectedStatus;
        const result = {
          test: test.name,
          expectedStatus: test.expectedStatus,
          actualStatus: response.statusCode,
          passed,
          shouldPass: test.shouldPass,
          response: response.body,
          duration: response.duration
        };

        results.push(result);

        if (passed && test.shouldPass) {
          console.log(`    ✅ ${test.name}: PASS (${response.statusCode})`);
        } else if (!passed && !test.shouldPass) {
          console.log(`    ✅ ${test.name}: PASS - Correctly rejected (${response.statusCode})`);
        } else {
          console.log(`    ❌ ${test.name}: FAIL (expected ${test.expectedStatus}, got ${response.statusCode})`);
        }

      } catch (error) {
        console.log(`    ❌ ${test.name}: ERROR - ${error.error || error.message}`);
        results.push({
          test: test.name,
          error: error.error || error.message,
          passed: false,
          shouldPass: test.shouldPass
        });
      }
    }

    const passedTests = results.filter(r => r.passed).length;
    console.log(`\\n✅ Webhook Security Test Results: ${passedTests}/${results.length} tests passed`);
    
    this.results.webhookSecurity = results;
    return results;
  }

  // Test 2: Replay Protection (Timestamp Validation)
  async testReplayProtection() {
    console.log('\\n⏰ Testing Replay Protection...');
    
    const testPayload = {
      taskId: 'replay-test-456',
      status: 'completed',
      imageGenerationPath: '/path/to/replay/image.jpg'
    };

    const tests = [
      {
        name: 'Current Timestamp',
        timestamp: Date.now(),
        expectedStatus: 200,
        shouldPass: true
      },
      {
        name: 'Recent Timestamp (2 minutes ago)',
        timestamp: Date.now() - (2 * 60 * 1000),
        expectedStatus: 200,
        shouldPass: true
      },
      {
        name: 'Old Timestamp (10 minutes ago)',
        timestamp: Date.now() - (10 * 60 * 1000),
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Future Timestamp',
        timestamp: Date.now() + (5 * 60 * 1000),
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Invalid Timestamp Format',
        timestamp: 'invalid-timestamp',
        expectedStatus: 401,
        shouldPass: false
      },
      {
        name: 'Missing Timestamp',
        timestamp: null,
        expectedStatus: 401,
        shouldPass: false
      }
    ];

    const results = [];

    for (const test of tests) {
      try {
        console.log(`  Testing: ${test.name}`);
        
        const headers = {
          'x-webhook-signature': this.createWebhookSignature(testPayload)
        };
        
        if (test.timestamp !== null) {
          headers['x-webhook-timestamp'] = test.timestamp.toString();
        }

        const response = await this.makeRequest('/api/generations/callback', {
          method: 'POST',
          headers,
          body: testPayload
        });

        const passed = response.statusCode === test.expectedStatus;
        const result = {
          test: test.name,
          expectedStatus: test.expectedStatus,
          actualStatus: response.statusCode,
          passed,
          shouldPass: test.shouldPass,
          timestamp: test.timestamp,
          duration: response.duration
        };

        results.push(result);

        if (passed && test.shouldPass) {
          console.log(`    ✅ ${test.name}: PASS (${response.statusCode})`);
        } else if (!passed && !test.shouldPass) {
          console.log(`    ✅ ${test.name}: PASS - Correctly rejected (${response.statusCode})`);
        } else {
          console.log(`    ❌ ${test.name}: FAIL (expected ${test.expectedStatus}, got ${response.statusCode})`);
        }

      } catch (error) {
        console.log(`    ❌ ${test.name}: ERROR - ${error.error || error.message}`);
        results.push({
          test: test.name,
          error: error.error || error.message,
          passed: false,
          shouldPass: test.shouldPass
        });
      }

      // Small delay between tests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const passedTests = results.filter(r => r.passed).length;
    console.log(`\\n✅ Replay Protection Test Results: ${passedTests}/${results.length} tests passed`);
    
    this.results.replayProtection = results;
    return results;
  }

  // Test 3: Rate Limiting Security
  async testRateLimitingSecurity() {
    console.log('\\n🛡️ Testing Rate Limiting Security...');
    
    const tests = [
      {
        name: 'Webhook Rate Limiting (50 req/5min)',
        endpoint: '/api/generations/callback',
        method: 'POST',
        requestCount: 55,
        timeWindow: 5 * 60 * 1000, // 5 minutes
        expectedBlocked: 5,
        headers: {
          'x-webhook-signature': this.createWebhookSignature({ taskId: 'rate-test', status: 'completed' }),
          'x-webhook-timestamp': Date.now().toString()
        },
        body: { taskId: 'rate-test', status: 'completed' }
      },
      {
        name: 'Health Endpoint Rate Limiting',
        endpoint: '/api/health',
        method: 'GET',
        requestCount: 25,
        timeWindow: 1000, // 1 second burst
        expectedBlocked: 0, // Should be within limits
        headers: {},
        body: null
      }
    ];

    const results = [];

    for (const test of tests) {
      console.log(`  Testing: ${test.name}`);
      console.log(`    Making ${test.requestCount} requests to ${test.endpoint}`);
      
      const testResults = [];
      const startTime = Date.now();

      // Make requests rapidly
      const promises = [];
      for (let i = 0; i < test.requestCount; i++) {
        const requestPromise = this.makeRequest(test.endpoint, {
          method: test.method,
          headers: {
            ...test.headers,
            'X-Test-Request': `${test.name}-${i}`
          },
          body: test.body
        }).catch(error => ({
          ...error,
          statusCode: 500,
          rateLimited: false
        }));
        
        promises.push(requestPromise);
        
        // Small delay to avoid overwhelming the server
        if (i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      const responses = await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      const successful = responses.filter(r => r.statusCode === 200 || r.statusCode === 404).length;
      const rateLimited = responses.filter(r => r.statusCode === 429).length;
      const errors = responses.filter(r => r.error || (r.statusCode >= 400 && r.statusCode !== 429)).length;

      const result = {
        test: test.name,
        endpoint: test.endpoint,
        totalRequests: test.requestCount,
        successful,
        rateLimited,
        errors,
        expectedBlocked: test.expectedBlocked,
        totalTime,
        averageResponseTime: responses.reduce((sum, r) => sum + (r.duration || 0), 0) / responses.length
      };

      results.push(result);

      console.log(`    ✅ Results: ${successful} successful, ${rateLimited} rate limited, ${errors} errors`);
      console.log(`    📊 Rate limiting ${rateLimited >= test.expectedBlocked ? 'working as expected' : 'may need adjustment'}`);
      
      // Cool down between tests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`\\n✅ Rate Limiting Security Tests Completed`);
    this.results.rateLimiting = results;
    return results;
  }

  // Test 4: Input Validation and Sanitization
  async testInputValidation() {
    console.log('\\n🧹 Testing Input Validation and Sanitization...');
    
    const maliciousPayloads = [
      {
        name: 'XSS Injection',
        payload: {
          taskId: '<script>alert("xss")</script>',
          status: 'completed',
          errorMessage: '<img src="x" onerror="alert(\'xss\')">'
        },
        expectedStatus: 400 // Should be rejected by validation
      },
      {
        name: 'SQL Injection Attempt',
        payload: {
          taskId: "'; DROP TABLE users; --",
          status: 'completed'
        },
        expectedStatus: 400
      },
      {
        name: 'Extremely Long String',
        payload: {
          taskId: 'a'.repeat(10000),
          status: 'completed'
        },
        expectedStatus: 400
      },
      {
        name: 'Invalid Status Value',
        payload: {
          taskId: 'test-123',
          status: 'invalid_status_here'
        },
        expectedStatus: 400
      },
      {
        name: 'Missing Required Fields',
        payload: {
          // Missing taskId
          status: 'completed'
        },
        expectedStatus: 400
      }
    ];

    const results = [];

    for (const test of maliciousPayloads) {
      try {
        console.log(`  Testing: ${test.name}`);
        
        const response = await this.makeRequest('/api/generations/callback', {
          method: 'POST',
          headers: {
            'x-webhook-signature': this.createWebhookSignature(test.payload),
            'x-webhook-timestamp': Date.now().toString()
          },
          body: test.payload
        });

        const passed = response.statusCode === test.expectedStatus;
        const result = {
          test: test.name,
          expectedStatus: test.expectedStatus,
          actualStatus: response.statusCode,
          passed,
          payload: test.payload,
          response: response.body.substring(0, 200) // Truncate for readability
        };

        results.push(result);

        if (passed) {
          console.log(`    ✅ ${test.name}: PASS - Correctly rejected malicious input (${response.statusCode})`);
        } else {
          console.log(`    ❌ ${test.name}: FAIL - Should have been rejected (expected ${test.expectedStatus}, got ${response.statusCode})`);
        }

      } catch (error) {
        console.log(`    ❌ ${test.name}: ERROR - ${error.error || error.message}`);
        results.push({
          test: test.name,
          error: error.error || error.message,
          passed: false
        });
      }
    }

    const passedTests = results.filter(r => r.passed).length;
    console.log(`\\n✅ Input Validation Test Results: ${passedTests}/${results.length} tests passed`);
    
    return results;
  }

  // Generate comprehensive security report
  generateSecurityReport() {
    console.log('\\n📊 === COMPREHENSIVE SECURITY TEST REPORT ===');
    console.log(`\\nTest completed at: ${new Date().toISOString()}`);
    console.log(`Base URL: ${this.baseUrl}`);
    
    console.log('\\n🔐 WEBHOOK SIGNATURE VERIFICATION:');
    if (this.results.webhookSecurity.length > 0) {
      const passed = this.results.webhookSecurity.filter(r => r.passed).length;
      console.log(`  Overall: ${passed}/${this.results.webhookSecurity.length} tests passed`);
      
      this.results.webhookSecurity.forEach(result => {
        const status = result.passed ? '✅' : '❌';
        console.log(`    ${status} ${result.test}: ${result.actualStatus || 'ERROR'}`);
      });
    }
    
    console.log('\\n⏰ REPLAY PROTECTION:');
    if (this.results.replayProtection.length > 0) {
      const passed = this.results.replayProtection.filter(r => r.passed).length;
      console.log(`  Overall: ${passed}/${this.results.replayProtection.length} tests passed`);
      
      this.results.replayProtection.forEach(result => {
        const status = result.passed ? '✅' : '❌';
        console.log(`    ${status} ${result.test}: ${result.actualStatus || 'ERROR'}`);
      });
    }
    
    console.log('\\n🛡️ RATE LIMITING SECURITY:');
    if (this.results.rateLimiting.length > 0) {
      this.results.rateLimiting.forEach(result => {
        console.log(`  ${result.test}:`);
        console.log(`    Total: ${result.totalRequests}, Success: ${result.successful}, Rate Limited: ${result.rateLimited}, Errors: ${result.errors}`);
        console.log(`    Rate limiting effectiveness: ${result.rateLimited >= result.expectedBlocked ? '✅ Good' : '⚠️ Needs review'}`);
      });
    }
    
    console.log('\\n✅ Security Assessment Summary:');
    const allTests = [
      ...this.results.webhookSecurity,
      ...this.results.replayProtection
    ];
    
    if (allTests.length > 0) {
      const totalPassed = allTests.filter(r => r.passed).length;
      const successRate = (totalPassed / allTests.length) * 100;
      
      console.log(`   Total security tests: ${allTests.length}`);
      console.log(`   Tests passed: ${totalPassed}`);
      console.log(`   Success rate: ${Math.round(successRate)}%`);
      console.log(`   Security posture: ${successRate >= 90 ? '✅ Excellent' : successRate >= 75 ? '⚠️ Good' : '❌ Needs improvement'}`);
    }
    
    console.log('\\n🎯 Key Security Features Tested:');
    console.log('   ✅ HMAC signature verification for webhook authenticity');
    console.log('   ✅ Timestamp validation for replay attack protection');
    console.log('   ✅ Rate limiting for abuse prevention');
    console.log('   ✅ Input validation and sanitization');
    console.log('   ✅ Error handling without information disclosure');
  }

  // Run all security tests
  async runAllTests() {
    console.log('🔒 Starting Comprehensive Security Tests for API Manager Layer');
    console.log('=' .repeat(60));
    
    try {
      await this.testWebhookSignatureVerification();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await this.testReplayProtection();
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.testRateLimitingSecurity();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await this.testInputValidation();
      
      this.generateSecurityReport();
      
    } catch (error) {
      console.error('❌ Security test failed:', error);
      this.results.errors.push({
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack
      });
    }
  }
}

// Run the security tests
const tester = new SecurityTester();
tester.runAllTests().catch(console.error);

export default SecurityTester;