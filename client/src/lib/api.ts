import { apiRequest } from "./queryClient";
import type { UploadResponse, GenerationCreateRequest, GenerationStatusResponse } from "@shared/types";

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
    const response = await apiRequest('POST', '/api/generations', data);
    return response.json();
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
  }
};
