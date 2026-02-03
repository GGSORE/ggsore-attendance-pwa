import React, { useEffect, useMemo, useState } from "react";
import "./styles.css";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

type Mode = "login" | "create";

function normalizeTrecLicense(v: string): string {
  return v.trim().toUpperCase();
}

export default function App() {
  const [mode, setMode] = useState<Mode>("login");

  // IMPORTANT: start empty so the browser doesn't show "your credentials" by default
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // create-account fields
  const [firstName, setFirstName] = useState("");
  const [mi, setMi] = useState("");
  const [lastName, setLastName] = useState("");
  const [trecLicense, setTrecLicense] = useState("");

  // student-facing UX: no "missing required fields" banner until AFTER submit
  const [status, setStatus] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    if (!email.trim() || !password) return false;
    if (mode === "login") return true;
    return (
      !!firstName.trim() &&
      !!lastName.trim() &&
      !!normalizeTrecLicense(trecLicense)
    );
  }, [email, password, mode, firstName, lastName, trecLicense]);

  useEffect(() => {
    // Clear status whenever user changes mode or edits fields (so we don't nag)
    setStatus(null);
  }, [mode]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setStatus(null);

    if (!supabase) {
      setStatus("Config error: Supabase environment variables are missing.");
      return;
    }
    if (!email.trim() || !password) {
      setStatus("Please enter email and password.");
      return;
    }

    try {
      setLoading(true);
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      setStatus("Logged in.");
    } catch (err: any) {
      setStatus(err?.message ?? "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setStatus(null);

    if (!supabase) {
      setStatus("Config error: Supabase environment variables are missing.");
      return;
    }

    const t = normalizeTrecLicense(trecLicense);
    if (!email.trim() || !password || !firstName.trim() || !lastName.trim() || !t) {
      setStatus("Please complete all required fields.");
      return;
    }

    try {
      setLoading(true);

      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      const userId = data.user?.id;
      if (!userId) {
        setStatus("Account created. Please check email for verification if enabled.");
        return;
      }

      // Insert profile row if your schema has gg_profiles
      // If you renamed tables, adjust here.
      const { error: profileErr } = await supabase.from("gg_profiles").upsert({
        user_id: userId,
        email: email.trim(),
        first_name: firstName.trim(),
        middle_initial: mi.trim(),
        last_name: lastName.trim(),
        trec_license: t,
      }, { onConflict: "user_id" });

      // If table doesn't exist or column mismatch, show a friendly message
      if (profileErr) {
        // Still consider auth signup successful
        setStatus("Account created. Profile saving will be finalized by the administrator.");
        return;
      }

      setStatus("Account created. Please log in.");
      setMode("login");
      setPassword(""); // don't keep password around
    } catch (err: any) {
      setStatus(err?.message ?? "Create account failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <header className="brand-header">
          <img
            src="/classcheckpro-logo.png"
            alt="ClassCheck Pro logo"
            className="brand-logo"
            draggable={false}
          />
        </header>

        <div className="mode-row">
          <p className="subtitle">Login or create an account.</p>
          <div className="mode-buttons" role="tablist" aria-label="Mode">
            <button
              type="button"
              className={`pill ${mode === "login" ? "active" : ""}`}
              onClick={() => setMode("login")}
            >
              Login
            </button>
            <button
              type="button"
              className={`pill ${mode === "create" ? "active" : ""}`}
              onClick={() => setMode("create")}
            >
              Create Account
            </button>
          </div>
        </div>

        <form
          className="form"
          onSubmit={mode === "login" ? handleLogin : handleCreateAccount}
          autoComplete="off"
        >
          <div className="row">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                autoComplete="off"
                inputMode="email"
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </label>
          </div>

          {mode === "login" && (
            <button className="primary" type="submit" disabled={loading}>
              {loading ? "Logging in..." : "Login"}
            </button>
          )}

          {mode === "create" && (
            <>
              <button className="primary" type="submit" disabled={loading}>
                {loading ? "Creating..." : "Create Account"}
              </button>

              <hr className="divider" />

              <h2 className="section-title">Create Account Details</h2>

              <div className="notice">
                <strong>Important:</strong> Enter your name exactly as it appears on the TREC license, including middle initial.
                <br />
                For the TREC license number, be sure to include the appropriate suffix: <strong>-SA</strong>, <strong>-B</strong>, or <strong>-BB</strong>.
              </div>

              <div className="row">
                <label className="field">
                  <span>First Name</span>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="First"
                    autoComplete="off"
                  />
                </label>

                <label className="field mi">
                  <span>M.I. (optional)</span>
                  <input
                    value={mi}
                    onChange={(e) => setMi(e.target.value)}
                    placeholder="M"
                    autoComplete="off"
                    maxLength={2}
                  />
                </label>

                <label className="field">
                  <span>Last Name</span>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Last"
                    autoComplete="off"
                  />
                </label>
              </div>

              <label className="field">
                <span>TREC License</span>
                <input
                  value={trecLicense}
                  onChange={(e) => setTrecLicense(e.target.value)}
                  placeholder="123456-SA"
                  autoComplete="off"
                />
              </label>
            </>
          )}

          {/* Status message — keep it tame & student-friendly */}
          {(status || (submitted && !canSubmit && mode === "create")) && (
            <div className="status">
              {status ?? "Please complete all required fields."}
            </div>
          )}
        </form>

        <footer className="footer">© {new Date().getFullYear()} ClassCheck Pro™</footer>
      </div>
    </div>
  );
}

