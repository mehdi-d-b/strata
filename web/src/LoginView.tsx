import { useState } from "react";
import { useAuth } from "./auth";
import { ApiError } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginView() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Identifiants invalides"
          : "Erreur de connexion",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-8 shadow-sm"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-[0.15em] text-foreground">STRATA</h1>
          <p className="text-sm text-muted-foreground">Connexion</p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Utilisateur
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          Mot de passe
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <div className="rounded-md bg-bad/15 px-3 py-2 text-sm text-bad">{error}</div>
        )}
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy ? "Connexion…" : "Se connecter"}
        </Button>
      </form>
    </div>
  );
}
