import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
// @ts-ignore - jsqr has no bundled TS types in some setups
import jsQR from "jsqr";

/**
 * GGSORE Attendance PWA
 * - Student: sign up / log in, upload headshot, scan QR to check in/out
 * - Admin: create/select session, import roster CSV (persists), add walk-ins, manage attendance
 *
 * IMPORTANT: This file assumes Supabase tables:
 *  - gg_sessions: id (uuid PK), title (text), starts_at (timestamptz), ends_at (timestamptz)
 *      (other columns are OK; app only requires these 4)
 *  - gg_roster: session_id (uuid), trec_license (text), first_name (text), middle_initial (text, nullable),
 *              last_name (text), payment (text), checkin_at (timestamptz, nullable),
 *              checkout_at (timestamptz, nullable), status (text, nullable), absent (boolean, nullable)
 *  - gg_headshot_map: trec_license (text unique), storage_path (text)
 * And bucket: gg-headshots
 */

// ===== Supabase =====
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type PaymentMethod = "pay_link" | "cash";

type SessionRow = {
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
};

type RosterRow = {
  session_id: string;
  trec_license: string;
  first_name: string;
  middle_initial?: string | null;
  last_name: string;
  payment?: string | null;
  checkin_at?: string | null;
  checkout_at?: string | null;
  status?: string | null;
  absent?: boolean | null;
};

type HeadshotMapRow = {
  trec_license: string;
  storage_path: string;
};

// ===== Helpers =====
const BRAND_RED = "#8B0000";
const FONT_STACK =
  'Century Gothic, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

function toTitleCase(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeLicense(raw: string) {
  return raw.trim();
}

function parseCsv(text: string): string[][] {
  // Minimal CSV parser (handles quoted fields + commas)
  const rows: string[][] = [];
  let cur: string[] = [];
  let val = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        val += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        val += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        cur.push(val);
        val = "";
      } else if (ch === "\n") {
        cur.push(val);
        rows.push(cur.map((x) => x.trim()));
        cur = [];
        val = "";
      } else if (ch !== "\r") {
        val += ch;
      }
    }
  }
  if (val.length > 0 || cur.length > 0) {
    cur.push(val);
    rows.push(cur.map((x) => x.trim()));
  }
  // remove empty trailing rows
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function safeIsoFromDateTimeLocal(v: string): string | null {
  // v like "2026-02-02T09:00"
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function localDateTimeFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function isoNow() {
  return new Date().toISOString();
}

function badgeStyle(bg: string, color: string) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    background: bg,
    color,
    fontWeight: 800 as const,
    fontSize: 12,
  };
}

function btnStyle(bg: string, color: string = "#fff") {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    background: bg,
    color,
    fontWeight: 900 as const,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  };
}

function subtleCard() {
  return {
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 16,
    padding: 16,
  };
}

export default function App() {
  // ===== Auth + identity =====
  const [authUser, setAuthUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [mode, setMode] = useState<"student" | "admin">("student");
  const [isAdmin, setIsAdmin] = useState(false);

  // Student auth form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [trecLicense, setTrecLicense] = useState("");

  // Student profile fields (sign-up)
  const [firstName, setFirstName] = useState("");
  const [middleInitial, setMiddleInitial] = useState("");
  const [lastName, setLastName] = useState("");

  const [studentMsg, setStudentMsg] = useState<string | null>(null);

  // Headshot
  const [pendingHeadshot, setPendingHeadshot] = useState<File | null>(null);
  const [headshotUploading, setHeadshotUploading] = useState(false);
  const [headshotSignedUrl, setHeadshotSignedUrl] = useState<string | null>(null);

  // ===== Sessions + roster =====
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [adminNote, setAdminNote] = useState<string | null>(null);

  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  // Create session
  const CLASS_TITLES = useMemo(
    () => [
      "Commercial Leasing 101™",
      "Commercial Leasing Contracts 101™",
      "Commercial Letters of Intent 101™ – Leasing & Sales",
      "Commercial Sales 101™: From Client to Contract to Close",
      "Deal Dynamics™: Deciphering Commercial Real Estate Contracts",
      "Commercial Property Management 101™ – Apartments Not Included",
      "Things You Need to Know About Practicing Law in Real Estate™",
    ],
    []
  );

  const [newTitle, setNewTitle] = useState(CLASS_TITLES[0] || "");
  const [newStartsLocal, setNewStartsLocal] = useState("");
  const [newEndsLocal, setNewEndsLocal] = useState("");

  // CSV import
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);

  // Roster (single source of truth = DB)
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);

  // Headshot URLs for roster
  const [rosterHeadshots, setRosterHeadshots] = useState<Record<string, string>>({});

  // Walk-in form (Admin only)
  const [walkInLicense, setWalkInLicense] = useState("");
  const [walkInFirst, setWalkInFirst] = useState("");
  const [walkInMI, setWalkInMI] = useState("");
  const [walkInLast, setWalkInLast] = useState("");
  const [walkInPayment, setWalkInPayment] = useState<PaymentMethod>("pay_link");
  const [walkInBusy, setWalkInBusy] = useState(false);

  // ===== Scanner =====
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [scanStatus, setScanStatus] = useState<null | { type: "ok" | "fail"; msg: string }>(null);
  const [scanBusy, setScanBusy] = useState(false);

  const checkinQrUrl = useMemo(() => {
    if (!selectedSessionId) return "";
    const payload = JSON.stringify({ session_id: selectedSessionId, action: "checkin" });
    return `data:text/plain,${encodeURIComponent(payload)}`;
  }, [selectedSessionId]);

  const checkoutQrUrl = useMemo(() => {
    if (!selectedSessionId) return "";
    const payload = JSON.stringify({ session_id: selectedSessionId, action: "checkout" });
    return `data:text/plain,${encodeURIComponent(payload)}`;
  }, [selectedSessionId]);

  // ===== Boot =====
  useEffect(() => {
    (async () => {
      setAuthLoading(true);
      const { data } = await supabase.auth.getUser();
      setAuthUser(data.user ?? null);

      // Admin check: table gg_admins (optional). If missing, isAdmin stays false.
      const admin = await isUserAdmin(data.user?.id);
      setIsAdmin(admin);

      setAuthLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setAuthUser(session?.user ?? null);
      const admin = await isUserAdmin(session?.user?.id);
      setIsAdmin(admin);
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (mode === "admin" && isAdmin) {
      void loadSessions();
    }
  }, [mode, isAdmin]);

  useEffect(() => {
    if (mode === "admin" && isAdmin && selectedSessionId) {
      void loadRosterFromDb(selectedSessionId);
    } else {
      setRoster([]);
      setRosterHeadshots({});
    }
  }, [mode, isAdmin, selectedSessionId]);

  useEffect(() => {
    if (mode === "student" && authUser) {
      // load student's headshot if available
      void loadMyHeadshot();
    } else {
      setHeadshotSignedUrl(null);
      setPendingHeadshot(null);
    }
  }, [mode, authUser]);

  // ===== Admin helper =====
  async function isUserAdmin(userId?: string): Promise<boolean> {
    if (!userId) return false;
    try {
      const { data, error } = await supabase.from("gg_admins").select("user_id").eq("user_id", userId).maybeSingle();
      if (error) return false;
      return !!data;
    } catch {
      return false;
    }
  }

  // ===== Sessions =====
  async function loadSessions() {
    setSessionsLoading(true);
    setAdminNote(null);
    try {
      const { data, error } = await supabase
        .from("gg_sessions")
        .select("id,title,starts_at,ends_at")
        .order("starts_at", { ascending: false })
        .limit(50);

      if (error) {
        setAdminNote(`Note: Could not load sessions.`);
        setSessions([]);
      } else {
        setSessions((data || []) as SessionRow[]);
      }
    } catch {
      setAdminNote(`Note: Could not load sessions.`);
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }

  async function createSession() {
    if (!isAdmin) return;
    setAdminNote(null);

    const startsIso = safeIsoFromDateTimeLocal(newStartsLocal);
    const endsIso = safeIsoFromDateTimeLocal(newEndsLocal);
    if (!newTitle.trim() || !startsIso || !endsIso) {
      setAdminNote("Note: Please select a class title, start time, and end time.");
      return;
    }

    const { data, error } = await supabase
      .from("gg_sessions")
      .insert([
        {
          title: newTitle.trim(),
          starts_at: startsIso,
          ends_at: endsIso,
        },
      ])
      .select("id,title,starts_at,ends_at")
      .single();

    if (error) {
      setAdminNote(`Note: Could not create session. ${error.message}`);
      return;
    }

    await loadSessions();
    setSelectedSessionId((data as any).id);
  }

  // ===== Roster DB =====
  async function loadRosterFromDb(sessionId: string) {
    setRosterLoading(true);
    setAdminNote(null);
    try {
      // Keep select list conservative to avoid schema-cache complaints.
      const { data, error } = await supabase
        .from("gg_roster")
        .select("session_id,trec_license,first_name,middle_initial,last_name,payment,checkin_at,checkout_at,status,absent")
        .eq("session_id", sessionId)
        .order("last_name", { ascending: true })
        .order("first_name", { ascending: true });

      if (error) {
        setAdminNote(`Note: Could not load roster. ${error.message}`);
        setRoster([]);
        setRosterHeadshots({});
      } else {
        const rows = (data || []) as RosterRow[];
        setRoster(rows);
        await hydrateRosterHeadshots(rows);
      }
    } catch (e: any) {
      setAdminNote(`Note: Could not load roster.`);
      setRoster([]);
      setRosterHeadshots({});
    } finally {
      setRosterLoading(false);
    }
  }

  async function hydrateRosterHeadshots(rows: RosterRow[]) {
    try {
      const licenses = Array.from(new Set(rows.map((r) => r.trec_license).filter(Boolean)));
      if (licenses.length === 0) {
        setRosterHeadshots({});
        return;
      }

      const { data: mapRows, error: mapErr } = await supabase
        .from("gg_headshot_map")
        .select("trec_license,storage_path")
        .in("trec_license", licenses);

      if (mapErr || !mapRows) {
        setRosterHeadshots({});
        return;
      }

      const maps = mapRows as HeadshotMapRow[];
      const paths = maps.map((m) => m.storage_path).filter(Boolean);
      if (paths.length === 0) {
        setRosterHeadshots({});
        return;
      }

      // createSignedUrls can batch
      const { data: signed, error: signErr } = await supabase.storage.from("gg-headshots").createSignedUrls(paths, 60 * 60);
      if (signErr || !signed) {
        setRosterHeadshots({});
        return;
      }

      const pathToUrl: Record<string, string> = {};
      signed.forEach((s) => {
        if (s?.signedUrl && s.path) pathToUrl[s.path] = s.signedUrl;
      });

      const licenseToUrl: Record<string, string> = {};
      maps.forEach((m) => {
        const url = pathToUrl[m.storage_path];
        if (url) licenseToUrl[m.trec_license] = url;
      });

      setRosterHeadshots(licenseToUrl);
    } catch {
      setRosterHeadshots({});
    }
  }

  async function upsertRosterRows(sessionId: string, rows: RosterRow[]) {
    if (!isAdmin) return;
    if (!sessionId) return;

    // Upsert by (session_id, trec_license) - assumes unique constraint.
    const payload = rows.map((r) => ({
      session_id: sessionId,
      trec_license: normalizeLicense(r.trec_license),
      first_name: toTitleCase(r.first_name || ""),
      middle_initial: (r.middle_initial || "").trim() || null,
      last_name: toTitleCase(r.last_name || ""),
      payment: r.payment ?? null,
      checkin_at: r.checkin_at ?? null,
      checkout_at: r.checkout_at ?? null,
      status: r.status ?? null,
      absent: r.absent ?? null,
    }));

    const { error } = await supabase
      .from("gg_roster")
      .upsert(payload, { onConflict: "session_id,trec_license" });

    if (error) {
      setAdminNote(`Note: Could not save roster. ${error.message}`);
    }
  }

  // ===== CSV Import =====
  const rosterTemplate = `photo,trec_license,first_name,middle_initial,last_name,payment,checkin_at,checkout_at,status
,123456-SA,First,M,Last,pay_link,,,`;
  async function importCsvToRoster() {
    if (!isAdmin) return;
    if (!selectedSessionId) {
      setAdminNote("Note: Create or select a session first.");
      return;
    }
    if (!csvFile) {
      setAdminNote("Note: Please choose a CSV file first.");
      return;
    }

    setCsvBusy(true);
    setAdminNote(null);

    try {
      const text = await csvFile.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        setAdminNote("Note: CSV appears empty.");
        return;
      }

      const header = rows[0].map((h) => h.toLowerCase());
      const idx = (name: string) => header.indexOf(name);

      // expected headers
      const iLicense = idx("trec_license");
      const iFirst = idx("first_name");
      const iMI = idx("middle_initial");
      const iLast = idx("last_name");
      const iPayment = idx("payment");
      const iCheckin = idx("checkin_at");
      const iCheckout = idx("checkout_at");
      const iStatus = idx("status");

      if (iLicense < 0 || iFirst < 0 || iLast < 0) {
        setAdminNote("Note: CSV must include headers: trec_license, first_name, last_name (and optional middle_initial, payment, checkin_at, checkout_at, status).");
        return;
      }

      const parsed: RosterRow[] = rows.slice(1).map((r) => ({
        session_id: selectedSessionId,
        trec_license: normalizeLicense(r[iLicense] || ""),
        first_name: r[iFirst] || "",
        middle_initial: iMI >= 0 ? (r[iMI] || "") : "",
        last_name: r[iLast] || "",
        payment: iPayment >= 0 ? (r[iPayment] || null) : null,
        checkin_at: iCheckin >= 0 ? (r[iCheckin] || null) : null,
        checkout_at: iCheckout >= 0 ? (r[iCheckout] || null) : null,
        status: iStatus >= 0 ? (r[iStatus] || null) : null,
        absent: false,
      })).filter((r) => r.trec_license);

      await upsertRosterRows(selectedSessionId, parsed);
      await loadRosterFromDb(selectedSessionId);
      setCsvFile(null);
    } catch (e: any) {
      setAdminNote("Note: Could not import CSV.");
    } finally {
      setCsvBusy(false);
    }
  }

  // ===== Walk-ins =====
  async function addWalkIn() {
    if (!isAdmin) return;
    if (!selectedSessionId) {
      setAdminNote("Note: Create or select a session first.");
      return;
    }
    const lic = normalizeLicense(walkInLicense);
    if (!lic || !walkInFirst.trim() || !walkInLast.trim()) {
      setAdminNote("Note: Walk-in requires TREC License, First Name, and Last Name.");
      return;
    }

    setWalkInBusy(true);
    setAdminNote(null);

    const now = isoNow();
    const row: RosterRow = {
      session_id: selectedSessionId,
      trec_license: lic,
      first_name: walkInFirst,
      middle_initial: walkInMI,
      last_name: walkInLast,
      payment: walkInPayment,
      checkin_at: now,
      checkout_at: null,
      status: "present",
      absent: false,
    };

    await upsertRosterRows(selectedSessionId, [row]);
    await loadRosterFromDb(selectedSessionId);

    setWalkInLicense("");
    setWalkInFirst("");
    setWalkInMI("");
    setWalkInLast("");
    setWalkInPayment("pay_link");
    setWalkInBusy(false);
  }

  // ===== Attendance actions =====
  async function updateRosterRow(sessionId: string, lic: string, patch: Partial<RosterRow>) {
    const { error } = await supabase
      .from("gg_roster")
      .update(patch)
      .eq("session_id", sessionId)
      .eq("trec_license", lic);

    if (error) {
      setAdminNote(`Note: Update failed. ${error.message}`);
      return false;
    }
    return true;
  }

  async function markAbsent(r: RosterRow, absent: boolean) {
    if (!selectedSessionId) return;
    await updateRosterRow(selectedSessionId, r.trec_license, { absent, status: absent ? "absent" : "present" });
    await loadRosterFromDb(selectedSessionId);
  }

  async function clearPhoto(r: RosterRow) {
    try {
      // remove mapping row; doesn't delete storage object (keeps it safe)
      await supabase.from("gg_headshot_map").delete().eq("trec_license", r.trec_license);
      await loadRosterFromDb(selectedSessionId);
    } catch {
      setAdminNote("Note: Could not clear photo map.");
    }
  }

  async function removeStudent(r: RosterRow) {
    if (!selectedSessionId) return;
    const { error } = await supabase
      .from("gg_roster")
      .delete()
      .eq("session_id", selectedSessionId)
      .eq("trec_license", r.trec_license);
    if (error) setAdminNote(`Note: Could not remove student. ${error.message}`);
    await loadRosterFromDb(selectedSessionId);
  }

  async function manualCheckIn(r: RosterRow) {
    if (!selectedSessionId) return;
    await updateRosterRow(selectedSessionId, r.trec_license, { checkin_at: isoNow(), status: "present", absent: false });
    await loadRosterFromDb(selectedSessionId);
  }

  async function undoCheckIn(r: RosterRow) {
    if (!selectedSessionId) return;
    await updateRosterRow(selectedSessionId, r.trec_license, { checkin_at: null });
    await loadRosterFromDb(selectedSessionId);
  }

  async function manualCheckOut(r: RosterRow) {
    if (!selectedSessionId) return;
    await updateRosterRow(selectedSessionId, r.trec_license, { checkout_at: isoNow() });
    await loadRosterFromDb(selectedSessionId);
  }

  async function undoCheckOut(r: RosterRow) {
    if (!selectedSessionId) return;
    await updateRosterRow(selectedSessionId, r.trec_license, { checkout_at: null });
    await loadRosterFromDb(selectedSessionId);
  }

  // ===== Student: sign up / login / logout =====
  async function signUpStudent() {
    setStudentMsg(null);

    const lic = normalizeLicense(trecLicense);
    if (!email.trim() || !password || !lic || !firstName.trim() || !lastName.trim()) {
      setStudentMsg("Please complete Email, Password, TREC License, First Name, and Last Name.");
      return;
    }

    const mi = (middleInitial || "").trim().slice(0, 1).toUpperCase();

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          trec_license: lic,
          first_name: toTitleCase(firstName),
          middle_initial: mi || null,
          last_name: toTitleCase(lastName),
        },
      },
    });

    if (error) {
      setStudentMsg(error.message);
      return;
    }

    setStudentMsg("Account created. Please log in to check in to class.");
  }

  async function loginStudent() {
    setStudentMsg(null);
    if (!email.trim() || !password) {
      setStudentMsg("Please enter Email and Password.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setStudentMsg(error.message);
      return;
    }

    // Optional: verify entered license matches user_metadata
    const u = (await supabase.auth.getUser()).data.user;
    const metaLic = (u?.user_metadata?.trec_license || "").toString();
    const inputLic = normalizeLicense(trecLicense);
    if (inputLic && metaLic && inputLic !== metaLic) {
      setStudentMsg("Logged in, but TREC License does not match this account.");
    } else {
      setStudentMsg(null);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    setEmail("");
    setPassword("");
    setTrecLicense("");
    setFirstName("");
    setMiddleInitial("");
    setLastName("");
    setStudentMsg(null);
    setCameraOn(false);
    stopCamera();
  }

  // ===== Student: Headshot =====
  async function uploadHeadshot(file: File) {
    if (!authUser) return;
    const lic = normalizeLicense((authUser.user_metadata?.trec_license || trecLicense || "").toString());
    if (!lic) {
      setStudentMsg("Please add TREC License to the account before uploading a photo.");
      return;
    }

    setHeadshotUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${lic}/${Date.now()}.${ext}`;

      const { error: upErr } = await supabase.storage.from("gg-headshots").upload(path, file, {
        cacheControl: "3600",
        upsert: true,
        contentType: file.type || "image/jpeg",
      });

      if (upErr) {
        setStudentMsg(upErr.message);
        return;
      }

      // Map license -> path
      const { error: mapErr } = await supabase
        .from("gg_headshot_map")
        .upsert([{ trec_license: lic, storage_path: path }], { onConflict: "trec_license" });

      if (mapErr) {
        setStudentMsg(mapErr.message);
        return;
      }

      setPendingHeadshot(null);
      await loadMyHeadshot();
    } finally {
      setHeadshotUploading(false);
    }
  }

  async function loadMyHeadshot() {
    if (!authUser) return;
    const lic = normalizeLicense((authUser.user_metadata?.trec_license || "").toString());
    if (!lic) return;

    const { data, error } = await supabase
      .from("gg_headshot_map")
      .select("trec_license,storage_path")
      .eq("trec_license", lic)
      .maybeSingle();

    if (error || !data?.storage_path) {
      setHeadshotSignedUrl(null);
      return;
    }

    const { data: signed, error: signErr } = await supabase.storage.from("gg-headshots").createSignedUrl(data.storage_path, 60 * 60);
    if (signErr || !signed?.signedUrl) {
      setHeadshotSignedUrl(null);
      return;
    }
    setHeadshotSignedUrl(signed.signedUrl);
  }

  // ===== Scanner =====
  async function startCamera() {
    setScanStatus(null);
    const video = videoRef.current;
    if (!video) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      setCameraOn(true);
      tickScan();
    } catch (e: any) {
      setScanStatus({ type: "fail", msg: "Camera access blocked. Check browser permissions." });
      setCameraOn(false);
    }
  }

  function stopCamera() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const video = videoRef.current;
    if (video?.srcObject) {
      const tracks = (video.srcObject as MediaStream).getTracks();
      tracks.forEach((t) => t.stop());
      video.srcObject = null;
    }
    setCameraOn(false);
  }

  function tickScan() {
    rafRef.current = requestAnimationFrame(tickScan);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

    const size = 520; // square scan canvas
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw center-crop square from video
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const s = Math.min(vw, vh);
    const sx = (vw - s) / 2;
    const sy = (vh - s) / 2;
    ctx.drawImage(video, sx, sy, s, s, 0, 0, size, size);

    const imageData = ctx.getImageData(0, 0, size, size);
    const code = jsQR(imageData.data, imageData.width, imageData.height);

    if (code?.data && !scanBusy) {
      // attempt parse and apply
      void handleScan(code.data);
    }
  }

  async function handleScan(raw: string) {
    if (!authUser) {
      setScanStatus({ type: "fail", msg: "Please log in first." });
      return;
    }
    if (!raw) return;

    setScanBusy(true);
    try {
      // We expect raw to be either JSON payload or a URL/data URI that contains JSON
      let payloadText = raw;

      // If it's a data URI we created (data:text/plain,...)
      const prefix = "data:text/plain,";
      if (payloadText.startsWith(prefix)) {
        payloadText = decodeURIComponent(payloadText.slice(prefix.length));
      }

      let payload: any = null;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        // Not valid
        setScanStatus({ type: "fail", msg: "Failure — QR code not recognized." });
        return;
      }

      const sessionId = payload?.session_id;
      const action = payload?.action;
      if (!sessionId || (action !== "checkin" && action !== "checkout")) {
        setScanStatus({ type: "fail", msg: "Failure — QR code not recognized." });
        return;
      }

      // Use student license from metadata (preferred) else input
      const lic = normalizeLicense((authUser.user_metadata?.trec_license || trecLicense || "").toString());
      if (!lic) {
        setScanStatus({ type: "fail", msg: "Please add TREC License to the account first." });
        return;
      }

      // Update roster row for that session+license; if row doesn't exist, create it with names from metadata
      const now = isoNow();
      const meta = authUser.user_metadata || {};
      const baseRow: Partial<RosterRow> = {
        session_id: sessionId,
        trec_license: lic,
        first_name: toTitleCase((meta.first_name || "").toString() || firstName),
        middle_initial: (meta.middle_initial || "").toString() || null,
        last_name: toTitleCase((meta.last_name || "").toString() || lastName),
        payment: null,
        status: "present",
        absent: false,
      };

      // Upsert then patch times
      await supabase.from("gg_roster").upsert([baseRow], { onConflict: "session_id,trec_license" });

      if (action === "checkin") {
        await updateRosterRow(sessionId, lic, { checkin_at: now, status: "present", absent: false });
        setScanStatus({ type: "ok", msg: "Success — checked in!" });
      } else {
        await updateRosterRow(sessionId, lic, { checkout_at: now });
        setScanStatus({ type: "ok", msg: "Success — checked out!" });
      }
    } catch {
      setScanStatus({ type: "fail", msg: "Failure — try again." });
    } finally {
      // brief lockout to prevent repeat scans
      setTimeout(() => setScanBusy(false), 1200);
    }
  }

  // ===== UI =====
  const header = (
    <div
      style={{
        background: "#fff",
        borderBottom: "1px solid #e6e6e6",
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 1050,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <img
            src="/ggsore-logo.png"
            alt="The Guillory Group School of Real Estate"
            style={{ width: 44, height: 44, objectFit: "contain" }}
          />
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, lineHeight: 1.1 }}>
              The Guillory Group School of Real Estate
              <div style={{ fontWeight: 900, fontSize: 15 }}>Student Attendance App</div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
              TREC Education Provider #9998-CEP
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => setMode("student")}
            style={{
              ...btnStyle(mode === "student" ? BRAND_RED : "#f1f1f1", mode === "student" ? "#fff" : "#111"),
              border: mode === "student" ? `1px solid ${BRAND_RED}` : "1px solid #ddd",
            }}
          >
            Student
          </button>
          <button
            onClick={() => setMode("admin")}
            style={{
              ...btnStyle(mode === "admin" ? BRAND_RED : "#f1f1f1", mode === "admin" ? "#fff" : "#111"),
              border: mode === "admin" ? `1px solid ${BRAND_RED}` : "1px solid #ddd",
            }}
          >
            Admin / Instructor
          </button>
          {authUser && (
            <button onClick={logout} style={{ ...btnStyle(BRAND_RED) }}>
              Log out
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (authLoading) {
    return (
      <div style={{ fontFamily: FONT_STACK, padding: 20 }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", fontFamily: FONT_STACK }}>
      {header}

      <div style={{ maxWidth: 1050, margin: "0 auto", padding: 16 }}>
        {mode === "student" ? (
          <div style={{ display: "grid", gap: 14 }}>
            {!authUser ? (
              <div style={subtleCard()}>
                <h2 style={{ marginTop: 0, marginBottom: 8 }}>Student Login</h2>

                <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
                  <label style={{ fontWeight: 800 }}>Email</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                    placeholder="name@example.com"
                    autoComplete="email"
                  />

                  <label style={{ fontWeight: 800 }}>Password</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      style={{ flex: 1, padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      type={showPw ? "text" : "password"}
                      placeholder=""
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      style={{ ...btnStyle("#f1f1f1", "#111") }}
                      aria-label={showPw ? "Hide password" : "Show password"}
                    >
                      {showPw ? "Hide" : "Show"}
                    </button>
                  </div>

                  <label style={{ fontWeight: 800 }}>TREC License</label>
                  <input
                    value={trecLicense}
                    onChange={(e) => setTrecLicense(e.target.value)}
                    style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                    placeholder="123456-SA"
                  />

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={loginStudent} style={btnStyle(BRAND_RED)}>
                      Log in
                    </button>
                  </div>

                  <div style={{ borderTop: "1px solid #eee", paddingTop: 12, marginTop: 6 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Create an account</div>

                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 90px 1fr" }}>
                        <div style={{ display: "grid", gap: 6 }}>
                          <label style={{ fontWeight: 800 }}>First Name</label>
                          <input
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                          />
                        </div>

                        <div style={{ display: "grid", gap: 6 }}>
                          <label style={{ fontWeight: 800 }}>M.I.</label>
                          <input
                            value={middleInitial}
                            onChange={(e) => setMiddleInitial(e.target.value)}
                            style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc", textTransform: "uppercase" }}
                            maxLength={1}
                          />
                        </div>

                        <div style={{ display: "grid", gap: 6 }}>
                          <label style={{ fontWeight: 800 }}>Last Name</label>
                          <input
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                          />
                        </div>
                      </div>

                      <div style={{ fontSize: 12, opacity: 0.85 }}>
                        Name should match the name shown on the TREC license.
                      </div>

                      <button onClick={signUpStudent} style={btnStyle("#1167b1")}>
                        Create Account
                      </button>
                    </div>
                  </div>

                  {studentMsg && (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 12, background: "#fff7d6", border: "1px solid #f0dca3" }}>
                      {studentMsg}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div style={subtleCard()}>
                  <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                    {headshotSignedUrl ? (
                      <img
                        src={headshotSignedUrl}
                        alt="Headshot"
                        style={{
                          width: 80,
                          height: 106,
                          objectFit: "cover",
                          objectPosition: "center top",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 80,
                          height: 106,
                          borderRadius: 10,
                          border: "1px dashed #bbb",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 900,
                          opacity: 0.7,
                        }}
                      >
                        No photo
                      </div>
                    )}

                    <div style={{ minWidth: 260 }}>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>
                        Welcome to class, {toTitleCase((authUser.user_metadata?.first_name || "").toString() || "Student")}!
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.85 }}>
                        Logged in. Ready to check in and check out.
                      </div>
                    </div>

                    <div style={{ flex: 1 }} />

                    <div style={{ display: "grid", gap: 10 }}>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) setPendingHeadshot(f);
                        }}
                      />

                      {pendingHeadshot && (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ fontSize: 12, opacity: 0.85 }}>Selected photo preview:</div>
                          <img
                            src={URL.createObjectURL(pendingHeadshot)}
                            alt="Headshot preview"
                            style={{
                              width: 120,
                              height: 160,
                              objectFit: "cover",
                              objectPosition: "center top",
                              borderRadius: 12,
                              border: "1px solid #ddd",
                            }}
                          />

                          <button
                            disabled={!pendingHeadshot || headshotUploading}
                            onClick={async () => {
                              if (!pendingHeadshot) return;
                              await uploadHeadshot(pendingHeadshot);
                            }}
                            style={{
                              ...btnStyle(BRAND_RED),
                              opacity: pendingHeadshot ? 1 : 0.5,
                            }}
                          >
                            {headshotUploading ? "Uploading..." : "Upload Photo"}
                          </button>
                        </div>
                      )}

                      <div style={{ fontSize: 11, opacity: 0.85 }}>
                        Use a clear, front-facing photo (no hats/sunglasses if possible).
                      </div>
                    </div>
                  </div>
                </div>

                <div style={subtleCard()}>
                  <h3 style={{ marginTop: 0 }}>Check In / Check Out</h3>

                  <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      When the camera opens, hold the QR code steady in the frame.
                    </div>

                    <div
                      style={{
                        width: "100%",
                        maxWidth: 520,
                        aspectRatio: "1 / 1",
                        borderRadius: 16,
                        border: "1px solid #ddd",
                        overflow: "hidden",
                        background: "#000",
                        position: "relative",
                      }}
                    >
                      <video
                        ref={videoRef}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        muted
                        playsInline
                      />
                      <canvas ref={canvasRef} style={{ display: "none" }} />
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {!cameraOn ? (
                        <button onClick={startCamera} style={btnStyle("#1167b1")}>
                          Open Scanner
                        </button>
                      ) : (
                        <button onClick={stopCamera} style={btnStyle("#03254c")}>
                          Close Scanner
                        </button>
                      )}
                    </div>

                    {scanStatus && (
                      <div
                        style={{
                          padding: 12,
                          borderRadius: 16,
                          border: "1px solid #ddd",
                          background: "#fff",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          maxWidth: 520,
                        }}
                      >
                        <div
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 999,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: scanStatus.type === "ok" ? "#2e7d32" : "#b71c1c",
                            color: "#fff",
                            fontWeight: 900,
                            fontSize: 18,
                          }}
                        >
                          {scanStatus.type === "ok" ? "✓" : "!"}
                        </div>
                        <div style={{ fontWeight: 900 }}>{scanStatus.msg}</div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {!isAdmin ? (
              <div style={subtleCard()}>
                <h2 style={{ marginTop: 0 }}>Admin / Instructor</h2>
                <div style={{ opacity: 0.85 }}>
                  This page is restricted. Log in with an admin account.
                </div>
              </div>
            ) : (
              <>
                {adminNote && (
                  <div style={{ padding: 10, borderRadius: 12, background: "#fff7d6", border: "1px solid #f0dca3" }}>
                    {adminNote}
                  </div>
                )}

                <div style={subtleCard()}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Create Session</div>

                  <div
                    style={{
                      display: "grid",
                      gap: 10,
                      gridTemplateColumns: "minmax(240px, 1fr) 1fr 1fr auto",
                      alignItems: "end",
                    }}
                  >
                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>Class Title</label>
                      <select
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      >
                        {CLASS_TITLES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>Start</label>
                      <input
                        type="datetime-local"
                        value={newStartsLocal}
                        onChange={(e) => setNewStartsLocal(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      />
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>End</label>
                      <input
                        type="datetime-local"
                        value={newEndsLocal}
                        onChange={(e) => setNewEndsLocal(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      />
                    </div>

                    <button onClick={createSession} style={btnStyle(BRAND_RED)}>
                      Create
                    </button>
                  </div>

                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 8 }}>Select Session</div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <select
                        value={selectedSessionId}
                        onChange={(e) => setSelectedSessionId(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc", minWidth: 320, maxWidth: "100%" }}
                      >
                        <option value="">— Select —</option>
                        {sessions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title} — {s.starts_at ? new Date(s.starts_at).toLocaleString() : ""}
                          </option>
                        ))}
                      </select>

                      <button onClick={loadSessions} style={btnStyle("#f1f1f1", "#111")} disabled={sessionsLoading}>
                        {sessionsLoading ? "Refreshing..." : "Refresh Sessions"}
                      </button>
                    </div>

                    {selectedSession && (
                      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <span style={badgeStyle("#f1f1f1", "#111")}>
                          Session
                        </span>
                        <span style={badgeStyle("#f1f1f1", "#111")}>
                          {selectedSession.title}
                        </span>
                        <span style={badgeStyle("#f1f1f1", "#111")}>
                          {selectedSession.starts_at ? new Date(selectedSession.starts_at).toLocaleString() : ""} —{" "}
                          {selectedSession.ends_at ? new Date(selectedSession.ends_at).toLocaleString() : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div style={subtleCard()}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Roster CSV Import</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
                    CSV headers expected (in any order): photo, trec_license, first_name, middle_initial, last_name, payment, checkin_at, checkout_at, status
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                    />
                    <button onClick={importCsvToRoster} style={btnStyle("#1167b1")} disabled={csvBusy}>
                      {csvBusy ? "Importing..." : "Load Roster"}
                    </button>
                    <button
                      onClick={async () => {
                        const blob = new Blob([rosterTemplate], { type: "text/csv;charset=utf-8" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "ggsore_roster_template.csv";
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={btnStyle("#f1f1f1", "#111")}
                    >
                      Download Template
                    </button>
                  </div>
                </div>

                <div style={subtleCard()}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Add Walk-In (paid at the door)</div>

                  <div
                    style={{
                      display: "grid",
                      gap: 10,
                      gridTemplateColumns: "1fr 1fr 120px 1fr 1fr auto",
                      alignItems: "end",
                    }}
                  >
                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>TREC License</label>
                      <input
                        value={walkInLicense}
                        onChange={(e) => setWalkInLicense(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      />
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>First</label>
                      <input
                        value={walkInFirst}
                        onChange={(e) => setWalkInFirst(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      />
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>M.I.</label>
                      <input
                        value={walkInMI}
                        onChange={(e) => setWalkInMI(e.target.value)}
                        maxLength={1}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc", textTransform: "uppercase" }}
                      />
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>Last</label>
                      <input
                        value={walkInLast}
                        onChange={(e) => setWalkInLast(e.target.value)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      />
                    </div>

                    <div style={{ display: "grid", gap: 6 }}>
                      <label style={{ fontWeight: 800 }}>Payment</label>
                      <select
                        value={walkInPayment}
                        onChange={(e) => setWalkInPayment(e.target.value as PaymentMethod)}
                        style={{ padding: 12, borderRadius: 12, border: "1px solid #ccc" }}
                      >
                        <option value="pay_link">Pay Link</option>
                        <option value="cash">Cash</option>
                      </select>
                    </div>

                    <button onClick={addWalkIn} style={btnStyle("#1167b1")} disabled={walkInBusy}>
                      {walkInBusy ? "Adding..." : "Add Walk-In"}
                    </button>
                  </div>
                </div>

                <div style={subtleCard()}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>
                    Roster {selectedSessionId ? `(${roster.length})` : ""}
                  </div>

                  {!selectedSessionId ? (
                    <div style={{ opacity: 0.85 }}>Select a session to view its roster.</div>
                  ) : rosterLoading ? (
                    <div style={{ opacity: 0.85 }}>Loading roster…</div>
                  ) : roster.length === 0 ? (
                    <div style={{ opacity: 0.85 }}>No roster loaded yet for this session.</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                        <thead>
                          <tr style={{ textAlign: "left" }}>
                            {[
                              "Photo",
                              "TREC License",
                              "First",
                              "M.I.",
                              "Last",
                              "Payment",
                              "Check-in",
                              "Check-out",
                              "Status",
                              "Actions",
                            ].map((h) => (
                              <th
                                key={h}
                                style={{
                                  padding: "10px 8px",
                                  borderBottom: "1px solid #e6e6e6",
                                  fontSize: 12,
                                  textTransform: "uppercase",
                                  letterSpacing: 0.6,
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>

                        <tbody>
                          {roster.map((r) => {
                            const lic = r.trec_license;
                            const photo = rosterHeadshots[lic];
                            const absent = !!r.absent;

                            return (
                              <tr key={lic} style={{ borderBottom: "1px solid #f0f0f0" }}>
                                <td style={{ padding: "10px 8px" }}>
                                  {photo ? (
                                    <img
                                      src={photo}
                                      alt="headshot"
                                      style={{ width: 44, height: 58, objectFit: "cover", borderRadius: 10, border: "1px solid #ddd" }}
                                    />
                                  ) : (
                                    <div
                                      style={{
                                        width: 44,
                                        height: 58,
                                        borderRadius: 10,
                                        border: "1px dashed #bbb",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontSize: 10,
                                        opacity: 0.7,
                                        fontWeight: 900,
                                      }}
                                    >
                                      —
                                    </div>
                                  )}
                                </td>

                                <td style={{ padding: "10px 8px", fontWeight: 900 }}>{lic}</td>
                                <td style={{ padding: "10px 8px" }}>{toTitleCase(r.first_name || "")}</td>
                                <td style={{ padding: "10px 8px" }}>{(r.middle_initial || "").toString().toUpperCase()}</td>
                                <td style={{ padding: "10px 8px" }}>{toTitleCase(r.last_name || "")}</td>
                                <td style={{ padding: "10px 8px" }}>{r.payment || ""}</td>
                                <td style={{ padding: "10px 8px", fontSize: 12 }}>
                                  {r.checkin_at ? new Date(r.checkin_at).toLocaleTimeString() : ""}
                                </td>
                                <td style={{ padding: "10px 8px", fontSize: 12 }}>
                                  {r.checkout_at ? new Date(r.checkout_at).toLocaleTimeString() : ""}
                                </td>
                                <td style={{ padding: "10px 8px" }}>
                                  {absent ? (
                                    <span style={badgeStyle("#d0efff", "#111")}>Absent</span>
                                  ) : r.checkin_at ? (
                                    <span style={badgeStyle("#e8f5e9", "#1b5e20")}>Present</span>
                                  ) : (
                                    <span style={badgeStyle("#f1f1f1", "#111")}>—</span>
                                  )}
                                </td>

                                <td style={{ padding: "10px 8px" }}>
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <button
                                      onClick={() => markAbsent(r, !absent)}
                                      style={btnStyle("#d0efff", "#111")}
                                    >
                                      {absent ? "Undo Absent" : "Mark Absent"}
                                    </button>

                                    <button
                                      onClick={() => removeStudent(r)}
                                      style={btnStyle("#187bcd", "#fff")}
                                    >
                                      Remove
                                    </button>

                                    <button onClick={() => clearPhoto(r)} style={btnStyle("#03254c", "#fff")}>
                                      Clear Photo
                                    </button>

                                    {!r.checkin_at ? (
                                      <button onClick={() => manualCheckIn(r)} style={btnStyle("#1167b1", "#fff")}>
                                        Manual Check-in
                                      </button>
                                    ) : (
                                      <button onClick={() => undoCheckIn(r)} style={btnStyle("#1167b1", "#fff")}>
                                        Undo Check-in
                                      </button>
                                    )}

                                    {!r.checkout_at ? (
                                      <button onClick={() => manualCheckOut(r)} style={btnStyle("#1167b1", "#fff")}>
                                        Manual Check-out
                                      </button>
                                    ) : (
                                      <button onClick={() => undoCheckOut(r)} style={btnStyle("#1167b1", "#fff")}>
                                        Undo Check-out
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div style={subtleCard()}>
                  <div style={{ fontWeight: 900, marginBottom: 10 }}>QR Codes</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {!selectedSessionId ? (
                      <div style={{ opacity: 0.85 }}>Select a session to generate QR codes.</div>
                    ) : (
                      <QrBlock checkinQrUrl={checkinQrUrl} checkoutQrUrl={checkoutQrUrl} />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function QrBlock({ checkinQrUrl, checkoutQrUrl }: { checkinQrUrl: string; checkoutQrUrl: string }) {
  const [checkinPng, setCheckinPng] = useState<string>("");
  const [checkoutPng, setCheckoutPng] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!checkinQrUrl || !checkoutQrUrl) return;
      const ci = await QRCode.toDataURL(checkinQrUrl, { margin: 1, width: 420 });
      const co = await QRCode.toDataURL(checkoutQrUrl, { margin: 1, width: 420 });
      setCheckinPng(ci);
      setCheckoutPng(co);
    })();
  }, [checkinQrUrl, checkoutQrUrl]);

  return (
    <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
      <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Check-in QR</div>
        {checkinPng ? <img src={checkinPng} alt="check-in QR" style={{ width: "100%", maxWidth: 360 }} /> : "…"}
      </div>

      <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Check-out QR</div>
        {checkoutPng ? <img src={checkoutPng} alt="check-out QR" style={{ width: "100%", maxWidth: 360 }} /> : "…"}
      </div>
    </div>
  );
}

