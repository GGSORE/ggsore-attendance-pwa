import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import "./styles.css";

/**
 * ClassCheck Pro™ — single-file App.tsx
 * Hotfix: define/own admin view state (prevents "adminTab is not defined")
 * Also: no credential prefill, Century Gothic everywhere, student/admin separation.
 */

// ---------- Supabase ----------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const adminEmailEnv = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) ?? "";

function buildSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey);
}

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
};

type SessionRow = {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  created_at?: string;
};

export default function App() {
  const supabase = useMemo(() => buildSupabase(), []);
  const [view, setView] = useState<View>("auth");
  const [authTab, setAuthTab] = useState<AuthTab>("login");

  // HOTFIX: adminTab must exist (we use appTab, but this prevents undefined usage)
  const [appTab, setAppTab] = useState<AppTab>("student");

  // Auth fields (never prefilled)
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  // Create Account fields
  const [firstName, setFirstName] = useState<string>("");
  const [middleInitial, setMiddleInitial] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [trecLicense, setTrecLicense] = useState<string>("");

  const [userProfile, setUserProfile] = useState<Profile | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");

  // Check-in
  const [manualQr, setManualQr] = useState<string>("");
  const [scanSupported, setScanSupported] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  // Admin session creator
  const [sessionTitle, setSessionTitle] = useState<string>("");
  const [sessionStart, setSessionStart] = useState<string>("");
  const [sessionEnd, setSessionEnd] = useState<string>("");
  const [recentSessions, setRecentSessions] = useState<SessionRow[]>([]);

  const isAdmin = useMemo(() => {
    const e = (userProfile?.email ?? "").toLowerCase();
    const adminE = adminEmailEnv.toLowerCase();
    return !!e && !!adminE && e === adminE;
  }, [userProfile?.email]);

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
    // Best-effort: profiles table commonly used; if not present, fallback to minimal profile
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,first_name,middle_initial,last_name,trec_license")
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
      // Validate only on submit (no student-facing missing-field banner)
      const missing: string[] = [];
      if (!email) missing.push("email");
      if (!password) missing.push("password");
      if (!firstName) missing.push("first name");
      if (!lastName) missing.push("last name");
      if (!trecLicense) missing.push("TREC license");
      if (missing.length) {
        setStatusMsg(`Please complete: ${missing.join(", ")}.`);
        return;
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      // Best-effort profile insert (non-fatal)
      try {
        await supabase.from("profiles").upsert({
          id: data.user?.id,
          email,
          first_name: firstName,
          middle_initial: middleInitial || null,
          last_name: lastName,
          trec_license: trecLicense,
        });
      } catch {
        // ignore
      }

      if (data.user) {
        await loadProfile(data.user.id, data.user.email ?? "");
      }
      setView("app");
      setAppTab("student");
      setPassword("");
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
      setManualQr("");
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
      setStatusMsg("QR scanning isn’t supported in this browser. Use Manual Entry below.");
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
              setManualQr(raw);
              stopScan();
              setStatusMsg("QR captured. Review and submit below.");
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
    if (!manualQr.trim()) {
      setStatusMsg("Paste the QR value (or scan) before submitting.");
      return;
    }
    try {
      // Table name may vary; use "checkins" as default.
      const { error } = await supabase.from("checkins").insert({
        user_id: userProfile?.id,
        qr_value: manualQr.trim(),
      });
      if (error) throw error;
      setStatusMsg("✅ Check-in submitted!");
      setManualQr("");
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Check-in failed (table/permissions may need setup).");
    }
  }

  // ---------- Admin ----------
  async function loadRecentSessions() {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("class_sessions")
        .select("id,title,start_time,end_time,created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      setRecentSessions((data as any) ?? []);
    } catch {
      setRecentSessions([]);
    }
  }

  useEffect(() => {
    if (view === "app" && isAdmin && appTab === "admin") {
      loadRecentSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, isAdmin, appTab]);

  async function createSession() {
    setStatusMsg("");
    if (!supabase) return;
    if (!sessionTitle.trim() || !sessionStart || !sessionEnd) {
      setStatusMsg("Please provide a session title, start time, and end time.");
      return;
    }
    try {
      const { error } = await supabase.from("class_sessions").insert({
        title: sessionTitle.trim(),
        start_time: new Date(sessionStart).toISOString(),
        end_time: new Date(sessionEnd).toISOString(),
        created_by: userProfile?.id,
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
              <button type="button" className={"tabBtn" + (authTab === "login" ? " tabBtnActive" : "")} onClick={() => setAuthTab("login")}>
                Login
              </button>
              <button type="button" className={"tabBtn" + (authTab === "create" ? " tabBtnActive" : "")} onClick={() => setAuthTab("create")}>
                Create Account
              </button>
            </div>

            <div className="grid2">
              <div>
                <label className="label">Email</label>
                <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" inputMode="email" placeholder="name@example.com" />
              </div>
              <div>
                <label className="label">Password</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="••••••••" />
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
                  <strong>Important:</strong> Enter your name exactly as it appears on your TREC license, including middle initial.
                  <br />
                  For the TREC license number, be sure to include the appropriate suffix: -SA, -B, or -BB.
                </div>

                <div className="grid3">
                  <div>
                    <label className="label">First Name</label>
                    <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" />
                  </div>
                  <div>
                    <label className="label">M.I. (optional)</label>
                    <input className="input" value={middleInitial} onChange={(e) => setMiddleInitial(e.target.value)} maxLength={1} autoComplete="off" />
                  </div>
                  <div>
                    <label className="label">Last Name</label>
                    <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" />
                  </div>
                </div>

                <div className="grid1">
                  <div>
                    <label className="label">TREC License</label>
                    <input className="input" value={trecLicense} onChange={(e) => setTrecLicense(e.target.value)} autoComplete="off" placeholder="123456-SA" />
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
                    <button type="button" className={"tabBtn small" + (appTab === "student" ? " tabBtnActive" : "")} onClick={() => setAppTab("student")}>
                      Student
                    </button>
                    <button type="button" className={"tabBtn small" + (appTab === "admin" ? " tabBtnActive" : "")} onClick={() => setAppTab("admin")}>
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

                <div className="rowBetween">
                  <div className="sectionSubtitle">Scan QR Code</div>
                  <button type="button" className="btnOutline" onClick={() => (scanning ? stopScan() : startScan())}>
                    {scanning ? "Stop Scan" : "Start Scan"}
                  </button>
                </div>

                <div className="scanBox">
                  {scanSupported ? <video ref={videoRef} className="video" muted playsInline /> : <div className="scanUnsupported">QR scanning isn’t supported in this browser. Use Manual Entry below.</div>}
                </div>

                <div className="sectionSubtitle">Manual Entry</div>
                <input className="input" value={manualQr} onChange={(e) => setManualQr(e.target.value)} placeholder="Paste the QR value here (if needed)" autoComplete="off" />
                <div className="actions">
                  <button type="button" className="btnPrimary" onClick={submitCheckIn}>
                    Submit Check-In
                  </button>
                </div>

                {statusMsg ? <div className="status">{statusMsg}</div> : null}
              </>
            ) : (
              <>
                <div className="sectionTitle">Admin / Instructor</div>

                <div className="grid1">
                  <div>
                    <label className="label">Session Title</label>
                    <input className="input" value={sessionTitle} onChange={(e) => setSessionTitle(e.target.value)} />
                  </div>
                </div>

                <div className="grid2">
                  <div>
                    <label className="label">Start Time</label>
                    <input className="input" type="datetime-local" value={sessionStart} onChange={(e) => setSessionStart(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">End Time</label>
                    <input className="input" type="datetime-local" value={sessionEnd} onChange={(e) => setSessionEnd(e.target.value)} />
                  </div>
                </div>

                <div className="actions">
                  <button type="button" className="btnPrimary" onClick={createSession}>
                    Create New Class Session
                  </button>
                </div>

                <div className="sectionSubtitle">Recent Sessions</div>
                <div className="table">
                  <div className="tHead">
                    <div>Title</div>
                    <div>Start</div>
                    <div>End</div>
                  </div>
                  {recentSessions.length ? (
                    recentSessions.map((s) => (
                      <div className="tRow" key={s.id}>
                        <div>{s.title}</div>
                        <div>{new Date(s.start_time).toLocaleString()}</div>
                        <div>{new Date(s.end_time).toLocaleString()}</div>
                      </div>
                    ))
                  ) : (
                    <div className="tEmpty">No sessions yet.</div>
                  )}
                </div>

                {statusMsg ? <div className="status">{statusMsg}</div> : null}
              </>
            )}
          </>
        )}

        <footer className="footer">© {new Date().getFullYear()} ClassCheck Pro™</footer>
      </div>
    </div>
  );
}

  const [rosterRows, setRosterRows] = useState<Array<{first_name:string; mi:string; last_name:string; trec_license:string; email:string;}>>([]);
  const [rosterError, setRosterError] = useState<string>('');
  const [manualStudent, setManualStudent] = useState({ first_name:'', mi:'', last_name:'', trec_license:'', email:'' });

  const parseCsv = (text: string) => {
    // Simple CSV parser (comma-separated, supports quoted values)
    const rows: string[][] = [];
    let cur = '';
    let row: string[] = [];
    let inQuotes = false;
    for (let i=0;i<text.length;i++){
      const ch = text[i];
      if (ch === '"'){
        if (inQuotes && text[i+1] === '"'){ cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes){
        row.push(cur.trim()); cur=''; 
      } else if ((ch === '\n' || ch === '\r') && !inQuotes){
        if (ch === '\r' && text[i+1] === '\n') i++;
        row.push(cur.trim()); cur='';
        if (row.some(c=>c.length>0)) rows.push(row);
        row=[];
      } else {
        cur += ch;
      }
    }
    if (cur.length || row.length){ row.push(cur.trim()); if (row.some(c=>c.length>0)) rows.push(row); }
    return rows;
  };

  const handleRosterUpload = async (file: File) => {
    setRosterError('');
    try{
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0){ setRosterError('Roster file appears to be empty.'); return; }
      const header = rows[0].map(h=>h.toLowerCase().replace(/\s+/g,'_'));
      const data = rows.slice(1);
      const idx = (name: string) => header.indexOf(name);
      const iFirst = idx('first_name');
      const iMI = idx('mi');
      const iLast = idx('last_name');
      const iTrec = idx('trec_license');
      const iEmail = idx('email');
      if (iFirst === -1 || iLast === -1 || iTrec === -1){
        setRosterError('CSV must include columns: first_name, last_name, trec_license (email and mi are optional).');
        return;
      }
      const clean = data
        .filter(r=>r.length)
        .map(r=>({
          first_name: (r[iFirst]||'').trim(),
          mi: (iMI>-1 ? (r[iMI]||'').trim() : ''),
          last_name: (r[iLast]||'').trim(),
          trec_license: (r[iTrec]||'').trim(),
          email: (iEmail>-1 ? (r[iEmail]||'').trim() : ''),
        }))
        .filter(r=>r.first_name && r.last_name && r.trec_license);
      setRosterRows(clean);
      // persist locally so it survives refreshes
      localStorage.setItem('ccp_roster_preview', JSON.stringify(clean));
    }catch(e:any){
      setRosterError(e?.message || 'Could not read roster file.');
    }
  };

  const addManualStudentToRoster = () => {
    setRosterError('');
    const r = { ...manualStudent };
    if (!r.first_name || !r.last_name || !r.trec_license){
      setRosterError('Please enter first name, last name, and TREC license for manual add.');
      return;
    }
    const next = [r, ...rosterRows];
    setRosterRows(next);
    localStorage.setItem('ccp_roster_preview', JSON.stringify(next));
    setManualStudent({ first_name:'', mi:'', last_name:'', trec_license:'', email:'' });
  };

