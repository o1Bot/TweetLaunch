"use client";

import { useState } from "react";

/**
 * Shown when the edge did not identify a country — locally, or behind a proxy
 * that strips the header. The user states their own jurisdiction instead of the
 * app assuming one. Nothing is persisted yet: there is no account to attach it
 * to until the Lighter link step exists, and a promise stored nowhere would be
 * worse than an honest one.
 */
export function Attest({ children }: { children: React.ReactNode }) {
  const [confirmed, setConfirmed] = useState(false);

  if (confirmed) return <>{children}</>;

  return (
    <div className="panel gate">
      <h2>Confirm where you are</h2>
      <p>
        We could not determine your location from this request, so we are not going to guess it.
        Lighter does not serve residents of the countries listed above.
      </p>
      <label className="check">
        <input type="checkbox" onChange={(e) => setConfirmed(e.target.checked)} />
        <span>
          I confirm I do not reside in, and am not accessing this from, any of those jurisdictions.
        </span>
      </label>
    </div>
  );
}
