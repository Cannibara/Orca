import { useEffect } from "react";

/** Puts `title` in the browser tab while the calling page is on screen. Pages that are still loading leave the title as it is. */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
