import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Loader2, Clock, X, Minimize2, Maximize2, RefreshCw, AlertTriangle, Info } from "lucide-react";
import type { GenerationStatusResponse } from "@shared/types";

interface GenerationStatusCardProps {
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
  onDismiss: (id: string) => void;
  onToggleMinimize: (id: string) => void;
  onRetry: (taskId: string) => void;
  className?: string;
}

export function GenerationStatusCard({
  id,
  taskId,
  status,
  errorMessage,
  errorDetails,
  errorType,
  retryCount,
  maxRetries,
  nextRetryAt,
  webhookResponseStatus,
  webhookResponseBody,
  startTime,
  isMinimized,
  onDismiss,
  onToggleMinimize,
  onRetry,
  className = ""
}: GenerationStatusCardProps) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [finalElapsedTime, setFinalElapsedTime] = useState<number | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [previousStatus, setPreviousStatus] = useState<string>(status);

  // Update elapsed time every second
  useEffect(() => {
    const isCompleted = status === "completed" || status === "200" || status === "failed";
    
    if (isCompleted) {
      // Capture final elapsed time when status becomes final and ensure it's displayed
      if (finalElapsedTime === null) {
        const finalTime = Math.floor((new Date().getTime() - startTime.getTime()) / 1000);
        setFinalElapsedTime(finalTime);
        setElapsedTime(finalTime);
        
        // Force one final update to ensure the timer shows the completion time
        setTimeout(() => {
          setElapsedTime(finalTime);
        }, 100);
      }
      return;
    }

    // Reset final time if status changes back to pending/processing (e.g., retry)
    if (finalElapsedTime !== null) {
      setFinalElapsedTime(null);
    }

    const interval = setInterval(() => {
      const now = new Date();
      const elapsed = Math.floor((now.getTime() - startTime.getTime()) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [status, startTime, finalElapsedTime]);

  // Detect status changes and ensure completion is handled
  useEffect(() => {
    const isCompleted = status === "completed" || status === "200" || status === "failed";
    const wasNotCompleted = previousStatus !== "completed" && previousStatus !== "200" && previousStatus !== "failed";
    
    // If status changed to completed and we haven't captured final time yet
    if (isCompleted && wasNotCompleted && finalElapsedTime === null) {
      const finalTime = Math.floor((new Date().getTime() - startTime.getTime()) / 1000);
      setFinalElapsedTime(finalTime);
      setElapsedTime(finalTime);
    }
    
    setPreviousStatus(status);
  }, [status, previousStatus, startTime, finalElapsedTime]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatGenerationTime = (startTime: Date): string => {
    // Use final elapsed time if available, otherwise calculate from current time
    const totalSeconds = finalElapsedTime !== null 
      ? finalElapsedTime 
      : Math.floor((new Date().getTime() - startTime.getTime()) / 1000);
    
    if (totalSeconds < 60) {
      return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`;
    } else {
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      
      if (secs === 0) {
        return `${mins} minute${mins !== 1 ? 's' : ''}`;
      } else {
        return `${mins} minute${mins !== 1 ? 's' : ''} and ${secs} second${secs !== 1 ? 's' : ''}`;
      }
    }
  };

  const canRetry = (): boolean => {
    if (status !== "failed") return false;
    const currentRetryCount = parseInt(retryCount || "0");
    const maxRetryCount = parseInt(maxRetries || "3");
    return currentRetryCount < maxRetryCount;
  };

  const getErrorTypeDisplayName = (type: string | null | undefined): string => {
    switch (type) {
      case "webhook_failure": return "Service Error";
      case "network_error": return "Network Error";
      case "timeout": return "Timeout Error";
      case "validation_error": return "Validation Error";
      case "unknown": return "Unknown Error";
      default: return "Error";
    }
  };

  const getNextRetryTime = (): string | null => {
    if (!nextRetryAt) return null;
    try {
      const retryTime = new Date(nextRetryAt);
      const now = new Date();
      const diffMs = retryTime.getTime() - now.getTime();
      
      if (diffMs <= 0) return "Now";
      
      const diffSecs = Math.ceil(diffMs / 1000);
      if (diffSecs < 60) return `${diffSecs}s`;
      
      const diffMins = Math.ceil(diffSecs / 60);
      return `${diffMins}m`;
    } catch {
      return null;
    }
  };

  const getStatusContent = () => {
    switch (status) {
      case "pending":
        return {
          icon: <Clock className="h-5 w-5 text-blue-500" />,
          title: "Preparing",
          message: "Your request is being prepared...",
          showTimer: false,
          bgColor: "bg-blue-50",
          borderColor: "border-blue-200",
          textColor: "text-blue-700",
        };
      case "processing":
        return {
          icon: <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />,
          title: "Generating",
          message: "Video is being generated...",
          showTimer: true,
          bgColor: "bg-blue-50",
          borderColor: "border-blue-200",
          textColor: "text-blue-700",
        };
      case "completed":
      case "200":
        return {
          icon: <CheckCircle className="h-5 w-5 text-green-500" />,
          title: "Completed",
          message: `Generated in ${formatGenerationTime(startTime)}`,
          showTimer: false,
          bgColor: "bg-green-50",
          borderColor: "border-green-200",
          textColor: "text-green-700",
        };
      case "failed":
        // Check for content policy failure (error message "400")
        if (errorMessage === "400") {
          // Use final elapsed time to ensure consistent display
          const displayTime = finalElapsedTime !== null ? finalElapsedTime : elapsedTime;
          const minutes = Math.floor(displayTime / 60);
          const seconds = displayTime % 60;
          const timeStr = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
          
          return {
            icon: <AlertTriangle className="h-5 w-5 text-amber-500" />,
            title: "Content Policy Violation",
            message: `Job has failed at ${timeStr} likely due to Google's content policy. Try your request again.`,
            showTimer: false,
            bgColor: "bg-amber-50",
            borderColor: "border-amber-200",
            textColor: "text-amber-700",
          };
        }
        
        const retryInfo = canRetry() ? ` (${retryCount || 0}/${maxRetries || 3} attempts)` : " (Max retries exceeded)";
        const errorTypeDisplay = errorType ? getErrorTypeDisplayName(errorType) : "Error";
        
        return {
          icon: <XCircle className="h-5 w-5 text-red-500" />,
          title: `${errorTypeDisplay}${retryInfo}`,
          message: errorMessage || "Generation failed",
          showTimer: false,
          bgColor: "bg-red-50",
          borderColor: "border-red-200",
          textColor: "text-red-700",
        };
      default:
        return {
          icon: <Clock className="h-5 w-5 text-gray-500" />,
          title: "Unknown",
          message: "Checking status...",
          showTimer: false,
          bgColor: "bg-gray-50",
          borderColor: "border-gray-200",
          textColor: "text-gray-700",
        };
    }
  };

  const statusContent = getStatusContent();
  const canDismiss = status === "completed" || status === "200" || status === "failed";

  if (isMinimized) {
    return (
      <Card className={`${statusContent.bgColor} ${statusContent.borderColor} border-2 shadow-lg ${className}`}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {statusContent.icon}
              <span className={`text-sm font-medium ${statusContent.textColor}`}>
                {statusContent.title}
              </span>
              {statusContent.showTimer && (
                <span className="font-mono text-sm">
                  {formatTime(finalElapsedTime !== null ? finalElapsedTime : elapsedTime)}
                </span>
              )}
            </div>
            <div className="flex items-center space-x-1">
              {status === "failed" && canRetry() && errorMessage !== "400" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-white/50"
                  onClick={() => onRetry(taskId)}
                  title="Retry generation"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:bg-white/50"
                onClick={() => onToggleMinimize(id)}
              >
                <Maximize2 className="h-3 w-3" />
              </Button>
              {canDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-white/50"
                  onClick={() => onDismiss(id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={`${statusContent.bgColor} ${statusContent.borderColor} border-2 shadow-lg ${className}`}>
      <CardContent className="p-4">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {statusContent.icon}
              <span className={`font-medium ${statusContent.textColor}`}>
                {statusContent.title}
              </span>
            </div>
            <div className="flex items-center space-x-1">
              {status === "failed" && canRetry() && errorMessage !== "400" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-white/50"
                  onClick={() => onRetry(taskId)}
                  title="Retry generation"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              )}
              {status === "failed" && (errorDetails || webhookResponseBody) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-white/50"
                  onClick={() => setShowErrorDetails(!showErrorDetails)}
                  title={showErrorDetails ? "Hide error details" : "Show error details"}
                >
                  <Info className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:bg-white/50"
                onClick={() => onToggleMinimize(id)}
              >
                <Minimize2 className="h-3 w-3" />
              </Button>
              {canDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 hover:bg-white/50"
                  onClick={() => onDismiss(id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Message */}
          <p className={`text-sm ${statusContent.textColor}`}>
            {statusContent.message}
          </p>

          {/* Timer */}
          {statusContent.showTimer && (
            <div className="flex items-center justify-center">
              <div className="inline-flex items-center space-x-2 bg-white/70 rounded-lg px-3 py-1">
                <Clock className="h-3 w-3 text-slate-500" />
                <span className="font-mono text-sm font-medium text-slate-700">
                  {formatTime(finalElapsedTime !== null ? finalElapsedTime : elapsedTime)}
                </span>
              </div>
            </div>
          )}

          {/* Retry information for failed generations */}
          {status === "failed" && errorMessage !== "400" && (
            <div className="space-y-2">
              {/* Retry controls */}
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-600">
                  Attempts: {retryCount || 0}/{maxRetries || 3}
                </div>
                {canRetry() && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRetry(taskId)}
                    className="h-7 px-2 text-xs"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry Now
                  </Button>
                )}
              </div>
              
              {/* Next retry info */}
              {nextRetryAt && getNextRetryTime() && (
                <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
                  Next retry in: {getNextRetryTime()}
                </div>
              )}
              
              {/* Webhook response status */}
              {webhookResponseStatus && (
                <div className="text-xs text-slate-600">
                  Response Status: {webhookResponseStatus}
                </div>
              )}
            </div>
          )}

          {/* Error details expandable section */}
          {status === "failed" && showErrorDetails && (errorDetails || webhookResponseBody) && (
            <div className="mt-3 p-3 bg-slate-50 rounded border">
              <div className="text-xs font-medium text-slate-700 mb-2">Error Details</div>
              
              {errorDetails && (
                <div className="space-y-2">
                  <div className="text-xs text-slate-600">
                    <strong>Type:</strong> {getErrorTypeDisplayName(errorType)}
                  </div>
                  <div className="text-xs text-slate-600 break-all">
                    <strong>Details:</strong> {JSON.stringify(errorDetails, null, 2)}
                  </div>
                </div>
              )}
              
              {webhookResponseBody && (
                <div className="mt-2">
                  <div className="text-xs text-slate-600">
                    <strong>Webhook Response:</strong>
                  </div>
                  <div className="text-xs text-slate-500 bg-white p-2 rounded border mt-1 max-h-20 overflow-y-auto break-all">
                    {webhookResponseBody}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Task ID for reference */}
          <div className="text-xs text-slate-500 truncate">
            ID: {taskId.substring(0, 8)}...
          </div>
        </div>
      </CardContent>
    </Card>
  );
}