import { Navigate } from "react-router-dom";
import { useAuth } from "./auth";
import { userIsAdmin } from "./api";
import type { ReactNode } from "react";

/** Protège une route : renvoie à l'accueil si l'utilisateur n'est pas admin. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!userIsAdmin(user)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
