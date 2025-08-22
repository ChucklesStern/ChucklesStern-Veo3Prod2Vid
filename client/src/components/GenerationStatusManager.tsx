import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useNotificationSound } from "@/lib/notification-sound";
import { useTabIndicators } from "@/hooks/use-tab-indicators";
import { useNotificationPreferences } from "@/contexts/NotificationPreferences";
import { api } from "@/lib/api";
import type { GenerationStatusResponse } from "@shared/types";
import { Button } from "@/components/ui/button";

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
  endTime?: Date;
  isMinimized: boolean;
  hasNotified: boolean; // Track if we've already notified for this completion
}

interface CompletedGeneration {
  id: string;
  taskId: string;
  status: "completed" | "200" | "failed";
  endTime: Date;
  duration: number; // in seconds
  isSuccess: boolean;
  isContentPolicy?: boolean;
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
  const [pendingNotifications, setPendingNotifications] = useState<CompletedGeneration[]>([]);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { showNotification, requestPermission, permission } = useBrowserNotifications();
  const { isVisible, isHidden } = useTabVisibility();
  const { playSound } = useNotificationSound();
  const { updateFaviconBadge, updateTabTitle, clearIndicators } = useTabIndicators();
  const { preferences } = useNotificationPreferences();
  
  const batchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      pollingIntervals.forEach(interval => clearInterval(interval));
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current);
      }
    };
  }, [pollingIntervals]);

  // Update tab indicators based on active generations
  useEffect(() => {
    const activeCount = generations.filter(g => 
      g.status === "pending" || g.status === "processing"
    ).length;
    
    if (preferences.showFaviconBadge) {
      updateFaviconBadge(activeCount);
    }
    
    if (preferences.updateTabTitle) {
      if (activeCount > 0) {
        updateTabTitle(`(${activeCount}) Generating`);
      } else {
        updateTabTitle();
      }
    }
  }, [generations, preferences.showFaviconBadge, preferences.updateTabTitle, updateFaviconBadge, updateTabTitle]);

  // Handle completed generation notifications
  const handleCompletedGeneration = useCallback((completed: CompletedGeneration) => {
    const shouldNotify = preferences.onlyNotifyWhenTabHidden ? isHidden : true;
    
    if (!shouldNotify) return;

    if (preferences.batchNotifications) {
      setPendingNotifications(prev => [...prev, completed]);
      
      // Clear existing timeout
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current);
      }
      
      // Set new timeout for batch processing
      batchTimeoutRef.current = setTimeout(() => {
        processBatchedNotifications();
      }, preferences.batchTimeoutMs);
    } else {
      // Send individual notification immediately
      sendNotification([completed]);
    }
  }, [preferences, isHidden]);

  const processBatchedNotifications = useCallback(() => {
    setPendingNotifications(prev => {
      if (prev.length === 0) return prev;
      
      const batch = prev.slice(0, preferences.maxNotificationsPerBatch);
      const remaining = prev.slice(preferences.maxNotificationsPerBatch);
      
      sendNotification(batch);
      
      // If there are remaining notifications, schedule another batch
      if (remaining.length > 0) {
        batchTimeoutRef.current = setTimeout(() => {
          setPendingNotifications(remaining);
          processBatchedNotifications();
        }, 1000); // 1 second delay between batches
      }
      
      return remaining;
    });
  }, [preferences.maxNotificationsPerBatch]);

  const sendNotification = useCallback((completedGenerations: CompletedGeneration[]) => {
    const successCount = completedGenerations.filter(g => g.isSuccess).length;
    const failureCount = completedGenerations.length - successCount;
    
    // Play sound notification
    if (preferences.enableSounds) {
      if (failureCount > 0) {
        playSound({ type: "error", volume: preferences.soundVolume });
      } else {
        playSound({ type: "success", volume: preferences.soundVolume });
      }
    }

    // Show toast notification
    if (preferences.showToastNotifications) {
      const isSuccess = failureCount === 0;
      const contentPolicyCount = completedGenerations.filter(g => g.isContentPolicy).length;
      
      let title: string;
      let description: string;
      
      if (completedGenerations.length === 1) {
        const gen = completedGenerations[0];
        if (gen.isContentPolicy) {
          title = "Content Policy Violation";
          const minutes = Math.floor(gen.duration / 60);
          const seconds = gen.duration % 60;
          const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          description = `Job failed at ${timeStr} likely due to Google's content policy. Try your request again.`;
        } else {
          title = isSuccess ? "Video Generated!" : "Generation Failed";
          description = isSuccess 
            ? `Video generation completed in ${gen.duration}s`
            : "Generation failed. Check the status panel for details.";
        }
      } else {
        title = `${completedGenerations.length} Videos ${isSuccess ? "Completed" : "Finished"}`;
        
        if (contentPolicyCount > 0) {
          if (contentPolicyCount === completedGenerations.length) {
            description = `All ${contentPolicyCount} generations failed due to content policy violations`;
          } else {
            description = `${successCount} succeeded, ${failureCount} failed (${contentPolicyCount} content policy violations)`;
          }
        } else {
          if (failureCount === 0) {
            description = `All ${successCount} video generations completed successfully`;
          } else if (successCount === 0) {
            description = `All ${failureCount} video generations failed`;
          } else {
            description = `${successCount} succeeded, ${failureCount} failed`;
          }
        }
      }

      const toastResult = toast({
        title,
        description,
        variant: isSuccess ? "default" : "destructive",
        duration: 8000,
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Scroll to results section
              const resultsSection = document.querySelector('[data-results-section]');
              if (resultsSection) {
                resultsSection.scrollIntoView({ behavior: 'smooth' });
              }
              toastResult.dismiss();
            }}
          >
            View Results
          </Button>
        ),
      });
    }

    // Show browser notification
    if (preferences.showBrowserNotifications && permission === "granted") {
      const isSuccess = failureCount === 0;
      const contentPolicyCount = completedGenerations.filter(g => g.isContentPolicy).length;
      
      let title: string;
      let body: string;
      
      if (completedGenerations.length === 1) {
        const gen = completedGenerations[0];
        if (gen.isContentPolicy) {
          title = "Content Policy Violation";
          const minutes = Math.floor(gen.duration / 60);
          const seconds = gen.duration % 60;
          const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          body = `Job failed at ${timeStr} likely due to Google's content policy`;
        } else {
          title = isSuccess ? "Video Generated!" : "Generation Failed";
          body = isSuccess 
            ? `Your video generation completed successfully in ${gen.duration}s`
            : "Your video generation failed. Click to view details.";
        }
      } else {
        title = `${completedGenerations.length} Videos ${isSuccess ? "Completed" : "Finished"}`;
        
        if (contentPolicyCount > 0) {
          if (contentPolicyCount === completedGenerations.length) {
            body = `All ${contentPolicyCount} generations failed due to content policy violations`;
          } else {
            body = `${successCount} succeeded, ${failureCount} failed (${contentPolicyCount} content policy)`;
          }
        } else {
          if (failureCount === 0) {
            body = `All ${successCount} video generations completed successfully`;
          } else if (successCount === 0) {
            body = `All ${failureCount} video generations failed`;
          } else {
            body = `${successCount} succeeded, ${failureCount} failed`;
          }
        }
      }

      showNotification({
        title,
        body,
        icon: "/favicon.ico",
        tag: "video-generation",
        requireInteraction: false,
        data: { completedGenerations },
      });
    }
  }, [preferences, toast, playSound, showNotification, permission]);

  const pollGenerationStatus = useCallback(async (generationId: string, taskId: string) => {
    try {
      const status = await api.getGenerationStatus(taskId);
      let shouldNotify = false;
      let completedGeneration: CompletedGeneration | null = null;
      
      setGenerations(prev => prev.map(gen => {
        if (gen.id === generationId) {
          const wasCompleted = gen.status === "completed" || gen.status === "200" || gen.status === "failed";
          const isNowCompleted = status.status === "completed" || status.status === "200" || status.status === "failed";
          
          // Check for content policy failure (error message "400")
          const isContentPolicyFailure = status.errorMessage === "400";
          
          // If content policy failure detected, force completion and stop timer
          if (isContentPolicyFailure && !wasCompleted) {
            shouldNotify = true;
            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - gen.startTime.getTime()) / 1000);
            
            completedGeneration = {
              id: gen.id,
              taskId: gen.taskId,
              status: "failed" as const,
              endTime,
              duration,
              isSuccess: false,
              isContentPolicy: true,
            };
            
            // Immediately stop polling for this generation - this prevents timer race conditions
            const interval = pollingIntervals.get(generationId);
            if (interval) {
              clearInterval(interval);
              setPollingIntervals(prev => {
                const newMap = new Map(prev);
                newMap.delete(generationId);
                return newMap;
              });
            }
          }
          // Check if this is a new completion that we haven't notified about
          else if (!wasCompleted && isNowCompleted && !gen.hasNotified) {
            shouldNotify = true;
            const endTime = new Date();
            const duration = Math.round((endTime.getTime() - gen.startTime.getTime()) / 1000);
            const isSuccess = status.status === "completed" || status.status === "200";
            
            completedGeneration = {
              id: gen.id,
              taskId: gen.taskId,
              status: status.status as "completed" | "200" | "failed",
              endTime,
              duration,
              isSuccess,
            };
            
            // Immediately stop polling for this generation to prevent timer race conditions
            const interval = pollingIntervals.get(generationId);
            if (interval) {
              clearInterval(interval);
              setPollingIntervals(prev => {
                const newMap = new Map(prev);
                newMap.delete(generationId);
                return newMap;
              });
            }
          }
          
          return { 
            ...gen, 
            status: status.status, 
            errorMessage: status.errorMessage,
            errorDetails: status.errorDetails,
            errorType: status.errorType,
            retryCount: status.retryCount,
            maxRetries: status.maxRetries,
            nextRetryAt: status.nextRetryAt,
            webhookResponseStatus: status.webhookResponseStatus,
            webhookResponseBody: status.webhookResponseBody,
            endTime: isNowCompleted && !gen.endTime ? new Date() : gen.endTime,
            hasNotified: isNowCompleted || gen.hasNotified,
          };
        }
        return gen;
      }));

      // Handle completion notifications
      if (shouldNotify && completedGeneration) {
        handleCompletedGeneration(completedGeneration);
      }

      // Check if generation is complete and stop polling (only if not already stopped above)
      if ((status.status === "completed" || status.status === "200" || status.status === "failed") && 
          pollingIntervals.has(generationId)) {
        const interval = pollingIntervals.get(generationId);
        if (interval) {
          clearInterval(interval);
          setPollingIntervals(prev => {
            const newMap = new Map(prev);
            newMap.delete(generationId);
            return newMap;
          });
        }
        
        // Refresh the completed videos list to ensure UI consistency
        queryClient.invalidateQueries({ queryKey: ['/api/generations'] });
      }
    } catch (error) {
      console.error('Error polling status:', error);
      // Continue polling even if there's an error, but we could add retry logic here
    }
  }, [queryClient, pollingIntervals, handleCompletedGeneration]);

  const addGeneration = useCallback((taskId: string) => {
    const generationId = `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const newGeneration: GenerationStatus = {
      id: generationId,
      taskId,
      status: "pending",
      startTime: new Date(),
      isMinimized: false,
      hasNotified: false,
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
            ? { 
                ...gen, 
                status: "pending", 
                errorMessage: null, 
                errorDetails: null,
                hasNotified: false,
                endTime: undefined
              }
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