import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

const BRAND = {
  schoolName: "The Guillory Group School of Real Estate",
  logo: "/logo.png",
};

// ===== ADMIN ACCESS CONTROL =====
const ADMIN_EMAILS = ["michicaguillory@outlook.com"];

// ===== TREC LICENSE FORMAT =====
// Numeric portion: 6 or 7 digits (leading zero allowed)
// Suffix: -SA, -B, or -BB (required)
// Examples: 123456-SA, 0123456-B, 1000001-BB
function normalizeLicense(raw: string) {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}
function isValidLicense(raw: string) {
  const v = normalizeLicense(raw);
  return /^\d{6,7}-(SA|B|BB)$/.test(v);
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

type Session = {
  id: string;
  title: string;
  startsAt: string;          // ISO
  endsAt: string;            // ISO
  checkinExpiresAt: string;  // ISO
  checkoutExpiresAt: string; // ISO
  checkinCode: string;       // static session code
  checkoutCode: string;      // static session code
};

type RosterRow = {
  trec_license: string; // normalized
  first_name?: string;
  last_name?: string;
  notes?: string;
};

type Attendance = {
  session_id: string;
  trec_license: string; // normalized
  checkin_at?: string;
  checkout_at?: string;
  method_checkin?: "scan" | "manual";
  method_checkout?: "scan" | "manual";
  notes?: string;
};

function isoNow() {
  return new Date().toISOString();
}

function randCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function toLocalInputValue(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(v: string) {
  return new Date(v).toISOString();
}

// Expect CSV headers like:
// trec_license,first_name,last_name,notes
// or "license" / "trec" variants – we’ll try to detect.
function csvToRoster(text: string): RosterRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const idx = (name: string) => headers.indexOf(name);

  const iLic =
    idx("trec_license") >= 0 ? idx("trec_license")
    : idx("license") >= 0 ? idx("license")
    : idx("license_no") >= 0 ? idx("license_no")
    : idx("trec") >= 0 ? idx("trec")
    : -1;

  const iFirst = idx("first_name");
  const iLast = idx("last_name");
  const iNotes = idx("notes");

  return lines
    .slice(1)
    .map((row) => {
      const cols = row.split(",").map((c) => c.trim());
      const raw = iLic >= 0 ? (cols[iLic] || "") : "";
      const trec_license = normalizeLicense(raw);

      return {
        trec_license,
        first_name: iFirst >= 0 ? cols[iFirst] : undefined,
        last_name: iLast >= 0 ? cols[iLast] : undefined,
        notes: iNotes >= 0 ? cols[iNotes] : undefined,
      };
    })
    .filter((r) => isValidLicense(r.trec_license));
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCSV(records: Attendance[]) {
  const header = [
    "session_id",
    "trec_license",
    "checkin_at",
    "checkout_at",
    "method_checkin",
    "method_checkout",
    "notes",
  ].join(",");

  const rows = records.map((r) =>
    [
      r.session_id,
      r.trec_license,
      r.checkin_at || "",
      r.checkout_at || "",
      r.method_checkin || "",
      r.method_checkout || "",
      (r.notes || "").replace(/\n/g, " ").replace(/,/g, " "),
    ].join(",")
  );

  return [header, ...rows].join("\n");
}

// QR payload is static but includes an expiration window.
// (Later we can sign this payload. MVP proves workflow.)
function qrPayload(
  action: "checkin" | "checkout",
  sessionId: string,
  code: string,
  expiresAt: string
) {
  return JSON.stringify({ action, sessionId, code, expiresAt });
}

function isExpired(expiresAt: string) {
  return Date.now() > new Date(expiresAt).getTime();
}

export default function App() {
  // Splash Screen
  const [showSplash, setShowSplash] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1100);
    return () => clearTimeout(t);
  }, []);

  // Tabs
  const [tab, setTab] = useState<"student" | "admin">("student");

  // Auth
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Login fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // License is REQUIRED (account + login + attendance)
  const [licenseInput, setLicenseInput] = useState("");

  // Password recovery
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  const [status, setStatus] = useState<string>("");

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  // QR images
  const [checkinQrUrl, setCheckinQrUrl] = useState("");
  const [checkoutQrUrl, setCheckoutQrUrl] = useState("");

  // Roster + Attendance (local persistence for now)
  const [rosterCSV, setRosterCSV] = useState("trec_license,first_name,last_name,notes\n");
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  // Student scan (camera optional)
  const [scanText, setScanText] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  function setAdminFromEmail(e: string) {
    const norm = e.trim().toLowerCase();
    setIsAdmin(ADMIN_EMAILS.map((x) => x.toLowerCase()).includes(norm));
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

  // Detect recovery link (Supabase uses URL hash)
  useEffect(() => {
    const hash = window.location.hash || "";
    const qs = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const type = qs.get("type");
    if (type === "recovery") {
      setRecoveryMode(true);
      setStatus("Create a new password below.");
    }
    // Also restore existing login session (stay logged in)
    loadSessionFromSupabase();
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

    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim()) return setStatus("Enter a password.");

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) {
      return setStatus(
        "Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB)."
      );
    }

    if (supabase) {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password.trim(),
      });
      if (error) return setStatus(error.message);

      await ensureLicenseSavedToProfile(lic);
    }

    setAuthed(true);
    setAdminFromEmail(email);
    setStatus("Logged in.");
  }

  async function createAccount() {
    setStatus("");

    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim() || password.trim().length < 8)
      return setStatus("Use a password with at least 8 characters.");

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) {
      return setStatus(
        "Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB)."
      );
    }

    if (supabase) {
      const { error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password: password.trim(),
        options: { data: { trec_license: lic } },
      });
      if (error) return setStatus(error.message);
    }

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

    setStatus("Password reset email sent. Open it on this same device to set a new password.");
  }

  async function setPasswordFromRecovery() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!newPassword || newPassword.length < 8) return setStatus("New password must be at least 8 characters.");
    if (newPassword !== newPassword2) return setStatus("Passwords do not match.");

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return setStatus(error.message);

    setRecoveryMode(false);
    setNewPassword("");
    setNewPassword2("");
    setStatus("Password updated. Please log in.");
  }

  // Load/save locally (roster + attendance + sessions)
  useEffect(() => {
    const raw = localStorage.getItem("ggsore_attendance_pwa_v2");
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      setSessions(p.sessions || []);
      setActiveSessionId(p.activeSessionId || "");
      setRoster(p.roster || []);
      setAttendance(p.attendance || []);
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "ggsore_attendance_pwa_v2",
      JSON.stringify({ sessions, activeSessionId, roster, attendance })
    );
  }, [sessions, activeSessionId, roster, attendance]);

  // Create a default session if none exist
  useEffect(() => {
    if (sessions.length) return;

    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    const checkinExp = new Date(start.getTime() + 90 * 60 * 1000);
    const checkoutExp = new Date(end.getTime() + 10 * 60 * 1000);

    const s: Session = {
      id: crypto.randomUUID(),
      title: "Demo Class Session",
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      checkinExpiresAt: checkinExp.toISOString(),
      checkoutExpiresAt: checkoutExp.toISOString(),
      checkinCode: randCode(),
      checkoutCode: randCode(),
    };

    setSessions([s]);
    setActiveSessionId(s.id);
  }, [sessions.length]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  // Generate QR codes for the active session
  useEffect(() => {
    (async () => {
      if (!activeSession) {
        setCheckinQrUrl("");
        setCheckoutQrUrl("");
        return;
      }
      const c1 = qrPayload("checkin", activeSession.id, activeSession.checkinCode, activeSession.checkinExpiresAt);
      const c2 = qrPayload("checkout", activeSession.id, activeSession.checkoutCode, activeSession.checkoutExpiresAt);

      setCheckinQrUrl(
        await QRCode.toDataURL(c1, { width: 520, margin: 2, errorCorrectionLevel: "M" })
      );
      setCheckoutQrUrl(
        await QRCode.toDataURL(c2, { width: 520, margin: 2, errorCorrectionLevel: "M" })
      );
    })();
  }, [activeSession]);

  function importRoster() {
    const r = csvToRoster(rosterCSV);
    setRoster(r);
    setStatus(`Roster loaded: ${r.length} student(s) with valid TREC license format.`);
  }

  function rosterContains(licenseRaw: string) {
    const lic = normalizeLicense(licenseRaw);
    return roster.some((r) => r.trec_license === lic);
  }

  function upsertAttendance(sessionId: string, trec_license_raw: string) {
    const trec_license = normalizeLicense(trec_license_raw);
    const idx = attendance.findIndex((a) => a.session_id === sessionId && a.trec_license === trec_license);
    if (idx >= 0) return { rec: attendance[idx], idx };
    const rec: Attendance = { session_id: sessionId, trec_license };
    const next = [...attendance, rec];
    setAttendance(next);
    return { rec, idx: next.length - 1 };
  }

  function updateAttendance(idx: number, rec: Attendance) {
    const next = [...attendance];
    next[idx] = rec;
    setAttendance(next);
  }

  async function submitScan(
    method: "scan" | "manual",
    actionOverride?: "checkin" | "checkout",
    licenseOverride?: string
  ) {
    setStatus("");
    if (!activeSession) return setStatus("No active session selected.");

    // Use override if provided, else use the current licenseInput (auto-filled after login)
    const studentLicense = normalizeLicense(licenseOverride || licenseInput);

    if (!isValidLicense(studentLicense)) {
      return setStatus("Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB).");
    }

    // If student is scanning, require login + roster match
    if (method === "scan") {
      if (!authed) return setStatus("Please log in first.");
      if (!rosterContains(studentLicense)) {
        return setStatus("That TREC license number is not on the paid roster for this class session.");
      }
    }

    // If scanning QR, parse payload
    let payload: any = null;
    if (!actionOverride) {
      try {
        payload = JSON.parse(scanText);
      } catch {
        return setStatus("Invalid QR data. If scanning fails, paste the QR token text.");
      }
    }

    const action = actionOverride || payload?.action;
    const sessionId = payload?.sessionId || activeSession.id;
    const code = payload?.code;
    const expiresAt = payload?.expiresAt;

    if (sessionId !== activeSession.id) return setStatus("That code is for a different class session.");
    if (!action) return setStatus("Invalid QR format.");

    if (method === "scan") {
      if (!code || !expiresAt) return setStatus("Invalid QR format.");
      if (isExpired(expiresAt)) return setStatus("That code has expired for today.");

      if (action === "checkin" && code !== activeSession.checkinCode) return setStatus("Invalid check-in code.");
      if (action === "checkout" && code !== activeSession.checkoutCode) return setStatus("Invalid check-out code.");
    }

    const { rec, idx } = upsertAttendance(activeSession.id, studentLicense);

    if (action === "checkin") {
      if (rec.checkin_at) return setStatus(`Already checked in (${new Date(rec.checkin_at).toLocaleTimeString()}).`);
      const updated: Attendance = { ...rec, checkin_at: isoNow(), method_checkin: method };
      updateAttendance(idx, updated);
      return setStatus(method === "manual" ? "Manual check-in recorded." : "Checked in. Welcome!");
    }

    if (action === "checkout") {
      if (!rec.checkin_at) return setStatus("Check-in required before check-out.");
      if (rec.checkout_at) return setStatus(`Already checked out (${new Date(rec.checkout_at).toLocaleTimeString()}).`);
      const updated: Attendance = { ...rec, checkout_at: isoNow(), method_checkout: method };
      updateAttendance(idx, updated);
      return setStatus(method === "manual" ? "Manual check-out recorded." : "Checked out. Thank you!");
    }

    setStatus("Unknown action.");
  }

  // Optional camera scan support
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
    if (!("BarcodeDetector" in window)) return setStatus("QR scan not supported on this browser. Paste token instead.");
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

  // Admin: Create session UI
  const [newTitle, setNewTitle] = useState("");
  const [newStart, setNewStart] = useState(toLocalInputValue(new Date().toISOString()));
  const [newEnd, setNewEnd] = useState(toLocalInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()));
  const [newCheckinExp, setNewCheckinExp] = useState(toLocalInputValue(new Date(Date.now() + 90 * 60 * 1000).toISOString()));
  const [newCheckoutExp, setNewCheckoutExp] = useState(toLocalInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()));

  function createSession() {
    const s: Session = {
      id: crypto.randomUUID(),
      title: newTitle.trim() || "Untitled Session",
      startsAt: fromLocalInputValue(newStart),
      endsAt: fromLocalInputValue(newEnd),
      checkinExpiresAt: fromLocalInputValue(newCheckinExp),
      checkoutExpiresAt: fromLocalInputValue(newCheckoutExp),
      checkinCode: randCode(),
      checkoutCode: randCode(),
    };
    setSessions((prev) => [s, ...prev]);
    setActiveSessionId(s.id);
    setNewTitle("");
    setStatus("Session created.");
  }

  if (showSplash) {
    return (
      <div className="splash" aria-label="Loading">
        <div className="splashInner">
          <img className="splashLogo" src={BRAND.logo} alt="GGSORE logo" />
          <div style={{ fontSize: 20, fontWeight: 700 }}>{BRAND.schoolName}</div>
          <div className="small" style={{ marginTop: 6 }}>Attendance App Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="header">
        <div className="container row" style={{ justifyContent: "space-between" }}>
          <div className="brand">
            <img className="logo" src={BRAND.logo} alt="GGSORE logo" />
            <div>
              <p className="h1">{BRAND.schoolName}</p>
              <p className="h2">Student Check-In / Check-Out</p>
            </div>
          </div>

          <div className="row">
            <span className="badge">Checked in: {checkedInCount}</span>
            <span className="badge">Checked out: {checkedOutCount}</span>
          </div>
        </div>
      </div>

      <div className="container">
        {!supabase && (
          <div className="card" style={{ marginBottom: 14 }}>
            <b>Supabase not connected yet.</b>
            <div className="small" style={{ marginTop: 6 }}>
              Add <b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b> in Vercel. For now, the app runs using saved device storage.
            </div>
          </div>
        )}

        <div className="tabs" role="tablist" aria-label="App sections">
          <button className={`tab ${tab === "student" ? "tabActive" : ""}`} onClick={() => setTab("student")}>
            Student
          </button>

          {isAdmin && (
            <button className={`tab ${tab === "admin" ? "tabActive" : ""}`} onClick={() => setTab("admin")}>
              Admin/Instructor
            </button>
          )}
        </div>

        <hr />

        {status && (
          <div className="card" aria-live="polite" style={{ marginBottom: 14 }}>
            {status}
          </div>
        )}

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b style={{ fontSize: 18 }}>Active Session</b>
              <div className="small" style={{ marginTop: 4 }}>Select the class session for today.</div>
            </div>

            <div style={{ minWidth: 280, flex: 1 }}>
              <label>Session</label>
              <select
                value={activeSessionId}
                onChange={(e) => setActiveSessionId(e.target.value)}
                style={{ height: 56, borderRadius: 18, border: "1px solid var(--border)", fontSize: 18, padding: "0 14px" }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {new Date(s.startsAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {activeSession && (
            <div className="small" style={{ marginTop: 10 }}>
              Check-in expires: <b>{new Date(activeSession.checkinExpiresAt).toLocaleString()}</b> · Check-out expires:{" "}
              <b>{new Date(activeSession.checkoutExpiresAt).toLocaleString()}</b>
            </div>
          )}
        </div>

        {tab === "student" && (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Student Login</b>

              <div className="small" style={{ marginTop: 6 }}>
                Required: full TREC license number including suffix <b>-SA</b>, <b>-B</b>, or <b>-BB</b>. Example: <b>123456-SA</b>
              </div>

              <div className="row" style={{ marginTop: 14 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
                </div>

                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Password</label>
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="At least 8 characters" />
                  <div className="small" style={{ marginTop: 6 }}>
                    Password must be at least <b>8</b> characters. (Password can be reset later.)
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
                  inputMode="text"
                />
                <div className="small" style={{ marginTop: 6 }}>
                  The numeric portion may be 6 or 7 digits. Suffix must be SA, B, or BB.
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                {!recoveryMode ? (
                  !authed ? (
                    <>
                      <button className="btn btnPrimary" onClick={login}>Log In</button>
                      <button className="btn btnSecondary" onClick={createAccount}>Create Account</button>
                      <button className="btn btnSecondary" onClick={forgotPassword}>Forgot password?</button>
                    </>
                  ) : (
                    <button className="btn btnSecondary" onClick={logout}>Log Out</button>
                  )
                ) : (
                  <button className="btn btnSecondary" onClick={() => setRecoveryMode(false)}>Back to login</button>
                )}
              </div>

              {recoveryMode && (
                <div style={{ marginTop: 12 }}>
                  <label>New Password</label>
                  <input
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    type="password"
                    placeholder="At least 8 characters"
                  />
                  <div style={{ marginTop: 10 }}>
                    <label>Confirm New Password</label>
                    <input
                      value={newPassword2}
                      onChange={(e) => setNewPassword2(e.target.value)}
                      type="password"
                      placeholder="Re-type new password"
                    />
                  </div>

                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn btnPrimary" onClick={setPasswordFromRecovery}>Set New Password</button>
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <b style={{ fontSize: 18 }}>Check-In / Check-Out</b>
              <div className="small" style={{ marginTop: 6 }}>
                Scan the QR code shown in class. If scanning isn’t supported, paste the QR token text and tap Submit Scan.
              </div>

              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn btnSecondary" onClick={() => (cameraOn ? stopCamera() : startCamera())}>
                  {cameraOn ? "Stop Camera" : "Open Camera"}
                </button>
                <button className="btn btnSecondary" onClick={captureQR} disabled={!cameraOn}>
                  Capture QR
                </button>
              </div>

              {cameraOn && (
                <div style={{ marginTop: 12 }}>
                  <video ref={videoRef} style={{ width: "100%", borderRadius: 18, border: "1px solid var(--border)" }} />
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <label>QR Token</label>
                <textarea value={scanText} onChange={(e) => setScanText(e.target.value)} placeholder="Paste QR token text here if needed…" />
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btnPrimary" onClick={() => submitScan("scan")}>Submit Scan</button>
              </div>
            </div>
          </>
        )}

        {tab === "admin" && (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Create a Session (Admin)</b>
              <div className="small" style={{ marginTop: 6 }}>
                Generates Check-In and Check-Out codes. Codes are static but time-boxed by expiration.
              </div>

              <div style={{ marginTop: 12 }}>
                <label>Session Title</label>
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Commercial Leasing 101 — Day 1" />
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Start</label>
                  <input type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>End</label>
                  <input type="datetime-local" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Check-In Expires</label>
                  <input type="datetime-local" value={newCheckinExp} onChange={(e) => setNewCheckinExp(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Check-Out Expires</label>
                  <input type="datetime-local" value={newCheckoutExp} onChange={(e) => setNewCheckoutExp(e.target.value)} />
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btnPrimary" onClick={createSession}>Create Session</button>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Session QR Codes (Display in Classroom)</b>

              {!activeSession ? (
                <div className="small" style={{ marginTop: 8 }}>Select or create a session to generate QR codes.</div>
              ) : (
                <div className="row" style={{ marginTop: 12, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <b>Check-In QR</b>
                    <div className="small">Valid until {new Date(activeSession.checkinExpiresAt).toLocaleString()}</div>
                    {checkinQrUrl && (
                      <img
                        src={checkinQrUrl}
                        alt="Check-in QR"
                        style={{
                          width: "100%",
                          maxWidth: 420,
                          borderRadius: 18,
                          border: "1px solid var(--border)",
                          marginTop: 10,
                        }}
                      />
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 280 }}>
                    <b>Check-Out QR</b>
                    <div className="small">Valid until {new Date(activeSession.checkoutExpiresAt).toLocaleString()}</div>
                    {checkoutQrUrl && (
                      <img
                        src={checkoutQrUrl}
                        alt="Check-out QR"
                        style={{
                          width: "100%",
                          maxWidth: 420,
                          borderRadius: 18,
                          border: "1px solid var(--border)",
                          marginTop: 10,
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Paid Roster Import (Excel → CSV)</b>
              <div className="small" style={{ marginTop: 6 }}>
                Paste a CSV with a TREC license column. Header examples: <b>trec_license</b> or <b>license</b>. Format must be like <b>123456-SA</b>.
              </div>

              <div style={{ marginTop: 12 }}>
                <label>Roster CSV</label>
                <textarea value={rosterCSV} onChange={(e) => setRosterCSV(e.target.value)} />
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btnPrimary" onClick={importRoster}>Load Roster</button>
                <span className="badge">Roster: {roster.length}</span>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Manual Overrides (Phone Trouble)</b>
              <div className="small" style={{ marginTop: 6 }}>
                Enter a TREC license number and record check-in or check-out manually.
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>TREC License Number</label>
                  <input placeholder="123456-SA" value={licenseInput} onChange={(e) => setLicenseInput(e.target.value)} />
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btnSecondary" onClick={() => submitScan("manual", "checkin", licenseInput)}>Manual Check-In</button>
                <button className="btn btnSecondary" onClick={() => submitScan("manual", "checkout", licenseInput)}>Manual Check-Out</button>
              </div>
            </div>

            <div className="card">
              <b style={{ fontSize: 18 }}>Export Attendance</b>
              <div className="small" style={{ marginTop: 6 }}>
                Exports the attendance log for the active session.
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn btnPrimary"
                  onClick={() => {
                    if (!activeSession) return setStatus("No active session selected.");
                    const rows = attendance.filter((a) => a.session_id === activeSession.id);
                    downloadText(`attendance_${activeSession.title.replace(/\s+/g, "_")}.csv`, toCSV(rows));
                    setStatus("Attendance CSV downloaded.");
                  }}
                >
                  Download CSV
                </button>
              </div>
            </div>
          </>
        )}

        <hr />

        <div className="small">
          Install on phone: open this link → Share/Options → <b>Add to Home Screen</b>.
        </div>
      </div>
    </div>
  );
}
