import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export interface NotificationPreferences {
  // Toast notifications
  showToastNotifications: boolean;
  
  // Browser notifications
  showBrowserNotifications: boolean;
  
  // Sound notifications
  enableSounds: boolean;
  soundVolume: number; // 0.0 to 1.0
  
  // Visual indicators
  showFaviconBadge: boolean;
  updateTabTitle: boolean;
  
  // Smart notifications
  onlyNotifyWhenTabHidden: boolean;
  batchNotifications: boolean;
  maxNotificationsPerBatch: number;
  batchTimeoutMs: number;
}

interface NotificationPreferencesContextType {
  preferences: NotificationPreferences;
  updatePreferences: (updates: Partial<NotificationPreferences>) => void;
  resetToDefaults: () => void;
}

const defaultPreferences: NotificationPreferences = {
  showToastNotifications: true,
  showBrowserNotifications: true,
  enableSounds: true,
  soundVolume: 0.3,
  showFaviconBadge: true,
  updateTabTitle: true,
  onlyNotifyWhenTabHidden: true,
  batchNotifications: true,
  maxNotificationsPerBatch: 3,
  batchTimeoutMs: 2000,
};

const NotificationPreferencesContext = createContext<NotificationPreferencesContextType | undefined>(
  undefined
);

const STORAGE_KEY = "video-generation-notification-preferences";

interface NotificationPreferencesProviderProps {
  children: ReactNode;
}

export function NotificationPreferencesProvider({ children }: NotificationPreferencesProviderProps) {
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultPreferences);

  // Load preferences from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setPreferences((prev) => ({ ...prev, ...parsed }));
      }
    } catch (error) {
      console.warn("Failed to load notification preferences:", error);
    }
  }, []);

  // Save preferences to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
      console.warn("Failed to save notification preferences:", error);
    }
  }, [preferences]);

  const updatePreferences = (updates: Partial<NotificationPreferences>) => {
    setPreferences((prev) => ({ ...prev, ...updates }));
  };

  const resetToDefaults = () => {
    setPreferences(defaultPreferences);
  };

  return (
    <NotificationPreferencesContext.Provider
      value={{
        preferences,
        updatePreferences,
        resetToDefaults,
      }}
    >
      {children}
    </NotificationPreferencesContext.Provider>
  );
}

export function useNotificationPreferences(): NotificationPreferencesContextType {
  const context = useContext(NotificationPreferencesContext);
  if (!context) {
    throw new Error(
      "useNotificationPreferences must be used within a NotificationPreferencesProvider"
    );
  }
  return context;
}