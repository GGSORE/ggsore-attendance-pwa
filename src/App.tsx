import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

const BRAND = {
  schoolName: "The Guillory Group School of Real Estate",
  logo: "/logo.png" // we’ll upload this into /public as logo.png
};

// ===== ADMIN ACCESS CONTROL =====
const ADMIN_EMAILS = ["michicaguillory@outlook.com"];

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// App runs in local MVP mode until Supabase keys are present (no crashing).
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
  email: string;
  first_name?: string;
  last_name?: string;
  license_no?: string;
};

type Attendance = {
  session_id: string;
  email: string;
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

function csvToRoster(text: string): RosterRow[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(",")
    .map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const idx = (name: string) => headers.indexOf(name);
  const iEmail = idx("email");
  const iFirst = idx("first_name");
  const iLast = idx("last_name");
  const iLic = idx("license_no");

  return lines
    .slice(1)
    .map(row => {
      const cols = row.split(",").map(c => c.trim());
      const email = (cols[iEmail] || "").toLowerCase();
      return {
        email,
        first_name: iFirst >= 0 ? cols[iFirst] : undefined,
        last_name: iLast >= 0 ? cols[iLast] : undefined,
        license_no: iLic >= 0 ? cols[iLic] : undefined
      };
    })
    .filter(r => r.email.includes("@"));
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
    "email",
    "checkin_at",
    "checkout_at",
    "method_checkin",
    "method_checkout",
    "notes"
  ].join(",");

  const rows = records.map(r =>
    [
      r.session_id,
      r.email,
      r.checkin_at || "",
      r.checkout_at || "",
      r.method_checkin || "",
      r.method_checkout || "",
      (r.notes || "").replace(/\n/g, " ").replace(/,/g, " ")
    ].join(",")
  );

  return [header, ...rows].join("\n");
}

// QR payload is static but includes an expiration window.
// (In production we can sign this payload, but this MVP proves the workflow.)
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
  // Splash Screen (Option B: splash + header branding)
  const [showSplash, setShowSplash] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1100);
    return () => clearTimeout(t);
  }, []);

  // Tabs
  const [tab, setTab] = useState<"student" | "admin">("student");

  // Auth (local UI; becomes real when Supabase keys are set)
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [status, setStatus] = useState<string>("");

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  // QR images
  const [checkinQrUrl, setCheckinQrUrl] = useState("");
  const [checkoutQrUrl, setCheckoutQrUrl] = useState("");

  // Roster + Attendance (local MVP persistence)
  const [rosterCSV, setRosterCSV] = useState("email,first_name,last_name,license_no\n");
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  // Student scan (camera optional)
  const [scanText, setScanText] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  // Load/save locally (works even before Supabase)
  useEffect(() => {
    const raw = localStorage.getItem("ggsore_attendance_pwa_v1");
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
      "ggsore_attendance_pwa_v1",
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
      checkoutCode: randCode()
    };

    setSessions([s]);
    setActiveSessionId(s.id);
  }, [sessions.length]);

  const activeSession = useMemo(
    () => sessions.find(s => s.id === activeSessionId) || null,
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
      const c1 = qrPayload(
        "checkin",
        activeSession.id,
        activeSession.checkinCode,
        activeSession.checkinExpiresAt
      );
      const c2 = qrPayload(
        "checkout",
        activeSession.id,
        activeSession.checkoutCode,
        activeSession.checkoutExpiresAt
      );

      setCheckinQrUrl(
        await QRCode.toDataURL(c1, {
          width: 520,
          margin: 2,
          errorCorrectionLevel: "M"
        })
      );

      setCheckoutQrUrl(
        await QRCode.toDataURL(c2, {
          width: 520,
          margin: 2,
          errorCorrectionLevel: "M"
        })
      );
    })();
  }, [activeSession]);

  async function login() {
    setStatus("");
    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim()) return setStatus("Enter a password.");

    if (supabase) {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password: password.trim()
      });
      if (error) return setStatus(error.message);
    }

    setAuthed(true);
    setIsAdmin(ADMIN_EMAILS.includes(email.trim().toLowerCase()));

    setStatus("Logged in.");
  }

  async function createAccount() {
    setStatus("");
    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim() || password.trim().length < 8)
      return setStatus("Use a password with at least 8 characters.");

    if (supabase) {
      const { error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password: password.trim()
      });
      if (error) return setStatus(error.message);
    }

    setAuthed(true);
    setIsAdmin(ADMIN_EMAILS.includes(email.trim().toLowerCase()));

    setStatus("Account created.");
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    setAuthed(false);
    setPassword("");
    setStatus("Logged out.");
  }

  function importRoster() {
    const r = csvToRoster(rosterCSV);
    setRoster(r);
    setStatus(`Roster loaded: ${r.length} student(s).`);
  }

  function rosterContains(emailToCheck: string) {
    return roster.some(r => r.email.toLowerCase() === emailToCheck.toLowerCase());
  }

  function upsertAttendance(sessionId: string, studentEmail: string): { rec: Attendance; idx: number } {
    const e = studentEmail.toLowerCase();
    const idx = attendance.findIndex(a => a.session_id === sessionId && a.email === e);
    if (idx >= 0) return { rec: attendance[idx], idx };
    const rec: Attendance = { session_id: sessionId, email: e };
    const next = [...attendance, rec];
    setAttendance(next);
    return { rec, idx: next.length - 1 };
  }

  function updateAttendance(idx: number, rec: Attendance) {
    const next = [...attendance];
    next[idx] = rec;
    setAttendance(next);
  }

  function submitScan(method: "scan" | "manual", actionOverride?: "checkin" | "checkout", emailOverride?: string) {
    setStatus("");
    if (!activeSession) return setStatus("No active session selected.");
    const studentEmail = (emailOverride || email).trim().toLowerCase();
    if (!studentEmail.includes("@")) return setStatus("Enter a valid email.");

    if (method === "scan" && !authed) return setStatus("Please log in first.");

    // Students scanning must be registered; admin manual override can bypass roster.
    if (method === "scan" && !rosterContains(studentEmail)) {
      return setStatus("Not on the roster for this session. (Admin can manually override.)");
    }

    let payload: any = null;
    if (!actionOverride) {
      try {
        payload = JSON.parse(scanText);
      } catch {
        return setStatus("Invalid QR data. If your phone can’t scan, paste the QR text.");
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

    const { rec, idx } = upsertAttendance(activeSession.id, studentEmail);

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

  // Optional camera scan support (works on many browsers but not all)
  async function startCamera() {
    setStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setStatus("Camera blocked/unavailable. Use token paste instead.");
    }
  }

  function stopCamera() {
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
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
    return attendance.filter(a => a.session_id === activeSession.id && a.checkin_at).length;
  }, [attendance, activeSession]);

  const checkedOutCount = useMemo(() => {
    if (!activeSession) return 0;
    return attendance.filter(a => a.session_id === activeSession.id && a.checkout_at).length;
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
      checkoutCode: randCode()
    };
    setSessions(prev => [s, ...prev]);
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
              Add <b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b> when we deploy to Vercel.
              For now, the app runs locally in the browser using saved device storage.
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
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {new Date(s.startsAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {activeSession && (
            <div className="small" style={{ marginTop: 10 }}>
              Check-in expires: <b>{new Date(activeSession.checkinExpiresAt).toLocaleString()}</b> ·
              Check-out expires: <b>{new Date(activeSession.checkoutExpiresAt).toLocaleString()}</b>
            </div>
          )}
        </div>

        {tab === "student" && (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Student Login</b>
              <div className="small" style={{ marginTop: 6 }}>
                Students create an account for the school, then scan the class QR codes to check in and check out.
              </div>

              <div className="row" style={{ marginTop: 14 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
                </div>

                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Password</label>
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="At least 8 characters" />
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                {!authed ? (
                  <>
                    <button className="btn btnPrimary" onClick={login}>Log In</button>
                    <button className="btn btnSecondary" onClick={createAccount}>Create Account</button>
                  </>
                ) : (
                  <button className="btn btnSecondary" onClick={logout}>Log Out</button>
                )}
              </div>
            </div>

            <div className="card">
              <b style={{ fontSize: 18 }}>Check-In / Check-Out</b>
              <div className="small" style={{ marginTop: 6 }}>
                Scan the QR code shown in class. If scanning isn’t supported on your phone, paste the QR text and tap Submit Scan.
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
                <textarea value={scanText} onChange={(e) => setScanText(e.target.value)} placeholder="Paste QR text here if needed…" />
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
                This generates today’s Check-In and Check-Out codes. Codes are static but time-boxed by expiration.
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
                          marginTop: 10
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
                          marginTop: 10
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <b style={{ fontSize: 18 }}>Roster Import (Excel → CSV)</b>
              <div className="small" style={{ marginTop: 6 }}>
                Excel: File → Save As → CSV, then paste here using headers:
                <b> email, first_name, last_name, license_no</b>
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
                Enter a student email and record check-in or check-out manually.
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Student Email</label>
                  <input placeholder="name@email.com" value={scanText} onChange={(e) => setScanText(e.target.value)} />
                </div>
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btnSecondary" onClick={() => submitScan("manual", "checkin", scanText)}>
                  Manual Check-In
                </button>
                <button className="btn btnSecondary" onClick={() => submitScan("manual", "checkout", scanText)}>
                  Manual Check-Out
                </button>
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
                    const rows = attendance.filter(a => a.session_id === activeSession.id);
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
