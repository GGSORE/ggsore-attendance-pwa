import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import jsQR from "jsqr";

type AttendanceRow = {
  id?: string;
  session_id: string;
  trec_license: string;
  first_name: string;
  middle_initial?: string | null;
  last_name: string;
  payment?: "pay_link" | "cash" | null;
  note?: string | null;
  absent?: boolean | null;
  checkin_at?: string | null;
  checkout_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

type SessionRow = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  created_at?: string;
};

const BRAND_RED = "#8B0000";
const BTN_BLUE_LIGHT = "#d0efff"; // Mark Absent
const BTN_BLUE = "#187bcd";       // Remove
const BTN_NAVY = "#03254c";       // Clear Photo
const BTN_MIDBLUE = "#1167b1";    // Manual check in/out

const fontFamily = 'Century Gothic, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

function isoNow() {
  return new Date().toISOString();
}

function capWord(s: string) {
  if (!s) return s;
  return s
    .trim()
    .split(/\s+/g)
    .map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "")
    .join(" ");
}

function normalizeLicense(s: string) {
  return (s || "").trim().toUpperCase();
}

function parseCsv(text: string): Array<Pick<AttendanceRow,"trec_license"|"first_name"|"middle_initial"|"last_name"|"payment"|"note">> {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iLic = idx("trec_license");
  const iFirst = idx("first_name");
  const iLast = idx("last_name");
  const iMid = idx("middle_initial");
  const iPay = idx("payment");
  const iNote = idx("note");
  if (iLic < 0 || iFirst < 0 || iLast < 0) {
    throw new Error("CSV must include headers: trec_license,first_name,last_name (optional: middle_initial,payment,note)");
  }
  const out: any[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(",").map(c => c.trim());
    const trec_license = normalizeLicense(cols[iLic] || "");
    if (!trec_license) continue;
    out.push({
      trec_license,
      first_name: capWord(cols[iFirst] || ""),
      middle_initial: (iMid >= 0 ? (cols[iMid] || "").trim().slice(0, 1).toUpperCase() : "") || null,
      last_name: capWord(cols[iLast] || ""),
      payment: (iPay >= 0 ? (cols[iPay] || "").trim().toLowerCase() : "") as any,
      note: (iNote >= 0 ? (cols[iNote] || "").trim() : "") || null,
    });
  }
  return out;
}

async function fileToText(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error || new Error("File read failed"));
    fr.readAsText(file);
  });
}

export default function App() {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || "";

  const supabase: SupabaseClient | null = useMemo(() => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }, [SUPABASE_URL, SUPABASE_ANON_KEY]);

  const [tab, setTab] = useState<"student"|"admin">("student");
  const [status, setStatus] = useState<string>("");

  // Auth
  const [authed, setAuthed] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // Student account fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [trecLicense, setTrecLicense] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleInitial, setMiddleInitial] = useState("");
  const [lastName, setLastName] = useState("");

  // Student roster awareness
  const [rosterLoadedCount, setRosterLoadedCount] = useState<number>(0); // admin-only indicator (moved off student UI)
  const [studentRosterLoaded, setStudentRosterLoaded] = useState(false); // for student: do we have roster for selected session?

  // Sessions
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  // Admin: create session
  const [newTitle, setNewTitle] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");

  // Admin: roster import
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string>("");
  const [importing, setImporting] = useState(false);

  // Roster
  const [roster, setRoster] = useState<AttendanceRow[]>([]);
  const [headshotUrlByLicense, setHeadshotUrlByLicense] = useState<Record<string,string>>({});

  // Admin: walk-in form
  const [walkInLicense, setWalkInLicense] = useState("");
  const [walkInFirst, setWalkInFirst] = useState("");
  const [walkInMid, setWalkInMid] = useState("");
  const [walkInLast, setWalkInLast] = useState("");
  const [walkInPayment, setWalkInPayment] = useState<"pay_link"|"cash">("pay_link");
  const [walkInNote, setWalkInNote] = useState("");

  // Camera scanning
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [scanMode, setScanMode] = useState<"checkin"|"checkout">("checkin");
  const [scanToast, setScanToast] = useState<{type:"success"|"fail"|"info", msg:string} | null>(null);
  const scanLoopRef = useRef<number | null>(null);
  const lastScanAtRef = useRef<number>(0);

  const canSeeAdminTab = authed && isAdmin;

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const s = data.session;
      if (s?.user) {
        setAuthed(true);
        setUserEmail(s.user.email || "");
        setUserId(s.user.id);
        setIsAdmin(!!(ADMIN_EMAIL && s.user.email && s.user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()));
      } else {
        setAuthed(false);
        setUserEmail("");
        setUserId(null);
        setIsAdmin(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      setAuthed(!!u);
      setUserEmail(u?.email || "");
      setUserId(u?.id || null);
      setIsAdmin(!!(ADMIN_EMAIL && u?.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()));
      if (!u) {
        setTab("student");
        setActiveSessionId("");
        setRoster([]);
        setHeadshotUrlByLicense({});
        setRosterLoadedCount(0);
        setStudentRosterLoaded(false);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase, ADMIN_EMAIL]);

  // Load sessions for admin
  useEffect(() => {
    if (!supabase || !canSeeAdminTab) return;
    (async () => {
      const { data, error } = await supabase.from("gg_sessions").select("*").order("start_at", { ascending: false }).limit(50);
      if (error) {
        console.error(error);
        setStatus("Could not load sessions.");
        return;
      }
      setSessions((data || []) as any);
    })();
  }, [supabase, canSeeAdminTab]);

  // When active session changes: load roster from DB (single source of truth)
  useEffect(() => {
    if (!supabase || !activeSessionId) return;
    (async () => {
      const { data, error } = await supabase
        .from("gg_roster")
        .select("*")
        .eq("session_id", activeSessionId)
        .order("last_name", { ascending: true });
      if (error) {
        console.error(error);
        setStatus("Could not load roster for this session.");
        setRoster([]);
        setRosterLoadedCount(0);
        setStudentRosterLoaded(false);
        return;
      }
      const rows = (data || []) as AttendanceRow[];
      setRoster(rows);
      setRosterLoadedCount(rows.length);
      setStudentRosterLoaded(rows.length > 0);
      // headshots map lookup (best effort)
      await hydrateHeadshots(rows.map(r => r.trec_license));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, activeSessionId]);

  async function hydrateHeadshots(licenses: string[]) {
    if (!supabase) return;
    const unique = Array.from(new Set(licenses.map(normalizeLicense).filter(Boolean)));
    if (!unique.length) return;

    try {
      const { data: mapRows, error: mapErr } = await supabase
        .from("gg_headshot_map")
        .select("trec_license,headshot_path")
        .in("trec_license", unique);

      if (mapErr) {
        // table might not exist yet; fail quietly
        console.warn(mapErr);
        return;
      }

      const next: Record<string,string> = {};
      for (const row of (mapRows || []) as any[]) {
        const lic = normalizeLicense(row.trec_license || "");
        const path = String(row.headshot_path || "");
        if (!lic || !path) continue;
        const { data: signed } = await supabase.storage.from("gg-headshots").createSignedUrl(path, 60 * 60);
        if (signed?.signedUrl) next[lic] = signed.signedUrl;
      }
      setHeadshotUrlByLicense(prev => ({ ...prev, ...next }));
    } catch (e) {
      console.warn(e);
    }
  }

  async function signUpOrLogin(isSignup: boolean) {
    if (!supabase) return;
    setStatus("");
    const e = email.trim().toLowerCase();
    const pw = password;
    const lic = normalizeLicense(trecLicense);
    if (!e || !pw) return setStatus("Email and password are required.");
    if (isSignup) {
      if (!lic) return setStatus("TREC license is required.");
      if (!firstName.trim() || !lastName.trim()) return setStatus("First and last name are required.");
      const { error } = await supabase.auth.signUp({
        email: e,
        password: pw,
        options: {
          data: {
            trec_license: lic,
            first_name: capWord(firstName),
            middle_initial: (middleInitial || "").trim().slice(0,1).toUpperCase(),
            last_name: capWord(lastName),
          }
        }
      });
      if (error) return setStatus(error.message);
      setStatus("Account created. Please check email if confirmation is required, then log in.");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: e, password: pw });
    if (error) return setStatus(error.message);
  }

  async function logout() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  async function createSession() {
    if (!supabase) return;
    if (!isAdmin) return setStatus("Admin access required.");
    setStatus("");

    const title = newTitle.trim();
    const start_at = newStart.trim();
    const end_at = newEnd.trim();

    if (!title || !start_at || !end_at) return setStatus("Title, start, and end are required.");

    const { data, error } = await supabase.from("gg_sessions").insert({
      title,
      start_at,
      end_at,
    }).select("*").single();

    if (error) {
      console.error(error);
      return setStatus(error.message);
    }

    const s = data as any as SessionRow;
    setSessions(prev => [s, ...prev]);
    setActiveSessionId(s.id);
    setNewTitle(""); setNewStart(""); setNewEnd("");
    setStatus("Session created.");
  }

  async function importRoster() {
    if (!supabase) return;
    if (!isAdmin) return setStatus("Admin access required.");
    if (!activeSessionId) return setStatus("Select a session first.");
    setStatus("");

    try {
      setImporting(true);

      let text = csvText.trim();
      if (!text && csvFile) text = (await fileToText(csvFile)).trim();
      if (!text) return setStatus("Choose a CSV file (or paste CSV) first.");

      const parsed = parseCsv(text);
      if (!parsed.length) return setStatus("CSV has no usable rows.");

      // upsert by (session_id, trec_license)
      const payload: AttendanceRow[] = parsed.map(r => ({
        session_id: activeSessionId,
        trec_license: r.trec_license,
        first_name: r.first_name,
        middle_initial: r.middle_initial || null,
        last_name: r.last_name,
        payment: (r.payment === "cash" || r.payment === "pay_link") ? r.payment : null,
        note: r.note || null,
        absent: false,
      }));

      const { error } = await supabase
        .from("gg_roster")
        .upsert(payload, { onConflict: "session_id,trec_license" });

      if (error) {
        console.error(error);
        return setStatus(`Roster import failed: ${error.message}`);
      }

      setCsvFile(null);
      setCsvText("");

      // reload roster from DB
      const { data, error: reloadErr } = await supabase
        .from("gg_roster")
        .select("*")
        .eq("session_id", activeSessionId)
        .order("last_name", { ascending: true });

      if (reloadErr) {
        console.error(reloadErr);
        return setStatus("Imported, but could not reload roster.");
      }

      const rows = (data || []) as AttendanceRow[];
      setRoster(rows);
      setRosterLoadedCount(rows.length);
      setStudentRosterLoaded(rows.length > 0);
      await hydrateHeadshots(rows.map(r => r.trec_license));
      setStatus(`Roster saved. ${rows.length} students loaded.`);
    } catch (e: any) {
      console.error(e);
      setStatus(e?.message || "Roster import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function addWalkIn() {
    if (!supabase) return;
    if (!isAdmin) return setStatus("Admin access required.");
    if (!activeSessionId) return setStatus("Select a session first.");
    setStatus("");

    const lic = normalizeLicense(walkInLicense);
    if (!lic) return setStatus("Walk-in TREC license is required.");
    if (!walkInFirst.trim() || !walkInLast.trim()) return setStatus("Walk-in first and last name are required.");

    const row: AttendanceRow = {
      session_id: activeSessionId,
      trec_license: lic,
      first_name: capWord(walkInFirst),
      middle_initial: (walkInMid || "").trim().slice(0,1).toUpperCase() || null,
      last_name: capWord(walkInLast),
      payment: walkInPayment,
      note: (walkInNote || "").trim() || null,
      absent: false,
    };

    const { error } = await supabase.from("gg_roster").upsert([row], { onConflict: "session_id,trec_license" });
    if (error) {
      console.error(error);
      return setStatus(`Walk-in failed: ${error.message}`);
    }

    setWalkInLicense(""); setWalkInFirst(""); setWalkInMid(""); setWalkInLast(""); setWalkInPayment("pay_link"); setWalkInNote("");

    // reload roster
    const { data, error: reloadErr } = await supabase
      .from("gg_roster")
      .select("*")
      .eq("session_id", activeSessionId)
      .order("last_name", { ascending: true });
    if (reloadErr) {
      console.error(reloadErr);
      return setStatus("Walk-in added, but roster reload failed.");
    }
    const rows = (data || []) as AttendanceRow[];
    setRoster(rows);
    setRosterLoadedCount(rows.length);
    setStudentRosterLoaded(rows.length > 0);
    await hydrateHeadshots(rows.map(r => r.trec_license));
    setStatus("Walk-in added.");
  }

  async function patchRoster(license: string, patch: Partial<AttendanceRow>) {
    if (!supabase) return;
    if (!isAdmin) return setStatus("Admin access required.");
    if (!activeSessionId) return setStatus("Select a session first.");
    const lic = normalizeLicense(license);
    const { error } = await supabase.from("gg_roster").update(patch).eq("session_id", activeSessionId).eq("trec_license", lic);
    if (error) {
      console.error(error);
      return setStatus(error.message);
    }
    // update local roster quickly
    setRoster(prev => prev.map(r => (r.session_id === activeSessionId && normalizeLicense(r.trec_license) === lic) ? ({ ...r, ...patch } as any) : r));
  }

  async function removeFromRoster(license: string) {
    if (!supabase) return;
    if (!isAdmin) return setStatus("Admin access required.");
    if (!activeSessionId) return setStatus("Select a session first.");
    const lic = normalizeLicense(license);
    const { error } = await supabase.from("gg_roster").delete().eq("session_id", activeSessionId).eq("trec_license", lic);
    if (error) {
      console.error(error);
      return setStatus(error.message);
    }
    setRoster(prev => prev.filter(r => !(r.session_id === activeSessionId && normalizeLicense(r.trec_license) === lic)));
    setRosterLoadedCount(prev => Math.max(0, prev - 1));
  }

  // =========================
  // Camera scanning
  // =========================
  async function startCamera() {
    setCameraError("");
    setScanToast(null);
    if (!videoRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });

      const v = videoRef.current;
      v.srcObject = stream;
      v.setAttribute("playsinline", "true");
      await v.play();
      setCameraOn(true);

      // start scanning loop
      if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = requestAnimationFrame(scanLoop);
    } catch (e: any) {
      console.error(e);
      setCameraError(e?.message || "Could not access camera.");
      setCameraOn(false);
    }
  }

  function stopCamera() {
    setCameraOn(false);
    if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
    scanLoopRef.current = null;
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (v) v.srcObject = null;
  }

  async function handleScanPayload(payload: string) {
    // basic debounce so it doesn't fire multiple times per second
    const now = Date.now();
    if (now - lastScanAtRef.current < 1250) return;
    lastScanAtRef.current = now;

    // Expect payload to contain session_id and action or be a URL with params
    // We'll accept: "session:<id>|checkin" or "session:<id>|checkout"
    // OR URL params: ?session_id=...&mode=checkin/checkout
    let sessionId = "";
    let mode: "checkin"|"checkout" = scanMode;

    try {
      if (payload.includes("session_id=")) {
        const u = new URL(payload);
        sessionId = u.searchParams.get("session_id") || "";
        const m = (u.searchParams.get("mode") || "").toLowerCase();
        if (m === "checkin" || m === "checkout") mode = m;
      } else if (payload.startsWith("session:")) {
        const parts = payload.split("|");
        sessionId = parts[0].replace("session:", "").trim();
        const m = (parts[1] || "").trim().toLowerCase();
        if (m === "checkin" || m === "checkout") mode = m;
      } else {
        // If it's just a session id, accept it
        sessionId = payload.trim();
      }
    } catch {
      sessionId = payload.trim();
    }

    if (!sessionId) {
      setScanToast({ type: "fail", msg: "Hmm… that QR code isn’t speaking our language." });
      return;
    }

    if (!authed || !supabase) {
      setScanToast({ type: "fail", msg: "Login first, then scan again." });
      return;
    }

    // Confirm student is on roster
    const lic = normalizeLicense(trecLicense || "");
    if (!lic) {
      setScanToast({ type: "fail", msg: "Add a TREC license to the account first." });
      return;
    }

    // Update gg_roster checkin/checkout for this student
    const patch: Partial<AttendanceRow> = {};
    if (mode === "checkin") patch.checkin_at = isoNow();
    if (mode === "checkout") patch.checkout_at = isoNow();

    const { error } = await supabase
      .from("gg_roster")
      .update(patch)
      .eq("session_id", sessionId)
      .eq("trec_license", lic);

    if (error) {
      console.error(error);
      setScanToast({ type: "fail", msg: "Nope — that QR code isn’t accepted for this roster (yet)." });
      return;
    }

    setScanToast({ type: "success", msg: mode === "checkin" ? "✅ Checked in! Go be great in class." : "✅ Checked out! See you next time." });
  }

  function scanLoop() {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      scanLoopRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    const canvas = document.createElement("canvas");
    const w = v.videoWidth || 640;
    const h = v.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      scanLoopRef.current = requestAnimationFrame(scanLoop);
      return;
    }
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
    if (code?.data) {
      handleScanPayload(code.data);
    }
    scanLoopRef.current = requestAnimationFrame(scanLoop);
  }

  useEffect(() => {
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const header = (
    <div style={{ background: "#fff", borderBottom: "1px solid #e6e6e6", padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src="/ggsore-logo.png" alt="GGSORE logo" style={{ width: 40, height: 40, objectFit: "contain" }} />
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>
            The Guillory Group School of Real Estate Student Attendance App
          </div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>TREC Education Provider #9998-CEP</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {authed && canSeeAdminTab && (
            <>
              <button type="button" onClick={() => setTab("student")} style={{ padding: "8px 10px", borderRadius: 10, border: tab === "student" ? `2px solid ${BRAND_RED}` : "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                Student
              </button>
              <button type="button" onClick={() => setTab("admin")} style={{ padding: "8px 10px", borderRadius: 10, border: tab === "admin" ? `2px solid ${BRAND_RED}` : "1px solid #ddd", background: "#fff", fontWeight: 800 }}>
                Admin / Instructor
              </button>
            </>
          )}
          {authed && (
            <button type="button" onClick={logout} style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
              Log Out
            </button>
          )}
        </div>
      </div>
    </div>
  );

  function pill(color: string, textColor: string) {
    return {
      padding: "9px 12px",
      borderRadius: 12,
      border: "1px solid rgba(0,0,0,0.12)",
      background: color,
      color: textColor,
      fontWeight: 900,
      cursor: "pointer" as const
    };
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", fontFamily }}>
      {header}
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
        {!!status && (
          <div style={{ background: "#fff6e6", border: "1px solid #ffdca8", borderRadius: 14, padding: 12, marginBottom: 12 }}>
            <strong>Note:</strong> {status}
          </div>
        )}

        {!authed ? (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
              <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10 }}>Login or Create Account</div>

              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ fontWeight: 800 }}>Email</label>
                  <input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@email.com" style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ fontWeight: 800 }}>Password</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                    <input
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      type={showPw ? "text" : "password"}
                      placeholder="Enter password"
                      style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                    />
                    <button type="button" onClick={() => setShowPw(v => !v)} style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontWeight: 900 }}>
                      {showPw ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div style={{ gridColumn: "1 / -1", borderTop: "1px dashed #eee", paddingTop: 12, marginTop: 2 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>For new accounts</div>

                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 120px" }}>
                    <div>
                      <label style={{ fontWeight: 800 }}>First name</label>
                      <input value={firstName} onChange={e => setFirstName(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>Last name</label>
                      <input value={lastName} onChange={e => setLastName(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>M.I.</label>
                      <input value={middleInitial} onChange={e => setMiddleInitial(e.target.value)} maxLength={1} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd", textTransform: "uppercase" }} />
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <label style={{ fontWeight: 800 }}>TREC license</label>
                      <input value={trecLicense} onChange={e => setTrecLicense(e.target.value)} placeholder="123456-SA" style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>(Name should appear exactly as shown on the TREC license.)</div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" onClick={() => signUpOrLogin(false)} style={{ padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
                  Log In
                </button>
                <button type="button" onClick={() => signUpOrLogin(true)} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid #ddd", background: "#fff", fontWeight: 900 }}>
                  Create Account
                </button>
              </div>

              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 10 }}>
                Admin note: login using the admin email configured in Vercel env (VITE_ADMIN_EMAIL).
              </div>
            </div>
          </div>
        ) : (
          <>
            {tab === "student" && (
              <div style={{ display: "grid", gap: 14 }}>
                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 18 }}>Welcome to class, {capWord((firstName || userEmail.split("@")[0] || "").replace(/\./g," "))}.</div>
                  <div style={{ marginTop: 6, opacity: 0.85 }}>
                    Scan the class QR code to check in or check out.
                  </div>
                  {!studentRosterLoaded && (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                      (If the roster is not loaded yet for this session, check-in will be rejected until the instructor imports it.)
                    </div>
                  )}
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 16 }}>Check In / Check Out</div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Camera auto-scans — no tapping required.</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => setScanMode("checkin")} style={{ padding: "10px 12px", borderRadius: 12, border: scanMode === "checkin" ? `2px solid ${BRAND_RED}` : "1px solid #ddd", background: "#fff", fontWeight: 900 }}>
                        Check-In Mode
                      </button>
                      <button type="button" onClick={() => setScanMode("checkout")} style={{ padding: "10px 12px", borderRadius: 12, border: scanMode === "checkout" ? `2px solid ${BRAND_RED}` : "1px solid #ddd", background: "#fff", fontWeight: 900 }}>
                        Check-Out Mode
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    {!cameraOn ? (
                      <button type="button" onClick={startCamera} style={{ padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
                        Turn on Camera
                      </button>
                    ) : (
                      <button type="button" onClick={stopCamera} style={{ padding: "12px 16px", borderRadius: 14, border: "1px solid #ddd", background: "#fff", fontWeight: 900 }}>
                        Turn off Camera
                      </button>
                    )}
                  </div>

                  {!!cameraError && <div style={{ marginTop: 10, color: "#b00020", fontWeight: 800 }}>{cameraError}</div>}

                  <div style={{ marginTop: 12 }}>
                    <video ref={videoRef} style={{ width: "100%", maxHeight: 360, borderRadius: 16, background: "#000" }} />
                  </div>

                  {scanToast && (
                    <div style={{
                      marginTop: 12,
                      borderRadius: 16,
                      padding: 12,
                      border: "1px solid #ddd",
                      background: scanToast.type === "success" ? "#ecfdf3" : scanToast.type === "fail" ? "#fff1f2" : "#eef2ff",
                      display: "flex",
                      gap: 10,
                      alignItems: "center"
                    }}>
                      <div style={{ fontSize: 18 }}>
                        {scanToast.type === "success" ? "✅" : scanToast.type === "fail" ? "⚠️" : "ℹ️"}
                      </div>
                      <div style={{ fontWeight: 900 }}>{scanToast.msg}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "admin" && canSeeAdminTab && (
              <div style={{ display: "grid", gap: 14 }}>
                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Create Session</div>

                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", alignItems: "end" }}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <label style={{ fontWeight: 800 }}>Class title</label>
                      <input value={newTitle} onChange={e => setNewTitle(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>Start (ISO)</label>
                      <input value={newStart} onChange={e => setNewStart(e.target.value)} placeholder="2026-02-01T09:00:00" style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>End (ISO)</label>
                      <input value={newEnd} onChange={e => setNewEnd(e.target.value)} placeholder="2026-02-01T17:00:00" style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <button type="button" onClick={createSession} style={{ padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
                        Create Session
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Select Session</div>
                  <select
                    value={activeSessionId}
                    onChange={(e) => setActiveSessionId(e.target.value)}
                    style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  >
                    <option value="">— Select —</option>
                    {sessions.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({new Date(s.start_at).toLocaleString()})
                      </option>
                    ))}
                  </select>
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                    Roster loaded: <strong>{rosterLoadedCount}</strong> students
                  </div>
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Roster CSV Import</div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <input type="file" accept=".csv,text/csv" onChange={(e) => setCsvFile(e.target.files?.[0] || null)} />
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      CSV headers required: trec_license,first_name,last_name (optional: middle_initial,payment,note)
                    </div>

                    <div style={{ fontSize: 12, opacity: 0.75 }}>Optional: paste CSV text (instead of file)</div>
                    <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={4} style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />

                    <button
                      type="button"
                      onClick={importRoster}
                      style={{ padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900, opacity: importing ? 0.7 : 1 }}
                      disabled={importing}
                    >
                      {importing ? "Loading..." : "Load Roster"}
                    </button>
                  </div>
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Add Walk-In (paid at the door)</div>

                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 100px" }}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <label style={{ fontWeight: 800 }}>TREC license</label>
                      <input value={walkInLicense} onChange={(e) => setWalkInLicense(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>First name</label>
                      <input value={walkInFirst} onChange={(e) => setWalkInFirst(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>Last name</label>
                      <input value={walkInLast} onChange={(e) => setWalkInLast(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                    </div>
                    <div>
                      <label style={{ fontWeight: 800 }}>M.I.</label>
                      <input value={walkInMid} onChange={(e) => setWalkInMid(e.target.value)} maxLength={1} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd", textTransform: "uppercase" }} />
                    </div>

                    <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
                      <div style={{ minWidth: 220 }}>
                        <label style={{ fontWeight: 800 }}>Payment</label>
                        <select value={walkInPayment} onChange={(e) => setWalkInPayment(e.target.value as any)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }}>
                          <option value="pay_link">Pay Link</option>
                          <option value="cash">Cash</option>
                        </select>
                      </div>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <label style={{ fontWeight: 800 }}>Note</label>
                        <input value={walkInNote} onChange={(e) => setWalkInNote(e.target.value)} style={{ width: "100%", marginTop: 6, padding: 12, borderRadius: 12, border: "1px solid #ddd" }} />
                      </div>

                      <button type="button" onClick={addWalkIn} style={{ padding: "12px 16px", borderRadius: 14, border: `1px solid ${BRAND_RED}`, background: BRAND_RED, color: "#fff", fontWeight: 900 }}>
                        Add Walk-In
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>Roster</div>

                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                      <thead>
                        <tr style={{ textAlign: "left" }}>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Photo</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>TREC License</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>First</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>M.I.</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Last</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Payment</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Check-in</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Check-out</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Status</th>
                          <th style={{ padding: 8, borderBottom: "1px solid #eee" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster.map((r) => {
                          const lic = normalizeLicense(r.trec_license);
                          const imgUrl = headshotUrlByLicense[lic] || "";
                          const absent = !!r.absent;
                          return (
                            <tr key={`${r.session_id}-${lic}`}>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                                {imgUrl ? (
                                  <img src={imgUrl} alt="headshot" style={{ width: 44, height: 58, borderRadius: 10, objectFit: "cover", objectPosition: "center top", border: "1px solid #ddd" }} />
                                ) : (
                                  <div style={{ width: 44, height: 58, borderRadius: 10, border: "1px dashed #ccc", display: "grid", placeItems: "center", fontSize: 10, opacity: 0.7 }}>
                                    —
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{lic}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{capWord(r.first_name)}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{(r.middle_initial || "").toUpperCase()}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{capWord(r.last_name)}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.payment || ""}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3", whiteSpace: "nowrap" }}>{r.checkin_at ? new Date(r.checkin_at).toLocaleTimeString() : ""}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3", whiteSpace: "nowrap" }}>{r.checkout_at ? new Date(r.checkout_at).toLocaleTimeString() : ""}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                                {absent ? "Absent" : (r.checkin_at ? "Present" : "")}
                              </td>
                              <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  {!absent ? (
                                    <button type="button" onClick={() => patchRoster(lic, { absent: true })} style={pill(BTN_BLUE_LIGHT, "#000")}>
                                      Mark Absent
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => patchRoster(lic, { absent: false })} style={pill(BTN_BLUE_LIGHT, "#000")}>
                                      Undo Absent
                                    </button>
                                  )}

                                  <button type="button" onClick={() => removeFromRoster(lic)} style={pill(BTN_BLUE, "#fff")}>
                                    Remove
                                  </button>

                                  <button type="button" onClick={() => patchRoster(lic, { note: null })} style={pill(BTN_NAVY, "#fff")}>
                                    Clear Photo
                                  </button>

                                  {!r.checkin_at ? (
                                    <button type="button" onClick={() => patchRoster(lic, { checkin_at: isoNow() })} style={pill(BTN_MIDBLUE, "#fff")}>
                                      Manual Check-in
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => patchRoster(lic, { checkin_at: null })} style={pill(BTN_MIDBLUE, "#fff")}>
                                      Undo Check-in
                                    </button>
                                  )}

                                  {!r.checkout_at ? (
                                    <button type="button" onClick={() => patchRoster(lic, { checkout_at: isoNow() })} style={pill(BTN_MIDBLUE, "#fff")}>
                                      Manual Check-out
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => patchRoster(lic, { checkout_at: null })} style={pill(BTN_MIDBLUE, "#fff")}>
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

                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                    Mobile tip: roster table scrolls sideways. (We can tighten the session inputs later.)
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

