import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProtectedApp } from "@/components/ProtectedApp";
import { NotificationPreferencesProvider } from "@/contexts/NotificationPreferences";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <ProtectedApp>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </ProtectedApp>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NotificationPreferencesProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </NotificationPreferencesProvider>
    </QueryClientProvider>
  );
}

export default App;
