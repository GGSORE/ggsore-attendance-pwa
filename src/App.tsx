import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

/* =========================
   Supabase Setup
========================= */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined)?.toLowerCase() || "";

const supabase =
  supabaseUrl && supabaseAnon ? createClient(supabaseUrl, supabaseAnon) : null;

/* =========================
   Types
========================= */
type Session = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  checkinExpiresAt: string;
  checkoutExpiresAt: string;
  checkinCode: string;
  checkoutCode: string;
};

type Attendance = {
  session_id: string;
  trec_license: string;
  checkin_at?: string;
  checkout_at?: string;
  method_checkin?: "scan" | "manual";
  method_checkout?: "scan" | "manual";
  notes?: string;
};

type DBSess = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  checkin_expires_at: string;
  checkout_expires_at: string;
  checkin_code: string;
  checkout_code: string;
};

function dbSessToUi(s: DBSess): Session {
  return {
    id: s.id,
    title: s.title,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    checkinExpiresAt: s.checkin_expires_at,
    checkoutExpiresAt: s.checkout_expires_at,
    checkinCode: s.checkin_code,
    checkoutCode: s.checkout_code,
  };
}

function uiSessToDb(s: Session): Omit<DBSess, "id"> {
  return {
    title: s.title,
    starts_at: s.startsAt,
    ends_at: s.endsAt,
    checkin_expires_at: s.checkinExpiresAt,
    checkout_expires_at: s.checkoutExpiresAt,
    checkin_code: s.checkinCode,
    checkout_code: s.checkoutCode,
  };
}

/* =========================
   Helpers
========================= */
function normalizeLicense(v: string) {
  return v.trim().toUpperCase().replace(/\s+/g, "");
}
function isValidLicense(v: string) {
  return /^\d{6,7}-(SA|B|BB)$/i.test(v);
}
function randCode(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function isoNow() {
  return new Date().toISOString();
}
function isExpired(expiresAt: string) {
  return Date.now() > new Date(expiresAt).getTime();
}
function qrPayload(
  action: "checkin" | "checkout",
  sessionId: string,
  code: string,
  expiresAt: string
) {
  return JSON.stringify({ action, sessionId, code, expiresAt });
}

/* =========================
   App Component
========================= */
export default function App() {
  const [status, setStatus] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseInput, setLicenseInput] = useState("");

  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Password reset / recovery flow
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  const [tab, setTab] = useState<"student" | "admin">("student");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");

  const [checkinQrUrl, setCheckinQrUrl] = useState("");
  const [checkoutQrUrl, setCheckoutQrUrl] = useState("");

  const [attendance, setAttendance] = useState<Attendance[]>([]);

  const [scanText, setScanText] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  function setAdminFromEmail(e: string) {
    const norm = e.trim().toLowerCase();
    setIsAdmin(Boolean(ADMIN_EMAIL) && norm === ADMIN_EMAIL);
  }

  async function loadSessionFromSupabase() {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) return;

    const u = session.user;
    setAuthed(true);
    setEmail(u.email || "");
    setAdminFromEmail(u.email || "");

    const lic = (u.user_metadata?.trec_license as string | undefined) || "";
    if (lic) setLicenseInput(normalizeLicense(lic));
  }

  // Detect password recovery link + PASSWORD_RECOVERY event
  useEffect(() => {
    if (!supabase) return;

    // If link contains type=recovery in the hash, show recovery UI
    const hash = window.location.hash || "";
    const qs = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    if (qs.get("type") === "recovery") {
      setRecoveryMode(true);
      setStatus("Set a new password below.");
    }

    // Listen for auth events
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setStatus("Set a new password below.");
      }
      if (session?.user) {
        setAuthed(true);
        setEmail(session.user.email || "");
        setAdminFromEmail(session.user.email || "");
      }
    });

    loadSessionFromSupabase();

    return () => {
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureLicenseSavedToProfile(licRaw: string) {
    if (!supabase) return;
    const lic = normalizeLicense(licRaw);
    if (!isValidLicense(lic)) return;
    await supabase.auth.updateUser({ data: { trec_license: lic } });
  }

  async function login() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim()) return setStatus("Enter a password.");

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: password.trim(),
    });
    if (error) return setStatus(error.message);

    setAuthed(true);
    setAdminFromEmail(email);
    setStatus("Logged in.");
  }

  async function createAccount() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim() || password.trim().length < 8)
      return setStatus("Use a password with at least 8 characters.");

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) {
      return setStatus("Enter full TREC license like 123456-SA (suffix: -SA, -B, or -BB).");
    }

    const { error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password: password.trim(),
      options: { data: { trec_license: lic } },
    });
    if (error) return setStatus(error.message);

    setAuthed(true);
    setAdminFromEmail(email);
    setStatus("Account created.");
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    setAuthed(false);
    setIsAdmin(false);
    setPassword("");
    setStatus("Logged out.");
  }

  async function forgotPassword() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    const e = email.trim().toLowerCase();
    if (!e) return setStatus("Enter your email first, then tap Forgot password.");

    const { error } = await supabase.auth.resetPasswordForEmail(e, {
      redirectTo: window.location.origin,
    });
    if (error) return setStatus(error.message);

    setStatus("Password reset email sent. Open it on this same device/browser.");
  }

  async function setPasswordFromRecovery() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!newPassword || newPassword.length < 8)
      return setStatus("New password must be at least 8 characters.");
    if (newPassword !== newPassword2) return setStatus("Passwords do not match.");

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return setStatus(error.message);

    setRecoveryMode(false);
    setNewPassword("");
    setNewPassword2("");
    setStatus("Password updated. Please log in.");
  }

  /* =========================
     Supabase data: Sessions + Attendance
  ========================= */
  async function refreshSessions() {
    if (!supabase) return;

    const { data, error } = await supabase
      .from("gg_sessions")
      .select("*")
      .order("starts_at", { ascending: false })
      .limit(50);

    if (error) {
      setStatus(error.message);
      return;
    }

    const ui = (data as DBSess[]).map(dbSessToUi);
    setSessions(ui);

    if (!activeSessionId && ui.length) {
      setActiveSessionId(ui[0].id);
    }
  }

  async function refreshAttendanceForActiveSession(sessionId: string) {
    if (!supabase || !sessionId) return;

    const { data, error } = await supabase
      .from("gg_attendance")
      .select("*")
      .eq("session_id", sessionId);

    if (error) {
      setStatus(error.message);
      return;
    }

    const mapped: Attendance[] = (data || []).map((r: any) => ({
      session_id: r.session_id,
      trec_license: r.trec_license,
      checkin_at: r.checkin_at || undefined,
      checkout_at: r.checkout_at || undefined,
      method_checkin: (r.method_checkin as any) || undefined,
      method_checkout: (r.method_checkout as any) || undefined,
      notes: r.notes || undefined,
    }));

    setAttendance(mapped);
  }

  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, isAdmin]);

  useEffect(() => {
    if (!activeSessionId) return;
    refreshAttendanceForActiveSession(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  useEffect(() => {
    (async () => {
      if (!activeSession) {
        setCheckinQrUrl("");
        setCheckoutQrUrl("");
        return;
      }
      const c1 = qrPayload("checkin", activeSession.id, activeSession.checkinCode, activeSession.checkinExpiresAt);
      const c2 = qrPayload("checkout", activeSession.id, activeSession.checkoutCode, activeSession.checkoutExpiresAt);

      setCheckinQrUrl(await QRCode.toDataURL(c1, { width: 520, margin: 2, errorCorrectionLevel: "M" }));
      setCheckoutQrUrl(await QRCode.toDataURL(c2, { width: 520, margin: 2, errorCorrectionLevel: "M" }));
    })();
  }, [activeSession]);

  async function createSessionInSupabase() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!isAdmin) return setStatus("Admin access required.");

    const now = new Date();
    const start = new Date(now.getTime());
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    const checkinExp = new Date(start.getTime() + 90 * 60 * 1000);
    const checkoutExp = new Date(end.getTime() + 10 * 60 * 1000);

    const newSession: Session = {
      id: crypto.randomUUID(),
      title: "New Class Session",
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      checkinExpiresAt: checkinExp.toISOString(),
      checkoutExpiresAt: checkoutExp.toISOString(),
      checkinCode: randCode(),
      checkoutCode: randCode(),
    };

    const { data, error } = await supabase
      .from("gg_sessions")
      .insert([uiSessToDb(newSession)])
      .select("*")
      .single();

    if (error) return setStatus(error.message);

    const created = dbSessToUi(data as any);
    setStatus("Session created.");
    await refreshSessions();
    setActiveSessionId(created.id);
  }

  async function submitScan(method: "scan" | "manual", actionOverride?: "checkin" | "checkout") {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!activeSession) return setStatus("No active session selected.");
    if (!authed) return setStatus("Please log in first.");

    const studentLicense = normalizeLicense(licenseInput);
    if (!isValidLicense(studentLicense)) {
      return setStatus("Enter full TREC license like 123456-SA (suffix: -SA, -B, or -BB).");
    }

    let action: "checkin" | "checkout" | null = actionOverride || null;
    let sessionId = activeSession.id;
    let code: string | null = null;
    let expiresAt: string | null = null;

    if (!actionOverride) {
      try {
        const payload = JSON.parse(scanText);
        action = payload?.action;
        sessionId = payload?.sessionId;
        code = payload?.code;
        expiresAt = payload?.expiresAt;
      } catch {
        return setStatus("Invalid QR data. If scanning fails, paste the QR token text.");
      }
    }

    if (sessionId !== activeSession.id) return setStatus("That code is for a different class session.");
    if (!action) return setStatus("Invalid QR format.");

    if (!actionOverride) {
      if (!code || !expiresAt) return setStatus("Invalid QR format.");
      if (isExpired(expiresAt)) return setStatus("That code has expired for today.");
      if (action === "checkin" && code !== activeSession.checkinCode) return setStatus("Invalid check-in code.");
      if (action === "checkout" && code !== activeSession.checkoutCode) return setStatus("Invalid check-out code.");
    }

    const { data: existing, error: selErr } = await supabase
      .from("gg_attendance")
      .select("*")
      .eq("session_id", activeSession.id)
      .eq("trec_license", studentLicense)
      .maybeSingle();

    if (selErr) return setStatus(selErr.message);

    const baseRow = existing || { session_id: activeSession.id, trec_license: studentLicense };

    if (action === "checkin") {
      if (baseRow.checkin_at) return setStatus("Already checked in.");
      const { error } = await supabase
        .from("gg_attendance")
        .upsert(
          [{
            ...baseRow,
            checkin_at: isoNow(),
            method_checkin: method,
          }],
          { onConflict: "session_id,trec_license" }
        );
      if (error) return setStatus(error.message);
      await refreshAttendanceForActiveSession(activeSession.id);
      return setStatus(method === "manual" ? "Manual check-in recorded." : "Checked in. Welcome!");
    }

    if (action === "checkout") {
      if (!baseRow.checkin_at) return setStatus("Check-in required before check-out.");
      if (baseRow.checkout_at) return setStatus("Already checked out.");
      const { error } = await supabase
        .from("gg_attendance")
        .upsert(
          [{
            ...baseRow,
            checkout_at: isoNow(),
            method_checkout: method,
          }],
          { onConflict: "session_id,trec_license" }
        );
      if (error) return setStatus(error.message);
      await refreshAttendanceForActiveSession(activeSession.id);
      return setStatus(method === "manual" ? "Manual check-out recorded." : "Checked out. Thank you!");
    }
  }

  async function startCamera() {
    setStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setStatus("Camera blocked/unavailable. Paste the QR token text instead.");
    }
  }

  function stopCamera() {
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setCameraOn(false);
  }

  async function captureQR() {
    // @ts-ignore
    if (!("BarcodeDetector" in window))
      return setStatus("QR scan not supported on this browser. Paste token instead.");
    const v = videoRef.current;
    if (!v) return;

    // @ts-ignore
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });

    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const codes = await detector.detect(canvas);

    if (!codes?.length) return setStatus("No QR found. Move closer and try again.");
    setScanText(codes[0].rawValue || "");
    setStatus("QR captured. Tap Submit Scan.");
  }

  const checkedInCount = useMemo(() => {
    if (!activeSession) return 0;
    return attendance.filter((a) => a.session_id === activeSession.id && a.checkin_at).length;
  }, [attendance, activeSession]);

  const checkedOutCount = useMemo(() => {
    if (!activeSession) return 0;
    return attendance.filter((a) => a.session_id === activeSession.id && a.checkout_at).length;
  }, [attendance, activeSession]);

  const canSeeAdminTab = isAdmin;

  return (
    <div style={{ padding: 20, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>GGSORE Attendance</h1>
      <div style={{ opacity: 0.8, marginBottom: 18 }}>
        Checked in: <b>{checkedInCount}</b> â€¢ Checked out: <b>{checkedOutCount}</b>
      </div>

      {status && (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 14 }}>
          {status}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <button
          onClick={() => setTab("student")}
          style={{
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid #ddd",
            fontWeight: 700,
            background: tab === "student" ? "#111" : "#fff",
            color: tab === "student" ? "#fff" : "#111",
          }}
        >
          Student
        </button>

        {canSeeAdminTab && (
          <button
            onClick={() => setTab("admin")}
            style={{
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid #ddd",
              fontWeight: 700,
              background: tab === "admin" ? "#111" : "#fff",
              color: tab === "admin" ? "#fff" : "#111",
            }}
          >
            Admin/Instructor
          </button>
        )}
      </div>

      <hr style={{ margin: "14px 0" }} />

      {tab === "student" && (
        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Login</h2>

          {!recoveryMode ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label>Email</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="info@commercialleasing101.com"
                    style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
                  />
                </div>
                <div>
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
                  />
                  <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
                    Password must be at least <b>8</b> characters.
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label>TREC License Number</label>
                <input
                  value={licenseInput}
                  onChange={(e) => setLicenseInput(e.target.value)}
                  onBlur={() => ensureLicenseSavedToProfile(licenseInput)}
                  placeholder="123456-SA"
                  style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
                />
                <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
                  Numeric portion may be <b>6 or 7</b> digits. Suffix must be <b>-SA</b>, <b>-B</b>, or <b>-BB</b>.
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                {!authed ? (
                  <>
                    <button onClick={login} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff", fontWeight: 800 }}>
                      Log In
                    </button>
                    <button onClick={createAccount} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                      Create Account
                    </button>
                    <button onClick={forgotPassword} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                      Forgot password?
                    </button>
                  </>
                ) : (
                  <button onClick={logout} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                    Log Out
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>Set a New Password</h3>
              <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
                <div>
                  <label>New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
                  />
                </div>
                <div>
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={newPassword2}
                    onChange={(e) => setNewPassword2(e.target.value)}
                    placeholder="Re-type new password"
                    style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
                  />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button onClick={setPasswordFromRecovery} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff", fontWeight: 800 }}>
                    Set New Password
                  </button>
                  <button onClick={() => setRecoveryMode(false)} style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                    Back to login
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "admin" && canSeeAdminTab && (
        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Admin / Instructor</h2>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <button
              onClick={createSessionInSupabase}
              style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff", fontWeight: 800 }}
            >
              Create New Class Session
            </button>

            <button
              onClick={() => refreshSessions()}
              style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 800 }}
            >
              Refresh Sessions
            </button>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <label>Active Session</label>
              <select
                value={activeSessionId}
                onChange={(e) => setActiveSessionId(e.target.value)}
                style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #ddd", padding: "0 12px" }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} â€” {new Date(s.startsAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>

            {activeSession && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Check-in QR</h3>
                  {checkinQrUrl ? <img src={checkinQrUrl} alt="Check-in QR" style={{ width: "100%", maxWidth: 380 }} /> : <div>Loadingâ€¦</div>}
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
                    Expires: {new Date(activeSession.checkinExpiresAt).toLocaleString()}
                  </div>
                </div>

                <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Check-out QR</h3>
                  {checkoutQrUrl ? <img src={checkoutQrUrl} alt="Check-out QR" style={{ width: "100%", maxWidth: 380 }} /> : <div>Loadingâ€¦</div>}
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
                    Expires: {new Date(activeSession.checkoutExpiresAt).toLocaleString()}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

