import { useEffect, useRef } from "react";

interface TabIndicatorsHook {
  updateFaviconBadge: (count: number) => void;
  updateTabTitle: (suffix?: string) => void;
  clearIndicators: () => void;
}

export function useTabIndicators(): TabIndicatorsHook {
  const originalTitle = useRef<string>("");
  const originalFavicon = useRef<string>("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // Store original title and favicon
    if (typeof document !== "undefined") {
      originalTitle.current = document.title;
      const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      originalFavicon.current = faviconLink?.href || "/favicon.ico";
    }

    // Create canvas for badge generation
    if (typeof document !== "undefined") {
      canvasRef.current = document.createElement("canvas");
      canvasRef.current.width = 32;
      canvasRef.current.height = 32;
    }

    return () => {
      // Cleanup on unmount
      clearIndicators();
    };
  }, []);

  const updateFaviconBadge = (count: number) => {
    if (typeof document === "undefined" || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, 32, 32);

    // Create base favicon (simplified icon)
    ctx.fillStyle = "#3b82f6"; // Blue background
    ctx.beginPath();
    ctx.roundRect(4, 4, 24, 24, 4);
    ctx.fill();

    // Add video icon representation
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.moveTo(12, 10);
    ctx.lineTo(12, 22);
    ctx.lineTo(22, 16);
    ctx.closePath();
    ctx.fill();

    // Add badge if count > 0
    if (count > 0) {
      const displayCount = count > 99 ? "99+" : count.toString();
      
      // Badge background
      ctx.fillStyle = "#ef4444"; // Red
      ctx.beginPath();
      ctx.arc(24, 8, 8, 0, 2 * Math.PI);
      ctx.fill();

      // Badge text
      ctx.fillStyle = "white";
      ctx.font = count > 9 ? "10px Arial" : "12px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(displayCount, 24, 8);
    }

    // Update favicon
    const dataURL = canvas.toDataURL("image/png");
    let faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    
    if (!faviconLink) {
      faviconLink = document.createElement("link");
      faviconLink.rel = "icon";
      document.head.appendChild(faviconLink);
    }
    
    faviconLink.href = dataURL;
  };

  const updateTabTitle = (suffix?: string) => {
    if (typeof document === "undefined") return;

    if (suffix) {
      document.title = `${suffix} | ${originalTitle.current}`;
    } else {
      document.title = originalTitle.current;
    }
  };

  const clearIndicators = () => {
    if (typeof document === "undefined") return;

    // Reset title
    document.title = originalTitle.current;

    // Reset favicon
    let faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (faviconLink && originalFavicon.current) {
      faviconLink.href = originalFavicon.current;
    }
  };

  return {
    updateFaviconBadge,
    updateTabTitle,
    clearIndicators,
  };
}