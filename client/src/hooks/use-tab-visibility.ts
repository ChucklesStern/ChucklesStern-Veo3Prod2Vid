import { useState, useEffect } from "react";

interface TabVisibilityHook {
  isVisible: boolean;
  isHidden: boolean;
  visibilityState: DocumentVisibilityState;
}

export function useTabVisibility(): TabVisibilityHook {
  const [visibilityState, setVisibilityState] = useState<DocumentVisibilityState>(
    typeof document !== "undefined" ? document.visibilityState : "visible"
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      setVisibilityState(document.visibilityState);
    };

    if (typeof document !== "undefined") {
      setVisibilityState(document.visibilityState);
      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
    }
  }, []);

  return {
    isVisible: visibilityState === "visible",
    isHidden: visibilityState === "hidden",
    visibilityState,
  };
}