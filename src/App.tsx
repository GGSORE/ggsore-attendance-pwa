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

const CENTRAL_TZ = "America/Chicago";

// Display an ISO string in Central Time (stable, always CT)
function formatCentral(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

// Convert a datetime-local string (YYYY-MM-DDTHH:mm) interpreted as CENTRAL time into ISO (UTC)
function centralLocalToIso(dtLocal: string) {
  // dtLocal example: "2026-01-28T09:00"
  const [d, t] = dtLocal.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);

  // Start with a UTC guess
  const utcGuess = new Date(Date.UTC(Y, M - 1, D, h, m, 0));

  // Compute Central offset at that moment (handles DST)
  const offsetMin = tzOffsetMinutes(utcGuess, CENTRAL_TZ);

  // Adjust guess by offset to get actual UTC time for that Central wall time
  const corrected = new Date(utcGuess.getTime() - offsetMin * 60 * 1000);
  return corrected.toISOString();
}

// Helper: timezone offset minutes for a given date in a given IANA tz
function tzOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;

  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  return (asUtc - date.getTime()) / 60000;
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

  // Headshot (student photo for attendance verification)
const [headshotPath, setHeadshotPath] = useState<string>("");
const [headshotSignedUrl, setHeadshotSignedUrl] = useState<string>("");
const [headshotUploading, setHeadshotUploading] = useState(false);

   
  // Password reset / recovery flow
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  const [tab, setTab] = useState<"student" | "admin">("student");
  // Admin: session creation (ALL times Central)
const [adminTitle, setAdminTitle] = useState("Commercial Leasing 101™");
const [adminStartLocal, setAdminStartLocal] = useState(""); // datetime-local string
const [adminEndLocal, setAdminEndLocal] = useState("");     // datetime-local string

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

const hs = (u.user_metadata?.headshot_path as string | undefined) || "";
setHeadshotPath(hs);
if (hs) await refreshHeadshotSignedUrl(hs);

   
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

  if (!adminTitle.trim()) return setStatus("Enter a class title.");
  if (!adminStartLocal) return setStatus("Select a class START time (Central).");
  if (!adminEndLocal) return setStatus("Select a class END time (Central).");

  const startIso = centralLocalToIso(adminStartLocal);
  const endIso = centralLocalToIso(adminEndLocal);

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (!(endMs > startMs)) return setStatus("End time must be after start time.");

  // Window rules:
  // Check-in opens 30 min BEFORE start, closes 30 min AFTER start
  const checkinOpensMs = startMs - 30 * 60 * 1000;
  const checkinClosesMs = startMs + 30 * 60 * 1000;

  // Check-out opens 60 min BEFORE end, closes 60 min AFTER end
  const checkoutOpensMs = endMs - 60 * 60 * 1000;
  const checkoutClosesMs = endMs + 60 * 60 * 1000;

  const newSession: Session = {
    id: crypto.randomUUID(),
    title: adminTitle.trim(),
    startsAt: startIso,
    endsAt: endIso,
    checkinExpiresAt: new Date(checkinClosesMs).toISOString(),
    checkoutExpiresAt: new Date(checkoutClosesMs).toISOString(),
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

    if (!headshotPath) {
  return setStatus("Headshot required. Please upload your photo before checking in/out.");
}
     
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

  const nowMs = Date.now();
  const startMs = new Date(activeSession.startsAt).getTime();
  const endMs = new Date(activeSession.endsAt).getTime();

  const checkinOpensMs = startMs - 30 * 60 * 1000;
  const checkinClosesMs = startMs + 30 * 60 * 1000;

  const checkoutOpensMs = endMs - 60 * 60 * 1000;
  const checkoutClosesMs = endMs + 60 * 60 * 1000;

  if (action === "checkin") {
    if (nowMs < checkinOpensMs) return setStatus("Check-in is not open yet.");
    if (nowMs > checkinClosesMs) return setStatus("Check-in has closed for today.");
  }

  if (action === "checkout") {
    if (nowMs < checkoutOpensMs) return setStatus("Check-out is not open yet.");
    if (nowMs > checkoutClosesMs) return setStatus("Check-out has closed for today.");
  }

  if (isExpired(expiresAt)) return setStatus("That code has expired for today.");
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

async function refreshHeadshotSignedUrl(path: string) {
  if (!supabase || !path) return;
  const { data, error } = await supabase.storage.from("gg_headshots").createSignedUrl(path, 60 * 60); // 1 hour
  if (!error && data?.signedUrl) setHeadshotSignedUrl(data.signedUrl);
}

async function uploadHeadshot(file: File) {
  if (!supabase) return setStatus("Supabase is not connected.");
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return setStatus("Please log in again.");

  // basic file checks
  if (!file.type.startsWith("image/")) return setStatus("Please upload an image file.");
  if (file.size > 3 * 1024 * 1024) return setStatus("Please use an image under 3MB.");

  setHeadshotUploading(true);
  setStatus("");

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";
  const path = `${user.id}/headshot.${safeExt}`;

  // upsert so students can replace/update
  const { error: upErr } = await supabase.storage
    .from("gg_headshots")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (upErr) {
    setHeadshotUploading(false);
    return setStatus(upErr.message);
  }

  // store path on the user profile (auth metadata)
  const { error: metaErr } = await supabase.auth.updateUser({ data: { headshot_path: path } });
  if (metaErr) {
    setHeadshotUploading(false);
    return setStatus(metaErr.message);
  }

  setHeadshotPath(path);
  await refreshHeadshotSignedUrl(path);

  setHeadshotUploading(false);
  setStatus("Headshot uploaded. Thank you!");
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
       Checked in: <b>{checkedInCount}</b> | Checked out: <b>{checkedOutCount}</b>
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

{/* =========================
    Headshot Upload (REQUIRED)
========================= */}
<div className="card" style={{ marginBottom: 14 }}>
  <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>
    Upload a photo (required for attendance verification)
  </div>

  <div className="small" style={{ fontSize: 11, opacity: 0.9, lineHeight: 1.25 }}>
    We use your headshot to help confirm identity during class check-in and check-out. It helps the instructor verify attendance without needing to exchange sensitive ID information.
    Your photo is used only for class purposes and is visible only to your instructor/admin.{" "}
    <a
      href="https://www.law.cornell.edu/regulations/texas/22-Tex-Admin-Code-SS-535-65"
      target="_blank"
      rel="noreferrer"
      style={{ textDecoration: "underline", fontWeight: 800 }}
    >
      Learn More
    </a>
  </div>

  <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
    {headshotSignedUrl ? (
      <img
        src={headshotSignedUrl}
        alt="Headshot preview"
        style={{ width: 88, height: 88, borderRadius: 16, objectFit: "cover", border: "1px solid #ddd" }}
      />
    ) : (
      <div style={{ width: 88, height: 88, borderRadius: 16, border: "1px dashed #bbb", display: "grid", placeItems: "center", opacity: 0.75 }}>
        No photo
      </div>
    )}

    <div style={{ display: "grid", gap: 10 }}>
      <input
        type="file"
        accept="image/*"
        capture="user"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadHeadshot(f);
        }}
      />

      <div className="small" style={{ fontSize: 11, opacity: 0.85 }}>
        Use a clear front-facing photo. Hats/sunglasses off if possible.
      </div>

      {headshotUploading && (
        <div className="small" style={{ fontSize: 11, opacity: 0.85 }}>
          Uploading…
        </div>
      )}
    </div>
  </div>
</div>

       
      {/* =========================
    Student Scan Panel
========================= */}
<div style={{ marginTop: 18, border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
  <h3 style={{ marginTop: 0 }}>Check In / Check Out</h3>

  {!authed ? (
    <div style={{ opacity: 0.85 }}>
      Log in first, then scan the QR code shown on the classroom screen.
    </div>
  ) : !activeSession ? (
    <div style={{ opacity: 0.85 }}>
      No class session is active yet. Please wait for the instructor to open today’s session.
    </div>
  ) : (
    <>
      <div className="small" style={{ marginBottom: 10, opacity: 0.85 }}>
        Active session: <b>{activeSession.title}</b> {" — "} {formatCentral(activeSession.startsAt)}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!cameraOn ? (
            <button
              onClick={startCamera}
              style={{
                padding: "14px 18px",
                borderRadius: 14,
                border: "1px solid #111",
                background: "#111",
                color: "#fff",
                fontWeight: 900,
                fontSize: 16,
              }}
            >
              Turn On Camera
            </button>
          ) : (
            <>
              <button
                onClick={captureQR}
                style={{
                  padding: "14px 18px",
                  borderRadius: 14,
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  fontWeight: 900,
                  fontSize: 16,
                }}
              >
                Scan QR Now
              </button>

              <button
                onClick={stopCamera}
                style={{
                  padding: "14px 18px",
                  borderRadius: 14,
                  border: "1px solid #ddd",
                  background: "#fff",
                  fontWeight: 900,
                  fontSize: 16,
                }}
              >
                Stop Camera
              </button>
            </>
          )}
        </div>

        {/* Camera Preview */}
        {cameraOn && (
          <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
            <div className="small" style={{ marginBottom: 8, opacity: 0.85 }}>
              Camera preview (aim at the QR code)
            </div>
            <video
              ref={videoRef}
              style={{ width: "100%", maxWidth: 520, borderRadius: 14 }}
              playsInline
              muted
            />
          </div>
        )}

      {isAdmin && (
  <div>
    <label style={{ fontWeight: 700 }}>QR Token (admin fallback)</label>
    <textarea
      value={scanText}
      onChange={(e) => setScanText(e.target.value)}
      placeholder="Paste QR token text here if scanning fails"
      style={{
        width: "100%",
        minHeight: 92,
        borderRadius: 14,
        border: "1px solid #ddd",
        padding: 12,
        fontSize: 14,
      }}
    />
  </div>
)}


        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => submitScan("scan")}
            style={{
              padding: "14px 18px",
              borderRadius: 14,
              border: "1px solid #111",
              background: "#111",
              color: "#fff",
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            Submit Scan
          </button>

          <button
            onClick={() => submitScan("manual", "checkin")}
            style={{
              padding: "14px 18px",
              borderRadius: 14,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            Manual Check-In
          </button>

          <button
            onClick={() => submitScan("manual", "checkout")}
            style={{
              padding: "14px 18px",
              borderRadius: 14,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            Manual Check-Out
          </button>
        </div>

        <div className="small" style={{ opacity: 0.85 }}>
          Tip: If the camera button doesn’t work, use “QR Token” paste + Submit Scan.
        </div>
      </div>
    </>
  )}
</div>
 
       
      {tab === "admin" && canSeeAdminTab && (
        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Admin / Instructor</h2>
<div style={{ display: "grid", gap: 12, marginBottom: 12, background: "#8B0000", padding: 16, borderRadius: 16, color: "#fff" }}>
  <div>
    <label style={{ color: "#fff", fontWeight: 600 }}>CLASS TITLE</label>

    <select
      value={adminTitle}
      onChange={(e) => setAdminTitle(e.target.value)}
      style={{
        width: "100%",
        height: 46,
        borderRadius: 12,
        border: "1px solid #fff",
        background: "#fff",
        color: "#111",
        padding: "0 12px",
        fontSize: 16
      }}
    >
      <option>Commercial Leasing 101™</option>
      <option>Commercial Leasing Contracts 101™</option>
      <option>Commercial Letters of Intent 101 for Leasing & Sales™</option>
      <option>Things You Need to Know About Practicing Law in Real Estate™</option>
      <option>Deal Dynamics: Deciphering Commercial Real Estate Contracts™</option>
      <option>Commercial Sales 101: From Client to Contract to Close™</option>
      <option>Commercial Property Management 101 - (Apartments Not Included)™</option>
      <option>Lights, Camera, Impact! REALTORS® Guide to Success on Camera™</option>
      <option>High Stakes: Seed-to-Sale Hemp Law Changes in Texas™ (3 hours)</option>
      <option>First, It's Not Marijuana: Hemp Laws & Texas Real Estate (2 hours)</option>
    </select>
  </div>

  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
    <div>
      <label style={{ color: "#fff", fontWeight: 600 }}>START (Central)</label>

      <input
        type="datetime-local"
        value={adminStartLocal}
        onChange={(e) => setAdminStartLocal(e.target.value)}
        style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #fff", background: "#fff", color: "#111", padding: "0 12px" }}
      />
    </div>

    <div>
      <label style={{ color: "#fff", fontWeight: 600 }}>END (Central)</label>

      <input
        type="datetime-local"
        value={adminEndLocal}
        onChange={(e) => setAdminEndLocal(e.target.value)}
        style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #fff", background: "#fff", color: "#111", padding: "0 12px" }}
      />
    </div>
  </div>

  <div style={{ fontSize: 13, opacity: 0.9 }}>
    Check-in window: <b>30 min before</b> start through <b>30 min after</b> start.
    Check-out window: <b>60 min before</b> end through <b>60 min after</b> end.
  </div>
</div>

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
                    {s.title} {" — "} {new Date(s.startsAt).toLocaleString()}
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

