import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import "./styles.css";

type View = "auth" | "app";
type AuthTab = "login" | "create";
type AppTab = "student" | "admin";

type Profile = {
id: string;
email: string;
first_name?: string | null;
middle_initial?: string | null;
last_name?: string | null;
trec_license?: string | null;
photo_url?: string | null;
};

type SessionRow = {
id: string;
title: string;
starts_at: string;
ends_at: string;
checkin_expires_at: string | null;
checkout_expires_at: string | null;
checkin_code: string;
checkout_code: string;
created_at?: string;
course_name?: string | null;
};

type RosterRow = {
  first_name: string;
  mi: string;
  last_name: string;
  trec_license: string;
  email: string;

  // admin-only status fields (optional)
  checked_in_at?: string | null;
  checked_out_at?: string | null;
  no_show?: boolean;
};


const COURSE_OPTIONS = [
"Commercial Leasing Contracts 101™",
"Commercial Letters of Intent 101 for Leasing & Sales™",
"Things You Need to Know About Practicing Law in Real Estate™",
"Deal Dynamics: Deciphering Commercial Real Estate Contracts™",
"Commercial Sales 101: From Client to Contract to Close™",
"Commercial Property Management 101 - (Apartments Not Included)™",
"Lights, Camera, Impact! REALTORS® Guide to Success on Camera™",
"High Stakes: Seed-to-Sale Hemp Law Changes in Texas™ (3 hours)™",
"First, It's Not Marijuana: Hemp Laws & Texas Real Estate (2 hours)™",
];

function safeLower(s: string | null | undefined) {
return (s ?? "").toLowerCase();
}

function parseCsv(text: string): string[][] {
// Simple CSV parser (comma-separated, supports quoted values)
const rows: string[][] = [];
let cur = "";
let row: string[] = [];
let inQuotes = false;

for (let i = 0; i < text.length; i++) {
const ch = text[i];
if (ch === '"') {
if (inQuotes && text[i + 1] === '"') {
cur += '"';
i++;
} else {
inQuotes = !inQuotes;
}
} else if (ch === "," && !inQuotes) {
row.push(cur.trim());
cur = "";
} else if ((ch === "\n" || ch === "\r") && !inQuotes) {
if (ch === "\r" && text[i + 1] === "\n") i++;
row.push(cur.trim());
cur = "";
if (row.some((c) => c.length > 0)) rows.push(row);
row = [];
} else {
cur += ch;
}
}

if (cur.length || row.length) {
row.push(cur.trim());
if (row.some((c) => c.length > 0)) rows.push(row);
}
return rows;
}

function addMinutesISO(isoOrDate: string | Date, minutes: number): string {
const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : new Date(isoOrDate);
d.setMinutes(d.getMinutes() + minutes);
return d.toISOString();
}

function genCode(len = 10): string {
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoids confusing chars
let out = "";
const arr = new Uint32Array(len);
crypto.getRandomValues(arr);
for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
return out;
}

export default function App() {
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const adminEmailEnv = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || "";

const supabase: SupabaseClient | null = useMemo(() => {
if (!supabaseUrl || !supabaseAnonKey) return null;
return createClient(supabaseUrl, supabaseAnonKey);
}, [supabaseUrl, supabaseAnonKey]);

const [view, setView] = useState<View>("auth");
const [authTab, setAuthTab] = useState<AuthTab>("login");
const [appTab, setAppTab] = useState<AppTab>("student");

// auth form fields
const [email, setEmail] = useState<string>("");
const [password, setPassword] = useState<string>("");

// create account fields
const [firstName, setFirstName] = useState<string>("");
const [middleInitial, setMiddleInitial] = useState<string>("");
const [lastName, setLastName] = useState<string>("");
const [trecLicense, setTrecLicense] = useState<string>("");
const [headshotFile, setHeadshotFile] = useState<File | null>(null);

const [userProfile, setUserProfile] = useState<Profile | null>(null);
const [statusMsg, setStatusMsg] = useState<string>("");

// ---------- Student Scan ----------
const [scanSupported, setScanSupported] = useState<boolean>(false);
const [scanning, setScanning] = useState<boolean>(false);
const videoRef = useRef<HTMLVideoElement | null>(null);
const streamRef = useRef<MediaStream | null>(null);
const scanTimerRef = useRef<number | null>(null);

// value captured by QR scan (student does NOT manually paste)
const [qrValue, setQrValue] = useState<string>("");

// ---------- Admin ----------
const [selectedCourse, setSelectedCourse] = useState<string>(COURSE_OPTIONS[0] ?? "");
const [sessionTitle, setSessionTitle] = useState<string>("");
const [sessionStart, setSessionStart] = useState<string>("");
const [sessionEnd, setSessionEnd] = useState<string>("");
const [recentSessions, setRecentSessions] = useState<SessionRow[]>([]);
const [selectedSessionId, setSelectedSessionId] = useState<string>("");

// roster tools
const [rosterRows, setRosterRows] = useState<RosterRow[]>(() => {
try {
const raw = localStorage.getItem("ccp_roster_preview");
return raw ? (JSON.parse(raw) as RosterRow[]) : [];
} catch {
return [];
}
});
const [rosterError, setRosterError] = useState<string>("");
const [manualStudent, setManualStudent] = useState<RosterRow>({
first_name: "",
mi: "",
last_name: "",
trec_license: "",
email: "",
});
const [rosterPhotoByTrec, setRosterPhotoByTrec] = useState<Record<string, string>>({});
const [rosterActionsByTrec, setRosterActionsByTrec] = useState<
  Record<
    string,
    {
      checkInAt?: string;
      checkOutAt?: string;
      noShowAt?: string;
    }
  >
>({});

const isAdmin = useMemo(() => {
const e = safeLower(userProfile?.email);
const adminE = safeLower(adminEmailEnv);
return !!e && !!adminE && e === adminE;
}, [userProfile?.email, adminEmailEnv]);

// Detect basic QR capability (BarcodeDetector is the lightest option)
useEffect(() => {
// @ts-ignore
const hasBarcodeDetector = typeof window !== "undefined" && "BarcodeDetector" in window;
setScanSupported(!!hasBarcodeDetector && !!navigator.mediaDevices?.getUserMedia);
}, []);

// On mount, check existing session
useEffect(() => {
if (!supabase) {
setStatusMsg("Missing Supabase env vars. Check Vercel env settings.");
return;
}
(async () => {
const { data } = await supabase.auth.getSession();
if (data.session?.user) {
await loadProfile(data.session.user.id, data.session.user.email ?? "");
setView("app");
}
})();
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [supabase]);

async function loadProfile(userId: string, emailAddr: string) {
if (!supabase) return;

try {
// IMPORTANT: Your Supabase table list shows gg_profiles (not "profiles")
const { data, error } = await supabase
.from("gg_profiles")
.select("id,email,first_name,middle_initial,last_name,trec_license,photo_url")
.eq("id", userId)
.maybeSingle();

if (error || !data) {
setUserProfile({ id: userId, email: emailAddr });
return;
}

setUserProfile({
id: data.id,
email: data.email ?? emailAddr,
first_name: data.first_name,
middle_initial: data.middle_initial,
last_name: data.last_name,
trec_license: data.trec_license,
photo_url: data.photo_url ?? null,
});
} catch {
setUserProfile({ id: userId, email: emailAddr });
}
}

async function onLogin() {
setStatusMsg("");
if (!supabase) return;

try {
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
if (error) throw error;

await loadProfile(data.user.id, data.user.email ?? "");
setView("app");
setAppTab("student");
setPassword(""); // do not retain
} catch (e: any) {
setStatusMsg(e?.message ?? "Login failed.");
}
}

async function onCreateAccount() {
setStatusMsg("");
if (!supabase) return;

try {
// Validate only on submit
const missing: string[] = [];
if (!email) missing.push("email");
if (!password) missing.push("password");
if (!firstName) missing.push("first name");
if (!lastName) missing.push("last name");
if (!trecLicense) missing.push("TREC license");
if (!headshotFile) missing.push("headshot");

if (missing.length) {
setStatusMsg(`Please complete: ${missing.join(", ")}.`);
return;
}

const cleanLicense = trecLicense.trim();

const { data, error } = await supabase.auth.signUp({ email, password });
if (error) throw error;

let photoUrl: string | null = null;

// Upload headshot (optional)
if (data.user?.id && headshotFile) {
try {
const name = headshotFile.name || "headshot";
const ext = (name.split(".").pop() || "jpg").toLowerCase();
const safeExt = ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" ? ext : "jpg";

// Store under: headshots/<trec_license>/headshot.<ext>
const filePath = `${cleanLicense}/headshot.${safeExt}`;

const { error: upErr } = await supabase.storage.from("headshots").upload(filePath, headshotFile, {
upsert: true,
contentType: headshotFile.type || "image/jpeg",
});

if (!upErr) {
const { data: pub } = supabase.storage.from("headshots").getPublicUrl(filePath);
photoUrl = pub?.publicUrl ?? null;
}
} catch {
// ignore upload errors; account still creates
}
}

// Best-effort profile upsert (non-fatal)
try {
if (data.user?.id) {
await supabase.from("gg_profiles").upsert({
id: data.user.id,
email,
first_name: firstName,
middle_initial: middleInitial || null,
last_name: lastName,
trec_license: cleanLicense,
photo_url: photoUrl, // ✅ save the URL
});
}
} catch {
// ignore
}

if (data.user) {
await loadProfile(data.user.id, data.user.email ?? "");
}
setView("app");
setAppTab("student");
setPassword("");
setHeadshotFile(null);
} catch (e: any) {
setStatusMsg(e?.message ?? "Account creation failed.");
}
}


async function onSignOut() {
setStatusMsg("");
try {
if (supabase) await supabase.auth.signOut();
} finally {
setUserProfile(null);
setEmail("");
setPassword("");
setFirstName("");
setMiddleInitial("");
setLastName("");
setTrecLicense("");
setHeadshotFile(null);
setQrValue("");
stopScan();
setView("auth");
setAuthTab("login");
}
}

function welcomeName(): string {
const fn = (userProfile?.first_name ?? "").trim();
return fn ? `Welcome back, ${fn}!` : "Welcome back!";
}

// ---------- Scan (BarcodeDetector) ----------
async function startScan() {
setStatusMsg("");
if (!scanSupported) {
setStatusMsg(
"QR scanning isn’t supported in this browser. Please use the mobile camera option (Safari/Chrome) or contact the instructor."
);
return;
}
setScanning(true);

try {
const stream = await navigator.mediaDevices.getUserMedia({
video: { facingMode: "environment" },
audio: false,
});
streamRef.current = stream;
if (videoRef.current) {
videoRef.current.srcObject = stream;
await videoRef.current.play();
}

// @ts-ignore
const detector = new window.BarcodeDetector({ formats: ["qr_code"] });

const tick = async () => {
if (!videoRef.current || !scanning) return;
try {
// @ts-ignore
const codes = await detector.detect(videoRef.current);
if (codes && codes.length) {
const raw = codes[0]?.rawValue ?? "";
if (raw) {
setQrValue(raw);
stopScan();
setStatusMsg("QR captured. Tap “Submit Check-In”.");
return;
}
}
} catch {
// keep trying
}
scanTimerRef.current = window.setTimeout(tick, 350);
};

scanTimerRef.current = window.setTimeout(tick, 350);
} catch (e: any) {
setScanning(false);
setStatusMsg(e?.message ?? "Unable to access camera.");
}
}

function stopScan() {
setScanning(false);
if (scanTimerRef.current) {
window.clearTimeout(scanTimerRef.current);
scanTimerRef.current = null;
}
if (streamRef.current) {
streamRef.current.getTracks().forEach((t) => t.stop());
streamRef.current = null;
}
if (videoRef.current) {
videoRef.current.srcObject = null;
}
}

async function submitCheckIn() {
setStatusMsg("");
if (!supabase) return;
if (!qrValue.trim()) {
setStatusMsg("Please scan the QR code first.");
return;
}

// NOTE: We are not changing your attendance/check-in schema here.
// This insert will succeed only if your table/columns match.
try {
const { error } = await supabase.from("gg_attendance").insert({
user_id: userProfile?.id,
qr_value: qrValue.trim(),
});
if (error) throw error;
setStatusMsg("✅ Check-in submitted!");
setQrValue("");
} catch (e: any) {
setStatusMsg(e?.message ?? "Check-in failed (table/permissions may need setup).");
}
}

// ---------- Admin: sessions ----------
async function loadRecentSessions() {
if (!supabase) return;
try {
const { data, error } = await supabase
.from("gg_sessions")
.select(
"id,title,starts_at,ends_at,checkin_expires_at,checkout_expires_at,checkin_code,checkout_code,created_at,course_name"
)
.order("created_at", { ascending: false })
.limit(10);

if (error) throw error;
setRecentSessions((data as any) ?? []);
} catch (e: any) {
// If anything goes wrong, keep UI stable, just show empty list.
setRecentSessions([]);
}
}

useEffect(() => {
if (view === "app" && isAdmin && appTab === "admin") {
loadRecentSessions();
}
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [view, isAdmin, appTab]);

useEffect(() => {
if (!selectedSessionId && recentSessions.length) {
setSelectedSessionId(recentSessions[0].id);
}
}, [recentSessions, selectedSessionId]);
useEffect(() => {
  // When admin changes the selected session, load THAT session’s roster
  if (view !== "app" || !isAdmin || appTab !== "admin") return;

  try {
    const raw = localStorage.getItem(rosterKey(selectedSessionId));
    const loaded = raw ? (JSON.parse(raw) as RosterRow[]) : [];
    setRosterRows(Array.isArray(loaded) ? loaded : []);
  } catch {
    setRosterRows([]);
  }
  setRosterError("");
}, [selectedSessionId, view, isAdmin, appTab]);

useEffect(() => {
if (!supabase) return;
if (view !== "app" || !isAdmin || appTab !== "admin") return;
if (!rosterRows.length) {
setRosterPhotoByTrec({});
return;
}

const licenses = Array.from(
new Set(
rosterRows
.map((r) => (r.trec_license || "").trim())
.filter((x) => x.length > 0)
)
);

if (!licenses.length) {
setRosterPhotoByTrec({});
return;
}

(async () => {
try {
const { data, error } = await supabase
.from("gg_profiles")
.select("trec_license,photo_url")
.in("trec_license", licenses);

if (error) throw error;

const map: Record<string, string> = {};
(data as any[] | null)?.forEach((p) => {
const key = (p?.trec_license || "").trim();
const url = (p?.photo_url || "").trim();
if (key && url) map[key] = url;
});

setRosterPhotoByTrec(map);
} catch {
setRosterPhotoByTrec({});
}
})();
}, [supabase, view, isAdmin, appTab, rosterRows]);

async function createSession() {
setStatusMsg("");
if (!supabase) return;

if (!sessionTitle.trim() || !sessionStart || !sessionEnd) {
setStatusMsg("Please provide a session title, start time, and end time.");
return;
}

// Convert datetime-local -> ISO
const startsISO = new Date(sessionStart).toISOString();
const endsISO = new Date(sessionEnd).toISOString();

// Reasonable defaults (can be changed later)
const checkinExpiresISO = addMinutesISO(startsISO, 30); // 30 minutes after start
const checkoutExpiresISO = addMinutesISO(endsISO, 30); // 30 minutes after end

const checkinCode = genCode(10);
const checkoutCode = genCode(10);

try {
const { error } = await supabase.from("gg_sessions").insert({
title: sessionTitle.trim(),
starts_at: startsISO,
ends_at: endsISO,
checkin_expires_at: checkinExpiresISO,
checkout_expires_at: checkoutExpiresISO,
checkin_code: checkinCode,
checkout_code: checkoutCode,
course_name: selectedCourse, // ✅ you added this column
});

if (error) throw error;

setStatusMsg("✅ Class session created.");
setSessionTitle("");
setSessionStart("");
setSessionEnd("");
await loadRecentSessions();
} catch (e: any) {
setStatusMsg(e?.message ?? "Session creation failed (table/permissions may need setup).");
}
}

// ---------- Admin: roster ----------
function rosterKey(sessionId: string) {
  return `ccp_roster_preview__${sessionId || "none"}`;
}

function persistRoster(next: RosterRow[]) {
  setRosterRows(next);
  try {
    localStorage.setItem(rosterKey(selectedSessionId), JSON.stringify(next));
  } catch {
    // ignore
  }
}


async function handleRosterUpload(file: File) {
  setRosterError("");
  if (!selectedSessionId) {
    setRosterError("Select a session first, then upload the roster.");
    return;
  }
  try {

const text = await file.text();
const rows = parseCsv(text);
if (!rows.length) {
setRosterError("Roster file appears to be empty.");
return;
}
const header = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, "_"));
const data = rows.slice(1);

const idx = (name: string) => header.indexOf(name);
const iFirst = idx("first_name");
const iMI = idx("mi");
const iLast = idx("last_name");
const iTrec = idx("trec_license");
const iEmail = idx("email");

if (iFirst === -1 || iLast === -1 || iTrec === -1) {
setRosterError(
"CSV must include columns: first_name, last_name, trec_license (email and mi are optional)."
);
return;
}

const clean: RosterRow[] = data
.filter((r) => r.length)
.map((r) => ({
first_name: (r[iFirst] || "").trim(),
mi: iMI > -1 ? (r[iMI] || "").trim() : "",
last_name: (r[iLast] || "").trim(),
trec_license: (r[iTrec] || "").trim(),
email: iEmail > -1 ? (r[iEmail] || "").trim() : "",
}))
.filter((r) => r.first_name && r.last_name && r.trec_license);

persistRoster(clean);
setStatusMsg(`Roster loaded: ${clean.length} student${clean.length === 1 ? "" : "s"}.`);
} catch (e: any) {
setRosterError(e?.message || "Could not read roster file.");
}
}

function addManualStudentToRoster() {
setRosterError("");
const r = { ...manualStudent };
if (!r.first_name || !r.last_name || !r.trec_license) {
setRosterError("Please enter first name, last name, and TREC license for manual add.");
return;
}
const next = [r, ...rosterRows];
persistRoster(next);
setManualStudent({ first_name: "", mi: "", last_name: "", trec_license: "", email: "" });
setStatusMsg("Student added to roster preview.");
}

// ---------- Render ----------
return (
<div className="page">
<div className="card">
<header className="header">
<img className="brandLogo" src="/classcheckpro-logo.png" alt="ClassCheck Pro™" draggable={false} />
</header>

{view === "auth" ? (
<>
<div className="subhead">Login or create an account.</div>

<div className="tabRow">
<button
type="button"
className={"tabBtn" + (authTab === "login" ? " tabBtnActive" : "")}
onClick={() => setAuthTab("login")}
>
Login
</button>
<button
type="button"
className={"tabBtn" + (authTab === "create" ? " tabBtnActive" : "")}
onClick={() => setAuthTab("create")}
>
Create Account
</button>
</div>

<div className="grid2">
<div>
<label className="label">Email</label>
<input
className="input"
value={email}
onChange={(e) => setEmail(e.target.value)}
autoComplete="off"
inputMode="email"
placeholder="name@example.com"
/>
</div>
<div>
<label className="label">Password</label>
<input
className="input"
type="password"
value={password}
onChange={(e) => setPassword(e.target.value)}
autoComplete="new-password"
placeholder="••••••••"
/>
</div>
</div>

{authTab === "login" ? (
<div className="actions">
<button type="button" className="btnPrimary" onClick={onLogin}>
Login
</button>
</div>
) : (
<>
<div className="sectionTitle">Create Account Details</div>

<div className="noteBox">
<strong>Important:</strong> Enter your name exactly as it appears on your TREC license, including middle
initial.
<br />
For the TREC license number, be sure to include the appropriate suffix: -SA, -B, or -BB.
For the TREC license number, be sure to include the appropriate suffix: -SA or -B.
</div>

<div className="grid3">
<div>
<label className="label">First Name</label>
<input
className="input"
value={firstName}
onChange={(e) => setFirstName(e.target.value)}
autoComplete="off"
/>
</div>
<div>
<label className="label">M.I. (optional)</label>
<input
className="input"
value={middleInitial}
onChange={(e) => setMiddleInitial(e.target.value)}
maxLength={1}
autoComplete="off"
/>
</div>
<div>
<label className="label">Last Name</label>
<input
className="input"
value={lastName}
onChange={(e) => setLastName(e.target.value)}
autoComplete="off"
/>
</div>
</div>

<div className="grid1">
<div>
<label className="label">TREC License</label>
<input
className="input"
value={trecLicense}
onChange={(e) => setTrecLicense(e.target.value)}
autoComplete="off"
placeholder="As it appears in TREC's REALM system followed by -SA or -B."
/>
</div>
</div>

<div className="grid1">
<div>
<label className="label">Headshot (Required)</label>
<input
className="input"
type="file"
accept="image/*"
onChange={(e) => {
const f = e.target.files?.[0] ?? null;
setHeadshotFile(f);
}}
/>
<div className="muted" style={{ marginTop: 6 }}>
Upload a clear headshot photo (JPG/PNG). This helps match attendance records.
</div>
</div>
</div>

<div className="actions">
<button type="button" className="btnPrimary" onClick={onCreateAccount}>
Create Account
</button>
</div>
</>
)}

{statusMsg ? <div className="status">{statusMsg}</div> : null}
</>
) : (
<>
<div className="topRow">
<div>
<div className="welcome">{welcomeName()}</div>
<div className="muted">{userProfile?.email}</div>
</div>

<div className="topActions">
{isAdmin ? (
<>
<button
type="button"
className={"tabBtn small" + (appTab === "student" ? " tabBtnActive" : "")}
onClick={() => setAppTab("student")}
>
Student
</button>
<button
type="button"
className={"tabBtn small" + (appTab === "admin" ? " tabBtnActive" : "")}
onClick={() => setAppTab("admin")}
>
Admin / Instructor
</button>
</>
) : null}

<button type="button" className="btnOutline" onClick={onSignOut}>
Sign out
</button>
</div>
</div>

{appTab === "student" ? (
<>
<div className="sectionTitle">Check-In</div>
{/* Photo ID Card (shows after login) */}
<div
  className="noteBox"
  style={{
    marginTop: 12,
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: 14,

    // subtle 3D card effect
    background: "#fff",
    borderRadius: 14,
    boxShadow: "0 4px 14px rgba(0,0,0,0.10)",
    border: "1px solid rgba(0,0,0,0.06)",
  }}
>
  {(() => {
    const fullName = `${(userProfile?.first_name ?? "").trim()}${
      userProfile?.middle_initial ? ` ${userProfile.middle_initial}.` : ""
    } ${(userProfile?.last_name ?? "").trim()}`.trim();

    const trec = (userProfile?.trec_license ?? "").trim();
    const photo = (userProfile?.photo_url ?? "").trim();

    const initials = `${(userProfile?.first_name?.[0] || "").toUpperCase()}${(
      userProfile?.last_name?.[0] || ""
    ).toUpperCase()}`.trim();

    return (
      <>
        <div style={{ flex: "0 0 76px", alignSelf: "center" }}>
          {photo ? (
            <img
              src={photo}
              alt={fullName || "Headshot"}
              style={{
                width: 76,
                height: 96,
                borderRadius: 14,
                border: "2px solid rgba(29,78,216,0.85)",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <div
              title="No headshot on file"
              style={{
                width: 76,
                height: 96,
                borderRadius: 14,
                border: "2px solid rgba(29,78,216,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 16,
                opacity: 0.8,
                background: "rgba(29,78,216,0.06)",
              }}
            >
              {initials || "—"}
            </div>
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, marginBottom: 2 }}>Photo ID</div>

          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <strong>Name:</strong> {fullName || "—"}
          </div>

          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <strong>TREC:</strong> {trec || "—"}
          </div>

          <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <strong>Email:</strong> {userProfile?.email || "—"}
          </div>
        </div>
      </>
    );
  })()}
</div>

<div className="rowBetween">
<div className="sectionSubtitle">Scan QR Code</div>
<button type="button" className="btnOutline" onClick={() => (scanning ? stopScan() : startScan())}>
{scanning ? "Stop Scan" : "Start Scan"}
</button>
</div>

<div className="scanBox">
{scanSupported ? (
<video ref={videoRef} className="video" muted playsInline />
) : (
<div className="scanUnsupported">QR scanning isn’t supported in this browser.</div>
)}
</div>

<div className="actions">
<button type="button" className="btnPrimary" onClick={submitCheckIn} disabled={!qrValue.trim()}>
Submit Check-In
</button>
</div>

{statusMsg ? <div className="status">{statusMsg}</div> : null}
</>
) : (
<>
<div className="sectionTitle">Admin / Instructor</div>

<div className="grid2">
<div>
<label className="label">Course</label>
<select className="input" value={selectedCourse} onChange={(e) => setSelectedCourse(e.target.value)}>
{COURSE_OPTIONS.map((c) => (
<option key={c} value={c}>
{c}
</option>
))}
</select>
</div>
<div>
<label className="label">Session Title</label>
<input
className="input"
value={sessionTitle}
onChange={(e) => setSessionTitle(e.target.value)}
placeholder="e.g., Morning Session"
/>
</div>
</div>

<div className="grid2">
<div>
<label className="label">Start Time</label>
<input
className="input"
type="datetime-local"
value={sessionStart}
onChange={(e) => setSessionStart(e.target.value)}
/>
</div>
<div>
<label className="label">End Time</label>
<input
className="input"
type="datetime-local"
value={sessionEnd}
onChange={(e) => setSessionEnd(e.target.value)}
/>
</div>
</div>

<div className="actions">
<button type="button" className="btnPrimary" onClick={createSession}>
Create New Class Session
</button>
</div>

<div className="sectionSubtitle">Roster Preview</div>
<div className="muted">
  {rosterRows.length ? `${rosterRows.length} student(s) loaded.` : "No roster loaded yet."}
</div>

{rosterRows.length ? (
  <div className="table" style={{ marginTop: 10 }}>
    {/* ✅ ONE header row ONLY (5 columns) */}
    <div
      className="tHead"
      style={{
        display: "grid",
        gridTemplateColumns: "56px 2.6fr 1.1fr 1.7fr 240px",
        alignItems: "center",
        columnGap: 12,
        background: "rgba(45, 120, 255, 0.10)", // ✅ light blue header
        borderRadius: 10,
        padding: "10px 12px",
        fontWeight: 800,
      }}
    >
      <div>Photo</div>
      <div>Name / Email</div>
      <div>TREC</div>
      <div>Status</div>
      <div style={{ textAlign: "right" }}>Actions</div>
    </div>

    {rosterRows.map((r, idx) => {
      const fullName = `${r.first_name}${r.mi ? ` ${r.mi}.` : ""} ${r.last_name}`.trim();
      const licenseKey = (r.trec_license || "").trim();
      const photoUrl = rosterPhotoByTrec[licenseKey] || "";
      const initials = `${(r.first_name?.[0] || "").toUpperCase()}${(r.last_name?.[0] || "").toUpperCase()}`;

      const actions = rosterActionsByTrec[licenseKey] || {};
      const checkInAt = actions.checkInAt || "";
      const checkOutAt = actions.checkOutAt || "";
      const noShowAt = actions.noShowAt || "";

      return (
        <div
          className="tRow"
          key={idx}
          style={{
            display: "grid",
            gridTemplateColumns: "56px 2.6fr 1.1fr 1.7fr 240px",
            alignItems: "center",
            columnGap: 12,
            padding: "10px 12px",
          }}
        >
          {/* Photo */}
          <div style={{ display: "flex", alignItems: "center" }}>
            {photoUrl ? (
              <img
                src={photoUrl}
                alt={fullName}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  objectFit: "cover",
                  display: "block",
                }}
              />
            ) : (
              <div
                title="No headshot on file"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 12,
                  opacity: 0.7,
                  border: "1px solid rgba(0,0,0,0.12)",
                }}
              >
                {initials || "—"}
              </div>
            )}
          </div>

          {/* Name + Email (2 lines, single-line each, no wrap) */}
          <div style={{ minWidth: 0 }}>
            <div
              title={fullName}
              style={{
                fontWeight: 800,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {fullName || "—"}
            </div>

            <div
              title={r.email || ""}
              style={{
                marginTop: 2,
                fontSize: 12,
                opacity: 0.85,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.email || "—"}
            </div>
          </div>

          {/* TREC */}
          <div
            title={r.trec_license}
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 700,
            }}
          >
            {r.trec_license}
          </div>

          {/* Status w/ timestamps (check-in stays even after check-out) */}
          <div style={{ minWidth: 0, fontSize: 12, lineHeight: 1.25 }}>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <strong>In:</strong> {checkInAt || "—"}
            </div>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <strong>Out:</strong> {checkOutAt || "—"}
            </div>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <strong>No-Show:</strong> {noShowAt || "—"}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btnOutline"
              style={{ padding: "6px 10px" }}
              onClick={() => {
                const ts = new Date().toLocaleString();
                setRosterActionsByTrec((prev) => ({
                  ...prev,
                  [licenseKey]: { ...(prev[licenseKey] || {}), checkInAt: ts },
                }));
                setStatusMsg(`✅ Checked in: ${fullName}`);
              }}
            >
              Check In
            </button>

            <button
              type="button"
              className="btnOutline"
              style={{ padding: "6px 10px" }}
              onClick={() => {
                const ts = new Date().toLocaleString();
                setRosterActionsByTrec((prev) => ({
                  ...prev,
                  [licenseKey]: { ...(prev[licenseKey] || {}), checkOutAt: ts },
                }));
                setStatusMsg(`✅ Checked out: ${fullName}`);
              }}
            >
              Check Out
            </button>

            <button
              type="button"
              className="tabBtn small"
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                lineHeight: 1,
                color: "#8B0000",
                border: "2px solid #8B0000",
                background: "rgba(139,0,0,0.06)",
              }}
              onClick={() => {
                const ts = new Date().toLocaleString();
                setRosterActionsByTrec((prev) => ({
                  ...prev,
                  [licenseKey]: { ...(prev[licenseKey] || {}), noShowAt: ts },
                }));
                setStatusMsg(`🟥 No-Show: ${fullName}`);
              }}
            >
              No-Show
            </button>

            <button
              type="button"
              className="btnOutline"
              title="Undo / Clear Status"
              style={{ width: 34, height: 34, padding: 0 }}
              onClick={() => {
                setRosterActionsByTrec((prev) => ({
                  ...prev,
                  [licenseKey]: { checkInAt: undefined, checkOutAt: undefined, noShowAt: undefined },
                }));
                setStatusMsg(`↺ Cleared: ${fullName}`);
              }}
            >
              ↺
            </button>

            <button
              type="button"
              className="btnOutline"
              title="Remove from roster"
              style={{ width: 34, height: 34, padding: 0 }}
              onClick={() => {
                const next = rosterRows.filter((_, i) => i !== idx);
                persistRoster(next);
                setRosterActionsByTrec((prev) => {
                  const copy = { ...prev };
                  delete copy[licenseKey];
                  return copy;
                });
                setStatusMsg(`🗑 Removed: ${fullName}`);
              }}
            >
              🗑
            </button>
          </div>
        </div>
      );
    })}
  </div>
) : null}

{statusMsg ? <div className="status">{statusMsg}</div> : null}
</>
)}
</>
)}
</>

<footer className="footer">© {new Date().getFullYear()} ClassCheck Pro™</footer>
</div>
</div>
);
}
