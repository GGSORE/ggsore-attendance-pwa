import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

/**
 * ClassCheck Pro<sup className="tm">™</sup> — GGSORE attendance/check-in app
 *
 * This file intentionally keeps student-facing messaging clean:
 * - No "Status: Missing required fields..." banner on first load
 * - Validation messages only appear after a submit attempt
 * - Admin-only diagnostics are hidden unless the signed-in user is an admin
 */

type Mode = "login" | "create";

type Profile = {
  user_id: string;
  email: string;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  trec_license: string;
  created_at?: string;
  updated_at?: string;
};

type SessionRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeTrecLicense(raw: string) {
  return raw.trim().toUpperCase();
}

function isValidEmail(email: string) {
  // simple + sufficient for UI validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function formatName(first: string, mi: string, last: string) {
  const f = first.trim();
  const m = mi.trim();
  const l = last.trim();
  return [f, m ? `${m}.` : "", l].filter(Boolean).join(" ");
}

export default function App() {
  const [mode, setMode] = useState<Mode>("login");

  // Auth fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Create-account fields
  const [firstName, setFirstName] = useState("");
  const [middleInitial, setMiddleInitial] = useState("");
  const [lastName, setLastName] = useState("");
  const [trecLicense, setTrecLicense] = useState("");

  // UI state
  const [busy, setBusy] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"error" | "success" | "info">("info");

  // Signed-in user + admin
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // Data
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  const createErrors = useMemo(() => {
    const errs: string[] = [];
    const e = normalizeEmail(email);
    const tl = normalizeTrecLicense(trecLicense);

    if (!e) errs.push("Email is required.");
    else if (!isValidEmail(e)) errs.push("Enter a valid email address.");

    if (!password) errs.push("Password is required.");

    if (!firstName.trim()) errs.push("First name is required.");
    if (!lastName.trim()) errs.push("Last name is required.");

    if (!tl) errs.push("TREC license is required.");
    // Friendly nudge (not strict validation): suffix
    // Students may include -SA / -B / -BB depending on license type.
    // We don't hard-fail here, we just remind below.

    return errs;
  }, [email, password, firstName, lastName, trecLicense]);

  const loginErrors = useMemo(() => {
    const errs: string[] = [];
    const e = normalizeEmail(email);

    if (!e) errs.push("Email is required.");
    else if (!isValidEmail(e)) errs.push("Enter a valid email address.");
    if (!password) errs.push("Password is required.");

    return errs;
  }, [email, password]);

  useEffect(() => {
    // Restore session + watch auth changes
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      const uid = data.session?.user?.id ?? null;
      setUserId(uid);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user?.id ?? null;
      setUserId(uid);
      if (!uid) {
        setProfile(null);
        setIsAdmin(false);
        setSessions([]);
        setActiveSessionId("");
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    // When userId becomes available, fetch profile and admin status
    if (!userId) return;

    (async () => {
      const { data: prof, error: pErr } = await supabase
        .from("gg_profiles")
        .select("user_id,email,first_name,middle_initial,last_name,trec_license,created_at,updated_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (pErr) {
        // keep student-facing clean; admin can inspect in console
        console.error("Profile fetch error:", pErr);
      }
      setProfile(prof ?? null);

      const { data: adminRow, error: aErr } = await supabase
        .from("gg_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (aErr) console.error("Admin check error:", aErr);
      setIsAdmin(!!adminRow);

      // Fetch sessions for all users (read-only)
      const { data: sess, error: sErr } = await supabase
        .from("gg_sessions")
        .select("id,title,starts_at,ends_at")
        .order("starts_at", { ascending: false });

      if (sErr) console.error("Sessions fetch error:", sErr);
      setSessions((sess ?? []) as SessionRow[]);
      setActiveSessionId((sess?.[0]?.id as string) ?? "");
    })();
  }, [userId]);

  function showMsg(type: "error" | "success" | "info", text: string) {
    setMessageType(type);
    setMessage(text);
  }

  async function handleLogin() {
    setSubmitAttempted(true);
    setMessage(null);

    if (loginErrors.length) {
      showMsg("error", loginErrors[0]);
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      });
      if (error) {
        showMsg("error", error.message);
        return;
      }
      showMsg("success", "Signed in.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAccount() {
    setSubmitAttempted(true);
    setMessage(null);

    if (createErrors.length) {
      showMsg("error", createErrors[0]);
      return;
    }

    setBusy(true);
    try {
      const e = normalizeEmail(email);
      const tl = normalizeTrecLicense(trecLicense);

      const { data, error } = await supabase.auth.signUp({
        email: e,
        password,
      });

      if (error) {
        showMsg("error", error.message);
        return;
      }

      const uid = data.user?.id;
      if (!uid) {
        showMsg("error", "Account created, but user ID was not returned. Try logging in.");
        return;
      }

      // Insert profile row
      const { error: insErr } = await supabase.from("gg_profiles").insert([
        {
          user_id: uid,
          email: e,
          first_name: firstName.trim(),
          middle_initial: middleInitial.trim() ? middleInitial.trim().toUpperCase() : null,
          last_name: lastName.trim(),
          trec_license: tl,
        },
      ]);

      if (insErr) {
        console.error("Profile insert error:", insErr);
        showMsg("error", "Account created, but profile could not be saved. Contact the school for help.");
        return;
      }

      showMsg("success", "Account created. If email confirmation is enabled, check inbox; otherwise, log in.");
      // Optional: switch back to login mode for clarity
      setMode("login");
      setSubmitAttempted(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setBusy(false);
    }
  }

  const brandTitle = "ClassCheck Pro";

  return (
    <div className="page">
      <div className="card">
        <header className="header">
          <div className="brand">
            <img
              className="logo"
              src="/classcheckpro-logo.png"
              alt="ClassCheck Pro logo"
              onError={(e) => {
                // In case the logo file isn't uploaded yet
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <div className="brandText">
              <h1>{brandTitle}<sup className="tm">™</sup></h1>
              <p className="subtitle">Login or create an account.</p>
            </div>
          </div>

          {userId && (
            <button className="btn btn-secondary" onClick={handleLogout} disabled={busy}>
              Logout
            </button>
          )}
        </header>

        {/* Student-facing messages only (no debug/status spam) */}
        {message && (
          <div className={`notice ${messageType}`}>
            {message}
          </div>
        )}

        {!userId ? (
          <>
            <div className="tabs">
              <button
                className={`tab ${mode === "login" ? "active" : ""}`}
                onClick={() => {
                  setMode("login");
                  setSubmitAttempted(false);
                  setMessage(null);
                }}
              >
                Login
              </button>
              <button
                className={`tab ${mode === "create" ? "active" : ""}`}
                onClick={() => {
                  setMode("create");
                  setSubmitAttempted(false);
                  setMessage(null);
                }}
              >
                Create Account
              </button>
            </div>

            <div className="grid2">
              <div className="field">
                <label>Email</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="name@email.com"
                />
              </div>

              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                />
              </div>
            </div>

            <div className="actions">
              {mode === "login" ? (
                <button className="btn btn-primary" onClick={handleLogin} disabled={busy}>
                  {busy ? "Signing in..." : "Login"}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={handleCreateAccount} disabled={busy}>
                  {busy ? "Creating..." : "Create Account"}
                </button>
              )}
            </div>

            {mode === "create" && (
              <div className="section">
                <h2>Create Account Details</h2>

                <div className="helper">
                  <p>
                    <strong>Important:</strong> Enter your name exactly as it appears on the TREC license, including middle initial.
                  </p>
                  <p>
                    For the TREC license number, be sure to include the appropriate suffix: <strong>-SA</strong>, <strong>-B</strong>, or <strong>-BB</strong>.
                  </p>
                </div>

                <div className="grid3">
                  <div className="field">
                    <label>First Name</label>
                    <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </div>

                  <div className="field">
                    <label>M.I. (optional)</label>
                    <input
                      value={middleInitial}
                      maxLength={1}
                      onChange={(e) => setMiddleInitial(e.target.value)}
                      placeholder="M"
                    />
                  </div>

                  <div className="field">
                    <label>Last Name</label>
                    <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </div>
                </div>

                <div className="field">
                  <label>TREC License</label>
                  <input
                    value={trecLicense}
                    onChange={(e) => setTrecLicense(e.target.value)}
                    placeholder="123456-SA"
                  />
                </div>

                {submitAttempted && createErrors.length > 1 && (
                  <div className="subtle">
                    <ul>
                      {createErrors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {/* Signed-in home */}
            <div className="section">
              <h2>Welcome{profile ? `, ${formatName(profile.first_name, profile.middle_initial ?? "", profile.last_name)}` : ""}.</h2>
              <p className="muted">
                Select a class session, then check in.
              </p>

              <div className="field">
                <label>Class Session</label>
                <select
                  value={activeSessionId}
                  onChange={(e) => setActiveSessionId(e.target.value)}
                >
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} — {new Date(s.starts_at).toLocaleString()}
                    </option>
                  ))}
                </select>
              </div>

              <div className="actions">
                <button className="btn btn-primary" disabled={!activeSessionId}>
                  Check In (next step)
                </button>
              </div>
            </div>

            {isAdmin && (
              <div className="section admin">
                <h2>Instructor / Admin</h2>
                <p className="muted">
                  Admin tools are shown only to instructors/admin users.
                </p>

                <div className="subtle">
                  <div><strong>User ID:</strong> {userId}</div>
                  <div><strong>Email:</strong> {profile?.email ?? "—"}</div>
                  <div><strong>TREC:</strong> {profile?.trec_license ?? "—"}</div>
                </div>

                <button className="btn btn-secondary" disabled>
                  Create New Class Session (next step)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="footer">
        <span className="muted">© {new Date().getFullYear()} ClassCheck Pro<sup className="tm">™</sup></span>
      </footer>
    </div>
  );
}

