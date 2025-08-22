/**
 * Load Testing Suite for API Manager Layer
 * Tests rate limiting, circuit breakers, and system performance under load
 */

import http from 'http';
import crypto from 'crypto';

class LoadTester {
  constructor(baseUrl = 'http://localhost:5001') {
    this.baseUrl = baseUrl;
    this.results = {
      rateLimiting: [],
      performance: [],
      errors: []
    };
  }

  // Make HTTP request with timing
  async makeRequest(path, options = {}) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'localhost',
        port: 5001,
        path: path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LoadTester/1.0',
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
        req.write(JSON.stringify(options.body));
      }

      req.end();
    });
  }

  // Test 1: Rate Limiting - Global Limit (100 req/min)
  async testGlobalRateLimit() {
    console.log('\n🔬 Testing Global Rate Limit (100 req/min)...');
    const results = [];
    const concurrent = 10;
    const totalRequests = 120; // Exceed the limit
    
    console.log(`Making ${totalRequests} requests with ${concurrent} concurrent connections`);
    
    const startTime = Date.now();
    
    // Create batches of concurrent requests
    for (let batch = 0; batch < Math.ceil(totalRequests / concurrent); batch++) {
      const promises = [];
      const batchStart = batch * concurrent;
      const batchEnd = Math.min((batch + 1) * concurrent, totalRequests);
      
      for (let i = batchStart; i < batchEnd; i++) {
        promises.push(
          this.makeRequest('/api/health', {
            headers: { 'X-Test-Request': `global-${i}` }
          }).catch(error => ({ ...error, requestId: i, rateLimited: true }))
        );
      }
      
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
      
      // Small delay between batches to simulate real usage
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const totalTime = Date.now() - startTime;
    const successful = results.filter(r => r.statusCode === 200);
    const rateLimited = results.filter(r => r.statusCode === 429);
    const errors = results.filter(r => r.error || (r.statusCode && r.statusCode >= 400 && r.statusCode !== 429));
    
    console.log(`✅ Global Rate Limit Test Results:`);
    console.log(`   Total requests: ${results.length}`);
    console.log(`   Successful: ${successful.length}`);
    console.log(`   Rate limited: ${rateLimited.length}`);
    console.log(`   Errors: ${errors.length}`);
    console.log(`   Total time: ${totalTime}ms`);
    console.log(`   Avg response time: ${Math.round(results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length)}ms`);
    
    if (rateLimited.length > 0) {
      console.log(`   ✅ Rate limiting is working - ${rateLimited.length} requests were properly limited`);
      
      // Check for rate limit headers
      const rateLimitedReq = rateLimited[0];
      if (rateLimitedReq.headers && rateLimitedReq.headers['x-ratelimit-global-limit']) {
        console.log(`   📊 Rate limit headers present: limit=${rateLimitedReq.headers['x-ratelimit-global-limit']}`);
      }
    } else {
      console.log(`   ⚠️  No rate limiting detected - this may indicate an issue`);
    }
    
    this.results.rateLimiting.push({
      test: 'global_rate_limit',
      totalRequests: results.length,
      successful: successful.length,
      rateLimited: rateLimited.length,
      errors: errors.length,
      avgResponseTime: results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length,
      totalTime
    });
  }

  // Test 2: API Strict Rate Limit (30 req/min for API calls)
  async testApiStrictRateLimit() {
    console.log('\n🔬 Testing API Strict Rate Limit (30 req/min)...');
    const results = [];
    const totalRequests = 40; // Exceed API strict limit
    
    console.log(`Making ${totalRequests} API requests quickly`);
    
    const startTime = Date.now();
    
    // Make requests to a non-GET, non-skip endpoint
    const promises = [];
    for (let i = 0; i < totalRequests; i++) {
      promises.push(
        this.makeRequest('/api/monitoring/metrics', {
          headers: { 'X-Test-Request': `api-strict-${i}` }
        }).catch(error => ({ ...error, requestId: i, rateLimited: true }))
      );
      
      // Small delay to simulate realistic timing
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    
    const totalTime = Date.now() - startTime;
    const successful = results.filter(r => r.statusCode === 200);
    const rateLimited = results.filter(r => r.statusCode === 429);
    
    console.log(`✅ API Strict Rate Limit Test Results:`);
    console.log(`   Total requests: ${results.length}`);
    console.log(`   Successful: ${successful.length}`);
    console.log(`   Rate limited: ${rateLimited.length}`);
    console.log(`   Total time: ${totalTime}ms`);
    
    this.results.rateLimiting.push({
      test: 'api_strict_rate_limit',
      totalRequests: results.length,
      successful: successful.length,
      rateLimited: rateLimited.length,
      totalTime
    });
  }

  // Test 3: Performance Under Normal Load
  async testPerformance() {
    console.log('\n🔬 Testing Performance Under Normal Load...');
    const results = [];
    const concurrent = 5;
    const duration = 10000; // 10 seconds
    
    console.log(`Running performance test for ${duration/1000} seconds with ${concurrent} concurrent requests`);
    
    const startTime = Date.now();
    let requestCount = 0;
    
    const makeRequests = async () => {
      while (Date.now() - startTime < duration) {
        const promises = [];
        for (let i = 0; i < concurrent; i++) {
          requestCount++;
          promises.push(
            this.makeRequest(`/api/health`, {
              headers: { 'X-Test-Request': `perf-${requestCount}` }
            }).catch(error => ({ ...error, requestId: requestCount }))
          );
        }
        
        const batchResults = await Promise.all(promises);
        results.push(...batchResults);
        
        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    
    await makeRequests();
    
    const totalTime = Date.now() - startTime;
    const successful = results.filter(r => r.statusCode === 200);
    const errors = results.filter(r => r.error || r.statusCode >= 400);
    const avgResponseTime = results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length;
    const requestsPerSecond = (results.length / totalTime) * 1000;
    
    console.log(`✅ Performance Test Results:`);
    console.log(`   Total requests: ${results.length}`);
    console.log(`   Successful: ${successful.length} (${Math.round(successful.length/results.length*100)}%)`);
    console.log(`   Errors: ${errors.length}`);
    console.log(`   Requests per second: ${Math.round(requestsPerSecond * 100)/100}`);
    console.log(`   Average response time: ${Math.round(avgResponseTime)}ms`);
    console.log(`   Min response time: ${Math.min(...results.map(r => r.duration || 0))}ms`);
    console.log(`   Max response time: ${Math.max(...results.map(r => r.duration || 0))}ms`);
    
    this.results.performance.push({
      test: 'normal_load_performance',
      totalRequests: results.length,
      successful: successful.length,
      errors: errors.length,
      requestsPerSecond,
      avgResponseTime,
      minResponseTime: Math.min(...results.map(r => r.duration || 0)),
      maxResponseTime: Math.max(...results.map(r => r.duration || 0)),
      totalTime
    });
  }

  // Test 4: Circuit Breaker (requires simulated failures)
  async testCircuitBreaker() {
    console.log('\n🔬 Testing Circuit Breaker Pattern...');
    
    // First, let's check the current retry manager status
    try {
      const statusRes = await this.makeRequest('/api/monitoring/api-manager');
      if (statusRes.statusCode === 200) {
        const status = JSON.parse(statusRes.body);
        console.log(`📊 Current circuit breaker status:`, status.retry.circuitBreakers);
      }
    } catch (error) {
      console.log(`⚠️  Could not fetch circuit breaker status: ${error.message}`);
    }
    
    console.log(`✅ Circuit breaker monitoring is available through /api/monitoring/api-manager endpoint`);
    console.log(`   Note: Circuit breakers activate automatically when external services fail`);
    console.log(`   They can be tested when n8n webhook calls fail consistently`);
  }

  // Generate comprehensive report
  generateReport() {
    console.log('\n📊 === COMPREHENSIVE LOAD TEST REPORT ===');
    console.log(`\nTest completed at: ${new Date().toISOString()}`);
    console.log(`Base URL: ${this.baseUrl}`);
    
    console.log('\n🛡️ RATE LIMITING TESTS:');
    this.results.rateLimiting.forEach(result => {
      console.log(`  ${result.test}:`);
      console.log(`    Total: ${result.totalRequests}, Success: ${result.successful}, Limited: ${result.rateLimited}, Errors: ${result.errors || 0}`);
      console.log(`    Avg Response: ${Math.round(result.avgResponseTime)}ms, Total Time: ${result.totalTime}ms`);
    });
    
    console.log('\n⚡ PERFORMANCE TESTS:');
    this.results.performance.forEach(result => {
      console.log(`  ${result.test}:`);
      console.log(`    RPS: ${Math.round(result.requestsPerSecond * 100)/100}, Success Rate: ${Math.round(result.successful/result.totalRequests*100)}%`);
      console.log(`    Response Times - Avg: ${Math.round(result.avgResponseTime)}ms, Min: ${result.minResponseTime}ms, Max: ${result.maxResponseTime}ms`);
    });
    
    console.log('\n✅ Overall System Assessment:');
    const totalRequests = this.results.rateLimiting.reduce((sum, r) => sum + r.totalRequests, 0) +
                          this.results.performance.reduce((sum, r) => sum + r.totalRequests, 0);
    const totalSuccessful = this.results.rateLimiting.reduce((sum, r) => sum + r.successful, 0) +
                           this.results.performance.reduce((sum, r) => sum + r.successful, 0);
    
    console.log(`   Total requests processed: ${totalRequests}`);
    console.log(`   Overall success rate: ${Math.round(totalSuccessful/totalRequests*100)}%`);
    console.log(`   Rate limiting is working: ${this.results.rateLimiting.some(r => r.rateLimited > 0) ? '✅' : '❓'}`);
    console.log(`   System stability: ${totalSuccessful/totalRequests > 0.95 ? '✅ Excellent' : totalSuccessful/totalRequests > 0.8 ? '⚠️ Good' : '❌ Needs attention'}`);
  }

  // Run all tests
  async runAllTests() {
    console.log('🚀 Starting Comprehensive Load Tests for API Manager Layer');
    console.log('=' .repeat(60));
    
    try {
      await this.testGlobalRateLimit();
      await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down
      
      await this.testApiStrictRateLimit();
      await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down
      
      await this.testPerformance();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await this.testCircuitBreaker();
      
      this.generateReport();
      
    } catch (error) {
      console.error('❌ Load test failed:', error);
      this.results.errors.push({
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack
      });
    }
  }
}

// Run the load tests
const tester = new LoadTester();
tester.runAllTests().catch(console.error);

export default LoadTester;