import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

/* =========================
   Supabase Setup
========================= */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const ADMIN_EMAIL = ((import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || "").toLowerCase();

const supabase =
  supabaseUrl && supabaseAnon ? createClient(supabaseUrl, supabaseAnon) : null;

/* =========================
   Brand / Links
========================= */
const BRAND_RED = "#8B0000";
const HEADSHOT_BUCKET = "gg-headshots";
// Official TREC rules landing page; section §535.65 includes the student identity requirement.
const TREC_RULES_URL = "https://www.trec.texas.gov/agency-information/rules-and-laws/trec-rules";

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

function isoNow() {
  return new Date().toISOString();
}

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

/* =========================
   Helpers
========================= */
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
function normalizeLicense(v: string) {
  return v.trim().toUpperCase().replace(/\s+/g, "");
}
function isValidLicense(v: string) {
  // Numeric portion is 6 or 7 digits; suffix required: -SA, -B, or -BB
  return /^\d{6,7}-(SA|B|BB)$/i.test(v);
}
function randCode(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function isExpired(expiresAt: string) {
  return Date.now() > new Date(expiresAt).getTime();
}
function qrPayload(action: "checkin" | "checkout", sessionId: string, code: string, expiresAt: string) {
  return JSON.stringify({ action, sessionId, code, expiresAt });
}

/* =========================
   Time helpers (Central)
========================= */
function formatCentral(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function capWords(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}


/* =========================
   CSV (roster) helpers
========================= */
type RosterRow = {
  trec_license: string;
  first_name?: string;
  last_name?: string;
  notes?: string;
  payment_method?: "pay_link" | "cash";
  is_walkin?: boolean;
};
function csvToRoster(csv: string): RosterRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idxLic = header.indexOf("trec_license");
  const idxFn = header.indexOf("first_name");
  const idxLn = header.indexOf("last_name");
  const idxNotes = header.indexOf("notes");
  if (idxLic === -1) return [];

  const out: RosterRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    const lic = normalizeLicense(parts[idxLic] || "");
    if (!isValidLicense(lic)) continue;
    out.push({
      trec_license: lic,
      first_name: idxFn >= 0 ? parts[idxFn] : "",
      last_name: idxLn >= 0 ? parts[idxLn] : "",
      notes: idxNotes >= 0 ? parts[idxNotes] : "",
      payment_method: "pay_link",
      is_walkin: false,
    });
  }
  return out;
}

/* =========================
   App
========================= */
export default function App() {
  const [status, setStatus] = useState("");

  // Auth / profile
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseInput, setLicenseInput] = useState("");
  const [authed, setAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Password recovery
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  // Tabs
  const [tab, setTab] = useState<"student" | "admin">("student");

  // Sessions + attendance
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  const [checkinQrUrl, setCheckinQrUrl] = useState("");
  const [checkoutQrUrl, setCheckoutQrUrl] = useState("");

  const [rosterCSV, setRosterCSV] = useState("trec_license,first_name,last_name,notes\n");
  const [roster, setRoster] = useState<RosterRow[]>([]);

const [adminStatus, setAdminStatus] = useState<string>("");

// =========================
// Roster persistence (admin convenience)
// Persists roster per session in browser localStorage so it survives reloads.
// =========================
const rosterStorageKey = (sessionId: string) => `ggsore_roster_v1_${sessionId}`;

function loadRosterFromStorage(sessionId: string): RosterRow[] {
  try {
    const raw = window.localStorage.getItem(rosterStorageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RosterRow[]) : [];
  } catch {
    return [];
  }
}

function saveRosterToStorage(sessionId: string, rows: RosterRow[]) {
  try {
    window.localStorage.setItem(rosterStorageKey(sessionId), JSON.stringify(rows));
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

// Load roster whenever the active session changes
useEffect(() => {
  if (!activeSessionId) return;
  const stored = loadRosterFromStorage(activeSessionId);
  if (stored.length) {
    setRoster(stored);
    refreshRosterHeadshots(stored);
  } else {
    setRoster([]);
    setRosterHeadshots({});
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [activeSessionId]);

async function upsertRosterRowsForSession(sessionId: string, rows: RosterRow[]) {
  // For now, roster lives in localStorage (and in React state).
  // Attendance is persisted in Supabase; roster is convenience data for instructors.
  saveRosterToStorage(sessionId, rows);
  setRoster(rows);
  await refreshRosterHeadshots(rows);
}

  const [walkinFirst, setWalkinFirst] = useState("");
  const [walkinLast, setWalkinLast] = useState("");
  const [walkinLicense, setWalkinLicense] = useState("");
  const [walkinPayMethod, setWalkinPayMethod] = useState<"pay_link" | "cash">("pay_link");
  const [walkinNotes, setWalkinNotes] = useState("");
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  const [rosterHeadshots, setRosterHeadshots] = useState<Record<string, string>>({});
  const [absentSet, setAbsentSet] = useState<Record<string, boolean>>({});
  const [removedSet, setRemovedSet] = useState<Record<string, boolean>>({});

  // Student scanning
  const [scanText, setScanText] = useState("");
  type ScanResult = { kind: "success" | "error"; message: string };
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  // Headshot
  const [headshotPath, setHeadshotPath] = useState<string>("");
  const [headshotSignedUrl, setHeadshotSignedUrl] = useState<string>("");
  const [headshotUploading, setHeadshotUploading] = useState(false);
  const [pendingHeadshot, setPendingHeadshot] = useState<File | null>(null);

  function setAdminFromEmail(e: string) {
    const norm = e.trim().toLowerCase();
    setIsAdmin(Boolean(ADMIN_EMAIL) && norm === ADMIN_EMAIL);
  }

  async function refreshHeadshotSignedUrl(path: string) {
    if (!supabase || !path) return;
    const { data, error } = await supabase.storage.from("gg-headshots").createSignedUrl(path, 60 * 60 * 24 * 7);
    if (error) return;
    setHeadshotSignedUrl(data?.signedUrl || "");
  }

  async function uploadHeadshot(file: File) {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return setStatus("Log in first.");

    setHeadshotUploading(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${user.id}/${Date.now()}_${safeName}`;

      const { error: upErr } = await supabase.storage.from("gg-headshots").upload(path, file, {
        cacheControl: "3600",
        upsert: true,
        contentType: file.type || "image/jpeg",
      });
      if (upErr) throw upErr;

      const { error: metaErr } = await supabase.auth.updateUser({ data: { headshot_path: path } });
      if (metaErr) throw metaErr;
    // Also keep a simple public profile map by TREC license for instructor roster display
    // (Requires gg_profiles table; see SQL snippet)
    try {
      const lic = normalizeLicense(licenseInput);
      if (isValidLicense(lic)) {
        await supabase.from("gg_profiles").upsert(
          { trec_license: lic, headshot_path: path, updated_at: isoNow() },
          { onConflict: "trec_license" }
        );
      }
    } catch {}

    // Refresh roster headshots if this student's license is on the roster
    await refreshRosterHeadshots();


      setHeadshotPath(path);
      await refreshHeadshotSignedUrl(path);
      setStatus("Headshot uploaded.");
    } catch (e: any) {
      setStatus(e?.message || "Upload failed.");
    } finally {
      setHeadshotUploading(false);
    }
  }  // =========================
  // Roster headshot map (gg_profiles)
  // =========================
    async function refreshRosterHeadshots(currentRoster: RosterRow[] = roster) {
    if (!supabase) return;

    // Build unique list of valid licenses
    const uniq = Array.from(
      new Set(
        (currentRoster || [])
          .map((r) => normalizeLicense(r.trec_license))
          .filter((x) => isValidLicense(x))
      )
    );

    if (!uniq.length) {
      setRosterHeadshots({});
      return;
    }

    // Source of truth: gg_headshots_map (license -> storage path)
    const { data, error } = await supabase
      .from("gg_headshots_map")
      .select("trec_license, headshot_path")
      .in("trec_license", uniq);

    if (error) {
      console.warn("refreshRosterHeadshots error:", error.message);
      return;
    }

    const rows = (data as any[]) || [];
    const pairs = rows
      .map((r) => ({
        lic: normalizeLicense(r.trec_license || ""),
        path: (r.headshot_path as string | null) || "",
      }))
      .filter((x) => x.lic && x.path);

    const out: Record<string, string> = {};

    await Promise.all(
      pairs.map(async ({ lic, path }) => {
        try {
          const { data: signed, error: sErr } = await supabase.storage
            .from(HEADSHOT_BUCKET)
            .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days

          if (!sErr && signed?.signedUrl) out[lic] = signed.signedUrl;
        } catch (e) {
          // ignore individual failures
        }
      })
    );

    setRosterHeadshots(out);
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

    const hs = (u.user_metadata?.headshot_path as string | undefined) || "";
    setHeadshotPath(hs);
    if (hs) await refreshHeadshotSignedUrl(hs);
  }

  // Detect password recovery + listen for auth events
  useEffect(() => {
    if (!supabase) return;

    const hash = window.location.hash || "";
    const qs = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    if (qs.get("type") === "recovery") {
      setRecoveryMode(true);
      setStatus("Set a new password below.");
    }

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

  // =========================
  // Supabase: Load sessions + attendance
  // =========================
  async function refreshSessions() {
    if (!supabase) return;

    const { data, error } = await supabase.from("gg_sessions").select("*").order("starts_at", { ascending: false }).limit(50);
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    const ui = (data as DBSess[]).map(dbSessToUi);
    setSessions(ui);
    if (!activeSessionId && ui.length) setActiveSessionId(ui[0].id);
  }

  async function refreshAttendanceForActiveSession(sessionId: string) {
    if (!supabase || !sessionId) return;
    const { data, error } = await supabase.from("gg_attendance").select("*").eq("session_id", sessionId);
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
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


  // =========================
  // Admin manual attendance overrides (for hotspots / glitches)
  // =========================
  async function adminSetAttendance(
    licRaw: string,
    action: "checkin" | "checkout" | "undo_checkin" | "undo_checkout"
  ) {
    if (!supabase || !activeSessionId) return;

    const lic = normalizeLicense(licRaw);
    const now = isoNow();

    const patch: any = { session_id: activeSessionId, trec_license: lic };

    if (action === "checkin") {
      patch.checkin_at = now;
      patch.method_checkin = "manual";
    } else if (action === "checkout") {
      patch.checkout_at = now;
      patch.method_checkout = "manual";
    } else if (action === "undo_checkin") {
      patch.checkin_at = null;
      patch.method_checkin = null;
    } else if (action === "undo_checkout") {
      patch.checkout_at = null;
      patch.method_checkout = null;
    }

    try {
      setStatus("Saving…");

      const { error } = await supabase
        .from("gg_attendance")
        .upsert(patch, { onConflict: "session_id,trec_license" });

      if (error) {
        setStatus(error.message);
        return;
      }

      await refreshAttendanceForActiveSession(activeSessionId);

      // Refresh headshots too (safe: if any errors, we don't crash the admin UI)
      try {
        await refreshRosterHeadshotsForLicenses([lic]);
      } catch {
        /* ignore */
      }

      setStatus("Saved.");
    } catch (e: any) {
      setStatus(e?.message || "Failed to save attendance.");
    }
  }

  useEffect(() => {
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  useEffect(() => {
    if (!activeSessionId) return;
    refreshAttendanceForActiveSession(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  // Build QR images for active session
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

  // Roster import
  
  async function handleRosterFile(file: File) {
    try {
      const text = await file.text();
      // normalize line endings
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      setRosterCSV(normalized);
      setStatus(`CSV file loaded: ${file.name}. Tap “Load Roster” to import.`);
    } catch (e: any) {
      setStatus(e?.message || "Could not read the CSV file.");
    }
  }

async function importRoster() {
    try {
      const r = csvToRoster(rosterCSV);
      setRoster(r);
      setRemovedSet({});
      setAbsentSet({});
      await refreshRosterHeadshots(r);
      setStatus(`Roster loaded: ${r.length} student(s).`);
    } catch (e: any) {
      setStatus(e?.message || "Roster import failed. Check the CSV format.");
    }
  }

  async function addWalkInToRoster() {
    setStatus("");

    const lic = normalizeLicense(walkInLicense);
    if (!isValidLicense(lic)) {
      return setStatus("Enter full TREC license like 123456-SA (suffix: -SA, -B, or -BB).");
    }

    const fn = (walkInFirst || "").trim();
    const ln = (walkInLast || "").trim();
    if (!fn || !ln) return setStatus("Enter first and last name.");

    const method = walkInPayment; // "paylink" | "cash"

    // Build the roster row first so we can reuse it
    const row: RosterRow = {
      trec_license: lic,
      first_name: fn,
      last_name: ln,
      notes: method === "cash" ? "Walk-in (Cash)" : "Walk-in (Pay Link)",
    };

    // Update local roster state
    setRoster((prev) => {
      const exists = prev.some((r) => normalizeLicense(r.trec_license) === lic);
      if (exists) return prev;
      return [row, ...prev].sort((a, b) => (a.last_name || "").localeCompare(b.last_name || ""));
    });

    // Ensure roster exists in Supabase for the active session
    if (supabase && activeSessionId) {
      await upsertRosterRowsForSession(activeSessionId, [row]);
      await refreshRosterHeadshots(rowsNext);
    }

    // Mark as PRESENT by default: create/refresh attendance row (notes store payment method)
    await adminSetAttendance(lic, "checkin", "manual", method);

    // clear form
    setWalkInFirst("");
    setWalkInLast("");
    setWalkInLicense("");
    setWalkInPayment("paylink");
    setStatus("Walk-in added and checked in.");
  }


  // Keep roster headshots refreshed (admin roster display)
  useEffect(() => {
    if (!supabase) return;
    // Don't run when roster is empty
    if (!roster.length) {
      setRosterHeadshots({});
      return;
    }
    refreshRosterHeadshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.length, authed]);


  // =========================
  // Auth
  // =========================
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

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) return setStatus("Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB).");

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: password.trim(),
    });
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    await ensureLicenseSavedToProfile(lic);

    setAuthed(true);
    setAdminFromEmail(email);
    setStatus("Logged in.");
    await loadSessionFromSupabase();
  }

  async function createAccount() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!email.trim()) return setStatus("Enter an email.");
    if (!password.trim() || password.trim().length < 8) return setStatus("Use a password with at least 8 characters.");

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) return setStatus("Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB).");

    const { error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password: password.trim(),
      options: { data: { trec_license: lic } },
    });
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    setAuthed(true);
    setAdminFromEmail(email);
    setStatus("Account created.");
    await loadSessionFromSupabase();
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut();
    setAuthed(false);
    setIsAdmin(false);
    setPassword("");
    setScanText("");
    stopCamera();
    setStatus("Logged out.");
  }

  async function forgotPassword() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    const e = email.trim().toLowerCase();
    if (!e) return setStatus("Enter your email first, then tap Forgot password.");

    const { error } = await supabase.auth.resetPasswordForEmail(e, { redirectTo: window.location.origin });
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    setStatus("Password reset email sent. Open it on this same device to set a new password.");
  }

  async function setPasswordFromRecovery() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");
    if (!newPassword || newPassword.length < 8) return setStatus("New password must be at least 8 characters.");
    if (newPassword !== newPassword2) return setStatus("Passwords do not match.");

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    setRecoveryMode(false);
    setNewPassword("");
    setNewPassword2("");
    setStatus("Password updated. Please log in.");
  }

  // =========================
  // Admin: Create session in Supabase (Central timing defaults)
  // =========================
  const COURSE_TITLES = [
    "Commercial Leasing 101™",
    "Commercial Leasing Contracts 101™",
    "Commercial  Letters of Intent 101 for Leasing & Sales™",
    "Things You Need to Know About Practicing Law in Real Estate™",
    "Deal Dynamics: Deciphering Commercial Real Estate Contracts™",
    "Commercial Sales 101: From Client to Contract to Close™",
    "Commercial Property Management 101 - (Apartments Not Included)™",
    "Lights, Camera, Impact! REALTORS®  Guide to Success on Camera™",
    "High Stakes: Seed-to-Sale Hemp Law Changes in Texas™ (3 hours)™",
    "First, It's Not Marijuana: Hemp Laws & Texas Real Estate (2 hours)™",
  ];

  const [adminTitle, setAdminTitle] = useState(COURSE_TITLES[0]);
  const [adminStart, setAdminStart] = useState<string>(() => {
    const d = new Date();
    // default to today at 9:00am Central-ish (local input uses local time)
    d.setHours(9, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [adminEnd, setAdminEnd] = useState<string>(() => {
    const d = new Date();
    d.setHours(17, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });

  // Walk-in form (Admin only)
  const [walkInLicense, setWalkInLicense] = useState<string>("");
  const [walkInFirst, setWalkInFirst] = useState<string>("");
  const [walkInLast, setWalkInLast] = useState<string>("");
  const [walkInPayment, setWalkInPayment] = useState<"pay_link" | "cash">("pay_link");


  function computeSessionTimes(startLocal: string, endLocal: string) {
    const start = new Date(startLocal);
    const end = new Date(endLocal);

    // Check-in open 30 mins before start; expires 30 mins after start
    const checkinOpen = new Date(start.getTime() - 30 * 60 * 1000);
    const checkinExp = new Date(start.getTime() + 30 * 60 * 1000);

    // Check-out open 60 mins before end; expires 60 mins after end
    const checkoutOpen = new Date(end.getTime() - 60 * 60 * 1000);
    const checkoutExp = new Date(end.getTime() + 60 * 60 * 1000);

    return { start, end, checkinOpen, checkinExp, checkoutOpen, checkoutExp };
  }

  async function createSessionInSupabase() {
    setStatus("");
    if (!supabase) return setStatus("Supabase is not connected.");

    const { data } = await supabase.auth.getSession();
    if (!data.session?.user) return setStatus("Log in first.");

    if (!adminTitle.trim()) return setStatus("Select a class title.");
    if (!adminStart) return setStatus("Select a start time.");
    if (!adminEnd) return setStatus("Select an end time.");

    const { start, end, checkinExp, checkoutExp } = computeSessionTimes(adminStart, adminEnd);
    if (end.getTime() <= start.getTime()) return setStatus("End must be after Start.");

    const s: Session = {
      id: crypto.randomUUID(),
      title: adminTitle.trim(),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      checkinExpiresAt: checkinExp.toISOString(),
      checkoutExpiresAt: checkoutExp.toISOString(),
      checkinCode: randCode(),
      checkoutCode: randCode(),
    };

    const { error } = await supabase.from("gg_sessions").insert([{ id: s.id, ...uiSessToDb(s) }]);
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    await refreshSessions();
    setActiveSessionId(s.id);
    setStatus("Session created.");
  }

  // =========================
  // Student: Submit scan / manual
  // =========================
  async function submitToken(method: "scan" | "manual", forceAction?: "checkin" | "checkout", tokenOverride?: string) {
    setStatus("");
    setScanResult(null);
    if (!supabase) return setStatus("Supabase is not connected.");

    const lic = normalizeLicense(licenseInput);
    if (!isValidLicense(lic)) return setStatus("Enter full TREC license number like 123456-SA (suffix required: -SA, -B, or -BB).");
    if (!activeSession) return setStatus("No active session yet.");

    const raw = (tokenOverride ?? scanText).trim();
    if (!raw) return setStatus(isAdmin ? "Paste token text or scan a QR code." : "Scan the QR code shown on the classroom screen.");

    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return setStatus("Invalid token.");
    }

    const action = (forceAction || payload.action) as "checkin" | "checkout";
    if (payload.sessionId !== activeSession.id) return setStatus("This QR code is for a different session.");
    if (payload.code !== (action === "checkin" ? activeSession.checkinCode : activeSession.checkoutCode)) return setStatus("Invalid code.");
    if (isExpired(payload.expiresAt)) return setStatus("This QR code has expired.");

    const now = new Date().toISOString();
    const patch: any = { session_id: activeSession.id, trec_license: lic };
    if (action === "checkin") {
      patch.checkin_at = now;
      patch.method_checkin = method;
    } else {
      patch.checkout_at = now;
      patch.method_checkout = method;
    }

    const { error } = await supabase.from("gg_attendance").upsert([patch], { onConflict: "session_id,trec_license" });
    if (error) {
      setScanResult({ kind: "error", message: error.message });
      return setStatus(error.message);
    }

    await refreshAttendanceForActiveSession(activeSession.id);
    setScanText("");
    setStatus(action === "checkin" ? "Checked in!" : "Checked out!");
    setScanResult({
      kind: "success",
      message: action === "checkin"
        ? "✅ Success! Check-in recorded."
        : "✅ Success! Check-out recorded.",
    });
  }

  // =========================
  // Camera scanning
  // =========================
  function clearScanLoop() {
    if (scanTimerRef.current) {
      window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }

  function stopCamera() {
    clearScanLoop();
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setCameraOn(false);
  }

  async function startCamera() {
    setStatus("");
    setScanResult(null);

    try {
      // Request the stream first
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });

      // Show the preview panel
      setCameraOn(true);

      // Wait for the <video> to mount
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      let v = videoRef.current;
      if (!v) {
        await new Promise((r) => setTimeout(r, 50));
        v = videoRef.current;
      }
      if (!v) throw new Error("Camera preview not ready.");

      v.srcObject = stream;
      await v.play();

      // Start scanning loop
      scanLoop();
    } catch {
      setCameraOn(false);
      setStatus("Camera blocked/unavailable. Please allow camera permissions.");
      setScanResult({ kind: "error", message: "Camera blocked/unavailable. Please allow camera permissions." });
    }
  }

  async function scanOnce(): Promise<string | null> {
    // @ts-ignore
    if (!("BarcodeDetector" in window)) return null;
    const v = videoRef.current;
    if (!v) return null;
    if (!v.videoWidth || !v.videoHeight) return null;

    // @ts-ignore
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });

    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    // @ts-ignore
    const bitmap = await createImageBitmap(canvas);
    const codes = await detector.detect(bitmap);
    if (!codes || !codes.length) return null;

    const raw = (codes[0] as any).rawValue as string | undefined;
    return raw || null;
  }

  function scanLoop() {
    clearScanLoop();

    // @ts-ignore
    if (!("BarcodeDetector" in window)) {
      setStatus("This browser can't scan QR codes. Try Chrome/Safari on mobile.");
      return;
    }

    const tick = async () => {
      if (!cameraOn) return;
      try {
        const raw = await scanOnce();
        if (raw) {
          setScanText(raw);
          stopCamera();
          await submitToken("scan", undefined, raw);
          return;
        }
      } catch {
        // ignore
      }
      scanTimerRef.current = window.setTimeout(tick, 700);
    };

    scanTimerRef.current = window.setTimeout(tick, 350);
  }

  // =========================
  // Derived UI
  // =========================
  const canSeeAdminTab = isAdmin;

  const rosterMap = useMemo(() => {
    const m = new Map<string, RosterRow>();
    roster.forEach((r) => m.set(r.trec_license, r));
    return m;
  }, [roster]);

  const attendanceMap = useMemo(() => {
    const m = new Map<string, Attendance>();
    attendance.forEach((a) => m.set(a.trec_license, a));
    return m;
  }, [attendance]);

  // Helper: get attendance record for a license in the active session
  const getAtt = (licRaw: string): Attendance | null => {
    const lic = normalizeLicense(licRaw);
    return attendanceMap.get(lic) || null;
  };



  const checkedInCount = useMemo(() => attendance.filter((a) => Boolean(a.checkin_at)).length, [attendance]);
  const checkedOutCount = useMemo(() => attendance.filter((a) => Boolean(a.checkout_at)).length, [attendance]);

  // =========================
  // UI
  // =========================
  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", padding: 16, fontFamily: "Century Gothic, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <img src="/ggsore-logo.png" alt="The Guillory Group School of Real Estate" style={{ width: 54, height: 54, borderRadius: 14, objectFit: "contain" }} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 2 }}>The Guillory Group School of Real Estate Student Attendance App</div>
            <div style={{ opacity: 0.75, fontSize: 13 }}>
              TREC Education Provider #9998-CEP
            </div>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="App sections" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            onClick={() => setTab("student")}
            style={{
              padding: "12px 16px",
              borderRadius: 999,
              border: "1px solid #1167b1",
              background: tab === "student" ? BRAND_RED : "#fff",
              color: tab === "student" ? "#fff" : "#111",
              fontWeight: 900,
            }}
          >
            Student
          </button>

          {canSeeAdminTab && (
            <button
              onClick={() => setTab("admin")}
              style={{
                padding: "12px 16px",
                borderRadius: 999,
                border: "1px solid #1167b1",
                background: tab === "admin" ? BRAND_RED : "#fff",
                color: tab === "admin" ? "#fff" : "#111",
                fontWeight: 900,
              }}
            >
              Admin / Instructor
            </button>
          )}
        </div>

        {status && (tab === "admin" || !status.toLowerCase().startsWith("roster loaded")) && (
          <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 12, marginBottom: 12, color: "#111", fontWeight: 800 }} aria-live="polite">
            {status}
          </div>
        )}

        {/* =========================
           Auth / Profile
        ========================= */}
        <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "grid", gap: 10 }}>
            
            {authed && !recoveryMode && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: 12, borderRadius: 14, border: "1px solid #ddd", background: "#fff", color: "#111", marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>Welcome to class.</div>
                  <div className="small" style={{ opacity: 0.85 }}>Signed in as <b>{email}</b>.</div>
                </div>
                <button
                  onClick={logout}
                  style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #8B0000", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                >
                  Log out
                </button>
              </div>
            )}

            {!authed && (
              <>
<div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 800 }}>Email</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                style={{ height: 52, borderRadius: 14, border: "1px solid #1167b1", padding: "0 12px", fontSize: 16 }}
              />
            </div>

            {!recoveryMode && (
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontWeight: 800 }}>Password</label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="••••••••"
                  style={{ height: 52, borderRadius: 14, border: "1px solid #1167b1", padding: "0 12px", fontSize: 16 }}
                />
              </div>
            )}

            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontWeight: 800 }}>TREC License Number</label>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Numeric portion is 6–7 digits. Suffix required: <b>-SA</b>, <b>-B</b>, or <b>-BB</b>. Example: <b>0123456-SA</b>
              </div>
              <input
                value={licenseInput}
                onChange={(e) => setLicenseInput(e.target.value)}
                placeholder="0123456-SA"
                style={{ height: 52, borderRadius: 14, border: "1px solid #1167b1", padding: "0 12px", fontSize: 16 }}
              />
            </div>

            
              </>
            )}


{recoveryMode ? (
              <div style={{ borderTop: "1px solid #eee", paddingTop: 12, marginTop: 6 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Create New Password</div>
                <input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  type="password"
                  placeholder="New password (8+ characters)"
                  style={{ height: 52, borderRadius: 14, border: "1px solid #1167b1", padding: "0 12px", fontSize: 16, marginBottom: 10 }}
                />
                <input
                  value={newPassword2}
                  onChange={(e) => setNewPassword2(e.target.value)}
                  type="password"
                  placeholder="Confirm new password"
                  style={{ height: 52, borderRadius: 14, border: "1px solid #1167b1", padding: "0 12px", fontSize: 16, marginBottom: 12 }}
                />

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={setPasswordFromRecovery}
                    style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #1167b1", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                  >
                    Set New Password
                  </button>
                  <button
                    onClick={() => setRecoveryMode(false)}
                    style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #8B0000", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                  >
                    Back to login
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                {!authed ? (
                  <>
                    <button
                      onClick={login}
                      style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #1167b1", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                    >
                      Log In
                    </button>
                    <button
                      onClick={createAccount}
                      style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #8B0000", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                    >
                      Create Account
                    </button>
                    <button
                      onClick={forgotPassword}
                      style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #8B0000", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                    >
                      Forgot password
                    </button>
                  </>
                ) : (
                  <button
                    onClick={logout}
                    style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #8B0000", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                  >
                    Log out
                  </button>
                )}
              </div>
            )}

            <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
              Identity verification is required for CE attendance under TREC Rule §535.65.{" "}
              <a href={TREC_RULES_URL} target="_blank" rel="noreferrer" style={{ fontWeight: 900 }}>
                Learn More
              </a>
            </div>
          </div>
        </div>

        {/* =========================
           STUDENT TAB
        ========================= */}
        {tab === "student" && (
          <>
            {/* Headshot Upload */}
            <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16, marginBottom: 12 }}>
              <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>Headshot</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
                A clear headshot helps verify identity for CE attendance (no driver license uploads needed).
              </div>

              <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                {headshotSignedUrl ? (
                  <img
                    src={headshotSignedUrl}
                    alt="Headshot"
                    style={{
                      width: 90,
                      height: 120,
                      objectFit: "cover",
                      objectPosition: "center top",
                      borderRadius: 12,
                      border: "1px solid #1167b1",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 90,
                      height: 120,
                      borderRadius: 12,
                      border: "1px dashed #bbb",
                      display: "grid",
                      placeItems: "center",
                      opacity: 0.75,
                      fontSize: 12,
                    }}
                  >
                    No photo
                  </div>
                )}

                <div style={{ display: "grid", gap: 10 }}>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      setPendingHeadshot(f);
                    }}
                  />

                  {pendingHeadshot && (
                    <img
                      src={URL.createObjectURL(pendingHeadshot)}
                      alt="Selected headshot preview"
                      style={{
                        width: 140,
                        height: 186,
                        objectFit: "cover",
                        objectPosition: "center top",
                        borderRadius: 12,
                        border: "1px solid #1167b1",
                      }}
                    />
                  )}

                  <button
                    disabled={!pendingHeadshot || headshotUploading || !authed}
                    onClick={async () => {
                      if (!pendingHeadshot) return;
                      await uploadHeadshot(pendingHeadshot);
                      setPendingHeadshot(null);
                    }}
                    style={{
                      padding: "12px 16px",
                      borderRadius: 12,
                      border: `1px solid ${BRAND_RED}`,
                      background: BRAND_RED,
                      color: "#fff",
                      fontWeight: 900,
                      opacity: !authed || !pendingHeadshot || headshotUploading ? 0.6 : 1,
                    }}
                  >
                    {headshotUploading ? "Uploading..." : authed ? "Upload Photo" : "Log in to upload"}
                  </button>
                </div>
              </div>
            </div>

            {/* Student Scan Panel */}
            <div style={ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }>
              <h3 style={{ marginTop: 0 }}>Check In / Check Out</h3>

              {!authed ? (
                <div style={{ opacity: 0.85 }}>Log in first, then scan the QR code shown on the classroom screen.</div>
              ) : !activeSession ? (
                <div style={{ opacity: 0.85 }}>No class session is active yet. Please wait for the instructor to open today’s session.</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
                    Active session: <b>{activeSession.title}</b> — {formatCentral(activeSession.startsAt)}
                  </div>
      {scanResult && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginBottom: 12,
            borderRadius: 16,
            padding: "14px 16px",
            border: scanResult.kind === "success" ? "1px solid #0a7a2f" : "1px solid #b00020",
            background: scanResult.kind === "success" ? "#e8f5ec" : "#fde8ea",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontWeight: 900,
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              background: scanResult.kind === "success" ? "#0a7a2f" : "#b00020",
              color: "#fff",
              fontSize: 18,
            }}
          >
            {scanResult.kind === "success" ? "✓" : "!"}
          </div>
          <div>{scanResult.message}</div>
        </div>
      )}


                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    {!cameraOn ? (
                      <button
                        onClick={startCamera}
                        style={{
                          padding: "14px 18px",
                          borderRadius: 14,
                          border: `1px solid ${BRAND_RED}`,
                          background: BRAND_RED,
                          color: "#fff",
                          fontWeight: 900,
                          fontSize: 16,
                        }}
                      >
                        Turn On Camera
                      </button>
                    ) : (
                      <button
                        onClick={stopCamera}
                        style={{
                          padding: "14px 18px",
                          borderRadius: 14,
                          border: "1px solid #1167b1",
                          background: "#187bcd",
                          fontWeight: 900,
                          fontSize: 16,
                        }}
                      >
                        Stop Camera
                      </button>
                    )}

                    

                    
                  </div>

                  {/* Always render video element (so ref always exists) */}
                  <div style={{ border: "1px solid #1167b1", borderRadius: 16, padding: 12, display: cameraOn ? "block" : "none" }}>
                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
                      Camera preview (aim at the QR code)
                    </div>
                    <video ref={videoRef} style={{ width: "100%", maxWidth: 520, borderRadius: 14 }} playsInline muted />
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
                      Scanning is automatic once the camera is on.
                    </div>
                  </div>

                  {/* Admin-only token paste fallback */}
                  {isAdmin && tab === "admin" && (
                    <div style={{ marginTop: 12 }}>
                      <label style={{ fontWeight: 900 }}>QR Token (admin fallback)</label>
                      <textarea
                        value={scanText}
                        onChange={(e) => setScanText(e.target.value)}
                        placeholder="Paste QR token text here if scanning fails"
                        style={{
                          width: "100%",
                          minHeight: 92,
                          borderRadius: 14,
                          border: "1px solid #1167b1",
                          padding: 12,
                          fontSize: 14,
                          marginTop: 6,
                        }}
                      />
                      <button
                        onClick={() => submitToken("scan")}
                        style={{
                          marginTop: 10,
                          padding: "12px 16px",
                          borderRadius: 12,
                          border: `1px solid ${BRAND_RED}`,
                          background: BRAND_RED,
                          color: "#fff",
                          fontWeight: 900,
                        }}
                      >
                        Submit Token
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* =========================
           ADMIN TAB
        ========================= */}
        {tab === "admin" && canSeeAdminTab && (
          <div style={ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }>
            <h2 style={{ marginTop: 0 }}>Admin / Instructor</h2>
          {adminStatus && (
            <div style={{ marginTop: 8, marginBottom: 8, padding: "10px 12px", borderRadius: 12, background: "#f1f5ff", border: "1px solid #1167b1", fontWeight: 800 }}>
              {adminStatus}
            </div>
          )}

            <div style={{ background: BRAND_RED, color: "#fff", borderRadius: 16, padding: 16, marginBottom: 12 }}>
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <label style={{ color: "#fff", fontWeight: 900 }}>CLASS TITLE</label>
                  <select
                    value={adminTitle}
                    onChange={(e) => setAdminTitle(e.target.value)}
                    style={{ width: "100%", height: 50, borderRadius: 12, border: "1px solid rgba(255,255,255,0.35)", padding: "0 12px", marginTop: 6, fontSize: 16 }}
                  >
                    {COURSE_TITLES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label style={{ color: "#fff", fontWeight: 900 }}>START</label>
                    <input
                      type="datetime-local"
                      value={adminStart}
                      onChange={(e) => setAdminStart(e.target.value)}
                      style={{ width: "100%", height: 50, borderRadius: 12, border: "1px solid rgba(255,255,255,0.35)", padding: "0 12px", marginTop: 6, fontSize: 16 }}
                    />
                    <div style={{ fontSize: 11, opacity: 0.9, marginTop: 4 }}>Central Time</div>
                  </div>

                  <div>
                    <label style={{ color: "#fff", fontWeight: 900 }}>END</label>
                    <input
                      type="datetime-local"
                      value={adminEnd}
                      onChange={(e) => setAdminEnd(e.target.value)}
                      style={{ width: "100%", height: 50, borderRadius: 12, border: "1px solid rgba(255,255,255,0.35)", padding: "0 12px", marginTop: 6, fontSize: 16 }}
                    />
                    <div style={{ fontSize: 11, opacity: 0.9, marginTop: 4 }}>Central Time</div>
                  </div>
                </div>

                <button
                  onClick={createSessionInSupabase}
                  style={{
                    padding: "12px 16px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.35)",
                    background: "#8B0000",
                    color: "#fff",
                    fontWeight: 900,
                  }}
                >
                  Create New Class Session
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
              <div>
                <b style={{ fontSize: 16 }}>Active Session</b>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  Select the class session for today.
                </div>
              </div>

              <select
                value={activeSessionId}
                onChange={(e) => setActiveSessionId(e.target.value)}
                style={{ height: 56, borderRadius: 18, border: "1px solid #1167b1", fontSize: 16, padding: "0 14px" }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} — {formatCentral(s.startsAt)}
                  </option>
                ))}
              </select>
            </div>

            {activeSession && (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div style={{ background: "#f8f8f9", border: "1px solid #1167b1", borderRadius: 16, padding: 12, minWidth: 220 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Check-In QR</div>
                    {checkinQrUrl && <img src={checkinQrUrl} alt="Check-in QR" style={{ width: "100%", maxWidth: 320, borderRadius: 12 }} />}
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                      Expires: {formatCentral(activeSession.checkinExpiresAt)}
                    </div>
                  </div>

                  <div style={{ background: "#f8f8f9", border: "1px solid #1167b1", borderRadius: 16, padding: 12, minWidth: 220 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Check-Out QR</div>
                    {checkoutQrUrl && <img src={checkoutQrUrl} alt="Check-out QR" style={{ width: "100%", maxWidth: 320, borderRadius: 12 }} />}
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                      Expires: {formatCentral(activeSession.checkoutExpiresAt)}
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 220, background: "#f8f8f9", border: "1px solid #1167b1", borderRadius: 16, padding: 12 }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Stats</div>
                    <div>Checked in: <b>{checkedInCount}</b> • Checked out: <b>{checkedOutCount}</b></div>
                  </div>
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>Roster Import (CSV)</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>Paste CSV with header trec_license,first_name,last_name,notes</div>
                    </div>
                    <button onClick={importRoster} style={{ padding: "12px 16px", borderRadius: 12, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
                      Load Roster
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                    <div className="small" style={{ fontSize: 12, opacity: 0.85 }}>
                      Upload roster CSV:
                    </div>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleRosterFile(f);
                      }}
                    />
                  </div>

                  
                </div>


                <div style={ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16, marginTop: 12 }>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Add Walk-In (paid at the door)</div>
                  <div className="small" style={{ opacity: 0.85, marginBottom: 10 }}>
                    Use this when someone registers at the door. Choose Pay Link or Cash, then add them to today’s roster.
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div>
                        <label>First name</label>
                        <input value={walkinFirst} onChange={(e) => setWalkinFirst(e.target.value)} style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #1167b1", padding: "0 12px" }} />
                      </div>
                      <div>
                        <label>Last name</label>
                        <input value={walkinLast} onChange={(e) => setWalkinLast(e.target.value)} style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #1167b1", padding: "0 12px" }} />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr", gap: 10 }}>
                      <div>
                        <label>TREC license (include suffix)</label>
                        <input
                          value={walkinLicense}
                          onChange={(e) => setWalkinLicense(e.target.value)}
                          placeholder="123456-SA"
                          style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #1167b1", padding: "0 12px" }}
                        />
                      </div>
                      <div>
                        <label>Payment</label>
                        <select
                          value={walkinPayMethod}
                          onChange={(e) => setWalkinPayMethod(e.target.value as any)}
                          style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #1167b1", padding: "0 12px" }}
                        >
                          <option value="pay_link">Pay Link</option>
                          <option value="cash">Cash</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label>Notes (optional)</label>
                      <input value={walkinNotes} onChange={(e) => setWalkinNotes(e.target.value)} style={{ width: "100%", height: 46, borderRadius: 12, border: "1px solid #1167b1", padding: "0 12px" }} />
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button
                        onClick={addWalkInToRoster}
                        style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #1167b1", background: "#8B0000", color: "#fff", fontWeight: 900 }}
                      >
                        Add Walk-In
                      </button>
                    </div>
                  </div>
                </div>


                <div style={ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Attendance</div>
                  <div style={{ overflowX: "auto" }}>
                    
<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
  <thead>
    <tr style={{ textAlign: "left" }}>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Name</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>TREC</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Photo</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Payment</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Check-in</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Check-out</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>Status</th>
      <th style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }} />
    </tr>
  </thead>
  <tbody>
    {roster
      .filter((r) => !removedSet[normalizeLicense(r.trec_license)])
      .map((r) => {
        const lic = normalizeLicense(r.trec_license);
        const a = getAtt(r.trec_license);
        const checkedIn = !!a?.checkin_at;
        const checkedOut = !!a?.checkout_at;
        const photo = rosterHeadshots[lic] || "";
        const statusText = checkedOut
          ? "Completed"
          : checkedIn
          ? "Checked in"
          : absentSet[lic]
          ? "Absent (marked)"
          : "Not checked in";

        return (
          <tr key={r.trec_license}>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px", fontWeight: 700 }}>
              {capWords(r.first_name)} {capWords(r.last_name)}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
              {lic}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px" }}>
              {photo ? (
                <img
                  src={photo}
                  alt="Headshot"
                  style={{
                    width: 44,
                    height: 58,
                    objectFit: "cover",
                    objectPosition: "center top",
                    borderRadius: 8,
                    border: "1px solid #1167b1",
                  }}
                />
              ) : (
                <div className="small" style={{ opacity: 0.6 }}>—</div>
              )}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px" }}>
              {r.payment || ""}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px" }}>
              {a?.checkin_at ? formatCentral(a.checkin_at) : "—"}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px" }}>
              {a?.checkout_at ? formatCentral(a.checkout_at) : "—"}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px", fontWeight: 800 }}>
              {statusText}
            </td>
            <td style={{ borderBottom: "1px solid #f2f2f2", padding: "8px 6px" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setAbsentSet((p) => ({ ...p, [lic]: !p[lic] }))}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #d0efff",
                    background: "#d0efff",
                    color: "#000",
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  {absentSet[lic] ? "Undo Absent" : "Mark Absent"}
                </button>

                <button
                  onClick={() => setRemovedSet((p) => ({ ...p, [lic]: true }))}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #1167b1",
                    background: "#187bcd",
                    color: "#fff",
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  Remove
                </button>

                  {/* Manual overrides */}
                  {!checkedIn ? (
                    <button
                      onClick={() => adminSetAttendance(lic, "checkin")}
                      style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #1167b1", background: "#1167b1", color: "#fff", fontWeight: 800 }}
                    >
                      Manual Check-In
                    </button>
                  ) : (
                    <button
                      onClick={() => adminSetAttendance(lic, "clear_checkin")}
                      style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #1167b1", background: "#1167b1", color: "#fff", fontWeight: 800 }}
                    >
                      Undo Check-In
                    </button>
                  )}

                  {!checkedOut ? (
                    <button
                      onClick={() => adminSetAttendance(lic, "checkout")}
                      style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #1167b1", background: "#1167b1", color: "#fff", fontWeight: 800 }}
                    >
                      Manual Check-Out
                    </button>
                  ) : (
                    <button
                      onClick={() => adminSetAttendance(lic, "clear_checkout")}
                      style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #1167b1", background: "#1167b1", color: "#fff", fontWeight: 800 }}
                    >
                      Undo Check-Out
                    </button>
                  )}

                <button
                  onClick={async () => {
                    if (!supabase) return;
                    try {
                      await supabase.from("gg_profiles").upsert(
                        { trec_license: lic, headshot_path: null, updated_at: isoNow() },
                        { onConflict: "trec_license" }
                      );
                      setRosterHeadshots((m) => {
                        const n = { ...m };
                        delete n[lic];
                        return n;
                      });
                      setStatus(`Headshot cleared for ${lic}.`);
                    } catch {
                      setStatus("Could not clear headshot (check gg_profiles table/policies).");
                    }
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid #03254c",
                    background: "#03254c",
                    color: "#fff",
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  Clear photo
                </button>
              </div>
            </td>
          </tr>
        );
      })}
  </tbody>
</table>

                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 14 }}>
          Admin access is restricted to the email stored in VITE_ADMIN_EMAIL (Vercel env var).
        </div>
      </div>
    </div>
  );

}


