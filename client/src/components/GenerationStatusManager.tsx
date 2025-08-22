import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import type { GenerationStatusResponse } from "@shared/types";

export interface GenerationStatus {
  id: string;
  taskId: string;
  status: GenerationStatusResponse["status"];
  errorMessage?: string | null;
  errorDetails?: any;
  errorType?: "webhook_failure" | "network_error" | "timeout" | "validation_error" | "unknown" | null;
  retryCount?: string | null;
  maxRetries?: string | null;
  nextRetryAt?: string | null;
  webhookResponseStatus?: string | null;
  webhookResponseBody?: string | null;
  startTime: Date;
  isMinimized: boolean;
}

interface GenerationStatusManagerProps {
  children: (props: {
    generations: GenerationStatus[];
    addGeneration: (taskId: string) => void;
    dismissGeneration: (id: string) => void;
    toggleMinimize: (id: string) => void;
    retryGeneration: (taskId: string) => void;
  }) => React.ReactNode;
}

export function GenerationStatusManager({ children }: GenerationStatusManagerProps) {
  const [generations, setGenerations] = useState<GenerationStatus[]>([]);
  const [pollingIntervals, setPollingIntervals] = useState<Map<string, NodeJS.Timeout>>(new Map());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      pollingIntervals.forEach(interval => clearInterval(interval));
    };
  }, [pollingIntervals]);

  const pollGenerationStatus = useCallback(async (generationId: string, taskId: string) => {
    try {
      const status = await api.getGenerationStatus(taskId);
      
      setGenerations(prev => prev.map(gen => 
        gen.id === generationId 
          ? { 
              ...gen, 
              status: status.status, 
              errorMessage: status.errorMessage,
              errorDetails: status.errorDetails,
              errorType: status.errorType,
              retryCount: status.retryCount,
              maxRetries: status.maxRetries,
              nextRetryAt: status.nextRetryAt,
              webhookResponseStatus: status.webhookResponseStatus,
              webhookResponseBody: status.webhookResponseBody
            }
          : gen
      ));

      // Check if generation is complete
      if (status.status === "completed" || status.status === "200" || status.status === "failed") {
        // Stop polling for this generation
        const interval = pollingIntervals.get(generationId);
        if (interval) {
          clearInterval(interval);
          setPollingIntervals(prev => {
            const newMap = new Map(prev);
            newMap.delete(generationId);
            return newMap;
          });
        }
        
        // Show completion notification
        const generation = generations.find(g => g.id === generationId);
        if (generation) {
          if (status.status === "completed" || status.status === "200") {
            toast({
              title: "Video Generated!",
              description: `Your video generation completed successfully.`,
              duration: 5000,
            });
          } else {
            toast({
              title: "Generation Failed",
              description: status.errorMessage || "Video generation failed. Please try again.",
              variant: "destructive",
              duration: 5000,
            });
          }
        }
        
        // Refresh the completed videos list
        queryClient.invalidateQueries({ queryKey: ['/api/generations'] });
      }
    } catch (error) {
      console.error('Error polling status:', error);
      // Continue polling even if there's an error, but we could add retry logic here
    }
  }, [queryClient, toast, pollingIntervals, generations]);

  const addGeneration = useCallback((taskId: string) => {
    const generationId = `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const newGeneration: GenerationStatus = {
      id: generationId,
      taskId,
      status: "pending",
      startTime: new Date(),
      isMinimized: false,
    };

    setGenerations(prev => [newGeneration, ...prev]);

    // Start polling for this generation
    const interval = setInterval(() => {
      pollGenerationStatus(generationId, taskId);
    }, 3000);

    setPollingIntervals(prev => new Map(prev).set(generationId, interval));
  }, [pollGenerationStatus]);

  const dismissGeneration = useCallback((id: string) => {
    // Clear polling interval
    const interval = pollingIntervals.get(id);
    if (interval) {
      clearInterval(interval);
      setPollingIntervals(prev => {
        const newMap = new Map(prev);
        newMap.delete(id);
        return newMap;
      });
    }

    // Remove from state
    setGenerations(prev => prev.filter(gen => gen.id !== id));
  }, [pollingIntervals]);

  const toggleMinimize = useCallback((id: string) => {
    setGenerations(prev => prev.map(gen => 
      gen.id === id 
        ? { ...gen, isMinimized: !gen.isMinimized }
        : gen
    ));
  }, []);

  const retryGeneration = useCallback(async (taskId: string) => {
    try {
      const result = await api.retryGeneration({ taskId });
      
      if (result.success) {
        toast({
          title: "Retry Successful",
          description: result.message,
          duration: 5000,
        });
        
        // Update status to pending and restart polling
        setGenerations(prev => prev.map(gen => 
          gen.taskId === taskId 
            ? { ...gen, status: "pending", errorMessage: null, errorDetails: null }
            : gen
        ));
        
        // Find the generation and restart polling
        const generation = generations.find(g => g.taskId === taskId);
        if (generation) {
          const interval = setInterval(() => {
            pollGenerationStatus(generation.id, taskId);
          }, 3000);
          setPollingIntervals(prev => new Map(prev).set(generation.id, interval));
        }
      } else {
        toast({
          title: "Retry Failed",
          description: result.message,
          variant: "destructive",
          duration: 5000,
        });
      }
    } catch (error) {
      console.error('Retry error:', error);
      toast({
        title: "Retry Error",
        description: "Failed to retry generation. Please try again.",
        variant: "destructive",
        duration: 5000,
      });
    }
  }, [api, toast, generations, pollGenerationStatus]);

  return (
    <>
      {children({
        generations,
        addGeneration,
        dismissGeneration,
        toggleMinimize,
        retryGeneration,
      })}
    </>
  );
}