import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Video, LogIn } from "lucide-react";

interface ProtectedAppProps {
  children: React.ReactNode;
}

export function ProtectedApp({ children }: ProtectedAppProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <div className="w-12 h-12 bg-gradient-to-br from-primary to-primary/80 rounded-lg flex items-center justify-center">
                <Video className="text-white" size={24} />
              </div>
              <div className="text-center">
                <h2 className="text-xl font-semibold text-slate-900">Loading...</h2>
                <p className="text-slate-600 mt-1">Checking authentication status</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-gradient-to-br from-primary to-primary/80 rounded-lg flex items-center justify-center">
                <Video className="text-white" size={32} />
              </div>
            </div>
            <CardTitle className="text-2xl">Welcome to Fabbitt</CardTitle>
            <p className="text-slate-600 mt-2">
              Transform your text and images into stunning videos
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-center">
              <p className="text-sm text-slate-600 mb-4">
                Sign in with your Google account to get started
              </p>
              <Button
                onClick={() => window.location.href = "/api/auth/google"}
                className="w-full flex items-center justify-center gap-2"
              >
                <LogIn className="h-4 w-4" />
                Sign In with Google
              </Button>
            </div>
            <div className="pt-4 border-t border-slate-200">
              <h3 className="font-medium text-slate-900 mb-2">What you can do:</h3>
              <ul className="text-sm text-slate-600 space-y-1">
                <li>• Create videos from text descriptions</li>
                <li>• Upload images to enhance your videos</li>
                <li>• View your completed video generations</li>
                <li>• Get real-time updates on video processing</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}