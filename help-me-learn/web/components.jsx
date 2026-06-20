/* ============================================================
   components.jsx — shared UI atoms
   ============================================================ */
const { useState, useEffect, useRef } = React;

/* ---- tiny inline icons (stroke, currentColor) ---- */
function Icon({ name, size = 18 }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    learn:   <><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H11v15H4.5A1.5 1.5 0 0 1 3 17.5z"/><path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H13v15h6.5a1.5 1.5 0 0 0 1.5-1.5z"/></>,
    quiz:    <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7"/><path d="M12 16.5h.01"/></>,
    cards:   <><rect x="3" y="6" width="13" height="13" rx="2"/><path d="M8 6V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1"/></>,
    progress:<><path d="M4 19V10"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M21 19H3"/></>,
    plan:    <><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 2.5v4M16 2.5v4"/><path d="M7.5 13l1.2 1.2L11 12M14 13.5h3"/></>,
    sun:     <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon:    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>,
    upload:  <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></>,
    file:    <><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></>,
    image:   <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
    spark:   <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>,
    check:   <path d="M20 6 9 17l-5-5"/>,
    x:       <path d="M18 6 6 18M6 6l12 12"/>,
    arrow:   <path d="M5 12h14M13 6l6 6-6 6"/>,
    plus:    <path d="M12 5v14M5 12h14"/>,
    trash:   <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>,
    flip:    <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>,
    book:    <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>,
    target:  <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></>,
    user:    <><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"/></>,
    warn:    <><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></>,
    next:    <><circle cx="12" cy="12" r="9"/><path d="m10 8 4 4-4 4"/></>,
    download:<><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></>,
    library: <><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></>,
    open:    <><path d="M14 3h7v7"/><path d="M21 3 11 13"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></>,
    plusbig: <><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></>,
    message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
    idea:    <><path d="M9 21h6M10 17.5h4"/><path d="M12 3a6.5 6.5 0 0 0-3.8 11.8c.6.5 1.3 1.3 1.3 2.2h5c0-.9.7-1.7 1.3-2.2A6.5 6.5 0 0 0 12 3z"/></>,
    hide:    <><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-6 0-9.27-5.7-10-8 .47-1.49 1.47-3.32 3.06-4.94M9.9 4.24A9.5 9.5 0 0 1 12 4c6 0 9.27 5.7 10 8a17.6 17.6 0 0 1-2.27 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M2 2l20 20"/></>,
    eye:     <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></>,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
    menu:    <path d="M4 6h16M4 12h16M4 18h16"/>,
    globe:   <><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></>,
    play:    <path d="M7 5l12 7-12 7z"/>,
    pause:   <><path d="M9 5v14"/><path d="M15 5v14"/></>,
    speaker: <><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></>,
    mic:     <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></>,
    chevrondown: <path d="M6 9l6 6 6-6"/>,
    openbook: <><path d="M12 6.6C10.4 5.2 7.2 4.6 4 5.1v13.2c3.2-.5 6.4.1 8 1.5 1.6-1.4 4.8-2 8-1.5V5.1c-3.2-.5-6.4.1-8 1.5z"/><path d="M12 6.6V20.3"/></>,
  };
  return <svg {...p}>{paths[name] || null}</svg>;
}

function Spinner({ size = 18 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

function ProgressBar({ value, max = 1 }) {
  const pct = Math.max(0, Math.min(1, value / max));
  return <div className="progress-track"><div className="progress-fill" style={{ transform: `scaleX(${pct})` }} /></div>;
}

function Tag({ children, variant }) {
  return <span className={"tag" + (variant ? " tag-" + variant : "")}>{children}</span>;
}

/* progress ring (svg) */
function Ring({ value, size = 60, stroke = 6, color = "var(--accent)" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, value)));
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.3,.9,.3,1)" }} />
    </svg>
  );
}

/* empty-state block */
function Empty({ icon, title, children }) {
  return (
    <div className="card empty-state">
      <div className="empty-icon"><Icon name={icon} size={26} /></div>
      <h3 className="empty-title">{title}</h3>
      <div className="empty-body">{children}</div>
    </div>
  );
}

/* ---- scroll reveal (IntersectionObserver, zero dependency) ----
   Attach the returned ref to an element carrying className "reveal": it starts
   hidden (CSS) and gets data-revealed="true" the first time it scrolls into
   view. Honors prefers-reduced-motion and missing IO support by revealing
   immediately, so content is never trapped invisible. */
function useReveal({ threshold = 0.12, margin = "0px 0px -8% 0px", once = true } = {}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      el.setAttribute("data-revealed", "true");
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.setAttribute("data-revealed", "true");
          if (once) io.unobserve(entry.target);
        } else if (!once) {
          entry.target.removeAttribute("data-revealed");
        }
      }
    }, { threshold, rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/* convenience wrapper — <Reveal>…</Reveal> or <Reveal as="section" delay={80}> */
function Reveal({ as = "div", delay = 0, className = "", style, children, ...rest }) {
  const ref = useReveal();
  const Cmp = as;
  return (
    <Cmp ref={ref} className={("reveal " + className).trim()}
      style={delay ? { transitionDelay: delay + "ms", ...style } : style} {...rest}>
      {children}
    </Cmp>
  );
}

/* section heading used across tabs — pass hero for the signature lesson entry */
function PageHead({ kicker, title, children, hero }) {
  return (
    <header className={"page-head" + (hero ? " page-head--hero" : "")}>
      {kicker && <div className="kicker">{kicker}</div>}
      <h1 className="page-title">{title}</h1>
      {children && <p className="page-lede">{children}</p>}
    </header>
  );
}

Object.assign(window, { Icon, Spinner, ProgressBar, Tag, Ring, Empty, PageHead, useReveal, Reveal, useState, useEffect, useRef });