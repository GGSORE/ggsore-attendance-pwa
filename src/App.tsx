import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

/* =========================
   Supabase Setup
========================= */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined)?.toLowerCase() || "";

const supabase = supabaseUrl && supabaseAnon ? createClient(supabaseUrl, supabaseAnon) : null;

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
   License Helpers
========================= */
function normalizeLicense(v: string) {
  return v.trim().toUpperCase().replace(/\s+/g, "");
}
function isValidLicense(v: string) {
  return /^\d{6,7}-(SA|B|BB)$/i.test(v);
}

/* =========================
   App Component
========================= */
export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseInput, setLicenseInput] = useState("");
  const [status, setStatus] = useState("");

  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");

  const [attendance, setAttendance] = useState<Attendance[]>([]);

  /* =========================
     Admin Detection
  ========================= */
  function setAdminFromEmail(e: string) {
    const norm = e.trim().toLowerCase();
    setIsAdmin(Boolean(ADMIN_EMAIL) && norm === ADMIN_EMAIL);
  }

  /* =========================
     Auth
  ========================= */
  async function login() {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setStatus(error.message);
    setAdminFromEmail(email);
    setAuthed(true);
    setStatus("Logged in.");
  }

  async function createAccount() {
    if (!supabase) return;
    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) return setStatus("Invalid license format.");
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { trec_license: lic } },
    });
    if (error) return setStatus(error.message);
    setAdminFromEmail(email);
    setAuthed(true);
    setStatus("Account created.");
  }

  /* =========================
     Load Sessions
  ========================= */
  async function refreshSessions() {
    if (!supabase) return;
    const { data } = await supabase.from("gg_sessions").select("*").order("starts_at", { ascending: false });
    const ui = (data || []).map(dbSessToUi);
    setSessions(ui);
    if (ui.length && !activeSessionId) setActiveSessionId(ui[0].id);
  }

  async function refreshAttendance(sessionId: string) {
    if (!supabase) return;
    const { data } = await supabase.from("gg_attendance").select("*").eq("session_id", sessionId);
    setAttendance(data || []);
  }

  useEffect(() => {
    refreshSessions();
  }, []);

  useEffect(() => {
    if (activeSessionId) refreshAttendance(activeSessionId);
  }, [activeSessionId]);

  /* =========================
     Create Session (Admin)
  ========================= */
  async function createSessionInSupabase() {
    if (!supabase || !isAdmin) return setStatus("Admin required.");
    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

    const newSession: Session = {
      id: crypto.randomUUID(),
      title: "New Class Session",
      startsAt: start,
      endsAt: end,
      checkinExpiresAt: start,
      checkoutExpiresAt: end,
      checkinCode: Math.random().toString(36).slice(2, 8),
      checkoutCode: Math.random().toString(36).slice(2, 8),
    };

    const { error } = await supabase.from("gg_sessions").insert([uiSessToDb(newSession)]);
    if (error) return setStatus(error.message);
    setStatus("Session created.");
    refreshSessions();
  }

  /* =========================
     UI
  ========================= */
  return (
    <div style={{ padding: 20 }}>
      <h1>GGSORE Attendance</h1>

      {!authed && (
        <div>
          <input placeholder="Email" onChange={e => setEmail(e.target.value)} />
          <input type="password" placeholder="Password" onChange={e => setPassword(e.target.value)} />
          <input placeholder="TREC License 123456-SA" onChange={e => setLicenseInput(e.target.value)} />
          <button onClick={login}>Login</button>
          <button onClick={createAccount}>Create Account</button>
        </div>
      )}

      {authed && isAdmin && (
        <div>
          <h2>Admin Panel</h2>
          <button onClick={createSessionInSupabase}>Create New Class Session</button>
        </div>
      )}

      <div>{status}</div>
    </div>
  );
}
