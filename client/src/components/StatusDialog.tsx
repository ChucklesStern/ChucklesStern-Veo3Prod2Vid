import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Loader2, Clock } from "lucide-react";
import type { GenerationStatusResponse } from "@shared/types";

interface StatusDialogProps {
  isOpen: boolean;
  onClose: () => void;
  status: GenerationStatusResponse["status"];
  errorMessage?: string | null;
  startTime: Date;
}

export function StatusDialog({ isOpen, onClose, status, errorMessage, startTime }: StatusDialogProps) {
  const [elapsedTime, setElapsedTime] = useState(0);

  // Update elapsed time every second
  useEffect(() => {
    if (!isOpen || status === "completed" || status === "200" || status === "failed") {
      return;
    }

    const interval = setInterval(() => {
      const now = new Date();
      const elapsed = Math.floor((now.getTime() - startTime.getTime()) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen, status, startTime]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusContent = () => {
    switch (status) {
      case "pending":
        return {
          icon: <Clock className="h-8 w-8 text-blue-500" />,
          title: "Preparing Video Generation",
          message: "Your request is being prepared...",
          showTimer: false,
          canClose: false,
        };
      case "processing":
        return {
          icon: <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />,
          title: "Video is Generating",
          message: "Please wait while your video is being generated...",
          showTimer: true,
          canClose: false,
        };
      case "completed":
      case "200":
        return {
          icon: <CheckCircle className="h-8 w-8 text-green-500" />,
          title: "Video Successfully Generated!",
          message: "Your video has been created and is now available in the results panel.",
          showTimer: false,
          canClose: true,
        };
      case "failed":
        return {
          icon: <XCircle className="h-8 w-8 text-red-500" />,
          title: "Video Generation Failed",
          message: errorMessage || "An error occurred while generating your video. Please try again.",
          showTimer: false,
          canClose: true,
        };
      default:
        return {
          icon: <Clock className="h-8 w-8 text-gray-500" />,
          title: "Unknown Status",
          message: "Checking status...",
          showTimer: false,
          canClose: true,
        };
    }
  };

  const statusContent = getStatusContent();

  return (
    <Dialog open={isOpen} onOpenChange={statusContent.canClose ? onClose : undefined}>
      <DialogContent className={`sm:max-w-md ${!statusContent.canClose ? '[&>button]:hidden' : ''}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-3">
            {statusContent.icon}
            <span>{statusContent.title}</span>
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <p className="text-slate-600 text-center">
            {statusContent.message}
          </p>
          
          {statusContent.showTimer && (
            <div className="text-center">
              <div className="inline-flex items-center space-x-2 bg-slate-100 rounded-lg px-4 py-2">
                <Clock className="h-4 w-4 text-slate-500" />
                <span className="font-mono text-lg font-medium text-slate-700">
                  {formatTime(elapsedTime)}
                </span>
              </div>
            </div>
          )}
        </div>

        {statusContent.canClose && (
          <div className="flex justify-center">
            <Button onClick={onClose} className="w-full sm:w-auto">
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}