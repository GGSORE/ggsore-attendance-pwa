import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

// -----------------------------
// Supabase
// -----------------------------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined)?.toLowerCase();

const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

// -----------------------------
// Types
// -----------------------------
type Profile = {
  id: string;
  email: string;
  first_name: string;
  middle_initial?: string | null;
  last_name: string;
  trec_license: string;
};

type ClassSession = {
  id: string;
  title: string;
  start_time: string; // ISO
  end_time: string;   // ISO
  created_by: string;
};

// -----------------------------
// Helpers
// -----------------------------
function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatLocal(dtIso: string) {
  try {
    const d = new Date(dtIso);
    return d.toLocaleString();
  } catch {
    return dtIso;
  }
}

function isProbablyAdmin(email: string | null | undefined) {
  if (!email) return false;
  if (ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL) return true;
  return false;
}

// -----------------------------
// QR Scanner (no extra deps)
// Uses BarcodeDetector when available (Chrome/Edge).
// -----------------------------
function QrScanner({
  onResult,
  onError,
}: {
  onResult: (text: string) => void;
  onError?: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [supported, setSupported] = useState<boolean>(() => {
    // @ts-ignore
    return typeof window !== "undefined" && "BarcodeDetector" in window;
  });

  const stop = async () => {
    setIsRunning(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (!supported) {
      onError?.("QR scanning isn't supported in this browser. Use Manual Entry below.");
      return;
    }
    try {
      // Prefer rear camera on mobile
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;

      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      setIsRunning(true);

      // @ts-ignore
      const detector = new BarcodeDetector({ formats: ["qr_code"] });

      const tick = async () => {
        if (!videoRef.current) return;

        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes?.length) {
            const val = barcodes[0]?.rawValue || "";
            if (val) {
              onResult(val);
              await stop();
              return;
            }
          }
        } catch (e) {
          // If detect fails, keep trying but surface one-time hint
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      onError?.(e?.message || "Camera permission failed. Use Manual Entry below.");
      await stop();
    }
  };

  return (
    <div className="scannerWrap">
      <div className="scannerHeader">
        <div className="scannerTitle">Scan QR Code</div>
        <div className="scannerActions">
          {!isRunning ? (
            <button className="btnSecondary" type="button" onClick={() => void start()}>
              Start Scan
            </button>
          ) : (
            <button className="btnSecondary" type="button" onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="scannerBox">
        <video ref={videoRef} className="scannerVideo" playsInline muted />
        {!supported ? (
          <div className="scannerHint">
            QR scanning isn’t supported in this browser. Use Manual Entry below.
          </div>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------
// App
// -----------------------------
export default function App() {
  const [fatalConfigError, setFatalConfigError] = useState<string | null>(null);

  const [mode, setMode] = useState<"login" | "create">("login");

  // Auth inputs
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Create account inputs
  const [firstName, setFirstName] = useState("");
  const [middleInitial, setMiddleInitial] = useState("");
  const [lastName, setLastName] = useState("");
  const [trecLicense, setTrecLicense] = useState("");

  // Auth state
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  // UI messaging
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  // Admin / sessions
  const [isAdmin, setIsAdmin] = useState(false);
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionStart, setNewSessionStart] = useState("");
  const [newSessionEnd, setNewSessionEnd] = useState("");

  // Check-in scanning (everyone)
  const [scanValue, setScanValue] = useState("");
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setFatalConfigError(
        "Missing Supabase environment variables. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel."
      );
      return;
    }

    // Load existing session
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const u = data?.session?.user;
      if (u?.id) {
        setUserId(u.id);
        setSessionEmail(u.email ?? null);
        setIsAdmin(isProbablyAdmin(u.email));
      }
    })();

    // Listen for auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      const u = sess?.user;
      setUserId(u?.id ?? null);
      setSessionEmail(u?.email ?? null);
      setIsAdmin(isProbablyAdmin(u?.email));
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  const showStudentLanding = useMemo(() => {
    return !!userId && !isAdmin;
  }, [userId, isAdmin]);

  const showAdminLanding = useMemo(() => {
    return !!userId && isAdmin;
  }, [userId, isAdmin]);

  // Load profile + sessions after login
  useEffect(() => {
    if (!supabase || !userId) return;

    void (async () => {
      // Profile
      const { data: p, error: pErr } = await supabase
        .from("profiles")
        .select("id,email,first_name,middle_initial,last_name,trec_license")
        .eq("id", userId)
        .maybeSingle();

      if (!pErr && p) setProfile(p as Profile);

      // Sessions (for admins and for viewing list)
      const { data: s, error: sErr } = await supabase
        .from("class_sessions")
        .select("id,title,start_time,end_time,created_by")
        .order("start_time", { ascending: false });

      if (!sErr && s) setSessions(s as ClassSession[]);
    })();
  }, [userId]);

  // -----------------------------
  // Auth actions
  // -----------------------------
  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);

    if (!supabase) return;
    if (!email.trim() || !password) {
      setAuthError("Email and password are required.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setAuthError(error.message);
      return;
    }

    setAuthSuccess("Welcome back!");
    setPassword("");
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);

    if (!supabase) return;

    // Validate only on submit (no student-facing "status" while typing)
    const missing: string[] = [];
    if (!email.trim()) missing.push("email");
    if (!password) missing.push("password");
    if (!firstName.trim()) missing.push("first name");
    if (!lastName.trim()) missing.push("last name");
    if (!trecLicense.trim()) missing.push("TREC license");

    if (missing.length) {
      setAuthError(`Missing required fields: ${missing.join(", ")}.`);
      return;
    }

    const cleanMi = middleInitial.trim().slice(0, 1).toUpperCase();
    const cleanLicense = trecLicense.trim().toUpperCase();

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          middle_initial: cleanMi || null,
          last_name: lastName.trim(),
          trec_license: cleanLicense,
        },
      },
    });

    if (error) {
      setAuthError(error.message);
      return;
    }

    if (data?.user?.id) {
      // Ensure profile row exists (depends on your trigger; safe to upsert)
      await supabase
        .from("profiles")
        .upsert(
          {
            id: data.user.id,
            email: email.trim(),
            first_name: firstName.trim(),
            middle_initial: cleanMi || null,
            last_name: lastName.trim(),
            trec_license: cleanLicense,
          },
          { onConflict: "id" }
        );
    }

    setAuthSuccess("Account created. Check email for confirmation if required.");
    setPassword("");
    // Keep them on create mode so they can confirm they created it
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setProfile(null);
    setSessions([]);
    setScanValue("");
    setScanMsg(null);
    setAuthError(null);
    setAuthSuccess(null);
  }

  // -----------------------------
  // Admin actions
  // -----------------------------
  async function createSession(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !userId) return;

    setAuthError(null);
    setAuthSuccess(null);

    if (!newSessionTitle.trim() || !newSessionStart || !newSessionEnd) {
      setAuthError("Session title, start time, and end time are required.");
      return;
    }

    const { error } = await supabase.from("class_sessions").insert({
      title: newSessionTitle.trim(),
      start_time: new Date(newSessionStart).toISOString(),
      end_time: new Date(newSessionEnd).toISOString(),
      created_by: userId,
    });

    if (error) {
      setAuthError(error.message);
      return;
    }

    setAuthSuccess("Class session created.");
    setNewSessionTitle("");
    setNewSessionStart("");
    setNewSessionEnd("");

    const { data: s } = await supabase
      .from("class_sessions")
      .select("id,title,start_time,end_time,created_by")
      .order("start_time", { ascending: false });

    if (s) setSessions(s as ClassSession[]);
  }

  // -----------------------------
  // Check-in actions (stub for now)
  // -----------------------------
  function onScanResult(text: string) {
    setScanValue(text);
    setScanMsg("Scan captured. Review and submit below.");
  }

  async function submitScan(e: React.FormEvent) {
    e.preventDefault();
    setScanMsg(null);

    if (!scanValue.trim()) {
      setScanMsg("Nothing to submit yet—scan a QR code or paste it in Manual Entry.");
      return;
    }

    // NOTE: actual attendance write will be added next (after we confirm QR format)
    setScanMsg("Captured! Next step is wiring this value to attendance records.");
  }

  // -----------------------------
  // Render
  // -----------------------------
  if (fatalConfigError) {
    return (
      <div className="page">
        <div className="card">
          <h1 className="title">ClassCheck Pro™</h1>
          <p className="muted">{fatalConfigError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <header className="brandHeader">
          <img
            src="/classcheckpro-logo.png"
            alt="ClassCheck Pro™"
            className="brandLogoWide"
          />
        </header>

        {!userId ? (
          <>
            <div className="subTitle">Login or create an account.</div>

            <div className="segmented">
              <button
                type="button"
                className={cx("segBtn", mode === "login" && "segBtnActive")}
                onClick={() => {
                  setMode("login");
                  setAuthError(null);
                  setAuthSuccess(null);
                }}
              >
                Login
              </button>
              <button
                type="button"
                className={cx("segBtn", mode === "create" && "segBtnActive")}
                onClick={() => {
                  setMode("create");
                  setAuthError(null);
                  setAuthSuccess(null);
                }}
              >
                Create Account
              </button>
            </div>

            {/* Messages */}
            {authError ? <div className="alert alertError">{authError}</div> : null}
            {authSuccess ? <div className="alert alertOk">{authSuccess}</div> : null}

            {/* Auth form */}
            <form
              className="form"
              onSubmit={mode === "login" ? signIn : signUp}
              autoComplete="off"
            >
              <div className="grid2">
                <div className="field">
                  <label>Email</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="field">
                  <label>Password</label>
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    autoComplete={mode === "create" ? "new-password" : "off"}
                  />
                </div>
              </div>

              <div className="actionsRow">
                <button className="btnPrimary" type="submit">
                  {mode === "login" ? "Login" : "Create Account"}
                </button>
              </div>

              {mode === "create" ? (
                <>
                  <hr className="divider" />

                  <h2 className="sectionTitle">Create Account Details</h2>

                  <div className="infoBox">
                    <strong>Important:</strong> Enter your name exactly as it appears on
                    your TREC license, including middle initial.
                    <br />
                    For the TREC license number, be sure to include the appropriate
                    suffix: -SA, -B, or -BB.
                  </div>

                  <div className="grid3">
                    <div className="field">
                      <label>First Name</label>
                      <input
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        type="text"
                        autoComplete="off"
                      />
                    </div>

                    <div className="field">
                      <label>M.I. (optional)</label>
                      <input
                        value={middleInitial}
                        onChange={(e) => setMiddleInitial(e.target.value)}
                        type="text"
                        maxLength={1}
                        autoComplete="off"
                      />
                    </div>

                    <div className="field">
                      <label>Last Name</label>
                      <input
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        type="text"
                        autoComplete="off"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label>TREC License</label>
                    <input
                      value={trecLicense}
                      onChange={(e) => setTrecLicense(e.target.value)}
                      type="text"
                      placeholder="123456-SA"
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : null}
            </form>
          </>
        ) : (
          <>
            <div className="topBar">
              <div className="welcome">
                {/* Choice B */}
                <div className="welcomeTitle">
                  Welcome back{profile?.first_name ? `, ${profile.first_name}` : ""}!
                </div>
                <div className="mutedSmall">{sessionEmail ?? ""}</div>
              </div>

              <div className="topActions">
                <button className="btnSecondary" type="button" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            </div>

            <hr className="divider" />

            {isAdmin ? (
              <div className="tabRow">
                <button
                  type="button"
                  className={
                    adminTab === "checkin"
                      ? "btnSecondary btnSecondaryActive"
                      : "btnSecondary"
                  }
                  onClick={() => setAdminTab("checkin")}
                >
                  Check-In
                </button>
                <button
                  type="button"
                  className={
                    adminTab === "admin"
                      ? "btnSecondary btnSecondaryActive"
                      : "btnSecondary"
                  }
                  onClick={() => setAdminTab("admin")}
                >
                  Admin / Instructor
                </button>
              </div>
            ) : null}

            {/* Student check-in tools */}
            {(!isAdmin || adminTab === "checkin") ? (<>
            <h2 className="sectionTitle">Check-In</h2>

            {scanMsg ? <div className="alert alertOk">{scanMsg}</div> : null}

            <QrScanner
              onResult={onScanResult}
              onError={(m) => setScanMsg(m)}
            />

            <form className="form" onSubmit={submitScan}>
              <div className="field">
                <label>Manual Entry</label>
                <input
                  value={scanValue}
                  onChange={(e) => setScanValue(e.target.value)}
                  type="text"
                  placeholder="Paste the QR value here (if needed)"
                  autoComplete="off"
                />
              </div>

              <div className="actionsRow">
                <button className="btnPrimary" type="submit">
                  Submit Check-In
                </button>
              </div>
            </form>

            </>
            ) : null}

            {/* Admin panel */}
            {isAdmin && adminTab === "admin" ? (
              <>
                <hr className="divider" />
                <h2 className="sectionTitle">Admin / Instructor</h2>

                <form className="form" onSubmit={createSession}>
                  <div className="field">
                    <label>Session Title</label>
                    <input
                      value={newSessionTitle}
                      onChange={(e) => setNewSessionTitle(e.target.value)}
                      type="text"
                      autoComplete="off"
                    />
                  </div>

                  <div className="grid2">
                    <div className="field">
                      <label>Start Time</label>
                      <input
                        value={newSessionStart}
                        onChange={(e) => setNewSessionStart(e.target.value)}
                        type="datetime-local"
                      />
                    </div>

                    <div className="field">
                      <label>End Time</label>
                      <input
                        value={newSessionEnd}
                        onChange={(e) => setNewSessionEnd(e.target.value)}
                        type="datetime-local"
                      />
                    </div>
                  </div>

                  <div className="actionsRow">
                    <button className="btnPrimary" type="submit">
                      Create New Class Session
                    </button>
                  </div>
                </form>

                <div className="tableWrap">
                  <div className="tableTitle">Recent Sessions</div>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Start</th>
                        <th>End</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.id}>
                          <td>{s.title}</td>
                          <td>{formatLocal(s.start_time)}</td>
                          <td>{formatLocal(s.end_time)}</td>
                        </tr>
                      ))}
                      {!sessions.length ? (
                        <tr>
                          <td colSpan={3} className="mutedSmall">
                            No sessions yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        )}

        <div className="footer">© 2026 ClassCheck Pro™</div>
      </div>
    </div>
  );
}

