import { useState, useEffect, useCallback } from "react";

export type NotificationPermission = "default" | "granted" | "denied";

interface BrowserNotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: any;
  requireInteraction?: boolean;
  silent?: boolean;
}

interface NotificationHook {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  showNotification: (options: BrowserNotificationOptions) => Promise<Notification | null>;
  isSupported: boolean;
}

export function useBrowserNotifications(): NotificationHook {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "denied"
  );

  const isSupported = typeof window !== "undefined" && "Notification" in window;

  useEffect(() => {
    if (isSupported) {
      setPermission(Notification.permission);
    }
  }, [isSupported]);

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (!isSupported) {
      return "denied";
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch (error) {
      console.error("Error requesting notification permission:", error);
      return "denied";
    }
  }, [isSupported]);

  const showNotification = useCallback(
    async (options: BrowserNotificationOptions): Promise<Notification | null> => {
      if (!isSupported || permission !== "granted") {
        return null;
      }

      try {
        const notification = new Notification(options.title, {
          body: options.body,
          icon: options.icon || "/favicon.ico",
          tag: options.tag,
          data: options.data,
          requireInteraction: options.requireInteraction || false,
          silent: options.silent || false,
        });

        // Auto-close after 5 seconds unless requireInteraction is true
        if (!options.requireInteraction) {
          setTimeout(() => {
            notification.close();
          }, 5000);
        }

        return notification;
      } catch (error) {
        console.error("Error showing notification:", error);
        return null;
      }
    },
    [isSupported, permission]
  );

  return {
    permission,
    requestPermission,
    showNotification,
    isSupported,
  };
}