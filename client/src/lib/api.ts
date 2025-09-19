import { apiRequest } from "./queryClient";
import type { UploadResponse, GenerationCreateRequest, GenerationStatusResponse, RetryGenerationRequest, RetryGenerationResponse } from "@shared/types";

export const api = {
  // Upload file
  uploadFile: async (file: File): Promise<UploadResponse> => {
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${errorText}`);
    }

    return response.json();
  },

  // Create video generation
  createGeneration: async (data: GenerationCreateRequest) => {
    console.log('🎬 === CLIENT: CREATING VIDEO GENERATION ===');
    console.log('📋 Request Data:', JSON.stringify(data, null, 2));
    console.log('🕐 Timestamp:', new Date().toISOString());
    console.log('📍 Endpoint: POST /api/generations');

    // Show the complete URL being called
    const fullUrl = `${window.location.origin}/api/generations`;
    console.log('🌐 COMPLETE CLIENT URL:', fullUrl);
    console.log('🏠 Origin:', window.location.origin);
    console.log('🛤️  Relative path:', '/api/generations');
    console.log('===============================================');

    const startTime = Date.now();
    try {
      const response = await apiRequest('POST', '/api/generations', data);
      const duration = Date.now() - startTime;
      const result = await response.json();

      console.log('✅ === CLIENT: GENERATION REQUEST SUCCESS ===');
      console.log('⏱️ Duration:', duration, 'ms');
      console.log('📨 Response Status:', response.status);
      console.log('📋 Response Data:', JSON.stringify(result, null, 2));
      console.log('🕐 Completed at:', new Date().toISOString());
      console.log('============================================');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      console.error('❌ === CLIENT: GENERATION REQUEST FAILED ===');
      console.error('⏱️ Duration:', duration, 'ms');
      console.error('🚫 Error:', error);
      console.error('📋 Original Request Data:', JSON.stringify(data, null, 2));
      console.error('🕐 Failed at:', new Date().toISOString());
      console.error('===========================================');

      throw error;
    }
  },

  // Get completed generations
  getGenerations: async () => {
    const response = await apiRequest('GET', '/api/generations?onlyCompleted=true');
    return response.json();
  },

  // Get single generation
  getGeneration: async (id: string) => {
    const response = await apiRequest('GET', `/api/generations/${id}`);
    return response.json();
  },

  // Get generation status by taskId
  getGenerationStatus: async (taskId: string): Promise<GenerationStatusResponse> => {
    const response = await apiRequest('GET', `/api/generations/status/${taskId}`);
    return response.json();
  },

  // Retry failed generation
  retryGeneration: async (data: RetryGenerationRequest): Promise<RetryGenerationResponse> => {
    console.log('🔄 === CLIENT: RETRYING GENERATION ===');
    console.log('📋 Retry Data:', JSON.stringify(data, null, 2));
    console.log('🕐 Timestamp:', new Date().toISOString());
    console.log('📍 Endpoint: POST /api/generations/retry');
    console.log('=====================================');

    const startTime = Date.now();
    try {
      const response = await apiRequest('POST', '/api/generations/retry', data);
      const duration = Date.now() - startTime;
      const result = await response.json();

      console.log('✅ === CLIENT: RETRY REQUEST SUCCESS ===');
      console.log('⏱️ Duration:', duration, 'ms');
      console.log('📨 Response Status:', response.status);
      console.log('📋 Response Data:', JSON.stringify(result, null, 2));
      console.log('🕐 Completed at:', new Date().toISOString());
      console.log('======================================');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      console.error('❌ === CLIENT: RETRY REQUEST FAILED ===');
      console.error('⏱️ Duration:', duration, 'ms');
      console.error('🚫 Error:', error);
      console.error('📋 Original Retry Data:', JSON.stringify(data, null, 2));
      console.error('🕐 Failed at:', new Date().toISOString());
      console.error('=====================================');

      throw error;
    }
  }
};
