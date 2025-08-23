import { GenerationStatusCard } from "./GenerationStatusCard";
import type { GenerationStatus } from "./GenerationStatusManager";

interface FloatingStatusPanelProps {
  generations: GenerationStatus[];
  onDismiss: (id: string) => void;
  onToggleMinimize: (id: string) => void;
  onRetry: (taskId: string) => void;
}

export function FloatingStatusPanel({
  generations,
  onDismiss,
  onToggleMinimize,
  onRetry,
}: FloatingStatusPanelProps) {
  if (generations.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-4 right-4 z-50 max-w-sm w-full space-y-3 pointer-events-none">
      <div className="space-y-2 pointer-events-auto">
        {generations.map((generation, index) => (
          <div
            key={generation.id}
            className="animate-in slide-in-from-right-full duration-300 ease-out"
            style={{
              animationDelay: `${index * 100}ms`,
            }}
          >
            <GenerationStatusCard
              id={generation.id}
              taskId={generation.taskId}
              status={generation.status}
              errorMessage={generation.errorMessage}
              errorDetails={generation.errorDetails}
              errorType={generation.errorType}
              retryCount={generation.retryCount}
              maxRetries={generation.maxRetries}
              nextRetryAt={generation.nextRetryAt}
              webhookResponseStatus={generation.webhookResponseStatus}
              webhookResponseBody={generation.webhookResponseBody}
              startTime={generation.startTime}
              isMinimized={generation.isMinimized}
              onDismiss={onDismiss}
              onToggleMinimize={onToggleMinimize}
              onRetry={onRetry}
              className="shadow-xl"
            />
          </div>
        ))}
      </div>
      
      {/* Backdrop for completed generations indicator */}
      {generations.some(g => g.status === "completed" || g.status === "200" || g.status === "failed") && (
        <div className="text-center pointer-events-auto space-y-1">
          {generations.some(g => g.status === "completed" || g.status === "200") && (
            <div className="inline-flex items-center space-x-2 bg-green-100 text-green-700 text-xs px-3 py-1 rounded-full border border-green-200">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
              <span>
                {generations.filter(g => g.status === "completed" || g.status === "200").length} completed
              </span>
            </div>
          )}
          {generations.some(g => g.status === "failed") && (
            <div className="inline-flex items-center space-x-2 bg-red-100 text-red-700 text-xs px-3 py-1 rounded-full border border-red-200">
              <div className="w-1.5 h-1.5 bg-red-500 rounded-full"></div>
              <span>
                {generations.filter(g => g.status === "failed").length} failed
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}