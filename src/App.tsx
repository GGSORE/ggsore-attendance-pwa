// --- existing imports unchanged ---
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import "./styles.css";

/* ---------------- TYPES (UNCHANGED) ---------------- */

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
  start_time: string;
  end_time: string;
  created_at?: string;
};

type RosterRow = {
  first_name: string;
  mi: string;
  last_name: string;
  trec_license: string;
  email: string;
};

/* ---------------- COURSES (UNCHANGED) ---------------- */

const COURSE_OPTIONS = [
  "Commercial Leasing Contracts 101™",
  "Commercial Letters of Intent 101 for Leasing & Sales™",
  "Things You Need to Know About Practicing Law in Real Estate™",
  "Deal Dynamics: Deciphering Commercial Real Estate Contracts™",
  "Commercial Sales 101: From Client to Contract to Close™",
  "Commercial Property Management 101 - (Apartments Not Included)™",
  "Lights, Camera, Impact! REALTORS® Guide to Success on Camera™",
  "High Stakes: Seed-to-Sale Hemp Law Changes in Texas™ (3 hours)™",
  "First, It's Not Marijuana: Hemp Laws & Texas Real Estate (2 hours)™"
];

function safeLower(s: string | null | undefined) {
  return (s ?? "").toLowerCase();
}

/* ===================================================== */

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

  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  const [firstName, setFirstName] = useState<string>("");
  const [middleInitial, setMiddleInitial] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [trecLicense, setTrecLicense] = useState<string>("");

  const [userProfile, setUserProfile] = useState<Profile | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");

  /* ================= HEADSHOT STATE (NEW) ================= */
  const [headshotFile, setHeadshotFile] = useState<File | null>(null);

  /* ================= LOAD PROFILE (UPDATED) ================= */
  async function loadProfile(userId: string, emailAddr: string) {
    if (!supabase) return;

    const { data: profile } = await supabase
      .from("gg_profiles")
      .select("id,email,first_name,middle_initial,last_name,trec_license")
      .eq("id", userId)
      .maybeSingle();

    let photoUrl: string | null = null;

    const { data: headshotRow } = await supabase
      .from("gg_headshots_map")
      .select("photo_url")
      .eq("user_id", userId)
      .maybeSingle();

    if (headshotRow?.photo_url) photoUrl = headshotRow.photo_url;

    setUserProfile({
      id: userId,
      email: emailAddr,
      first_name: profile?.first_name ?? null,
      middle_initial: profile?.middle_initial ?? null,
      last_name: profile?.last_name ?? null,
      trec_license: profile?.trec_license ?? null,
      photo_url: photoUrl
    });
  }

  /* ================= CREATE ACCOUNT (UPDATED) ================= */
  async function onCreateAccount() {
    setStatusMsg("");
    if (!supabase) return;

    try {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      const userId = data.user?.id;
      if (!userId) return;

      await supabase.from("gg_profiles").upsert({
        id: userId,
        email,
        first_name: firstName,
        middle_initial: middleInitial || null,
        last_name: lastName,
        trec_license: trecLicense
      });

      /* ---- HEADSHOT UPLOAD (NEW) ---- */
      let publicUrl: string | null = null;
      if (headshotFile) {
        const fileExt = headshotFile.name.split(".").pop();
        const filePath = `${userId}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from("headshots")
          .upload(filePath, headshotFile, { upsert: true });

        if (!uploadError) {
          const { data } = supabase.storage.from("headshots").getPublicUrl(filePath);
          publicUrl = data.publicUrl;

          await supabase.from("gg_headshots_map").upsert({
            user_id: userId,
            photo_url: publicUrl
          });
        }
      }

      await loadProfile(userId, email);
      setView("app");
      setAppTab("student");
    } catch (e: any) {
      setStatusMsg(e?.message ?? "Account creation failed.");
    }
  }

  /* ================= WELCOME PHOTO DISPLAY ================= */
  function HeadshotDisplay() {
    if (!userProfile?.photo_url) return null;
    return (
      <img
        src={userProfile.photo_url}
        alt="Headshot"
        style={{ width: 90, height: 90, borderRadius: "50%", objectFit: "cover", marginBottom: 10 }}
      />
    );
  }

  /* ================= RENDER ================= */
  return (
    <div className="page">
      <div className="card">
        <header className="header">
          <img className="brandLogo" src="/classcheckpro-logo.png" alt="ClassCheck Pro™" draggable={false} />
        </header>

        {view === "auth" ? (
          <>
            <div className="subhead">Login or create an account.</div>

            {authTab === "create" && (
              <>
                <div className="sectionTitle">Upload Headshot (required)</div>
                <input
                  type="file"
                  accept="image/*"
                  className="input"
                  onChange={(e) => setHeadshotFile(e.target.files?.[0] ?? null)}
                />
              </>
            )}

            <button type="button" className="btnPrimary" onClick={onCreateAccount}>
              Create Account
            </button>
          </>
        ) : (
          <>
            <div className="topRow">
              <div>
                <HeadshotDisplay />
                <div className="welcome">Welcome back!</div>
                <div className="muted">{userProfile?.email}</div>
              </div>
            </div>
          </>
        )}

        <footer className="footer">© {new Date().getFullYear()} ClassCheck Pro™</footer>
      </div>
    </div>
  );
}
