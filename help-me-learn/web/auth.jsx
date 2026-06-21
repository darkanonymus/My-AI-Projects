/* ============================================================
   auth.jsx — account UI: login / register / forgot + reset
   Extracted from main.jsx (was a 1100-line god-file). These two
   modals are self-contained: they only talk to /api/auth/* and
   reload on success so App re-fetches the per-user state.
   ============================================================ */
const { Icon: AIcon, useState: uS } = window;

/* Login / create-account modal. On success we reload so the app re-fetches the
   now per-user state from the server (courses follow you across devices). */
function AuthModal({ open, onClose, onAuthed }) {
  const [mode, setMode] = uS("login");   // "login" | "register" | "forgot"
  const [email, setEmail] = uS("");
  const [password, setPassword] = uS("");
  const [busy, setBusy] = uS(false);
  const [err, setErr] = uS("");
  const [showPw, setShowPw] = uS(false);
  const [sent, setSent] = uS(false);
  if (!open) return null;

  async function submit(e) {
    if (e) e.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (mode === "forgot") {
        await fetch("/api/auth/forgot", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        setSent(true); setBusy(false); return;   // always succeeds — never leaks if the email exists
      }
      const r = await fetch("/api/auth/" + mode, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Échec de la connexion.");
      if (onAuthed) onAuthed(data);
      window.location.reload();   // refetch per-user state
    } catch (e2) {
      setErr((e2 && e2.message) || String(e2));
      setBusy(false);
    }
  }

  const isReg = mode === "register";
  const isForgot = mode === "forgot";
  return (
    <div onClick={onClose} className="modal-overlay">
      <div className="card fade-in modal-panel" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><AIcon name="target" size={20} /></div>
            <h2>{isForgot ? "Mot de passe oublié" : isReg ? "Créer un compte" : "Se connecter"}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><AIcon name="x" size={18} /></button>
          </div>
          {isForgot && sent ? (
            <>
              <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
                Si un compte existe pour <b>{email.trim()}</b>, un lien de réinitialisation vient d'être envoyé (valable 1 heure). Pense à vérifier tes spams.
              </p>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSent(false); setErr(""); setMode("login"); }}
                style={{ width: "100%", justifyContent: "center" }}>Retour à la connexion</button>
            </>
          ) : (
            <>
              <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
                {isForgot
                  ? "Entre ton email : on t'enverra un lien pour choisir un nouveau mot de passe."
                  : "Connecte-toi pour retrouver tes cours sur tous tes appareils."}
              </p>
              <form onSubmit={submit}>
                <label className="field-label">Email</label>
                <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="toi@exemple.com" className="field" required />
                {!isForgot && (
                  <>
                    <label className="field-label" style={{ marginTop: "var(--space-3)" }}>Mot de passe</label>
                    <div style={{ position: "relative" }}>
                      <input type={showPw ? "text" : "password"} autoComplete={isReg ? "new-password" : "current-password"} value={password}
                        onChange={e => setPassword(e.target.value)} placeholder={isReg ? "10 caractères minimum" : "••••••••"} className="field" style={{ width: "100%", paddingRight: 42 }} required />
                      <button type="button" className="icon-btn" onClick={() => setShowPw(s => !s)}
                        aria-label={showPw ? "Masquer le mot de passe" : "Afficher le mot de passe"} title={showPw ? "Masquer" : "Afficher"}
                        style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>
                        <AIcon name={showPw ? "eyeoff" : "eye"} size={16} />
                      </button>
                    </div>
                  </>
                )}
                {err && <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>{err}</div>}
                <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-4)" }}>
                  {busy ? <Spinner size={15} /> : <AIcon name={isForgot ? "message" : isReg ? "plusbig" : "target"} size={15} />}
                  {isForgot ? "Envoyer le lien" : isReg ? "Créer mon compte" : "Se connecter"}
                </button>
              </form>
              {!isForgot && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode(isReg ? "login" : "register"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-3)" }}>
                  {isReg ? "J'ai déjà un compte — me connecter" : "Pas de compte ? En créer un"}
                </button>
              )}
              {mode === "login" && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode("forgot"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-1)" }}>
                  Mot de passe oublié ?
                </button>
              )}
              {isForgot && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setMode("login"); }}
                  style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-3)" }}>
                  Retour à la connexion
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Password-reset screen, shown when the URL carries ?reset=<token>
   (the link emailed by /api/auth/forgot). On success the user is logged in. */
function ResetModal({ token, onClose }) {
  const [password, setPassword] = uS("");
  const [busy, setBusy] = uS(false);
  const [err, setErr] = uS("");
  const [showPw, setShowPw] = uS(false);
  async function submit(e) {
    if (e) e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = await fetch("/api/auth/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Échec.");
      try { const u = new URL(window.location.href); u.searchParams.delete("reset"); window.history.replaceState({}, "", u); } catch (_) {}
      window.location.reload();   // now logged in with the new password
    } catch (e2) { setErr((e2 && e2.message) || String(e2)); setBusy(false); }
  }
  return (
    <div className="modal-overlay">
      <div className="card fade-in modal-panel" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 100%)" }}>
        <div className="accent-bar" />
        <div className="modal-body">
          <div className="modal-head">
            <div className="tile-icon"><AIcon name="target" size={20} /></div>
            <h2>Nouveau mot de passe</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Fermer"><AIcon name="x" size={18} /></button>
          </div>
          <p className="soft" style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, margin: "var(--space-1) 0 var(--space-4)" }}>
            Choisis un nouveau mot de passe pour ton compte.
          </p>
          <form onSubmit={submit}>
            <label className="field-label">Nouveau mot de passe</label>
            <div style={{ position: "relative" }}>
              <input type={showPw ? "text" : "password"} autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)} placeholder="10 caractères minimum" className="field" style={{ width: "100%", paddingRight: 42 }} required />
              <button type="button" className="icon-btn" onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? "Masquer" : "Afficher"} title={showPw ? "Masquer" : "Afficher"}
                style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}>
                <AIcon name={showPw ? "eyeoff" : "eye"} size={16} />
              </button>
            </div>
            {err && <div className="hint hint--warn" style={{ marginTop: "var(--space-3)" }}>{err}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: "var(--space-4)" }}>
              {busy ? <Spinner size={15} /> : <AIcon name="check" size={15} />}
              Choisir ce mot de passe
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AuthModal, ResetModal });
