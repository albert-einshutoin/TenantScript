import { useCallback, useEffect, useState } from "react";

export const routes = ["overview", "installations", "versions", "approvals", "executions"] as const;

export type AdminRoute = (typeof routes)[number];

export function useHashRoute(): [AdminRoute, (route: AdminRoute) => void] {
  const [route, setRouteState] = useState<AdminRoute>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      setRouteState(routeFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const setRoute = useCallback((nextRoute: AdminRoute) => {
    window.location.hash = nextRoute;
    setRouteState(nextRoute);
  }, []);

  return [route, setRoute];
}

function routeFromHash(hash: string): AdminRoute {
  const candidate = hash.replace(/^#\/?/, "");
  return isAdminRoute(candidate) ? candidate : "overview";
}

function isAdminRoute(value: string): value is AdminRoute {
  return routes.some((route) => route === value);
}
