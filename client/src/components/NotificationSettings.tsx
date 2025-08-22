import { useState } from "react";
import { Settings, Bell, Volume2, VolumeX, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useNotificationPreferences } from "@/contexts/NotificationPreferences";
import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { useNotificationSound } from "@/lib/notification-sound";

export function NotificationSettings() {
  const { preferences, updatePreferences, resetToDefaults } = useNotificationPreferences();
  const { requestPermission, permission, isSupported } = useBrowserNotifications();
  const { playSound, initialize } = useNotificationSound();
  const [isOpen, setIsOpen] = useState(false);

  const handleBrowserNotificationToggle = async (enabled: boolean) => {
    if (enabled && permission !== "granted") {
      const result = await requestPermission();
      if (result !== "granted") {
        return; // Don't update preferences if permission was denied
      }
    }
    updatePreferences({ showBrowserNotifications: enabled });
  };

  const handleSoundToggle = async (enabled: boolean) => {
    if (enabled) {
      await initialize();
    }
    updatePreferences({ enableSounds: enabled });
  };

  const handleTestSound = async () => {
    await initialize();
    await playSound({
      type: "success",
      volume: preferences.soundVolume,
    });
  };

  const handleVolumeChange = (volume: number[]) => {
    updatePreferences({ soundVolume: volume[0] });
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Bell className="h-4 w-4" />
          Notifications
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <Card className="border-0 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings className="h-4 w-4" />
              Notification Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Toast Notifications */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <Label htmlFor="toast-notifications" className="text-sm font-medium">
                  Toast Notifications
                </Label>
                <span className="text-xs text-muted-foreground">
                  Show in-page notification messages
                </span>
              </div>
              <Switch
                id="toast-notifications"
                checked={preferences.showToastNotifications}
                onCheckedChange={(checked) =>
                  updatePreferences({ showToastNotifications: checked })
                }
              />
            </div>

            <Separator />

            {/* Browser Notifications */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="browser-notifications" className="text-sm font-medium">
                    Browser Notifications
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Show system notifications when tab is inactive
                  </span>
                </div>
                <Switch
                  id="browser-notifications"
                  checked={preferences.showBrowserNotifications}
                  onCheckedChange={handleBrowserNotificationToggle}
                  disabled={!isSupported}
                />
              </div>
              
              {isSupported && permission === "denied" && (
                <div className="text-xs text-orange-600 bg-orange-50 p-2 rounded">
                  Browser notifications are blocked. Please enable them in your browser settings.
                </div>
              )}
              
              {isSupported && permission === "default" && preferences.showBrowserNotifications && (
                <div className="text-xs text-blue-600 bg-blue-50 p-2 rounded">
                  Click the toggle to request notification permission.
                </div>
              )}
            </div>

            <Separator />

            {/* Sound Notifications */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="sound-notifications" className="text-sm font-medium">
                    Sound Notifications
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Play sounds when generations complete
                  </span>
                </div>
                <Switch
                  id="sound-notifications"
                  checked={preferences.enableSounds}
                  onCheckedChange={handleSoundToggle}
                />
              </div>

              {preferences.enableSounds && (
                <div className="space-y-2 pl-4 border-l-2 border-gray-100">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Volume</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestSound}
                      className="h-6 px-2 text-xs"
                    >
                      Test
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <VolumeX className="h-3 w-3 text-muted-foreground" />
                    <Slider
                      value={[preferences.soundVolume]}
                      onValueChange={handleVolumeChange}
                      max={1}
                      min={0}
                      step={0.1}
                      className="flex-1"
                    />
                    <Volume2 className="h-3 w-3 text-muted-foreground" />
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* Visual Indicators */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Visual Indicators</Label>
              
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="favicon-badge" className="text-xs">
                    Favicon Badge
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Show count on tab icon
                  </span>
                </div>
                <Switch
                  id="favicon-badge"
                  checked={preferences.showFaviconBadge}
                  onCheckedChange={(checked) =>
                    updatePreferences({ showFaviconBadge: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="tab-title" className="text-xs">
                    Tab Title Updates
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Update tab title with status
                  </span>
                </div>
                <Switch
                  id="tab-title"
                  checked={preferences.updateTabTitle}
                  onCheckedChange={(checked) =>
                    updatePreferences({ updateTabTitle: checked })
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Smart Notifications */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Smart Notifications</Label>
              
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="only-hidden" className="text-xs">
                    Only When Tab Hidden
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Skip notifications when actively viewing
                  </span>
                </div>
                <Switch
                  id="only-hidden"
                  checked={preferences.onlyNotifyWhenTabHidden}
                  onCheckedChange={(checked) =>
                    updatePreferences({ onlyNotifyWhenTabHidden: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="batch-notifications" className="text-xs">
                    Batch Notifications
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Group multiple completions together
                  </span>
                </div>
                <Switch
                  id="batch-notifications"
                  checked={preferences.batchNotifications}
                  onCheckedChange={(checked) =>
                    updatePreferences({ batchNotifications: checked })
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Reset Button */}
            <div className="flex justify-between items-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={resetToDefaults}
                className="text-xs"
              >
                Reset to Defaults
              </Button>
              <Button
                size="sm"
                onClick={() => setIsOpen(false)}
                className="text-xs"
              >
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      </PopoverContent>
    </Popover>
  );
}