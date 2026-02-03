import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

type Profile = {
  id: string;
  email: string;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  trec_license: string;
};

type SessionRow = {
  id: string;
  title: string;
  starts_at: string; // ISO
  ends_at: string;   // ISO
};

function nowIso() {
  return new Date().toISOString();
}

function toLocal(dtIso: string) {
  const d = new Date(dtIso);
  return d.toLocaleString();
}

async function getPublicHeadshotUrl(headshotPath: string) {
  // bucket: headshots (PUBLIC), path like "headshots/1234567.jpg"
  const { data } = supabase.storage.from("headshots").getPublicUrl(headshotPath);
  return data.publicUrl;
}

export default function App() {
  const [loading, setLoading] = useState(true);

  // auth
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");

  // create account
  const [createFirst, setCreateFirst] = useState("");
  const [createMiddle, setCreateMiddle] = useState("");
  const [createLast, setCreateLast] = useState("");
  const [createTrec, setCreateTrec] = useState("");

  // signed-in user
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  // sessions/check-in
  const [activeSessions, setActiveSessions] = useState<SessionRow[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  // headshot
  const [headshotUrl, setHeadshotUrl] = useState<string | null>(null);

  // admin
  const [isAdmin, setIsAdmin] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionStart, setNewSessionStart] = useState("");
  const [newSessionEnd, setNewSessionEnd] = useState("");

  const [headshotTrec, setHeadshotTrec] = useState("");
  const [headshotFile, setHeadshotFile] = useState<File | null>(null);

  const [status, setStatus] = useState<string>("");

  const signedInName = useMemo(() => {
    if (!profile) return "";
    const mi = profile.middle_initial ? ` ${profile.middle_initial}.` : "";
    return `${profile.first_name}${mi} ${profile.last_name}`.trim();
  }, [profile]);

  async function refreshAuth() {
    setLoading(true);
    setStatus("");

    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id ?? null;
    setUserId(uid);

    if (!uid) {
      setProfile(null);
      setIsAdmin(false);
      setHeadshotUrl(null);
      setActiveSessions([]);
      setSelectedSessionId("");
      setLoading(false);
      return;
    }

    // Profile
    const { data: p, error: pErr } = await supabase
      .from("gg_profiles")
      .select("id,email,first_name,middle_initial,last_name,trec_license")
      .eq("id", uid)
      .maybeSingle();

    if (pErr) {
      setStatus(`Profile load error: ${pErr.message}`);
      setProfile(null);
    } else {
      setProfile(p as Profile);
    }

    // Admin check (RLS allows admins to read gg_admins)
    const { data: a, error: aErr } = await supabase
      .from("gg_admins")
      .select("user_id")
      .eq("user_id", uid)
      .maybeSingle();

    if (aErr) {
      setIsAdmin(false);
    } else {
      setIsAdmin(!!a);
    }

    await loadActiveSessions();

    // Headshot lookup
    if (p && (p as Profile).trec_license) {
      await loadHeadshot((p as Profile).trec_license);
    } else {
      setHeadshotUrl(null);
    }

    setLoading(false);
  }

  async function loadActiveSessions() {
    const { data, error } = await supabase
      .from("gg_sessions")
      .select("id,title,starts_at,ends_at")
      .gte("ends_at", nowIso())
      .order("starts_at", { ascending: true });

    if (error) {
      setStatus(`Session load error: ${error.message}`);
      setActiveSessions([]);
      setSelectedSessionId("");
      return;
    }

    const rows = (data ?? []) as SessionRow[];
    setActiveSessions(rows);
    setSelectedSessionId(rows.length > 0 ? rows[0].id : "");
  }

  async function loadHeadshot(trecLicense: string) {
    const { data, error } = await supabase
      .from("gg_headshots_map")
      .select("headshot_path")
      .eq("trec_license", trecLicense)
      .maybeSingle();

    if (error || !data?.headshot_path) {
      setHeadshotUrl(null);
      return;
    }

    const url = await getPublicHeadshotUrl(data.headshot_path);
    setHeadshotUrl(url);
  }

  useEffect(() => {
    refreshAuth();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      refreshAuth();
    });

    return () => {
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signIn() {
    setStatus("");
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });
    if (error) setStatus(error.message);
  }

  async function signOut() {
    setStatus("");
    await supabase.auth.signOut();
  }

  async function createAccount() {
    setStatus("");

    const email = authEmail.trim();
    const password = authPassword;
    const first = createFirst.trim();
    const middle = createMiddle.trim();
    const last = createLast.trim();
    const trec = createTrec.trim();

    if (!email || !password || !first || !last || !trec) {
      setStatus("Missing required fields: email, password, first name, last name, TREC license.");
      return;
    }

    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      setStatus(error.message);
      return;
    }

    const uid = data.user?.id;
    if (!uid) {
      setStatus("Account created, but user id was not returned. Try logging in.");
      return;
    }

    const { error: insErr } = await supabase.from("gg_profiles").upsert({
      id: uid,
      email,
      first_name: first,
      middle_initial: middle ? middle.slice(0, 1).toUpperCase() : null,
      last_name: last,
      trec_license: trec,
    });

    if (insErr) {
      setStatus(`Profile save error: ${insErr.message}`);
      return;
    }

    setStatus("Account created. If email confirmation is enabled, confirm email then log in.");
  }

  async function checkIn() {
    setStatus("");
    if (!userId) return;

    if (!selectedSessionId) {
      setStatus("No active session selected.");
      return;
    }

    const { error } = await supabase.from("gg_attendance").upsert({
      session_id: selectedSessionId,
      user_id: userId,
      checked_in_at: nowIso(),
    });

    if (error) {
      setStatus(`Check-in error: ${error.message}`);
      return;
    }
    setStatus("Checked in ✅");
  }

  async function createSession() {
    setStatus("");

    if (!newSessionTitle.trim() || !newSessionStart || !newSessionEnd) {
      setStatus("Missing title/start/end.");
      return;
    }

    // IMPORTANT: datetime-local returns "YYYY-MM-DDTHH:mm"
    // Supabase will coerce; for precise tz handling you can convert to ISO with timezone later.
    const { error } = await supabase.from("gg_sessions").insert({
      title: newSessionTitle.trim(),
      starts_at: newSessionStart,
      ends_at: newSessionEnd,
    });

    if (error) {
      setStatus(`Create session error: ${error.message}`);
      return;
    }

    setNewSessionTitle("");
    setNewSessionStart("");
    setNewSessionEnd("");
    setStatus("Session created ✅");
    await loadActiveSessions();
  }

  async function uploadHeadshot() {
    setStatus("");

    const trec = headshotTrec.trim();
    if (!trec) {
      setStatus("Missing TREC license.");
      return;
    }
    if (!headshotFile) {
      setStatus("Select an image file.");
      return;
    }

    const ext = headshotFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const safeExt = ext.replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `headshots/${trec}.${safeExt}`;

    const { error: upErr } = await supabase.storage
      .from("headshots")
      .upload(path, headshotFile, { upsert: true, contentType: headshotFile.type });

    if (upErr) {
      setStatus(`Storage upload error: ${upErr.message}`);
      return;
    }

    const { error: mapErr } = await supabase.from("gg_headshots_map").upsert({
      trec_license: trec,
      headshot_path: path,
      updated_at: nowIso(),
    });

    if (mapErr) {
      setStatus(`Headshot map save error: ${mapErr.message}`);
      return;
    }

    setStatus("Headshot uploaded + mapped ✅");
    setHeadshotFile(null);

    if (profile?.trec_license === trec) {
      await loadHeadshot(trec);
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="card">Loading…</div>
      </div>
    );
  }

  // Not signed in
  if (!userId) {
    return (
      <div className="container">
        <div className="card stack">
          <h1>GGSORE Check-in</h1>
          <div className="small">Login or create an account.</div>

          <div className="row">
            <div style={{ flex: 1, minWidth: 260 }}>
              <label>Email</label>
              <input value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <label>Password</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="row">
            <button onClick={signIn}>Login</button>
            <button className="ghost" onClick={createAccount}>Create Account</button>
          </div>

          <div className="hr" />

          <h2>Create Account Details</h2>
          <div className="row">
            <div style={{ flex: 1, minWidth: 220 }}>
              <label>First Name</label>
              <input value={createFirst} onChange={(e) => setCreateFirst(e.target.value)} />
            </div>
            <div style={{ width: 130 }}>
              <label>M.I. (optional)</label>
              <input
                value={createMiddle}
                onChange={(e) => setCreateMiddle(e.target.value)}
                maxLength={1}
              />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label>Last Name</label>
              <input value={createLast} onChange={(e) => setCreateLast(e.target.value)} />
            </div>
          </div>

          <div className="row">
            <div style={{ flex: 1, minWidth: 220 }}>
              <label>TREC License</label>
              <input value={createTrec} onChange={(e) => setCreateTrec(e.target.value)} />
            </div>
          </div>

          {status && (
            <div className="small">
              <b>Status:</b> {status}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Signed in
  return (
    <div className="container">
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            {headshotUrl ? (
              <img className="avatar" src={headshotUrl} alt="Headshot" />
            ) : (
              <div className="avatar" aria-label="No headshot" />
            )}
            <div>
              <h1 style={{ marginBottom: 4 }}>Welcome, {signedInName || "Student"}</h1>
              <div className="row">
                {profile?.trec_license && <span className="badge">TREC: {profile.trec_license}</span>}
                {isAdmin && <span className="badge">Admin</span>}
              </div>
            </div>
          </div>

          <button className="secondary" onClick={signOut}>Logout</button>
        </div>

        <div className="hr" />

        <h2>Student Check-in</h2>

        <div className="row">
          <div style={{ flex: 1, minWidth: 280 }}>
            <label>Active Sessions</label>
            <select value={selectedSessionId} onChange={(e) => setSelectedSessionId(e.target.value)}>
              {activeSessions.length === 0 && <option value="">No active sessions</option>}
              {activeSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} • {toLocal(s.starts_at)} → {toLocal(s.ends_at)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button onClick={checkIn} disabled={!selectedSessionId}>Check In</button>
          </div>
        </div>

        {isAdmin && (
          <>
            <div className="hr" />
            <h2>Admin</h2>

            <div className="card stack" style={{ borderRadius: 12, background: "#fbfbff" }}>
              <h3>Create New Session</h3>
              <div className="row">
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Title</label>
                  <input value={newSessionTitle} onChange={(e) => setNewSessionTitle(e.target.value)} />
                </div>
              </div>
              <div className="row">
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Start</label>
                  <input
                    type="datetime-local"
                    value={newSessionStart}
                    onChange={(e) => setNewSessionStart(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>End</label>
                  <input
                    type="datetime-local"
                    value={newSessionEnd}
                    onChange={(e) => setNewSessionEnd(e.target.value)}
                  />
                </div>
              </div>
              <button onClick={createSession}>Create Session</button>
              <div className="small">
                Tip: datetime-local saves without timezone. If needed, we can convert to ISO with timezone later.
              </div>
            </div>

            <div className="card stack" style={{ borderRadius: 12, background: "#fbfbff" }}>
              <h3>Headshots</h3>
              <div className="small">
                Uploads into Storage bucket <b>headshots</b> and writes <b>gg_headshots_map</b>.
              </div>

              <div className="row">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label>TREC License</label>
                  <input value={headshotTrec} onChange={(e) => setHeadshotTrec(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <label>Image File</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setHeadshotFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>

              <button onClick={uploadHeadshot}>Upload Headshot</button>
            </div>
          </>
        )}

        {status && (
          <div className="small">
            <b>Status:</b> {status}
          </div>
        )}
      </div>
    </div>
  );
}

