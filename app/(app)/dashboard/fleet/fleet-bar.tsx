"use client";

import { useEffect } from "react";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "fleet-bar": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        endpoint?: string;
        refresh?: string;
        theme?: "light" | "dark";
      };
    }
  }
}

export function FleetBar() {
  useEffect(() => {
    import("@profullstack/fleetbar");
  }, []);
  return <fleet-bar endpoint="/api/fleetbar" theme="dark" />;
}
