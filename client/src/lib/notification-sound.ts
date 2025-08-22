export type NotificationSoundType = "success" | "error" | "info" | "none";

interface NotificationSoundOptions {
  volume?: number; // 0.0 to 1.0
  type?: NotificationSoundType;
}

class NotificationSoundManager {
  private audioContext: AudioContext | null = null;
  private isEnabled: boolean = true;

  constructor() {
    // Initialize audio context on first user interaction
    if (typeof window !== "undefined") {
      this.isEnabled = localStorage.getItem("notification-sounds-enabled") !== "false";
    }
  }

  private async getAudioContext(): Promise<AudioContext | null> {
    if (typeof window === "undefined") return null;
    
    if (!this.audioContext) {
      try {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (error) {
        console.warn("Audio context not supported:", error);
        return null;
      }
    }

    // Resume context if suspended (required by some browsers)
    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch (error) {
        console.warn("Could not resume audio context:", error);
      }
    }

    return this.audioContext;
  }

  private async playTone(frequency: number, duration: number, volume: number = 0.3): Promise<void> {
    const audioContext = await this.getAudioContext();
    if (!audioContext || !this.isEnabled) return;

    try {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      oscillator.type = "sine";

      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(volume, audioContext.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + duration);
    } catch (error) {
      console.warn("Error playing notification sound:", error);
    }
  }

  private async playSuccessSound(volume: number): Promise<void> {
    // Play a pleasant two-tone chime (C5 -> E5)
    await this.playTone(523.25, 0.15, volume); // C5
    setTimeout(() => {
      this.playTone(659.25, 0.2, volume); // E5
    }, 100);
  }

  private async playErrorSound(volume: number): Promise<void> {
    // Play a lower, more urgent tone (F4 -> D4)
    await this.playTone(349.23, 0.2, volume); // F4
    setTimeout(() => {
      this.playTone(293.66, 0.3, volume); // D4
    }, 150);
  }

  private async playInfoSound(volume: number): Promise<void> {
    // Play a single, neutral tone (A4)
    await this.playTone(440, 0.2, volume);
  }

  async playNotificationSound(options: NotificationSoundOptions = {}): Promise<void> {
    const { volume = 0.3, type = "info" } = options;
    
    if (!this.isEnabled || type === "none") return;

    switch (type) {
      case "success":
        await this.playSuccessSound(volume);
        break;
      case "error":
        await this.playErrorSound(volume);
        break;
      case "info":
      default:
        await this.playInfoSound(volume);
        break;
    }
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (typeof window !== "undefined") {
      localStorage.setItem("notification-sounds-enabled", enabled.toString());
    }
  }

  isNotificationSoundEnabled(): boolean {
    return this.isEnabled;
  }

  // Initialize audio context on user interaction
  async initializeAudio(): Promise<void> {
    await this.getAudioContext();
  }
}

// Singleton instance
export const notificationSoundManager = new NotificationSoundManager();

// Hook for React components
export function useNotificationSound() {
  return {
    playSound: (options?: NotificationSoundOptions) => 
      notificationSoundManager.playNotificationSound(options),
    setEnabled: (enabled: boolean) => notificationSoundManager.setEnabled(enabled),
    isEnabled: () => notificationSoundManager.isNotificationSoundEnabled(),
    initialize: () => notificationSoundManager.initializeAudio(),
  };
}