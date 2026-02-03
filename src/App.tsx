
import { useState } from "react";
import "./styles.css";

export default function App() {
  const [view, setView] = useState<"login" | "create">("login");

  return (
    <div className="app-container">
      <div className="card">
        <div className="brand-header">
          <img src="/classcheckpro-logo.png" alt="ClassCheck Pro Logo" className="brand-logo" />
        </div>

        <p className="subhead">Login or create an account.</p>

        <div className="toggle-buttons">
          <button
            className={view === "login" ? "btn-outline active" : "btn-outline"}
            onClick={() => setView("login")}
          >
            Login
          </button>
          <button
            className={view === "create" ? "btn-outline active" : "btn-outline"}
            onClick={() => setView("create")}
          >
            Create Account
          </button>
        </div>

        {view === "login" ? (
          <div className="form">
            <label>Email</label>
            <input type="email" placeholder="Enter email" />

            <label>Password</label>
            <input type="password" placeholder="Enter password" />

            <button className="btn-primary">Login</button>
          </div>
        ) : (
          <div className="form">
            <h3>Create Account Details</h3>
            <div className="notice">
              <strong>Important:</strong> Enter your name exactly as it appears on your TREC license, including middle initial.
              <br />
              For the TREC license number, be sure to include the appropriate suffix: -SA, -B, or -BB.
            </div>

            <label>First Name</label>
            <input type="text" />

            <label>M.I. (optional)</label>
            <input type="text" />

            <label>Last Name</label>
            <input type="text" />

            <label>TREC License</label>
            <input type="text" placeholder="123456-SA" />

            <button className="btn-primary">Create Account</button>
          </div>
        )}
      </div>

      <footer>© 2026 ClassCheck Pro™</footer>
    </div>
  );
}

