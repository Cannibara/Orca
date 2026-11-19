import { useState } from "react";
import { creditOf, photoOf } from "../lib/people";

/**
 * The photo of the person behind a fund, round, before the fund name. Renders nothing when the
 * folder has no photo for them (or the file fails to load), so the name simply starts further left.
 */
export function Face({ manager }: { manager: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const src = photoOf(manager);
  if (!src || failed) return null;
  return (
    <img
      className="face"
      src={src}
      alt=""
      title={creditOf(manager)}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
